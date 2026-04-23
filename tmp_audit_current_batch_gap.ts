import { createClient } from '@supabase/supabase-js';
import { assignMergedMemberKeys } from './src/lib/memberMerge';
import { buildMemberTimeline, buildMonthList } from './src/lib/memberTimeline';
import { buildClassifierContext, classifyMember } from './src/lib/classifier';
import { isCoverallAORByName } from './src/lib/agents';
import { NPN_MAP } from './src/lib/constants';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL!;
const ANON = process.env.VITE_SUPABASE_PUBLISHABLE_KEY!;
const supabase = createClient(SUPABASE_URL, ANON);

function isDueEligibleFactory(payEntity: 'Coverall' | 'Vix' | 'All', aorScope: 'official' | 'all') {
  return (r: any): boolean => {
    const isCommission = r.source_type === 'COMMISSION';
    if (aorScope === 'official' && !isCommission) {
      const aorMatch =
        isCoverallAORByName(r.aor_bucket) ||
        isCoverallAORByName(r.raw_json?.['currentPolicyAOR']) ||
        isCoverallAORByName(r.raw_json?.['Broker Name'] ?? r.raw_json?.['broker_name']);
      if (!aorMatch) return false;
    }
    if (payEntity !== 'All') {
      if (isCommission) {
        const recPayEntity = String(r.pay_entity || '').trim();
        if (recPayEntity !== payEntity) return false;
      } else {
        const npn = String(r.agent_npn || '').trim();
        const info = (NPN_MAP as any)[npn];
        if (!info) return false;
        if (info.expectedPayEntity !== payEntity && info.expectedPayEntity !== 'Coverall_or_Vix') return false;
      }
    }
    return true;
  };
}

async function fetchCurrentBatchJan2026() {
  const { data: batchRows, error: batchError } = await supabase
    .from('upload_batches')
    .select('id, statement_month, created_at')
    .eq('statement_month', '2026-01-01')
    .order('created_at', { ascending: false })
    .limit(1);
  if (batchError) throw batchError;
  const batchId = batchRows?.[0]?.id;
  if (!batchId) throw new Error('No Jan 2026 batch found');

  const all: any[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('normalized_records')
      .select('*')
      .eq('batch_id', batchId)
      .is('superseded_at', null)
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data?.length) break;
    all.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return { batchId, records: all };
}

(async () => {
  const { batchId, records } = await fetchCurrentBatchJan2026();
  assignMergedMemberKeys(records as any);
  const monthList = buildMonthList('2026-01', '2026-01');
  const isDueEligible = isDueEligibleFactory('Coverall', 'official');
  const rows = buildMemberTimeline(records as any, monthList, isDueEligible);
  const context = buildClassifierContext(records as any, monthList, []);

  const byKey = new Map<string, any[]>();
  for (const r of records) {
    const k = r.member_key || r.applicant_name || 'unknown';
    const arr = byKey.get(k) ?? [];
    arr.push(r);
    byKey.set(k, arr);
  }

  let visibleTotal = 0;
  let allTimelineTotal = 0;
  const dropped: any[] = [];
  for (const row of rows) {
    const memberRecs = byKey.get(row.member_key) ?? [];
    const cls = classifyMember(memberRecs as any, context);
    let monthsDue = 0;
    for (const m of monthList) {
      const c = cls.cells[m];
      if (!c) continue;
      if (['paid', 'unpaid', 'pending', 'manual_review'].includes(c.state)) monthsDue++;
    }
    allTimelineTotal += row.total_paid;
    if (monthsDue > 0) {
      visibleTotal += row.total_paid;
    } else if (row.total_paid > 0) {
      dropped.push({
        key: row.member_key,
        name: row.applicant_name,
        total_paid: Number(row.total_paid.toFixed(2)),
        state: cls.cells['2026-01']?.state,
        reason: cls.cells['2026-01']?.reason,
        commission_count: memberRecs.filter(r => r.source_type === 'COMMISSION').length,
        commission_pay_entities: [...new Set(memberRecs.filter(r => r.source_type === 'COMMISSION').map(r => r.pay_entity || ''))],
        commission_npns: [...new Set(memberRecs.filter(r => r.source_type === 'COMMISSION').map(r => r.agent_npn || ''))],
        commission_aors: [...new Set(memberRecs.filter(r => r.source_type === 'COMMISSION').map(r => r.aor_bucket || ''))],
      });
    }
  }

  dropped.sort((a, b) => b.total_paid - a.total_paid);
  console.log(JSON.stringify({
    batchId,
    rowCount: rows.length,
    allTimelineTotal: Number(allTimelineTotal.toFixed(2)),
    visibleTotal: Number(visibleTotal.toFixed(2)),
    droppedTotal: Number((allTimelineTotal - visibleTotal).toFixed(2)),
    droppedCount: dropped.length,
    topDropped: dropped.slice(0, 12),
  }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
