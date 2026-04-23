import { createClient } from '@supabase/supabase-js';
import { assignMergedMemberKeys } from '../src/lib/memberMerge';
import { buildMonthList } from '../src/lib/memberTimeline';
import { buildClassifierContext, classifyMember, commissionServiceMonths } from '../src/lib/classifier';
import { isCoverallAORByName } from '../src/lib/agents';

const SUPABASE_URL = 'https://sbbsfbzxixcmaoliixae.supabase.co';
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNiYnNmYnp4aXhjbWFvbGlpeGFlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyMDM2NjUsImV4cCI6MjA5MTc3OTY2NX0.bXVHqrrVqBGCUYEXRBYKifDJ-3JhKstT5M5n5ZRFowM';
const supabase = createClient(SUPABASE_URL, ANON);

function isDueEligible(r: any, payEntity = 'Coverall'): boolean {
  const isCommission = r.source_type === 'COMMISSION';
  if (!isCommission) {
    const aorMatch =
      isCoverallAORByName(r.aor_bucket) ||
      isCoverallAORByName(r.raw_json?.['currentPolicyAOR']) ||
      isCoverallAORByName(r.raw_json?.['Broker Name'] ?? r.raw_json?.['broker_name']);
    if (!aorMatch) return false;
  }
  if (payEntity !== 'All' && isCommission) {
    if (String(r.pay_entity || '').trim() !== payEntity) return false;
  }
  return true;
}

(async () => {
  const all: any[] = [];
  let from = 0;
  while (true) {
    const { data } = await supabase.from('normalized_records').select('*').is('superseded_at', null).order('id').range(from, from + 999);
    if (!data?.length) break;
    all.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  assignMergedMemberKeys(all as any);
  const amanda = all.filter(r => r.applicant_name?.toLowerCase().includes('amanda richardson'));
  console.log('Amanda all records:', amanda.length);
  for (const r of amanda) {
    console.log(`  ${r.source_type} pe=${r.pay_entity||''} npn=${r.agent_npn||''} ptd=${r.paid_to_date||''} amt=${r.commission_amount||''} eligible=${isDueEligible(r)}`);
  }
  const eligible = amanda.filter(isDueEligible);
  console.log('\nClassifier-eligible records:', eligible.length);
  const ctx = buildClassifierContext(eligible as any, ['2026-01'], []);
  console.log('Statement months:', [...ctx.commissionStatementMonths]);
  const cls = classifyMember(eligible as any, ctx);
  console.log('First eligible month:', cls.first_eligible_month);
  for (const [m, c] of Object.entries(cls.cells)) {
    console.log(`  ${m}: state=${c.state} paid_amount=${c.paid_amount} reason="${c.reason}"`);
  }
  // Per-record commission service months
  console.log('\nPer-commission record service months:');
  for (const r of eligible.filter(r => r.source_type === 'COMMISSION')) {
    console.log('  ', commissionServiceMonths(r));
  }
})().catch(e => { console.error(e); process.exit(1); });
