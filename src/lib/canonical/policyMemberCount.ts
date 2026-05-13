/**
 * Bundle 13a — Resolve the member count used as input to the comp grid.
 *
 * Same timing + BO-first/EDE-fallback/conflict semantics as policyState.
 *
 * CRITICAL: Missing member counts do NOT default to 1. If neither BO nor
 * EDE provides a parseable count in or before the window, return unresolved.
 */

export interface PolicyMemberCountRecord {
  source: 'bo' | 'ede';
  asOfMonth: string;
  /** Raw member count value (string | number | null). Parsed defensively. */
  memberCount: number | string | null;
}

export interface PolicyMemberCountResolution {
  status: 'resolved' | 'manual_review' | 'unresolved';
  memberCount: number | null;
  source: 'bo' | 'ede' | null;
  conflicts?: number[];
  fallbackUsed?: 'historical';
}

function parseCount(v: number | string | null): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.trunc(v) : null;
  const trimmed = String(v).trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}

function inWindow(month: string, batchMonth: string, serviceMonths: string[]): boolean {
  if (month > batchMonth) return false;
  if (serviceMonths.length === 0) return true;
  const minS = serviceMonths.reduce((a, b) => (a < b ? a : b));
  const maxS = serviceMonths.reduce((a, b) => (a > b ? a : b));
  return month >= minS && month <= maxS;
}

function resolveFromSource(
  records: PolicyMemberCountRecord[],
  source: 'bo' | 'ede',
  batchMonth: string,
  serviceMonths: string[],
): PolicyMemberCountResolution | null {
  const parsed = records
    .filter(r => r.source === source && r.asOfMonth <= batchMonth)
    .map(r => ({ asOfMonth: r.asOfMonth, count: parseCount(r.memberCount) }))
    .filter(r => r.count != null) as { asOfMonth: string; count: number }[];
  if (parsed.length === 0) return null;

  const inWin = parsed.filter(r => inWindow(r.asOfMonth, batchMonth, serviceMonths));
  let pool = inWin;
  let fallback: 'historical' | undefined;
  if (pool.length === 0) {
    pool = parsed;
    fallback = 'historical';
  }

  const distinct = Array.from(new Set(pool.map(r => r.count)));
  if (distinct.length > 1) {
    return {
      status: 'manual_review',
      memberCount: null,
      source,
      conflicts: distinct,
      fallbackUsed: fallback,
    };
  }
  const sorted = [...pool].sort((a, b) => (a.asOfMonth < b.asOfMonth ? 1 : -1));
  return { status: 'resolved', memberCount: sorted[0].count, source, fallbackUsed: fallback };
}

export function resolvePolicyMemberCountForCompGrid(args: {
  records: PolicyMemberCountRecord[];
  targetBatchMonth: string;
  targetServiceMonths: string[];
}): PolicyMemberCountResolution {
  const { records, targetBatchMonth, targetServiceMonths } = args;
  const bo = resolveFromSource(records, 'bo', targetBatchMonth, targetServiceMonths);
  if (bo) return bo;
  const ede = resolveFromSource(records, 'ede', targetBatchMonth, targetServiceMonths);
  if (ede) return ede;
  return { status: 'unresolved', memberCount: null, source: null };
}
