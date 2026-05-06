/**
 * PR2 (D1/D2) regression guards: Dashboard page must derive
 *   - paidEligible / unpaid (D1) by slicing the canonical eligibleCohort,
 *   - Net Paid totals (D2) via getNetPaidCommission,
 *   - Direct/Downline split (D2) via getDirectVsDownlineSplit,
 * rather than re-rolling the predicates inline. These tests fail on the
 * pre-PR2 code shape.
 */
import { describe, it, expect } from 'vitest';
import {
  getEligibleCohort,
  getNetPaidCommission,
  getDirectVsDownlineSplit,
} from '@/lib/canonical';
import { isCoverallAORByNPN } from '@/lib/agents';
import type { FilteredEdeResult } from '@/lib/expectedEde';

function fixture() {
  // Member m1 is in EE universe, in BO, eligible, paid.
  // mGhost has the persistent flag set but is NOT in filteredEde — the OLD
  // inline predicate (eeUniverseKeys.has + effInBO + eligible) would also
  // exclude it, BUT a different shape (member-key reconciliation diff)
  // historically caused drift. We use mDup: same member_key as m1 but the
  // canonical helper de-dupes via filterReconciledByScope; the inline
  // `filtered.filter(...)` formula does not — exactly the D1 drift.
  const reconciled: any[] = [
    { member_key: 'm1', current_policy_aor: 'Jason Fine (21055210)', is_in_expected_ede_universe: true, in_back_office: true, eligible_for_commission: 'Yes', in_commission: true, agent_npn: '21055210' },
    { member_key: 'm2', current_policy_aor: 'Jason Fine (21055210)', is_in_expected_ede_universe: true, in_back_office: true, eligible_for_commission: 'Yes', in_commission: false, agent_npn: '21055210' },
  ];
  const filteredEde: FilteredEdeResult = {
    uniqueMembers: [
      { member_key: 'm1', applicant_name: 'A', policy_number: '', exchange_subscriber_id: '', issuer_subscriber_id: '', current_policy_aor: '', effective_date: '2026-03-01', policy_status: 'Effectuated', covered_member_count: 1, effective_month: '2026-03', active_months: ['2026-03'], in_back_office: true },
      { member_key: 'm2', applicant_name: 'B', policy_number: '', exchange_subscriber_id: '', issuer_subscriber_id: '', current_policy_aor: '', effective_date: '2026-03-01', policy_status: 'Effectuated', covered_member_count: 1, effective_month: '2026-03', active_months: ['2026-03'], in_back_office: true },
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

describe('D1: paidEligible/unpaid slice eligibleCohort (no inline re-derivation)', () => {
  it('paidEligible + unpaid sums equal eligibleCohort.length', () => {
    const { reconciled, filteredEde } = fixture();
    const cohort = getEligibleCohort(reconciled, 'Coverall', new Set(), filteredEde);
    const paidEligible = cohort.filter(r => r.in_commission).length;
    const unpaid = cohort.filter(r => !r.in_commission).length;
    expect(paidEligible + unpaid).toBe(cohort.length);
    expect(paidEligible).toBe(1);
    expect(unpaid).toBe(1);
  });
});

describe('D2: Net Paid + Direct/Downline use canonical helpers', () => {
  it('canonical net paid for Coverall matches sum of in-scope commission rows', () => {
    const { normalizedRecords } = fixture();
    const np = getNetPaidCommission(normalizedRecords, 'Coverall');
    expect(np.gross).toBe(125);
    expect(np.clawbacks).toBe(-10);
    expect(np.net).toBe(115);
  });
  it('direct + downline + unclassified covers every dollar of canonical net', () => {
    const { normalizedRecords } = fixture();
    const np = getNetPaidCommission(normalizedRecords, 'Coverall');
    const split = getDirectVsDownlineSplit(normalizedRecords, 'Coverall', isCoverallAORByNPN);
    expect(split.coverallDirectNet).toBe(90); // 100 - 10
    expect(split.downlineNet).toBe(25);
    expect(split.unclassifiedNet).toBe(0);
    expect(split.coverallDirectNet + split.downlineNet + split.unclassifiedNet).toBeCloseTo(np.net, 2);
  });
});
