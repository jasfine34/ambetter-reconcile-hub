// Mirror MemberTimelinePage's pipeline for All-Batches + Coverall + Jan-Jan 2026 + AOR-official.
// Identify member_keys whose commission rows pass per-row eligibility but the
// timeline drops the entire row via `months_due > 0`.
import { createClient } from '@supabase/supabase-js';
import { assignMergedMemberKeys } from '../src/lib/memberMerge';
import { buildMemberTimeline, buildMonthList } from '../src/lib/memberTimeline';
import { buildClassifierContext, classifyMember } from '../src/lib/classifier';
import { isCoverallAORByName } from '../src/lib/agents';
import { NPN_MAP } from '../src/lib/constants';

const SUPABASE_URL = 'https://sbbsfbzxixcmaoliixae.supabase.co';
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNiYnNmYnp4aXhjbWFvbGlpeGFlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyMDM2NjUsImV4cCI6MjA5MTc3OTY2NX0.bXVHqrrVqBGCUYEXRBYKifDJ-3JhKstT5M5n5ZRFowM';
const supabase = createClient(SUPABASE_URL, ANON);

async function fetchAll() {
  const all: any[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('normalized_records')
      .select('*')
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

function isDueEligible(r: any, payEntity = 'Coverall'): boolean {
  const aorMatch =
    isCoverallAORByName(r.aor_bucket) ||
    isCoverallAORByName(r.raw_json?.['currentPolicyAOR']) ||
    isCoverallAORByName(r.raw_json?.['Broker Name'] ?? r.raw_json?.['broker_name']);
  if (!aorMatch) return false;
  if (r.source_type === 'COMMISSION') {
    const recPe = String(r.pay_entity || '').trim();
    if (recPe && recPe !== payEntity) return false;
  } else {
    const npn = String(r.agent_npn || '').trim();
    const info = (NPN_MAP as any)[npn];
    if (!info) return false;
    if (info.expectedPayEntity !== payEntity && info.expectedPayEntity !== 'Coverall_or_Vix') return false;
  }
  return true;
}

(async () => {
  console.log('Fetching records…');
  const recs = await fetchAll();
  console.log('Fetched:', recs.length);
  assignMergedMemberKeys(recs as any);

  const monthList = buildMonthList('2026-01', '2026-01');
  const rows = buildMemberTimeline(recs as any, monthList, isDueEligible);
  const context = buildClassifierContext(recs as any, monthList, []);

  // Group records by member_key (post-merge)
  const byKey = new Map<string, any[]>();
  for (const r of recs) {
    const k = r.member_key || r.applicant_name || 'unknown';
    let arr = byKey.get(k); if (!arr) { arr = []; byKey.set(k, arr); }
    arr.push(r);
  }

  // Mirror MemberTimelinePage's classifiedRows + filteredRows logic
  type RowInfo = { key: string; name: string; total_paid: number; months_due: number; passes_filter: boolean;
    commission_rows_passing_pred: number; commission_dollars_passing_pred: number;
    member_record_summary: any[]; cell_state: string; cell_reason: string };
  const enriched: RowInfo[] = [];
  for (const row of rows) {
    const memberRecs = byKey.get(row.member_key) ?? [];
    const cls = classifyMember(memberRecs as any, context);
    let months_due = 0;
    for (const m of monthList) {
      const c = cls.cells[m]; if (!c) continue;
      if (['paid','unpaid','pending','manual_review'].includes(c.state)) months_due++;
    }
    // Per-record commission $ that PASS isDueEligible AND attribute to Jan
    let commPass = 0, commDol = 0;
    const recSummary: any[] = [];
    for (const r of memberRecs) {
      const passes = isDueEligible(r);
      recSummary.push({
        st: r.source_type,
        pe: r.pay_entity,
        aor: r.aor_bucket,
        npn: r.agent_npn,
        name: r.applicant_name,
        ptd: r.paid_to_date,
        amt: r.commission_amount,
        passes,
      });
      if (r.source_type === 'COMMISSION' && passes && String(r.paid_to_date||'').startsWith('2026-01')) {
        commPass++; commDol += (r.commission_amount || 0);
      }
    }
    const cell = cls.cells[monthList[0]];
    enriched.push({
      key: row.member_key, name: row.applicant_name,
      total_paid: row.total_paid, months_due,
      passes_filter: months_due > 0,
      commission_rows_passing_pred: commPass,
      commission_dollars_passing_pred: commDol,
      member_record_summary: recSummary,
      cell_state: cell?.state ?? '',
      cell_reason: cell?.reason ?? '',
    });
  }

  const dropped = enriched.filter(r => !r.passes_filter && r.commission_dollars_passing_pred > 0);
  const droppedTotal = dropped.reduce((s, r) => s + r.commission_dollars_passing_pred, 0);
  const passedTotal = enriched.filter(r => r.passes_filter).reduce((s, r) => s + r.total_paid, 0);
  const totalAttributedJan = enriched.reduce((s, r) => s + r.total_paid, 0);

  console.log('\n=== AGGREGATES ===');
  console.log('Total Jan-attributed paid (across all timeline rows):', totalAttributedJan.toFixed(2));
  console.log('Sum total_paid for rows passing months_due>0 filter:', passedTotal.toFixed(2));
  console.log('Sum commission $ on dropped rows (where commission_dollars_passing_pred>0 but months_due=0):', droppedTotal.toFixed(2));
  console.log('Number of dropped member_keys with commission $:', dropped.length);

  // Sort by dollars descending
  dropped.sort((a, b) => b.commission_dollars_passing_pred - a.commission_dollars_passing_pred);
  console.log('\n=== TOP 10 DROPPED MEMBER_KEYS WITH COMMISSION $ ===');
  for (const d of dropped.slice(0, 10)) {
    console.log(`\n— ${d.name} | key=${d.key}`);
    console.log(`  commission $ passing predicate: $${d.commission_dollars_passing_pred.toFixed(2)} across ${d.commission_rows_passing_pred} row(s)`);
    console.log(`  cell state: ${d.cell_state} — ${d.cell_reason}`);
    console.log(`  member's records (count ${d.member_record_summary.length}):`);
    for (const rs of d.member_record_summary.slice(0, 6)) {
      console.log(`    ${rs.st} pe=${rs.pe||''} aor=${rs.aor||''} npn=${rs.npn||''} ptd=${rs.ptd||''} $=${rs.amt ?? ''} pass=${rs.passes}`);
    }
    if (d.member_record_summary.length > 6) console.log(`    … +${d.member_record_summary.length - 6} more`);
  }
})().catch(e => { console.error(e); process.exit(1); });
