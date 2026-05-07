// @ts-nocheck
import { computeFilteredEde } from '../src/lib/expectedEde.ts';
import { getCoveredMonths } from '../src/lib/dateRange.ts';
import { reconcile } from '../src/lib/reconcile.ts';
import { getTotalCoveredLives, getMonthlyBreakdown } from '../src/lib/canonical/metrics.ts';

const URL = process.env.VITE_SUPABASE_URL!;
const KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY!;

const BATCHES = [
  { label: 'Jan 2026', id: '82d37413-231f-4ef2-a333-7d1f8e70221b', month: '2026-01-01' },
  { label: 'Feb 2026', id: '1569468f-8962-41c7-bd05-10bc509fa31b', month: '2026-02-01' },
  { label: 'Mar 2026', id: 'c275417a-7275-4b35-9027-d8d0049b89f4', month: '2026-03-01' },
  { label: 'Apr 2026', id: '652750c4-ec2f-4a48-b7fa-16bd4d29bd09', month: '2026-04-01' },
];

async function fetchAll(table: string, where: string) {
  let all: any[] = [];
  let from = 0;
  const SIZE = 1000;
  while (true) {
    const res = await fetch(`${URL}/rest/v1/${table}?select=*&${where}`, {
      headers: {
        apikey: KEY, Authorization: `Bearer ${KEY}`,
        Range: `${from}-${from + SIZE - 1}`, 'Range-Unit': 'items',
      },
    });
    const data = await res.json();
    all = all.concat(data || []);
    if (!data || data.length < SIZE) break;
    from += SIZE;
  }
  return all;
}

const fmtMonths = (m: Record<string, number>) =>
  Object.keys(m).sort().map(k => `${k}=${m[k]}`).join(' ');

console.log('batch | scope | OLD total | NEW total | delta | OLD by-month | NEW by-month | verdict');
console.log('---');

for (const b of BATCHES) {
  const recs = await fetchAll('normalized_records', `batch_id=eq.${b.id}&staging_status=eq.active&superseded_at=is.null`);
  const reconciled = await fetchAll('reconciled_members', `batch_id=eq.${b.id}`);
  const cm = getCoveredMonths(b.month);

  // Old: debugStats from reconcile() — whole-batch, scope-agnostic
  const { debug } = reconcile(recs as any, b.month, null);
  const oldTotal = debug.totalCoveredLives;
  const oldByMonth = debug.totalCoveredLivesByMonth;

  for (const scope of ['Coverall', 'Vix', 'All'] as const) {
    const fe = computeFilteredEde(recs, reconciled, scope, cm, null);
    const newTotal = getTotalCoveredLives(fe);
    const newByMonth = getMonthlyBreakdown('totalCoveredLives', fe);
    const delta = newTotal - oldTotal;
    const verdict = delta === 0 ? 'equal' : Math.abs(delta) <= 5 ? 'near-equal' : 'different';
    console.log(
      `${b.label} | ${scope} | ${oldTotal} | ${newTotal} | ${delta >= 0 ? '+' : ''}${delta} | ${fmtMonths(oldByMonth)} | ${fmtMonths(newByMonth)} | ${verdict}`
    );
  }
}
