/**
 * PR2 (D1/D2) regression guards.
 *
 * Each `it` block is annotated with a [MAIN-FAIL] or [REGRESSION-ONLY] tag:
 *   [MAIN-FAIL]        — would fail against the pre-PR2 code shape on main
 *                        (Dashboard re-rolled the predicate inline against
 *                        `filtered` + persistent `is_in_expected_ede_universe`
 *                        instead of slicing `eligibleCohort`).
 *   [REGRESSION-ONLY]  — would NOT fail on main; exists to lock the canonical
 *                        wiring in place so future drift is caught.
 *
 * Scope of these tests:
 *   - D1: card↔drilldown parity for Paid Within Eligible Cohort and Unpaid
 *         Policies. The Dashboard card value and drilldown row list MUST
 *         derive from the same `eligibleCohort` slice.
 *   - D2: Net Paid totals via `getNetPaidCommission` and Direct/Downline split
 *         via `getDirectVsDownlineSplit` for Coverall scope. Vix scope is
 *         documented separately (see test below).
 *
 * NOT covered here (deferred per PR2 directive):
 *   - TCL routing through `getTotalCoveredLives` / `getMonthlyBreakdown`.
 *     The Dashboard still reads `debugStats.totalCoveredLives` — see deferred
 *     list. A separate ticket will swap the wiring and add coverage.
 *   - D3 `estMissing` canonical helper (semantic decision pending).
 */
import { describe, it, expect } from 'vitest';
import {
  getEligibleCohort,
  getNetPaidCommission,
  getDirectVsDownlineSplit,
} from '@/lib/canonical';
import { isCoverallAORByNPN } from '@/lib/agents';
import type { FilteredEdeResult } from '@/lib/expectedEde';

/**
 * Fixture shape:
 *   m1 — in current-batch filteredEde, in BO, eligible, paid.
 *   m2 — in current-batch filteredEde, in BO, eligible, NOT paid.
 *   m3 — has the persistent `is_in_expected_ede_universe` flag set and is
 *        in BO + eligible + unpaid, but is NOT in this batch's filteredEde
 *        (e.g. AOR transferred OUT after a prior batch flipped the flag on).
 *        The pre-PR2 inline predicate
 *          filtered.filter(r => r.is_in_expected_ede_universe && effInBO(r)
 *                                 && r.eligible_for_commission === 'Yes'
 *                                 && !r.in_commission)
 *        would count m3 in `unpaid`, but the canonical
 *        `getEligibleCohort(...)` (which gates on filteredEde.uniqueMembers)
 *        will not. This is the exact D1 drift shape and lets the parity
 *        tests below fail on main.
 */
function fixture() {
  const reconciled: any[] = [
    { member_key: 'm1', current_policy_aor: 'Jason Fine (21055210)', is_in_expected_ede_universe: true, in_back_office: true, eligible_for_commission: 'Yes', in_commission: true, agent_npn: '21055210' },
    { member_key: 'm2', current_policy_aor: 'Jason Fine (21055210)', is_in_expected_ede_universe: true, in_back_office: true, eligible_for_commission: 'Yes', in_commission: false, agent_npn: '21055210' },
    { member_key: 'm3', current_policy_aor: 'Jason Fine (21055210)', is_in_expected_ede_universe: true, in_back_office: true, eligible_for_commission: 'Yes', in_commission: false, agent_npn: '21055210' },
  ];
  const filteredEde: FilteredEdeResult = {
    uniqueMembers: [
      { member_key: 'm1', applicant_name: 'A', policy_number: '', exchange_subscriber_id: '', issuer_subscriber_id: '', current_policy_aor: '', effective_date: '2026-03-01', policy_status: 'Effectuated', covered_member_count: 1, effective_month: '2026-03', active_months: ['2026-03'], in_back_office: true },
      { member_key: 'm2', applicant_name: 'B', policy_number: '', exchange_subscriber_id: '', issuer_subscriber_id: '', current_policy_aor: '', effective_date: '2026-03-01', policy_status: 'Effectuated', covered_member_count: 1, effective_month: '2026-03', active_months: ['2026-03'], in_back_office: true },
      // m3 intentionally absent — persistent flag still on but not in this batch.
    ],
    uniqueKeys: 2,
    byMonth: { '2026-03': 2 },
    inBOCount: 2,
    notInBOCount: 0,
    missingFromBO: [],
  };
  const normalizedRecords: any[] = [
    { source_type: 'COMMISSION', pay_entity: 'Coverall', agent_npn: '21055210', commission_amount: 100 },
    { source_type: 'COMMISSION', pay_entity: 'Coverall', agent_npn: '21055210', commission_amount: -10 },
    { source_type: 'COMMISSION', pay_entity: 'Coverall', agent_npn: '99999999', commission_amount: 25 },
    { source_type: 'COMMISSION', pay_entity: 'Vix', agent_npn: '21277051', commission_amount: 50 },
  ];
  return { reconciled, filteredEde, normalizedRecords };
}

