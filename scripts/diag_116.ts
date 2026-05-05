// @ts-nocheck
// READ-ONLY diagnostic.
(globalThis as any).localStorage = { getItem:()=>null, setItem:()=>{}, removeItem:()=>{}, clear:()=>{}, key:()=>null, length:0 };
import { reconcile } from '../src/lib/reconcile';

const URL = 'https://sbbsfbzxixcmaoliixae.supabase.co';
const KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNiYnNmYnp4aXhjbWFvbGlpeGFlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyMDM2NjUsImV4cCI6MjA5MTc3OTY2NX0.bXVHqrrVqBGCUYEXRBYKifDJ-3JhKstT5M5n5ZRFowM';
const FEB = '1569468f-8962-41c7-bd05-10bc509fa31b';

async function fetchAll(table: string, where: string) {
  let all: any[] = []; let from = 0; const SIZE = 1000;
  while (true) {
    const res = await fetch(`${URL}/rest/v1/${table}?select=*&${where}&order=id`, {
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Range: `${from}-${from + SIZE - 1}`, 'Range-Unit': 'items' },
    });
    const data = await res.json();
    all = all.concat(data || []);
    if (!data || data.length < SIZE) break;
    from += SIZE;
  }
  return all;
}

(async () => {
  const recs = await fetchAll('normalized_records', `batch_id=eq.${FEB}&staging_status=eq.active&superseded_at=is.null`);
  console.log('normalized records (active):', recs.length);
  const persistedRm = await fetchAll('reconciled_members', `batch_id=eq.${FEB}`);
  console.log('persisted reconciled_members:', persistedRm.length);

  // Pass null resolverIndex — Feb has no sidecar overlay impact for this question.
  const { members, debug } = reconcile(recs as any, '2026-02', null);
  console.log('in-memory reconcile members:', members.length);
  console.log('in-memory in_back_office=true:', members.filter(m => m.in_back_office).length);
  console.log('persisted in_back_office=true:', persistedRm.filter(m => m.in_back_office).length);

  const persByKey = new Map(persistedRm.map(m => [m.member_key, m]));
  let matches = 0, divergeFalseToTrue = 0, divergeTrueToFalse = 0, missingInPers = 0;
  const divergeSamples: any[] = [];
  for (const m of members) {
    const p = persByKey.get(m.member_key);
    if (!p) { missingInPers++; continue; }
    if (m.in_back_office === p.in_back_office) { matches++; continue; }
    if (m.in_back_office && !p.in_back_office) {
      divergeFalseToTrue++;
      if (divergeSamples.length < 5) divergeSamples.push({ key: m.member_key, name: m.applicant_name });
    } else divergeTrueToFalse++;
  }
  console.log('matches:', matches);
  console.log('IN-MEM true / PERS false (would-fix-by-rebuild):', divergeFalseToTrue);
  console.log('IN-MEM false / PERS true (regression):', divergeTrueToFalse);
  console.log('MISSING in persisted (in-mem produced new key):', missingInPers);
  console.log('samples (in-mem true, persisted false):', JSON.stringify(divergeSamples, null, 2));

  // Reverse: members in persisted that aren't in in-mem
  const memByKey = new Map(members.map(m => [m.member_key, m]));
  const orphanPersisted = persistedRm.filter(p => !memByKey.has(p.member_key));
  console.log('PERS rows whose member_key in-mem reconcile no longer produces:', orphanPersisted.length);
  if (orphanPersisted.length > 0) {
    console.log('orphan samples:', JSON.stringify(orphanPersisted.slice(0,5).map(o => ({key:o.member_key, name:o.applicant_name, in_bo:o.in_back_office})), null, 2));
  }
})().catch(e => { console.error(e); process.exit(1); });
