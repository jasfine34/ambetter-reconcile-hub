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

/**
 * Unwrap a PostgrestError (or any thrown value) to a human-readable string.
 * PostgrestError is NOT `instanceof Error`, so `String(err)` collapses to
 * "[object Object]". We pull message/details/hint/code so the message we
 * surface to the user/toast actually carries Postgres diagnostic text.
 *
 * Mirrors `extractErrorMessage` in src/lib/rebuild.ts; duplicated here so
 * persistence.ts has no dependency on rebuild.ts (which imports from us).
 */
export function unwrapPgError(err: unknown): string {
  if (err == null) return 'unknown error';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message || err.toString();
  const anyErr = err as any;
  const parts: string[] = [];
  if (anyErr.message) parts.push(String(anyErr.message));
  if (anyErr.details && anyErr.details !== anyErr.message) parts.push(`details: ${anyErr.details}`);
  if (anyErr.hint) parts.push(`hint: ${anyErr.hint}`);
  if (anyErr.code) parts.push(`code: ${anyErr.code}`);
  if (parts.length > 0) return parts.join(' | ');
  try {
    const json = JSON.stringify(err);
    if (json && json !== '{}') return json;
  } catch {
    /* fallthrough */
  }
  return String(err);
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

/**
 * Check whether a batch already exists for the given (statement_month, carrier)
 * combination. Used to warn before creating duplicates. Ambetter is the default
 * carrier since that's what `createBatch` inserts.
 */
export async function findExistingBatches(statementMonth: string, carrier: string = 'Ambetter') {
  const { data, error } = await supabase
    .from('upload_batches')
    .select('*')
    .eq('statement_month', statementMonth)
    .eq('carrier', carrier);
  if (error) throw error;
  return data ?? [];
}

/**
 * Permanently delete a batch and all its cascade data (uploaded_files,
 * normalized_records, reconciled_members, commission_estimates, and
 * snapshot rows all have ON DELETE CASCADE → removing a batch cleans them
 * up automatically). Storage objects are left alone since they're shared
 * across potential re-uploads; callers can prune `commission-files`
 * manually if disk pressure matters.
 */
export async function deleteBatch(batchId: string) {
  const { error } = await supabase
    .from('upload_batches')
    .delete()
    .eq('id', batchId);
  if (error) throw error;
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

  // Mark prior rows as superseded instead of deleting them. Each supersede
  // MUST capture {error} and throw before we proceed to the INSERT below —
  // otherwise a silent supersede failure (RLS, timeout, network blip) would
  // leave the prior current rows live AND the new ones would land on top,
  // producing duplicate-current data with a success toast (Codex Finding 1).
  const { error: normSupersedeError } = await supabase
    .from('normalized_records')
    .update({ superseded_at: now })
    .eq('batch_id', batchId)
    .eq('source_file_label', fileLabel)
    .is('superseded_at', null);
  if (normSupersedeError) {
    throw new Error(
      `Failed to supersede prior normalized_records for ${fileLabel}: ${unwrapPgError(normSupersedeError)}`,
    );
  }

  const { error: fileSupersedeError } = await supabase
    .from('uploaded_files')
    .update({ superseded_at: now })
    .eq('batch_id', batchId)
    .eq('file_label', fileLabel)
    .is('superseded_at', null);
  if (fileSupersedeError) {
    throw new Error(
      `Failed to supersede prior uploaded_files row for ${fileLabel}: ${unwrapPgError(fileSupersedeError)}`,
    );
  }

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
    // Phase 1b typed columns — null/empty when the source file doesn't carry
    // the signal. The adapters decide which ones they populate.
    broker_effective_date: r.broker_effective_date ?? null,
    broker_term_date: r.broker_term_date ?? null,
    member_responsibility: r.member_responsibility ?? null,
    on_off_exchange: r.on_off_exchange || null,
    auto_renewal: r.auto_renewal ?? null,
    ede_policy_origin_type: r.ede_policy_origin_type || null,
    ede_bucket: r.ede_bucket || null,
    policy_modified_date: r.policy_modified_date ?? null,
    client_address_1: r.client_address_1 || null,
    client_address_2: r.client_address_2 || null,
    client_city: r.client_city || null,
    client_state_full: r.client_state_full || null,
    client_zip: r.client_zip || null,
    paid_to_date: r.paid_to_date ?? null,
    months_paid: r.months_paid ?? null,
    writing_agent_carrier_id: r.writing_agent_carrier_id || null,
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
    // ORDER BY id is REQUIRED for stable pagination — without it Supabase/PG
    // may return overlapping or missing rows across .range() calls, which
    // silently inflates or deflates totals downstream.
    const { data, error } = await supabase
      .from('normalized_records')
      .select('*')
      .eq('batch_id', batchId)
      .is('superseded_at', null)
      .order('id', { ascending: true })
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
 * Returns CURRENT (non-superseded) normalized records across every batch.
 * Powers the Member Timeline's cross-batch scope, where the user wants to see
 * a member's full history (e.g. Jan batch's Jan service + Feb batch's
 * retroactive Jan catch-up together) rather than inspecting batches one at
 * a time. Paged to keep the Supabase query size manageable.
 */
export async function getAllNormalizedRecords() {
  const allData: any[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    // ORDER BY id is REQUIRED for stable pagination — see getNormalizedRecords.
    const { data, error } = await supabase
      .from('normalized_records')
      .select('*')
      .is('superseded_at', null)
      .order('id', { ascending: true })
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
      .order('id', { ascending: true })
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
 * Chunked DELETE helpers.
 *
 * Background: a single PostgREST `DELETE WHERE batch_id = X` against a large
 * batch (e.g. Feb 2026 with ~7.3k normalized_records) exceeded the Supabase
 * statement_timeout and crashed the rebuild. We now select the target ids in
 * pages and issue per-chunk `DELETE WHERE id IN (...)` statements. Chunk size
 * 500 keeps each statement comfortably under the API timeout while minimizing
 * round-trips. Used by rebuildBatch() and saveReconciledMembers().
 */
const DELETE_CHUNK_SIZE = 500;

async function chunkedDeleteByIds(table: string, ids: string[]) {
  for (let i = 0; i < ids.length; i += DELETE_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + DELETE_CHUNK_SIZE);
    const { error } = await (supabase as any).from(table).delete().in('id', chunk);
    if (error) throw error;
  }
}

async function fetchAllIds(
  table: string,
  filter: (q: any) => any,
): Promise<string[]> {
  const ids: string[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    let q = (supabase as any).from(table).select('id').order('id', { ascending: true }).range(from, from + pageSize - 1);
    q = filter(q);
    const { data, error } = await q;
    if (error) throw error;
    if (!data || data.length === 0) break;
    ids.push(...data.map((r: any) => r.id));
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return ids;
}

export async function deleteReconciledForBatch(batchId: string) {
  const ids = await fetchAllIds('reconciled_members', (q) => q.eq('batch_id', batchId));
  await chunkedDeleteByIds('reconciled_members', ids);
}

/**
 * Returns the number of reconciled_members rows currently stored for the given
 * batch. Used by the rebuild orchestrator's silent-failure assertion: if a
 * batch has normalized records but 0 reconciled members after a save, that
 * almost always means a transient Supabase write failure and we retry.
 */
export async function countReconciledForBatch(batchId: string): Promise<number> {
  const { count, error } = await supabase
    .from('reconciled_members')
    .select('id', { count: 'exact', head: true })
    .eq('batch_id', batchId);
  if (error) throw error;
  return count ?? 0;
}

/**
 * Returns the number of CURRENT (non-superseded) normalized_records rows for
 * the given batch. Pairs with countReconciledForBatch() to detect the
 * "0 reconciled despite N normalized" failure mode.
 */
export async function countCurrentNormalizedForBatch(batchId: string): Promise<number> {
  const { count, error } = await supabase
    .from('normalized_records')
    .select('id', { count: 'exact', head: true })
    .eq('batch_id', batchId)
    .is('superseded_at', null);
  if (error) throw error;
  return count ?? 0;
}

export async function deleteCommissionEstimatesForBatch(batchId: string) {
  const ids = await fetchAllIds('commission_estimates', (q) => q.eq('batch_id', batchId));
  await chunkedDeleteByIds('commission_estimates', ids);
}

/**
 * Counts commission_estimates rows for a batch — pairs with the
 * delete-then-verify discipline in rebuild.ts (see ARCHITECTURE_PLAN.md
 * § Rebuild Discipline).
 */
export async function countCommissionEstimatesForBatch(batchId: string): Promise<number> {
  const { count, error } = await supabase
    .from('commission_estimates')
    .select('id', { count: 'exact', head: true })
    .eq('batch_id', batchId);
  if (error) throw error;
  return count ?? 0;
}

export async function deleteCurrentNormalizedForBatch(batchId: string) {
  const ids = await fetchAllIds('normalized_records', (q) =>
    q.eq('batch_id', batchId).is('superseded_at', null),
  );
  await chunkedDeleteByIds('normalized_records', ids);
}

export async function saveReconciledMembers(batchId: string, members: ReconciledMember[]) {
  const rows = members.map(m => ({
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
    current_policy_aor: m.current_policy_aor || null,
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

  const estimates = members
    .filter(m => m.estimated_missing_commission != null)
    .map(m => ({
      member_key: m.member_key,
      basis: 'avg_agent_commission',
      estimated_commission: m.estimated_missing_commission!,
    }));

  // Atomic replace: the backend function runs DELETE + INSERT in one database
  // transaction, so a timeout/error rolls back to the prior reconciled state
  // instead of leaving the batch with 0 rows.
  const { error } = await (supabase as any).rpc('replace_reconciled_members_for_batch', {
    _batch_id: batchId,
    _members: rows,
    _estimates: estimates,
  });
  if (error) throw error;
}

/**
 * Canonical "save reconciled members + verify they actually landed + (optionally)
 * stamp the rebuild logic version" predicate.
 *
 * Why this exists (Codex Finding 2): three call sites — rebuildBatch (rebuild.ts),
 * the upload pipeline (UploadPage.tsx), and the dashboard's manual Re-run
 * Reconciliation button (DashboardPage.tsx) — all answer the same domain
 * question: "did my members actually persist?" Previously only rebuildBatch
 * verified the row count post-save; the other two trusted that
 * saveReconciledMembers() not throwing meant success. That's the same
 * silent-zero-write class of bug as #74. Routing all three through this
 * helper guarantees identical guard behavior.
 *
 * Returns the verified row count (and the stamped version when requested) so
 * callers can include it in success toasts.
 */
export async function saveAndVerifyReconciled(
  batchId: string,
  members: ReconciledMember[],
  opts: { stampLogicVersion?: boolean; logicVersion?: string } = {},
): Promise<{ rowCount: number; version?: string }> {
  await saveReconciledMembers(batchId, members);

  const rowCount = await countReconciledForBatch(batchId);
  if (rowCount === 0 && members.length > 0) {
    throw new Error(
      `Save verification failed for batch ${batchId}: expected ${members.length} reconciled ` +
        `members but found 0 rows after replace_reconciled_members_for_batch. ` +
        `Treating as a silent write failure — refusing to report success.`,
    );
  }

  let version: string | undefined;
  if (opts.stampLogicVersion) {
    if (!opts.logicVersion) {
      throw new Error('saveAndVerifyReconciled: stampLogicVersion=true requires logicVersion');
    }
    const { error } = await supabase
      .from('upload_batches')
      .update({
        last_full_rebuild_at: new Date().toISOString(),
        last_rebuild_logic_version: opts.logicVersion,
      })
      .eq('id', batchId);
    if (error) {
      throw new Error(
        `Failed to stamp last_rebuild_logic_version for batch ${batchId}: ${unwrapPgError(error)}`,
      );
    }
    version = opts.logicVersion;
  }

  return { rowCount, version };
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

/**
 * Server-paginated reconciled_members query for the All Records page.
 * Avoids loading all ~3,890 rows upfront — DB applies range, search, sort.
 *
 * `search` is matched case-insensitively across the same columns the old
 * client-side DataTable searched: name, policy #, sub IDs, agent name, NPN.
 * Empty search returns the unfiltered window.
 *
 * Returns the page rows + the total filtered count so the UI can render
 * "Page X of Y" pagination identically to the old client-side experience.
 */
export async function getReconciledMembersPage(
  batchId: string,
  opts: {
    page: number;        // 0-indexed
    pageSize: number;
    search?: string;
    sortKey?: string;
    sortDir?: 'asc' | 'desc';
  },
): Promise<{ rows: any[]; total: number }> {
  const { page, pageSize, search, sortKey, sortDir } = opts;
  const from = page * pageSize;
  const to = from + pageSize - 1;

  const buildBase = () => {
    let q: any = supabase.from('reconciled_members').select('*', { count: 'exact' }).eq('batch_id', batchId);
    if (search && search.trim()) {
      // Escape commas/parens in user input — PostgREST treats them as
      // separators inside .or(). A plain replace is sufficient here because
      // we only allow ilike patterns; any user-supplied % is treated as a
      // wildcard, which is the historical client-side behavior too.
      const safe = search.trim().replace(/([,()])/g, '');
      const pattern = `%${safe}%`;
      q = q.or([
        `applicant_name.ilike.${pattern}`,
        `policy_number.ilike.${pattern}`,
        `exchange_subscriber_id.ilike.${pattern}`,
        `issuer_subscriber_id.ilike.${pattern}`,
        `exchange_policy_id.ilike.${pattern}`,
        `issuer_policy_id.ilike.${pattern}`,
        `agent_name.ilike.${pattern}`,
        `agent_npn.ilike.${pattern}`,
      ].join(','));
    }
    // Stable sort: user-chosen column first, then id as a tiebreaker so
    // pagination is deterministic even when the sort column has ties.
    if (sortKey) {
      q = q.order(sortKey, { ascending: sortDir !== 'desc', nullsFirst: false });
      q = q.order('id', { ascending: true });
    } else {
      q = q.order('id', { ascending: true });
    }
    return q.range(from, to);
  };

  const { data, error, count } = await buildBase();
  if (error) throw error;
  return { rows: data ?? [], total: count ?? 0 };
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
