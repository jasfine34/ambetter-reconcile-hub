// @ts-nocheck
import { computeFilteredEde } from '../src/lib/expectedEde.ts';
import { getCoveredMonths } from '../src/lib/dateRange.ts';
import { getEligibleCohort } from '../src/lib/canonical/metrics.ts';

const URL = process.env.VITE_SUPABASE_URL!;
const KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY!;
const FEB = '1569468f-8962-41c7-bd05-10bc509fa31b';

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

const recs = await fetchAll('normalized_records', `batch_id=eq.${FEB}`);
const reconciled = await fetchAll('reconciled_members', `batch_id=eq.${FEB}`);
console.log('records:', recs.length, 'reconciled:', reconciled.length);
const cm = getCoveredMonths('2026-02-01');
console.log('covered months:', cm);
const fe = computeFilteredEde(recs, reconciled, 'Coverall', cm, null);
console.log('filteredEde Coverall uniqueKeys:', fe.uniqueKeys, 'inBO:', fe.inBOCount);
const eligible = getEligibleCohort(reconciled, 'Coverall', new Set(), fe);
console.log('eligible Coverall:', eligible.length);
console.log('missing-commission Coverall:', eligible.filter(r => !r.in_commission).length);

const feAll = computeFilteredEde(recs, reconciled, 'All', cm, null);
const elAll = getEligibleCohort(reconciled, 'All', new Set(), feAll);
console.log('eligible All:', elAll.length);
console.log('missing-commission All:', elAll.filter(r => !r.in_commission).length);

const feVix = computeFilteredEde(recs, reconciled, 'Vix', cm, null);
const elVix = getEligibleCohort(reconciled, 'Vix', new Set(), feVix);
console.log('eligible Vix:', elVix.length);
console.log('missing-commission Vix:', elVix.filter(r => !r.in_commission).length);
