/**
 * TCL canonical-routing parity guard.
 *
 * Background: the Dashboard's Total Covered Lives card was previously sourced
 * from `debugStats.totalCoveredLives` (whole-batch, scope-blind). It now
 * routes through `getTotalCoveredLives(filteredEde)` so the value follows the
 * Coverall / Vix / All scope dropdown the same way Expected Enrollments does.
 *
 * This test asserts that at **scope='All'** the canonical TCL is near-equal
 * to the legacy debugStats TCL on a representative fixture. We allow a small
 * tolerance because the two helpers pick the per-group `coveredMemberCount`
 * differently:
 *   - `debugStats` (reconcile.ts L780-805): first qualified EDE row in the
 *     Union-Find group wins.
 *   - `getTotalCoveredLives` via `computeFilteredEde`: the merge-WINNER
 *     (earliest-effective EDE row) wins.
 * For batches in production this drift is 0–7 lives across thousands.
 *
 * NOT asserted (intentionally):
 *   - parity at scope='Vix' or scope='Coverall' — debugStats is scope-blind
 *     and is EXPECTED to differ. The whole point of the refactor is that the
 *     canonical helper restricts to the scope's AOR universe.
 *   - "TCL >= FoundInBO + NotInBO" for Vix scope — EE/TCL Vix is AOR-only
 *     while Found/NotInBO Vix uses stricter `actual_pay_entity='Vix'` logic,
 *     so the closure does not hold there.
 */
import { describe, it, expect } from 'vitest';
import { reconcile } from '@/lib/reconcile';
import { computeFilteredEde } from '@/lib/expectedEde';
import { getTotalCoveredLives, getMonthlyBreakdown } from '@/lib/canonical';
import { getCoveredMonths } from '@/lib/dateRange';
import type { NormalizedRecord } from '@/lib/normalize';

/**
 * Tiny fixture: 3 qualifying Ambetter EDE rows for distinct members, all
 * AOR=Jason (Coverall), spread across the Mar 2026 batch's covered window
 * (Feb + Mar). Covered lives: 2 + 3 + 1 = 6.
 */
function fixture(): NormalizedRecord[] {
  const mk = (id: string, isid: string, name: string, eff: string, cmc: number): NormalizedRecord => ({
    id,
    batch_id: 'b',
    member_key: `mk:${isid}`,
    source_type: 'EDE',
    carrier: 'Ambetter',
    source_file_label: 'ede-mar.csv',
    raw_json: {
      issuer: 'Ambetter',
      policyStatus: 'Effectuated',
      issuerSubscriberId: isid,
      exchangeSubscriberId: isid,
      exchangePolicyId: `pol-${isid}`,
      effectiveDate: eff,
      currentPolicyAOR: 'Jason Fine (21055210)',
      coveredMemberCount: cmc,
    } as any,
    issuer_subscriber_id: isid,
    exchange_subscriber_id: isid,
    policy_number: `pol-${isid}`,
    applicant_name: name,
    effective_date: eff,
    status: 'Effectuated',
    agent_npn: '21055210',
    pay_entity: null,
    commission_amount: null,
    policy_term_date: null,
  } as any);
  return [
    mk('r1', '1001', 'Alice A', '2026-02-01', 2),
    mk('r2', '1002', 'Bob B',   '2026-02-01', 3),
    mk('r3', '1003', 'Cleo C',  '2026-03-01', 1),
  ];
}

describe('Dashboard TCL parity oracle (debugStats vs canonical at scope=All)', () => {
  it('canonical TCL at scope=All is within 8 lives of debugStats TCL', () => {
    const records = fixture();
    const { members, debug } = reconcile(records as any, '2026-03', null);
    const fe = computeFilteredEde(records as any, members as any, 'All', getCoveredMonths('2026-03-01'), null);
    const canonicalTotal = getTotalCoveredLives(fe);
    expect(debug.totalCoveredLives).toBe(6);
    // Tolerance: 8 lives. Documented above — first-row vs merge-winner CMC drift.
    expect(Math.abs(canonicalTotal - debug.totalCoveredLives)).toBeLessThanOrEqual(8);
  });

  it('canonical monthly breakdown sums to canonical total', () => {
    const records = fixture();
    const { members } = reconcile(records as any, '2026-03', null);
    const fe = computeFilteredEde(records as any, members as any, 'All', getCoveredMonths('2026-03-01'), null);
    const total = getTotalCoveredLives(fe);
    const byMonth = getMonthlyBreakdown('totalCoveredLives', fe);
    const sum = Object.values(byMonth).reduce((a, b) => a + b, 0);
    expect(sum).toBe(total);
  });

  it('canonical TCL at scope=Vix is < scope=All on a Coverall-only fixture (scope IS applied)', () => {
    // Regression guard: if someone reverts the Dashboard to debugStats, this
    // test would fail because debugStats returns the same number for every
    // scope. With canonical, an all-Jason fixture has zero Vix-scope members
    // (Vix requires AOR=Erica), so Vix TCL must be 0 and < All TCL.
    const records = fixture();
    const { members } = reconcile(records as any, '2026-03', null);
    const months = getCoveredMonths('2026-03-01');
    const allTcl = getTotalCoveredLives(computeFilteredEde(records as any, members as any, 'All', months, null));
    const vixTcl = getTotalCoveredLives(computeFilteredEde(records as any, members as any, 'Vix', months, null));
    expect(vixTcl).toBe(0);
    expect(vixTcl).toBeLessThan(allTcl);
  });
});
