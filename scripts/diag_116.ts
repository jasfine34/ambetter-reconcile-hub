// @ts-nocheck
// READ-ONLY: re-run reconcile against persisted Feb normalized_records and
// compare in_back_office assignment to what's persisted in reconciled_members.
import { createClient } from '@supabase/supabase-js';
import { reconcile } from '../src/lib/reconcile';
import { loadResolverIndex } from '../src/lib/resolvedIdentities';

const URL = 'https://sbbsfbzxixcmaoliixae.supabase.co';
const KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNiYnNmYnp4aXhjbWFvbGlpeGFlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyMDM2NjUsImV4cCI6MjA5MTc3OTY2NX0.bXVHqrrVqBGCUYEXRBYKifDJ-3JhKstT5M5n5ZRFowM';
const FEB = '1569468f-8962-41c7-bd05-10bc509fa31b';
const sb = createClient(URL, KEY);

async function fetchAll(table: string, where: any) {
  let all: any[] = [], from = 0; const SIZE = 1000;
  while (true) {
    const { data, error } = await sb.from(table).select('*').match(where).order('id').range(from, from + SIZE - 1);
    if (error) throw error;
    all = all.concat(data || []);
    if (!data || data.length < SIZE) break;
    from += SIZE;
  }
  return all;
}

(async () => {
  const recs = await fetchAll('normalized_records', { batch_id: FEB, staging_status: 'active' });
  const recsActive = recs.filter(r => !r.superseded_at);
  console.log('normalized records (active):', recsActive.length);
  const persistedRm = await fetchAll('reconciled_members', { batch_id: FEB });
  console.log('persisted reconciled_members:', persistedRm.length);

  const resolverIndex = await loadResolverIndex(true);
  const { members, debug } = reconcile(recsActive as any, '2026-02', resolverIndex);
  console.log('in-memory reconcile members:', members.length);
  console.log('in-memory in_back_office=true:', members.filter(m => m.in_back_office).length);
  console.log('persisted in_back_office=true:', persistedRm.filter(m => m.in_back_office).length);

  // Per-member compare
  const persByKey = new Map(persistedRm.map(m => [m.member_key, m]));
  let matches = 0, divergeFalseToTrue = 0, divergeTrueToFalse = 0, missingInPers = 0;
  const divergeSamples: any[] = [];
  for (const m of members) {
    const p = persByKey.get(m.member_key);
    if (!p) { missingInPers++; continue; }
    if (m.in_back_office === p.in_back_office) { matches++; continue; }
    if (m.in_back_office && !p.in_back_office) {
      divergeFalseToTrue++;
      if (divergeSamples.length < 10) divergeSamples.push({ key: m.member_key, name: m.applicant_name, mem: m.in_back_office, pers: p.in_back_office });
    } else divergeTrueToFalse++;
  }
  console.log('matches:', matches);
  console.log('in-mem true / pers false (would-fix-by-rebuild):', divergeFalseToTrue);
  console.log('in-mem false / pers true (regression):', divergeTrueToFalse);
  console.log('missing in persisted:', missingInPers);
  console.log('samples:', JSON.stringify(divergeSamples, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
