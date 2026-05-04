import { createClient } from '@supabase/supabase-js';
import { computeFilteredEde } from '/dev-server/src/lib/expectedEde.ts';
import { getCoveredMonths } from '/dev-server/src/lib/dateRange.ts';
import { getEligibleCohort } from '/dev-server/src/lib/canonical/metrics.ts';

const url = process.env.VITE_SUPABASE_URL!;
const key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY!;
const sb = createClient(url, key);

const FEB = '1569468f-8962-41c7-bd05-10bc509fa31b';
async function fetchAll(table: string, q: any) {
  let all: any[] = [];
  let from = 0;
  const SIZE = 1000;
  while (true) {
    const { data, error } = await q.range(from, from + SIZE - 1);
    if (error) throw error;
    all = all.concat(data || []);
    if (!data || data.length < SIZE) break;
    from += SIZE;
  }
  return all;
}

const recs = await fetchAll('normalized_records', sb.from('normalized_records').select('*').eq('batch_id', FEB));
const reconciled = await fetchAll('reconciled_members', sb.from('reconciled_members').select('*').eq('batch_id', FEB));
console.log('records:', recs.length, 'reconciled:', reconciled.length);
const cm = getCoveredMonths('2026-02-01');
console.log('covered months:', cm);
const fe = computeFilteredEde(recs, reconciled, 'Coverall', cm, null);
console.log('filteredEde uniqueKeys:', fe.uniqueKeys, 'inBO:', fe.inBOCount);
const eligible = getEligibleCohort(reconciled, 'Coverall', new Set(), fe);
console.log('eligible cohort (Coverall):', eligible.length);
const missing = eligible.filter(r => !r.in_commission);
console.log('missing-commission (Coverall):', missing.length);

const feAll = computeFilteredEde(recs, reconciled, 'All', cm, null);
const eligibleAll = getEligibleCohort(reconciled, 'All', new Set(), feAll);
console.log('All-scope missing:', eligibleAll.filter(r => !r.in_commission).length);
