// @ts-nocheck
import { computeFilteredEde } from '../src/lib/expectedEde.ts';
import { getCoveredMonths } from '../src/lib/dateRange.ts';

const URL = process.env.VITE_SUPABASE_URL!;
const KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY!;
const JAN = '82d37413-231f-4ef2-a333-7d1f8e70221b';

async function fetchAll(table: string, where: string) {
  let all: any[] = [];
  let from = 0;
  const SIZE = 1000;
  while (true) {
    const res = await fetch(`${URL}/rest/v1/${table}?select=*&${where}`, {
      headers: {
        apikey: KEY, Authorization: `Bearer ${KEY}`,
        Range: `${from}-${from + SIZE - 1}`, 'Range-Unit': 'items', Prefer: 'count=exact',
      },
    });
    const data = await res.json();
    all = all.concat(data || []);
    if (!data || data.length < SIZE) break;
    from += SIZE;
  }
  return all;
}

const recs = await fetchAll('normalized_records', `batch_id=eq.${JAN}&staging_status=eq.active&superseded_at=is.null`);
const reconciled = await fetchAll('reconciled_members', `batch_id=eq.${JAN}`);
console.log('records:', recs.length, 'reconciled:', reconciled.length);
const cm = getCoveredMonths('2026-01-01');
console.log('covered months:', cm);

const fe = computeFilteredEde(recs, reconciled, 'All', cm, null);
console.log('EE All:', fe.uniqueKeys);

const eeUniverse = new Set(fe.uniqueMembers.map(m => m.member_key));

// BO Only = !inEde(EE universe) && in_bo_active && eligible='Yes'
const boOnly = reconciled.filter(r =>
  !eeUniverse.has(r.member_key) && r.in_back_office && r.eligible_for_commission === 'Yes'
);
console.log('BO Only total:', boOnly.length);

// Bucket A: raw r.in_ede=false (true BO only)
// Bucket B: raw r.in_ede=true (BO active w/ stale-EDE evidence)
const bucketA = boOnly.filter(r => !r.in_ede);
const bucketB = boOnly.filter(r => r.in_ede);
console.log('Bucket A (true BO only, in_ede=false):', bucketA.length);
console.log('Bucket B (BO active + raw in_ede=true):', bucketB.length);
console.log('  paid A:', bucketA.filter(r=>r.in_commission).length, ' unpaid A:', bucketA.filter(r=>!r.in_commission).length);
console.log('  paid B:', bucketB.filter(r=>r.in_commission).length, ' unpaid B:', bucketB.filter(r=>!r.in_commission).length);

// Why did Bucket B fail filteredEde.uniqueMembers? Look at their raw EDE rows.
// Index EDE rows by candidate keys for lookup against reconciled member.
const edeByMemberKey = new Map<string, any[]>();
const edeByIssub = new Map<string, any[]>();
const edeByExsub = new Map<string, any[]>();
const edeByPolicy = new Map<string, any[]>();
const edeByName = new Map<string, any[]>();
function norm(n: string) { return (n || '').trim().toLowerCase().replace(/[^a-z]/g, ''); }
const QUALIFIED = new Set(['effectuated', 'pendingeffectuation', 'pendingtermination']);
const sortedCovered = cm.slice().sort();
const earliestCovered = sortedCovered[0];
const latestCovered = sortedCovered[sortedCovered.length - 1];

for (const r of recs) {
  if (r.source_type !== 'EDE') continue;
  if (r.member_key) {
    const a = edeByMemberKey.get(r.member_key) || []; a.push(r); edeByMemberKey.set(r.member_key, a);
  }
  if (r.issuer_subscriber_id) {
    const a = edeByIssub.get(r.issuer_subscriber_id) || []; a.push(r); edeByIssub.set(r.issuer_subscriber_id, a);
  }
  if (r.exchange_subscriber_id) {
    const a = edeByExsub.get(r.exchange_subscriber_id) || []; a.push(r); edeByExsub.set(r.exchange_subscriber_id, a);
  }
  if (r.policy_number) {
    const a = edeByPolicy.get(r.policy_number) || []; a.push(r); edeByPolicy.set(r.policy_number, a);
  }
  const nk = norm(r.applicant_name);
  if (nk) { const a = edeByName.get(nk) || []; a.push(r); edeByName.set(nk, a); }
}

function findEdeRowsForMember(m: any): any[] {
  const out = new Map<string, any>();
  const add = (rows: any[] | undefined) => { if (rows) for (const r of rows) out.set(r.id, r); };
  add(edeByMemberKey.get(m.member_key));
  if (m.issuer_subscriber_id) add(edeByIssub.get(m.issuer_subscriber_id));
  if (m.exchange_subscriber_id) add(edeByExsub.get(m.exchange_subscriber_id));
  if (m.policy_number) add(edeByPolicy.get(m.policy_number));
  if (m.applicant_name) add(edeByName.get(norm(m.applicant_name)));
  return Array.from(out.values());
}

