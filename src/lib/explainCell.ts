/**
 * Source-to-Screen Lineage — Stage 1 single source of truth.
 *
 * `explainCell` produces the canonical {@link CellTrace} for a (member,
 * month, scope) tuple. It runs the SAME classifyCell code path the
 * production Member Timeline page uses (no divergence), but threads a
 * TraceContext so guards/helpers/firing rules are captured.
 *
 * Two execution modes:
 *   - Preloaded:  caller passes `preloadedRecords` (+ optional context).
 *                 No Supabase access. Used by unit tests + Stage 2 UI
 *                 (which already has the records in memory).
 *   - Live:      caller omits `preloadedRecords`. Mirrors the MT page
 *                load path: getAllNormalizedRecordsForMemberTimeline →
 *                resolver merge → buildIsDueEligibleRecord scope filter →
 *                buildClassifierContext.
 */
import {
  classifyCell,
  buildClassifierContext,
  buildIsDueEligibleRecord,
  computeFirstEligibleMonth,
  type ClassifierContext,
  type PayEntityScope,
  type AorScope,
} from './classifier';
import type { MonthKey } from './dateRange';
import type { NormalizedRecord } from './normalize';
import { TraceContext, type CellTrace } from './explainCellTypes';

export type ExplainScope = 'All' | 'Vix' | 'Coverall';

export interface ExplainCellInput {
  memberKey: string;
  monthKey: MonthKey;
  scope: ExplainScope;
  /**
   * Pre-scoped records for this member. When provided, no live fetch is
   * performed and these records are passed directly to classifyCell. The
   * caller is responsible for having already applied the scope filter.
   */
  preloadedRecords?: NormalizedRecord[];
  /**
   * Pre-built classifier context. When provided alongside
   * `preloadedRecords`, used as-is. When omitted, a minimal context is
   * built from the records.
   */
  preloadedContext?: ClassifierContext;
}

function scopeToConfig(scope: ExplainScope): { aorScope: AorScope; payEntity: PayEntityScope } {
  switch (scope) {
    case 'Vix': return { aorScope: 'official', payEntity: 'Vix' };
    case 'Coverall': return { aorScope: 'official', payEntity: 'Coverall' };
    case 'All':
    default: return { aorScope: 'all', payEntity: 'All' };
  }
}

function pickIdentity(records: NormalizedRecord[]): { policyNumber: string; name: string } {
  const sample =
    records.find(r => r.source_type === 'BACK_OFFICE') ??
    records.find(r => r.source_type === 'EDE') ??
    records.find(r => r.source_type === 'COMMISSION');
  return {
    policyNumber: String((sample as any)?.policy_number ?? ''),
    name: String((sample as any)?.applicant_name ?? ''),
  };
}

export async function explainCell(input: ExplainCellInput): Promise<CellTrace> {
  const { memberKey, monthKey, scope } = input;
  const cfg = scopeToConfig(scope);
  const predicate = buildIsDueEligibleRecord(cfg);

  let scopedRecords: NormalizedRecord[];
  let context: ClassifierContext;

  if (input.preloadedRecords) {
    scopedRecords = input.preloadedRecords.filter(predicate);
    context = input.preloadedContext
      ?? buildClassifierContext(scopedRecords, [monthKey], []);
  } else {
    // Live path — same as MemberTimelinePage / named-canary-ledger test.
    const { getAllNormalizedRecordsForMemberTimeline, getBatches } = await import('./persistence');
    const { loadResolverIndex } = await import('./resolvedIdentities');
    const { mergeRecordsToMemberKeys } = await import('./canonical/memberKeyMerge');
    const { latestAuthoritativeBoTermDates, makeBoRecency } = await import('./canonical/latestAuthoritativeBo');

    const resolverIndex = await loadResolverIndex(true);
    const batches = await getBatches();
    const batchMonthByBatchId = new Map<string, string>();
    const batchMonthByBatchIdObj: Record<string, string> = {};
    for (const b of batches ?? []) {
      if (!b?.id || !b?.statement_month) continue;
      const ym = String(b.statement_month).substring(0, 7);
      batchMonthByBatchId.set(String(b.id), ym);
      batchMonthByBatchIdObj[String(b.id)] = ym;
    }
    const allRecords = await getAllNormalizedRecordsForMemberTimeline({
      batchMonthByBatchId: batchMonthByBatchIdObj,
    });
    mergeRecordsToMemberKeys(allRecords as any, resolverIndex);

    // Phase B — supersession overlay built off all-batch records so
    // explainCell's trace mirrors MT/MCE classification.
    const recency = makeBoRecency({ batchMonthByBatchId });
    const latestAuthoritativeBoOverlay = latestAuthoritativeBoTermDates(
      allRecords as any,
      recency,
    );

    scopedRecords = (allRecords as any[])
      .filter(r => (r.member_key || r.applicant_name) === memberKey)
      .filter(predicate);

    context = buildClassifierContext(scopedRecords, [monthKey], [], {
      batchMonthByBatchId,
      latestAuthoritativeBoOverlay,
    });
  }

  const firstEligible = computeFirstEligibleMonth(scopedRecords);
  const trace = new TraceContext();
  const cell = classifyCell(scopedRecords, monthKey, firstEligible, context, trace);

  const identity = pickIdentity(scopedRecords);

  return {
    member: {
      memberKey,
      policyNumber: identity.policyNumber,
      name: identity.name,
    },
    cell: { month: monthKey, scope },
    final: {
      state: cell.state,
      reason: cell.reason,
      chips: {
        in_ede: cell.in_ede,
        in_back_office: cell.in_back_office,
        in_commission: cell.in_commission,
        paid_amount: cell.paid_amount,
      },
      badges: {
        reversal_evidence: cell.reversal_evidence,
      },
    },
    helpers: trace.helpers,
    guards: trace.guards,
    firingRule: trace.firingRule,
    scopedRows: scopedRecords,
  };
}
