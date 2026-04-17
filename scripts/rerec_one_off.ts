import { createClient } from '@supabase/supabase-js';
import { reconcile } from '/dev-server/src/lib/reconcile';

const url = process.env.SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabase = createClient(url, key);
const BATCH = '82d37413-231f-4ef2-a333-7d1f8e70221b';

async function getAll(table: string) {
  const out: any[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase.from(table).select('*').eq('batch_id', BATCH).range(from, from+999);
    if (error) throw error;
    if (!data?.length) break;
    out.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return out;
}

(async () => {
  const recs = await getAll('normalized_records');
  console.log('normalized_records:', recs.length);
  const { members, debug } = reconcile(recs as any[]);
  console.log('reconciled members:', members.length);
  const veronicas = members.filter(m => (m.applicant_name||'').toLowerCase().includes('veronica') && (m.applicant_name||'').toLowerCase().includes('rios'));
  console.log('Veronica Rios members:', JSON.stringify(veronicas.map(m => ({
    name: m.applicant_name, key: m.member_key, esid: m.exchange_subscriber_id, isid: m.issuer_subscriber_id,
    in_ede: m.in_ede, in_bo: m.in_back_office, in_universe: m.is_in_expected_ede_universe,
    issue: m.issue_type, notes: m.issue_notes,
  })), null, 2));

  await supabase.from('reconciled_members').delete().eq('batch_id', BATCH);
  await supabase.from('commission_estimates').delete().eq('batch_id', BATCH);
  const rows = members.map(m => ({
    batch_id: BATCH, member_key: m.member_key, carrier: m.carrier, applicant_name: m.applicant_name,
    dob: m.dob, policy_number: m.policy_number, exchange_subscriber_id: m.exchange_subscriber_id,
    exchange_policy_id: m.exchange_policy_id, issuer_policy_id: m.issuer_policy_id,
    issuer_subscriber_id: m.issuer_subscriber_id, agent_name: m.agent_name, agent_npn: m.agent_npn,
    aor_bucket: m.aor_bucket, expected_pay_entity: m.expected_pay_entity, actual_pay_entity: m.actual_pay_entity,
    in_ede: m.in_ede, in_back_office: m.in_back_office, in_commission: m.in_commission,
    eligible_for_commission: m.eligible_for_commission, premium: m.premium, net_premium: m.net_premium,
    actual_commission: m.actual_commission, positive_commission: m.positive_commission,
    clawback_amount: m.clawback_amount, estimated_missing_commission: m.estimated_missing_commission,
    issue_type: m.issue_type, issue_notes: m.issue_notes,
    is_in_expected_ede_universe: m.is_in_expected_ede_universe ?? false,
    expected_ede_effective_month: m.expected_ede_effective_month || null,
  }));
  for (let i=0;i<rows.length;i+=500) {
    const chunk = rows.slice(i,i+500);
    const { error } = await supabase.from('reconciled_members').insert(chunk);
    if (error) throw error;
  }
  const estimates = members.filter(m => m.estimated_missing_commission != null).map(m => ({
    batch_id: BATCH, member_key: m.member_key, basis: 'avg_agent_commission',
    estimated_commission: m.estimated_missing_commission!,
  }));
  for (let i=0;i<estimates.length;i+=500) {
    const chunk = estimates.slice(i,i+500);
    const { error } = await supabase.from('commission_estimates').insert(chunk); if (error) throw error;
  }
  await supabase.from('upload_batches').update({
    last_full_rebuild_at: new Date().toISOString(),
    last_rebuild_logic_version: '2026.04.17-poison-id-isolation-v2',
  }).eq('id', BATCH);
  console.log('Saved. Estimates:', estimates.length);
})().catch(e => { console.error(e); process.exit(1); });