const reasons: Record<string, number> = {
  'no_qualified_status': 0,
  'effective_after_covered': 0,
  'terminated_before_covered': 0,
  'aor_not_in_scope': 0,
  'no_effective_date': 0,
  'issuer_not_ambetter': 0,
  'no_ede_rows_found': 0,
  'qualified_but_filtered_unknown': 0,
};

const aorTallyB: Record<string, number> = {};
const aorTallyA: Record<string, number> = {};

for (const m of bucketB) {
  const edeRows = findEdeRowsForMember(m);
  if (edeRows.length === 0) { reasons.no_ede_rows_found++; continue; }
  // Check if ANY row qualified individually for the EE filter (status / dates / issuer)
  let anyStatusOk = false, anyEffOk = false, anyTermOk = false, anyAorOk = false, anyIssuerOk = false;
  for (const r of edeRows) {
    const raw = r.raw_json || {};
    const issuer = String(raw.issuer ?? r.carrier ?? '').toLowerCase();
    const issuerOk = issuer.includes('ambetter');
    if (issuerOk) anyIssuerOk = true;
    const status = String(raw.policyStatus ?? r.status ?? '').toLowerCase().replace(/\s+/g,'');
    const statusOk = QUALIFIED.has(status);
    if (statusOk) anyStatusOk = true;
    const effDate = r.effective_date;
    if (!effDate) continue;
    const effMonth = String(effDate).substring(0,7);
    const termRaw = String(raw.policyTermDate ?? raw.policy_term_date ?? r.policy_term_date ?? '').trim();
    const termMonth = termRaw ? termRaw.substring(0,7) : '';
    const effOk = effMonth <= latestCovered;
    const termOk = !termMonth || termMonth > earliestCovered;
    if (effOk) anyEffOk = true;
    if (termOk) anyTermOk = true;
    const rawAor = String(raw.currentPolicyAOR ?? '').trim();
    if (rawAor) anyAorOk = true; // we'll check scope separately
  }
  if (!anyIssuerOk) reasons.issuer_not_ambetter++;
  else if (!anyStatusOk) reasons.no_qualified_status++;
  else if (!anyEffOk) reasons.effective_after_covered++;
  else if (!anyTermOk) reasons.terminated_before_covered++;
  else if (!anyAorOk) reasons.aor_not_in_scope++;
  else reasons.qualified_but_filtered_unknown++;

  const a = m.aor_bucket || m.current_policy_aor || '(none)';
  aorTallyB[a] = (aorTallyB[a] || 0) + 1;
}

for (const m of bucketA) {
  const a = m.aor_bucket || m.current_policy_aor || '(none)';
  aorTallyA[a] = (aorTallyA[a] || 0) + 1;
}

console.log('\nBucket B failure reasons:');
console.log(reasons);

const topA = Object.entries(aorTallyA).sort((a,b)=>b[1]-a[1]).slice(0,10);
const topB = Object.entries(aorTallyB).sort((a,b)=>b[1]-a[1]).slice(0,10);
console.log('\nTop AOR bucket A:'); for (const [k,v] of topA) console.log(`  ${v}\t${k}`);
console.log('\nTop AOR bucket B:'); for (const [k,v] of topB) console.log(`  ${v}\t${k}`);

console.log('\n10 sample rows from Bucket B:');
for (const m of bucketB.slice(0,10)) {
  const edeRows = findEdeRowsForMember(m);
  const ede = edeRows[0];
  const status = ede ? (ede.raw_json?.policyStatus ?? ede.status) : '';
  const effDate = ede ? ede.effective_date : '';
  console.log(`  ${m.applicant_name}\tpolicy=${m.policy_number}\tEDE.status=${status}\tEDE.eff=${effDate}\tBO.elig=${m.eligible_for_commission}\tAOR=${m.aor_bucket}\tpaid=${m.in_commission}`);
}

console.log('\n10 sample rows from Bucket A:');
for (const m of bucketA.slice(0,10)) {
  console.log(`  ${m.applicant_name}\tpolicy=${m.policy_number}\tBO.elig=${m.eligible_for_commission}\tAOR=${m.aor_bucket}\tpaid=${m.in_commission}`);
}

const EE = fe.uniqueKeys;
console.log('\n=== Should Be Paid interpretations ===');
console.log(`A. Current (EE + all BO Only):     ${EE} + ${boOnly.length} = ${EE + boOnly.length}`);
console.log(`B. Strict true-BO-only:            ${EE} + ${bucketA.length} = ${EE + bucketA.length}`);
console.log(`C. Split (EE + true BO only, B as diagnostic): ${EE} + ${bucketA.length} = ${EE + bucketA.length}  (+ ${bucketB.length} diagnostic)`);
