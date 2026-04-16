import { supabase } from '@/integrations/supabase/client';
import type { NormalizedRecord } from './normalize';
import type { ReconciledMember } from './reconcile';

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
    .eq('batch_id', batchId);
  if (error) throw error;
  return data;
}

export async function uploadFileRecord(
  batchId: string, fileLabel: string, fileName: string,
  sourceType: string, payEntity: string | null, aorBucket: string | null, storagePath: string
) {
  await supabase.from('normalized_records').delete().eq('batch_id', batchId).eq('source_file_label', fileLabel);
  await supabase.from('uploaded_files').delete().eq('batch_id', batchId).eq('file_label', fileLabel);

  const { data, error } = await supabase
    .from('uploaded_files')
    .insert({ batch_id: batchId, file_label: fileLabel, file_name: fileName, source_type: sourceType, pay_entity: payEntity, aor_bucket: aorBucket, storage_path: storagePath })
    .select().single();
  if (error) throw error;
  return data;
}

export async function insertNormalizedRecords(batchId: string, uploadedFileId: string, records: NormalizedRecord[]) {
  if (records.length === 0) return;
  const rows = records.map(r => ({
    batch_id: batchId,
    uploaded_file_id: uploadedFileId,
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
    member_key: r.member_key,
    raw_json: r.raw_json as unknown as Record<string, never>,
  }));

  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await supabase.from('normalized_records').insert(chunk);
    if (error) throw error;
  }
}

export async function getNormalizedRecords(batchId: string) {
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
    supabase.from('uploaded_files').select('id', { count: 'exact', head: true }).eq('batch_id', batchId),
    supabase.from('normalized_records').select('id', { count: 'exact', head: true }).eq('batch_id', batchId),
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
