/**
 * Cross-batch merge orphan diagnostic.
 *
 * Replicates the All-Batches Coverall pipeline for a given month range, but
 * also computes the "raw" sum of commission rows that pass per-record
 * eligibility before any merge / classifier filtering. The delta between the
 * two reveals merge orphans (records dropped because their member_key got
 * stranded with no other source presence) and double-counts (records that
 * landed in two member groups or were attributed to two months).
 */
import { createClient } from '@supabase/supabase-js';
import { assignMergedMemberKeys } from '../src/lib/memberMerge';
import { buildMemberTimeline, buildMonthList } from '../src/lib/memberTimeline';
import { buildClassifierContext, classifyMember } from '../src/lib/classifier';
import { isCoverallAORByName } from '../src/lib/agents';

const SUPABASE_URL = 'https://sbbsfbzxixcmaoliixae.supabase.co';
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNiYnNmYnp4aXhjbWFvbGlpeGFlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyMDM2NjUsImV4cCI6MjA5MTc3OTY2NX0.bXVHqrrVqBGCUYEXRBYKifDJ-3JhKstT5M5n5ZRFowM';
const supabase = createClient(SUPABASE_URL, ANON);

const PAY_ENTITY = 'Coverall';
const RANGES: Array<[string, string, string]> = [
  ['Jan-Jan 2026', '2026-01', '2026-01'],
  ['Feb-Feb 2026', '2026-02', '2026-02'],
];

