import { supabase } from '@/integrations/supabase/client';
import type { NormalizedRecord } from './normalize';
import type { ReconciledMember } from './reconcile';

/**
 * The metadata we need to link a snapshot to newly-inserted normalized_records.
 * Commission uploads do not have a snapshot (see §2 of ARCHITECTURE_PLAN.md).
 */
export interface SnapshotRef {
  id: string;
  kind: 'bo' | 'ede';
}

export async function createBatch(statementMonth: string, notes?: string) {
  const { data, error } = await supabase
    .from('upload_batches')
    .insert({ statement_month: statementMonth, notes })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function getBatches() {
  const { data, error } = await supabase
    .from('upload_batches')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

export async function getUploadedFiles(batchId: string) {
  const { data, error } = await supabase
    .from('uploaded_files')
    .select('*')
    .eq('batch_id', batchId)
    .is('superseded_at', null);
  if (error) throw error;
  return data;
}

/**
 * Record a file upload.
 *
 * Prior behaviour: DELETE prior normalized_records and the prior uploaded_files
 * row matching (batch_id, file_label). That destroyed historical snapshots.
 *
 * New behaviour: mark both rowsets as superseded (append-only history) and
 * create a bo_snapshots or ede_snapshots row for the new upload. Commission
 * uploads don't get a snapshot table; the supersede behaviour still applies so
 * re-uploaded commission files don't double-count.
 *
 * Returns the new uploaded_files row, plus (for EDE/BACK_OFFICE) the snapshot
 * created for it. The caller passes the snapshot to insertNormalizedRecords so
 * every row is linked back to the snapshot it came from.
 */
export async function uploadFileRecord(
  batchId: string, fileLabel: string, fileName: string,
  sourceType: string, payEntity: string | null, aorBucket: string | null, storagePath: string
): Promise<{ file: any; snapshot: SnapshotRef | null }> {
  const now = new Date().toISOString();

  // Mark prior rows as superseded instead of deleting them.
  await supabase
    .from('normalized_records')
    .update({ superseded_at: now })
    .eq('batch_id', batchId)
    .eq('source_file_label', fileLabel)
    .is('superseded_at', null);

  await supabase
    .from('uploaded_files')
    .update({ superseded_at: now })
    .eq('batch_id', batchId)
    .eq('file_label', fileLabel)
    .is('superseded_at', null);

  // Insert the new uploaded_files row.
  const { data: file, error: fileError } = await supabase
    .from('uploaded_files')
    .insert({
      batch_id: batchId,
      file_label: fileLabel,
      file_name: fileName,
      source_type: sourceType,
      pay_entity: payEntity,
      aor_bucket: aorBucket,
      storage_path: storagePath,
    })
    .select()
    .single();
  if (fileError) throw fileError;

  // Create a snapshot row for EDE and BACK_OFFICE uploads.
  const snapshot = await createSnapshotForUpload(file.id, sourceType, aorBucket, fileLabel);

  return { file, snapshot };
}

/**
 * Find or create a snapshot row for an uploaded_files row.
 *
 * Commission uploads return null — they don't have a snapshot table.
 */
async function createSnapshotForUpload(
  uploadedFileId: string,
  sourceType: string,
  aorBucket: string | null,
  fileLabel: string,
  snapshotDate?: string,
): Promise<SnapshotRef | null> {
  if (sourceType === 'BACK_OFFICE') {
    const payload: any = { uploaded_file_id: uploadedFileId };
    if (aorBucket) payload.agent_bucket = aorBucket;
    if (snapshotDate) payload.snapshot_date = snapshotDate;
    const { data, error } = await (supabase as any)
      .from('bo_snapshots')
      .insert(payload)
      .select()
      .single();
    if (error) throw error;
    return { id: data.id, kind: 'bo' };
  }
  if (sourceType === 'EDE') {
    const payload: any = { uploaded_file_id: uploadedFileId };
    payload.source_kind = deriveEdeSourceKind(fileLabel);
    if (snapshotDate) payload.snapshot_date = snapshotDate;
    const { data, error } = await (supabase as any)
      .from('ede_snapshots')
      .insert(payload)
      .select()
      .single();
    if (error) throw error;
    return { id: data.id, kind: 'ede' };
  }
  return null;
}

function deriveEdeSourceKind(fileLabel: string): string | null {
  const lower = fileLabel.toLowerCase();
  if (lower.includes('summary')) return 'summary';
  if (lower.includes('archived enrolled')) return 'archived_enrolled';
  if (lower.includes('archived not enrolled')) return 'archived_not_enrolled';
  return null;
}

/**
 * Look up (or lazy-create) the snapshot row for an existing uploaded_files row,
 * used by rebuilds which re-insert normalized_records without a fresh upload.
 *
 * For files uploaded before Phase 1a, no snapshot exists yet — we backfill one
 * dated to the uploaded_files.created_at so snapshot history is continuous.
 */
export async function getOrCreateSnapshotForFile(file: {
  id: string;
  source_type: string;
  aor_bucket: string | null;
  file_label: string;
  created_at: string;
}): Promise<SnapshotRef | null> {
  if (file.source_type === 'BACK_OFFICE') {
    const { data: existing } = await (supabase as any)
      .from('bo_snapshots')
      .select('id')
      .eq('uploaded_file_id', file.id)
      .maybeSingle();
    if (existing?.id) return { id: existing.id, kind: 'bo' };
    const snapshotDate = file.created_at.substring(0, 10);
    return createSnapshotForUpload(file.id, 'BACK_OFFICE', file.aor_bucket, file.file_label, snapshotDate);
  }
  if (file.source_type === 'EDE') {
    const { data: existing } = await (supabase as any)
      .from('ede_snapshots')
      .select('id')
      .eq('uploaded_file_id', file.id)
      .maybeSingle();
    if (existing?.id) return { id: existing.id, kind: 'ede' };
    const snapshotDate = file.created_at.substring(0, 10);
    return createSnapshotForUpload(file.id, 'EDE', null, file.file_label, snapshotDate);
  }
  return null;
}

export async function insertNormalizedRecords(
  batchId: string,
  uploadedFileId: string,
  records: NormalizedRecord[],
  snapshot?: SnapshotRef | null,
) {
  if (records.length === 0) return;
  const rows = records.map(r => ({
    batch_id: batchId,
    uploaded_file_id: uploadedFileId,
    bo_snapshot_id: snapshot?.kind === 'bo' ? snapshot.id : null,
    ede_snapshot_id: snapshot?.kind === 'ede' ? snapshot.id : null,
    source_type: r.source_type,
    source_file_label: r.source_file_label,
    carrier: r.carrier,
    applicant_name: r.applicant_name,
    first_name: r.first_name,
    last_name: r.last_name,
    dob: r.dob,
    member_id: r.member_id,
    policy_number: r.policy_number,
    exchange_subscriber_id: r.exchange_subscriber_id,
    exchange_policy_id: r.exchange_policy_id,
    issuer_policy_id: r.issuer_policy_id,
    issuer_subscriber_id: r.issuer_subscriber_id,
    agent_name: r.agent_name,
    agent_npn: r.agent_npn,
    aor_bucket: r.aor_bucket,
    pay_entity: r.pay_entity,
    status: r.status,
    effective_date: r.effective_date,
    premium: r.premium,
    net_premium: r.net_premium,
    commission_amount: r.commission_amount,
    eligible_for_commission: r.eligible_for_commission,
    policy_term_date: r.policy_term_date ?? null,
    paid_through_date: r.paid_through_date ?? null,
    member_key: r.member_key,
    raw_json: r.raw_json as unknown as Record<string, never>,
  }));

  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await (supabase as any).from('normalized_records').insert(chunk);
    if (error) throw error;
  }
}

/**
 * Returns all CURRENT (non-superseded) normalized records for a batch.
 * This is what reconciliation, timeline, and all existing pages consume.
 */
export async function getNormalizedRecords(batchId: string) {
  const allData: any[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('normalized_records')
      .select('*')
      .eq('batch_id', batchId)
      .is('superseded_at', null)
      .range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    allData.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return allData;
}

/**
 * Returns ALL normalized records for a batch, including superseded rows from
 * prior snapshot uploads. Use this when you need to reason about snapshot
 * history (e.g. "paid-through date as of the Feb 1 BO snapshot vs the Mar 1
 * snapshot"). Not used by existing reconciliation — reserved for the Phase 2
 * classifier.
 */
export async function getNormalizedRecordsAllSnapshots(batchId: string) {
  const allData: any[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('normalized_records')
      .select('*')
      .eq('batch_id', batchId)
      .range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    allData.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return allData;
}

export async function saveReconciledMembers(batchId: string, members: ReconciledMember[]) {
  await supabase.from('reconciled_members').delete().eq('batch_id', batchId);
  await supabase.from('commission_estimates').delete().eq('batch_id', batchId);

  if (members.length === 0) return;

  const rows = members.map(m => ({
    batch_id: batchId,
    member_key: m.member_key,
    carrier: m.carrier,
    applicant_name: m.applicant_name,
    dob: m.dob,
    policy_number: m.policy_number,
    exchange_subscriber_id: m.exchange_subscriber_id,
    exchange_policy_id: m.exchange_policy_id,
    issuer_policy_id: m.issuer_policy_id,
    issuer_subscriber_id: m.issuer_subscriber_id,
    agent_name: m.agent_name,
    agent_npn: m.agent_npn,
    aor_bucket: m.aor_bucket,
    expected_pay_entity: m.expected_pay_entity,
    actual_pay_entity: m.actual_pay_entity,
    in_ede: m.in_ede,
    in_back_office: m.in_back_office,
    in_commission: m.in_commission,
    eligible_for_commission: m.eligible_for_commission,
    premium: m.premium,
    net_premium: m.net_premium,
    actual_commission: m.actual_commission,
    positive_commission: m.positive_commission,
    clawback_amount: m.clawback_amount,
    estimated_missing_commission: m.estimated_missing_commission,
    issue_type: m.issue_type,
    issue_notes: m.issue_notes,
    is_in_expected_ede_universe: m.is_in_expected_ede_universe ?? false,
    expected_ede_effective_month: m.expected_ede_effective_month || null,
  }));

  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await supabase.from('reconciled_members').insert(chunk);
    if (error) throw error;
  }

  const estimates = members
    .filter(m => m.estimated_missing_commission != null)
    .map(m => ({
      batch_id: batchId,
      member_key: m.member_key,
      basis: 'avg_agent_commission',
      estimated_commission: m.estimated_missing_commission!,
    }));
  if (estimates.length > 0) {
    for (let i = 0; i < estimates.length; i += 500) {
      const chunk = estimates.slice(i, i + 500);
      const { error } = await supabase.from('commission_estimates').insert(chunk);
      if (error) throw error;
    }
  }
}

export async function getReconciledMembers(batchId: string) {
  const allData: any[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('reconciled_members')
      .select('*')
      .eq('batch_id', batchId)
      .range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    allData.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return allData;
}

export async function getBatchCounts(batchId: string) {
  const [files, normalized, reconciled] = await Promise.all([
    supabase.from('uploaded_files').select('id', { count: 'exact', head: true }).eq('batch_id', batchId).is('superseded_at', null),
    supabase.from('normalized_records').select('id', { count: 'exact', head: true }).eq('batch_id', batchId).is('superseded_at', null),
    supabase.from('reconciled_members').select('id', { count: 'exact', head: true }).eq('batch_id', batchId),
  ]);
  return {
    uploadedFiles: files.count ?? 0,
    normalizedRecords: normalized.count ?? 0,
    reconciledMembers: reconciled.count ?? 0,
  };
}

export async function saveManualOverride(leftId: string, rightId: string, reason: string) {
  const { error } = await supabase.from('manual_match_overrides').insert({
    left_source_record_id: leftId,
    right_source_record_id: rightId,
    override_reason: reason,
  });
  if (error) throw error;
}

export async function uploadFileToStorage(batchId: string, fileLabel: string, file: File) {
  const path = `${batchId}/${fileLabel.replace(/\s+/g, '_')}_${Date.now()}.csv`;
  const { error } = await supabase.storage.from('commission-files').upload(path, file);
  if (error) throw error;
  return path;
}
