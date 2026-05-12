/**
 * Bundle 3 — getExpectedMissingCommissionSum behavior tests.
 *
 * The helper sums `estimated_missing_commission` over the canonical
 * Expected But Unpaid row set produced by getExpectedPaymentBreakdown.
 * Null/undefined/missing per-row estimates contribute 0; we never fall back
 * to a computed value (commission-less batches intentionally suppress
 * phantom estimates).
 */
import { describe, it, expect, vi } from 'vitest';
import * as metrics from '../metrics';
import type { FilteredEdeResult } from '@/lib/expectedEde';

const emptyFiltered = {
  uniqueMembers: [],
  uniqueKeys: new Set<string>(),
  missingFromBO: [],
} as unknown as FilteredEdeResult;

const scope = { type: 'pay_entity' as const, pay_entity: 'Coverall' as const };

function withUnpaid(rows: any[]) {
  return vi.spyOn(metrics, 'getExpectedPaymentBreakdown').mockReturnValue({
    universe: { rows: [], total: 0, matched: [], boOnly: [], edeOnly: [],
      matchedCount: 0, boOnlyCount: 0, edeOnlyCount: 0,
      boActiveNonCurrentEde: [], boActiveNonCurrentEdeCount: 0,
      boIneligible: [], boIneligibleCount: 0 } as any,
    paidRows: [],
    unpaidRows: rows,
    paidCount: 0,
    unpaidCount: rows.length,
    paidSplit: { matched: 0, boOnly: 0, edeOnly: 0 },
    unpaidSplit: { matched: 0, boOnly: 0, edeOnly: 0 },
  });
}

describe('getExpectedMissingCommissionSum', () => {
  it('sums estimated_missing_commission across canonical unpaidRows', () => {
    const spy = withUnpaid([
      { estimated_missing_commission: 10 },
      { estimated_missing_commission: 25.5 },
      { estimated_missing_commission: 4.5 },
    ]);
    const out = metrics.getExpectedMissingCommissionSum([], scope, emptyFiltered, new Set());
    expect(out).toBeCloseTo(40);
    spy.mockRestore();
  });

  it('treats null / undefined / missing estimates as 0', () => {
    const spy = withUnpaid([
      { estimated_missing_commission: null },
      { estimated_missing_commission: undefined },
      {}, // missing key
      { estimated_missing_commission: 7 },
    ]);
    const out = metrics.getExpectedMissingCommissionSum([], scope, emptyFiltered, new Set());
    expect(out).toBe(7);
    spy.mockRestore();
  });

  it('returns 0 when unpaidRows is empty', () => {
    const spy = withUnpaid([]);
    expect(metrics.getExpectedMissingCommissionSum([], scope, emptyFiltered, new Set())).toBe(0);
    spy.mockRestore();
  });

  it('does NOT fall back to a computed estimate (NaN/strings ignored)', () => {
    const spy = withUnpaid([
      { estimated_missing_commission: NaN },
      { estimated_missing_commission: '15' as any },
      { estimated_missing_commission: 3 },
    ]);
    expect(metrics.getExpectedMissingCommissionSum([], scope, emptyFiltered, new Set())).toBe(3);
    spy.mockRestore();
  });

  it('mirrors getExpectedPaymentBreakdown input shape (delegates to it)', () => {
    const spy = withUnpaid([{ estimated_missing_commission: 1 }]);
    metrics.getExpectedMissingCommissionSum([{ a: 1 } as any], scope, emptyFiltered, new Set(['k']));
    expect(spy).toHaveBeenCalledWith(
      [{ a: 1 }],
      scope,
      emptyFiltered,
      new Set(['k']),
    );
    spy.mockRestore();
  });
});