async function fetchAll(): Promise<any[]> {
  const all: any[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    // Canonical active predicate — must match every other active read so the
    // partial index (idx_normalized_active) is used.
    const { data, error } = await supabase
      .from('normalized_records')
      .select('*')
      .eq('staging_status', 'active')
      .is('superseded_at', null)
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data?.length) break;
    all.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

// Mirror MemberTimelinePage.isDueEligibleRecord (post-fixes).
function isDueEligible(r: any, payEntity = PAY_ENTITY): boolean {
  const isCommission = r.source_type === 'COMMISSION';
  if (!isCommission) {
    const aorMatch =
      isCoverallAORByName(r.aor_bucket) ||
      isCoverallAORByName(r.raw_json?.['currentPolicyAOR']) ||
      isCoverallAORByName(r.raw_json?.['Broker Name'] ?? r.raw_json?.['broker_name']);
    if (!aorMatch) return false;
  }
  if (payEntity !== 'All') {
    if (isCommission) {
      if (String(r.pay_entity || '').trim() !== payEntity) return false;
    } else {
      // EDE/BO use NPN_MAP gating — for the orphan audit we don't need the
      // strict NPN check: any record with our AOR is in scope. (The page
      // does have NPN gating for EDE/BO; here we only care about commission
      // attribution since that's where the dollars are.)
    }
  }
  return true;
}

function ymOf(dateStr: any): string | null {
  if (!dateStr) return null;
  const s = String(dateStr).trim();
  const iso = s.match(/^(\d{4})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}`;
  return null;
}

function commissionMonths(r: any): { months: string[]; per: number } {
  const total = r.commission_amount ?? 0;
  if (total === 0) return { months: [], per: 0 };
  const ptd = ymOf(r.paid_to_date);
  if (!ptd) return { months: [], per: 0 };
  const span = r.months_paid && r.months_paid > 0 ? r.months_paid : 1;
  const months: string[] = [];
  for (let i = span - 1; i >= 0; i--) {
    const [y, m] = ptd.split('-').map(Number);
    const tot = y * 12 + (m - 1) - i;
    const ny = Math.floor(tot / 12);
    const nm = (tot % 12) + 1;
    months.push(`${ny}-${String(nm).padStart(2, '0')}`);
  }
  return { months, per: total / span };
}

(async () => {
  console.log('Fetching records…');
  const recs = await fetchAll();
  console.log('Fetched:', recs.length);
  assignMergedMemberKeys(recs as any, null);

  for (const [label, start, end] of RANGES) {
    console.log(`\n========== ${label} (${PAY_ENTITY}) ==========`);
    const monthList = buildMonthList(start, end);
    const monthSet = new Set(monthList);

    // RAW: per-record sum of commissions that are in-scope and attribute to range
    let rawTotal = 0;
    let rawRows = 0;
    const rawByKey = new Map<string, { name: string; total: number; rowCount: number; recs: any[] }>();
    for (const r of recs) {
      if (r.source_type !== 'COMMISSION') continue;
      if (!isDueEligible(r)) continue;
      const { months, per } = commissionMonths(r);
      const inRange = months.filter(m => monthSet.has(m));
      if (inRange.length === 0) continue;
      const dollars = per * inRange.length;
      rawTotal += dollars;
      rawRows++;
      const key = r.member_key || r.applicant_name || 'unknown';
      let entry = rawByKey.get(key);
      if (!entry) { entry = { name: r.applicant_name || '', total: 0, rowCount: 0, recs: [] }; rawByKey.set(key, entry); }
      entry.total += dollars;
      entry.rowCount++;
      entry.recs.push({ id: r.id, ptd: r.paid_to_date, amt: r.commission_amount, ent: r.pay_entity, npn: r.agent_npn, name: r.applicant_name });
    }

    // PIPELINE: full classifier path, just like the UI
    const filtered = recs; // no carrier/aor pill filters
    const rows = buildMemberTimeline(filtered as any, monthList, isDueEligible);
    const classifierRecs = filtered.filter(r => isDueEligible(r));
    const ctx = buildClassifierContext(classifierRecs as any, monthList, []);
    const byMember = new Map<string, any[]>();
    for (const r of classifierRecs) {
      const k = r.member_key || r.applicant_name || 'unknown';
      let arr = byMember.get(k); if (!arr) { arr = []; byMember.set(k, arr); }
      arr.push(r);
    }

    let pipelineTotal = 0;
    const pipelineByKey = new Map<string, { name: string; total: number; passes: boolean }>();
    for (const row of rows) {
      const memberRecs = byMember.get(row.member_key) ?? [];
      const cls = classifyMember(memberRecs as any, ctx);
      let monthsDue = 0;
      let cellPaid = 0;
      for (const m of monthList) {
        const c = cls.cells[m]; if (!c) continue;
        if (['paid', 'unpaid', 'pending', 'manual_review'].includes(c.state)) monthsDue++;
        cellPaid += c.paid_amount;
      }
      const passes = monthsDue > 0;
      // Reconstruct cell paid_amount the same way the UI shows it (uses memberTimeline's
      // commissionServiceMonths which now reads typed paid_to_date).
      const totalForRow = row.total_paid;
      pipelineByKey.set(row.member_key, { name: row.applicant_name, total: totalForRow, passes });
      if (passes) pipelineTotal += totalForRow;
    }

    console.log(`Raw sum (per-record, in-scope, in-range): $${rawTotal.toFixed(2)} across ${rawRows} rows / ${rawByKey.size} member_keys`);
    console.log(`Pipeline sum (rows passing months_due>0):  $${pipelineTotal.toFixed(2)}`);
    const gap = rawTotal - pipelineTotal;
    console.log(`GAP:                                        $${gap.toFixed(2)}`);

    // Diagnose: keys with raw $ that DROP at the pipeline (orphans)
    const orphans: Array<{ key: string; name: string; rawTotal: number; pipelineTotal: number; passes: boolean; recs: any[] }> = [];
    const doubleCounts: Array<{ key: string; name: string; rawTotal: number; pipelineTotal: number; delta: number }> = [];
    for (const [key, entry] of rawByKey) {
      const pipe = pipelineByKey.get(key);
      const pipeTotal = pipe?.total ?? 0;
      const passes = pipe?.passes ?? false;
      if (!passes && entry.total > 0) {
        orphans.push({ key, name: entry.name, rawTotal: entry.total, pipelineTotal: pipeTotal, passes, recs: entry.recs });
      } else if (passes && Math.abs(pipeTotal - entry.total) > 0.01) {
        doubleCounts.push({ key, name: entry.name, rawTotal: entry.total, pipelineTotal: pipeTotal, delta: pipeTotal - entry.total });
      }
    }
    // Also catch keys present in pipeline but missing from raw (pure double-count from merge)
    for (const [key, pipe] of pipelineByKey) {
      if (!pipe.passes) continue;
      const raw = rawByKey.get(key);
      if (!raw && pipe.total > 0.01) {
        doubleCounts.push({ key, name: pipe.name, rawTotal: 0, pipelineTotal: pipe.total, delta: pipe.total });
      }
    }

    orphans.sort((a, b) => b.rawTotal - a.rawTotal);
    doubleCounts.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

    const orphanTotal = orphans.reduce((s, o) => s + o.rawTotal, 0);
    const doubleTotal = doubleCounts.reduce((s, d) => s + d.delta, 0);
    console.log(`\nOrphans: ${orphans.length} keys, $${orphanTotal.toFixed(2)} dropped`);
    console.log(`Double-counts/over-attribution: ${doubleCounts.length} keys, net $${doubleTotal.toFixed(2)} extra`);

    if (orphans.length) {
      console.log('\n--- Top 5 ORPHANED member_keys ---');
      for (const o of orphans.slice(0, 5)) {
        console.log(`\n  ${o.name} | key=${o.key} | raw=$${o.rawTotal.toFixed(2)} | pipeline=$${o.pipelineTotal.toFixed(2)}`);
        for (const r of o.recs.slice(0, 3)) {
          console.log(`    row id=${r.id} ptd=${r.ptd} $=${r.amt} ent=${r.ent} npn=${r.npn} name="${r.name}"`);
        }
        // Show what other records share that member_key in the full set
        const sharedKey = recs.filter(x => (x.member_key || x.applicant_name || 'unknown') === o.key);
        const summary = sharedKey.map(x => `${x.source_type}/${x.pay_entity || ''}/${x.aor_bucket || ''}/${x.applicant_name || ''}`);
        console.log(`    sibling records in same member_key (${sharedKey.length}): ${summary.slice(0, 5).join(' | ')}`);
      }
    }

    if (doubleCounts.length) {
      console.log('\n--- Top 5 DOUBLE-COUNT / OVER-ATTRIBUTION member_keys ---');
      for (const d of doubleCounts.slice(0, 5)) {
        console.log(`  ${d.name} | key=${d.key} | raw=$${d.rawTotal.toFixed(2)} | pipeline=$${d.pipelineTotal.toFixed(2)} | delta=$${d.delta.toFixed(2)}`);
      }
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
