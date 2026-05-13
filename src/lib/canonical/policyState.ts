/**
 * Bundle 13a — Resolve the policy state used as input to the comp grid.
 *
 * Timing rules:
 *   - targetBatchMonth: YYYY-MM string. Records dated AFTER this are ignored.
 *   - targetServiceMonths: array of YYYY-MM strings. Used to validate that
 *     the resolved record was active during the service window. If no record
 *     covers the window, fall back to the most recent prior record.
 *
 * BO-first / EDE-fallback / conflict=manual_review semantics:
 *   - Prefer back-office records. If multiple BO records yield conflicting
 *     state values inside the window, return manual_review with conflicts.
 *   - If no BO records, fall back to EDE.
 *   - If neither source has any record in or before the window, return
 *     unresolved.
 */

export interface PolicyStateRecord {
  source: 'bo' | 'ede';
  /** YYYY-MM month at which this record was effective / observed. */
  asOfMonth: string;
  state: string | null;
}

export interface PolicyStateResolution {
  status: 'resolved' | 'manual_review' | 'unresolved';
  state: string | null;
  source: 'bo' | 'ede' | null;
  conflicts?: string[];
  fallbackUsed?: 'historical';
}

function inWindow(month: string, batchMonth: string, serviceMonths: string[]): boolean {
  if (month > batchMonth) return false;
  if (serviceMonths.length === 0) return true;
  const minS = serviceMonths.reduce((a, b) => (a < b ? a : b));
  const maxS = serviceMonths.reduce((a, b) => (a > b ? a : b));
  return month >= minS && month <= maxS;
}

function resolveFromSource(
  records: PolicyStateRecord[],
  source: 'bo' | 'ede',
  batchMonth: string,
  serviceMonths: string[],
): PolicyStateResolution | null {
  const own = records.filter(r => r.source === source && r.asOfMonth <= batchMonth);
  if (own.length === 0) return null;

  // Window-active first
  const inWin = own.filter(r => inWindow(r.asOfMonth, batchMonth, serviceMonths));
  let pool = inWin;
  let fallback: 'historical' | undefined;
  if (pool.length === 0) {
    pool = own;
    fallback = 'historical';
  }

  const distinct = Array.from(new Set(pool.map(r => r.state ?? '∅')));
  if (distinct.length > 1) {
    return {
      status: 'manual_review',
      state: null,
      source,
      conflicts: distinct,
      fallbackUsed: fallback,
    };
  }
  // Pick most recent.
  const sorted = [...pool].sort((a, b) => (a.asOfMonth < b.asOfMonth ? 1 : -1));
  return {
    status: 'resolved',
    state: sorted[0].state,
    source,
    fallbackUsed: fallback,
  };
}

export function resolvePolicyStateForCompGrid(args: {
  records: PolicyStateRecord[];
  targetBatchMonth: string;
  targetServiceMonths: string[];
}): PolicyStateResolution {
  const { records, targetBatchMonth, targetServiceMonths } = args;
  const bo = resolveFromSource(records, 'bo', targetBatchMonth, targetServiceMonths);
  if (bo) return bo;
  const ede = resolveFromSource(records, 'ede', targetBatchMonth, targetServiceMonths);
  if (ede) return ede;
  return { status: 'unresolved', state: null, source: null };
}
