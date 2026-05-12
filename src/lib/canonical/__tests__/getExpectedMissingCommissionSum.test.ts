/**
 * Bundle 3 — getExpectedMissingCommissionSum behavior tests.
 *
 * Sums `estimated_missing_commission` over the canonical Expected But Unpaid
 * row set produced by getExpectedPaymentBreakdown. Null/undefined/missing
 * estimates contribute 0; we never fall back to a computed value
 * (commission-less batches intentionally suppress phantom estimates).
 */
import { describe, it, expect } from 'vitest';
import { getExpectedMissingCommissionSum, getExpectedPaymentBreakdown } from '../metrics';
import type { FilteredEdeResult } from '@/lib/expectedEde';

/**
 * Build a minimal scenario whose rows fall into the EDE Only unpaid bucket
 * (inEde && !inBoActive). Each row's `estimated_missing_commission` flows
 * through to `breakdown.unpaidRows`.
 */
function makeScenario(rows: Array<{ key: string; est?: any }>) {
  const reconciled = rows.map((r) => ({
    member_key: r.key,
    in_back_office: false,
    in_ede: true,
    in_commission: false,
    eligible_for_commission: 'Yes',
    estimated_missing_commission: r.est,
  }));
  const filteredEde = {
    uniqueMembers: rows.map((r) => ({ member_key: r.key })),
    uniqueKeys: new Set(rows.map((r) => r.key)),
    missingFromBO: [],
  } as unknown as FilteredEdeResult;
  return { reconciled, filteredEde };
}

describe('getExpectedMissingCommissionSum', () => {
  it('sums estimated_missing_commission across canonical unpaidRows', () => {
    const { reconciled, filteredEde } = makeScenario([
      { key: 'a', est: 10 },
      { key: 'b', est: 25.5 },
      { key: 'c', est: 4.5 },
    ]);
    const out = getExpectedMissingCommissionSum(reconciled, 'All', filteredEde, new Set());
    expect(out).toBeCloseTo(40);
  });

  it('treats null / undefined / missing estimates as 0', () => {
    const { reconciled, filteredEde } = makeScenario([
      { key: 'a', est: null },
      { key: 'b', est: undefined },
      { key: 'c' }, // missing key
      { key: 'd', est: 7 },
    ]);
    expect(getExpectedMissingCommissionSum(reconciled, 'All', filteredEde, new Set())).toBe(7);
  });

  it('returns 0 when unpaidRows is empty', () => {
    expect(
      getExpectedMissingCommissionSum([], 'All', {
        uniqueMembers: [],
        uniqueKeys: new Set(),
        missingFromBO: [],
      } as unknown as FilteredEdeResult, new Set()),
    ).toBe(0);
  });

  it('does NOT fall back to a computed estimate (NaN/strings ignored)', () => {
    const { reconciled, filteredEde } = makeScenario([
      { key: 'a', est: NaN },
      { key: 'b', est: '15' },
      { key: 'c', est: 3 },
    ]);
    expect(getExpectedMissingCommissionSum(reconciled, 'All', filteredEde, new Set())).toBe(3);
  });

  it('respects the same scope/input behavior as getExpectedPaymentBreakdown (parity)', () => {
    const { reconciled, filteredEde } = makeScenario([
      { key: 'a', est: 12 },
      { key: 'b', est: 8 },
    ]);
    const breakdown = getExpectedPaymentBreakdown(reconciled, 'All', filteredEde, new Set());
    const expected = breakdown.unpaidRows.reduce(
      (s, r: any) => s + (typeof r.estimated_missing_commission === 'number' && Number.isFinite(r.estimated_missing_commission) ? r.estimated_missing_commission : 0),
      0,
    );
    expect(getExpectedMissingCommissionSum(reconciled, 'All', filteredEde, new Set())).toBe(expected);
  });
});