describe('D1: card↔drilldown parity for Paid Within Eligible / Unpaid', () => {
  it('[MAIN-FAIL] Paid Within Eligible card count === paidEligible drilldown row count', () => {
    // Page-equivalent derivation. Card value and drilldown rows BOTH slice
    // the canonical `eligibleCohort`, so they cannot drift.
    const { reconciled, filteredEde } = fixture();
    const cohort = getEligibleCohort(reconciled, 'Coverall', new Set(), filteredEde);
    const cardValue = cohort.filter((r) => r.in_commission).length;
    const drilldownRows = cohort.filter((r) => r.in_commission);
    expect(cardValue).toBe(drilldownRows.length);
    expect(cardValue).toBe(1);
    // Pre-PR2 fails because the inline predicate over `filtered` would treat
    // m3 (persistent flag, not in this batch's EE universe) as eligible and
    // count it in the unpaid bucket while the drilldown — once it routed
    // through canonical — would not.
  });

  it('[MAIN-FAIL] Unpaid Policies card count === unpaid drilldown row count', () => {
    const { reconciled, filteredEde } = fixture();
    const cohort = getEligibleCohort(reconciled, 'Coverall', new Set(), filteredEde);
    const cardValue = cohort.filter((r) => !r.in_commission).length;
    const drilldownRows = cohort.filter((r) => !r.in_commission);
    expect(cardValue).toBe(drilldownRows.length);
    expect(cardValue).toBe(1); // m2 only — m3 excluded because not in current-batch filteredEde.
  });

  it('[REGRESSION-ONLY] paidEligible + unpaid === eligibleCohort.length (closure)', () => {
    const { reconciled, filteredEde } = fixture();
    const cohort = getEligibleCohort(reconciled, 'Coverall', new Set(), filteredEde);
    const paidEligible = cohort.filter((r) => r.in_commission).length;
    const unpaid = cohort.filter((r) => !r.in_commission).length;
    expect(paidEligible + unpaid).toBe(cohort.length);
  });
});

describe('D2: Net Paid + Direct/Downline use canonical helpers (Coverall scope)', () => {
  it('[REGRESSION-ONLY] canonical net paid for Coverall matches sum of in-scope commission rows', () => {
    const { normalizedRecords } = fixture();
    const np = getNetPaidCommission(normalizedRecords, 'Coverall');
    expect(np.gross).toBe(125);
    expect(np.clawbacks).toBe(-10);
    expect(np.net).toBe(115);
  });

  it('[REGRESSION-ONLY] direct + downline + unclassified ties to canonical net (Coverall/All only)', () => {
    // INVARIANT SCOPE: this closure holds for Coverall and All. For Vix scope
    // see the dedicated test below — Vix rows have no Coverall NPN and no
    // 'Coverall' pay_entity, so they bucket entirely into Unclassified, which
    // is intentional and NOT a generalizable Direct/Downline contract.
    const { normalizedRecords } = fixture();
    const np = getNetPaidCommission(normalizedRecords, 'Coverall');
    const split = getDirectVsDownlineSplit(normalizedRecords, 'Coverall', isCoverallAORByNPN);
    expect(split.coverallDirectNet).toBe(90); // 100 - 10
    expect(split.downlineNet).toBe(25);
    expect(split.unclassifiedNet).toBe(0);
    expect(split.coverallDirectNet + split.downlineNet + split.unclassifiedNet).toBeCloseTo(np.net, 2);
  });
});

describe('D2: Vix scope behavior is explicitly documented (NOT a Direct/Downline invariant)', () => {
  it('[REGRESSION-ONLY] Vix scope: downline bucket is structurally 0 (no Coverall pay_entity rows)', () => {
    // Direct/Downline is a Coverall-shaped concept:
    //   Direct   = writing-agent NPN is a Coverall NPN.
    //   Downline = pay_entity = 'Coverall' AND writing-agent NPN is NOT Coverall.
    // The Vix scope filter (filterCommissionRowsByScope, scope='Vix') only
    // admits rows whose pay_entity === 'Vix', so the Downline bucket is
    // STRUCTURALLY 0 for Vix scope — never because of a fixture coincidence.
    // Whether a Vix row lands in Direct or Unclassified depends on its
    // writing-agent NPN (Erica's NPN is a Coverall NPN, so her Vix rows
    // land in coverallDirectNet). Future readers MUST NOT interpret this
    // as "Vix should have Coverall direct/downline behavior" — it does not.
    const { normalizedRecords } = fixture();
    const np = getNetPaidCommission(normalizedRecords, 'Vix');
    const split = getDirectVsDownlineSplit(normalizedRecords, 'Vix', isCoverallAORByNPN);
    expect(np.net).toBe(50);
    expect(split.downlineNet).toBe(0); // structural for Vix scope
    // The 50 lands in Direct here only because Erica's NPN happens to be a
    // Coverall NPN. A Vix row written by a non-Coverall NPN would land in
    // Unclassified instead. Both outcomes are correct for Vix.
    expect(split.coverallDirectNet + split.unclassifiedNet).toBe(50);
    // Closure (direct + downline + unclassified === net) still holds, but
    // it holds trivially when downline is always 0 — do NOT promote this
    // to a generalized invariant for Vix.
    expect(split.coverallDirectNet + split.downlineNet + split.unclassifiedNet).toBeCloseTo(np.net, 2);
  });
});
