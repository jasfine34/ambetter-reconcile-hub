import { describe, it, expect } from 'vitest';
import {
  getMembersInScope,
  filterReconciledByScope,
  filterCommissionRowsByScope,
  aorBelongsToScope,
} from '@/lib/canonical/scope';
import {
  getNetPaidCommission,
  getEligibleCohort,
  getFoundInBackOffice,
  getDirectVsDownlineSplit,
} from '@/lib/canonical/metrics';
import { runInvariants } from '@/lib/canonical/invariants';
import { isCoverallAORByNPN } from '@/lib/agents';
import { pickStableKey } from '@/lib/weakMatch';
import type { FilteredEdeResult } from '@/lib/expectedEde';

// Minimal fixture mimicking Mar 2026 Coverall scope at the shape level.
function makeFixture() {
  const reconciled: any[] = [
    {
      member_key: 'm1',
      current_policy_aor: 'Jason Fine (21055210)',
      expected_pay_entity: 'Coverall',
      actual_pay_entity: 'Coverall',
      is_in_expected_ede_universe: true,
      in_back_office: true,
      in_commission: true,
      eligible_for_commission: 'Yes',
      issuer_subscriber_id: 'U111',
      estimated_missing_commission: 0,
    },
    {
      member_key: 'm2',
      current_policy_aor: 'Becky Shuta (16531877)',
      expected_pay_entity: 'Coverall',
      actual_pay_entity: 'Coverall',
      is_in_expected_ede_universe: true,
      in_back_office: false,
      in_commission: false,
      eligible_for_commission: 'Yes',
      issuer_subscriber_id: 'U222',
      estimated_missing_commission: 0,
    },
    {
      member_key: 'm3',
      current_policy_aor: 'Erica Fine (21277051)',
      expected_pay_entity: 'Vix',
      actual_pay_entity: 'Vix',
      is_in_expected_ede_universe: true,
      in_back_office: true,
      in_commission: true,
      eligible_for_commission: 'Yes',
      issuer_subscriber_id: 'U333',
      estimated_missing_commission: 0,
    },
  ];
  const normalizedRecords: any[] = [
    // Coverall direct (Jason)
    { source_type: 'COMMISSION', pay_entity: 'Coverall', agent_npn: '21055210', commission_amount: 100 },
    // Coverall direct clawback
    { source_type: 'COMMISSION', pay_entity: 'Coverall', agent_npn: '21055210', commission_amount: -10 },
    // Downline (non-Coverall NPN paid through Coverall)
    { source_type: 'COMMISSION', pay_entity: 'Coverall', agent_npn: '99999999', commission_amount: 25 },
    // Vix row (out of Coverall scope)
    { source_type: 'COMMISSION', pay_entity: 'Vix', agent_npn: '21277051', commission_amount: 50 },
  ];
  const filteredEde: FilteredEdeResult = {
    uniqueMembers: [
      { member_key: 'm1', applicant_name: 'Alpha', policy_number: 'P1', exchange_subscriber_id: '', issuer_subscriber_id: 'U111', current_policy_aor: '', effective_date: '2026-03-01', policy_status: 'Effectuated', covered_member_count: 2, effective_month: '2026-03', active_months: ['2026-03'], in_back_office: true },
      { member_key: 'm2', applicant_name: 'Beta', policy_number: 'P2', exchange_subscriber_id: '', issuer_subscriber_id: 'U222', current_policy_aor: '', effective_date: '2026-03-01', policy_status: 'Effectuated', covered_member_count: 1, effective_month: '2026-03', active_months: ['2026-03'], in_back_office: false },
    ],
    uniqueKeys: 2,
    byMonth: { '2026-03': 2 },
    inBOCount: 1,
    notInBOCount: 1,
    missingFromBO: [
      { member_key: 'm2', applicant_name: 'Beta', policy_number: 'P2', exchange_subscriber_id: '', issuer_subscriber_id: 'U222', current_policy_aor: '', effective_date: '2026-03-01', policy_status: 'Effectuated', covered_member_count: 1, effective_month: '2026-03', active_months: ['2026-03'], in_back_office: false },
    ],
  };
  return { reconciled, normalizedRecords, filteredEde };
}

describe('canonical/scope', () => {
  it('Coverall scope picks up Coverall + Coverall_or_Vix members', () => {
    const { reconciled } = makeFixture();
    const keys = getMembersInScope(reconciled, 'Coverall');
    expect(keys.has('m1')).toBe(true);
    expect(keys.has('m2')).toBe(true);
    expect(keys.has('m3')).toBe(false);
  });

  it('All scope returns every member', () => {
    const { reconciled } = makeFixture();
    expect(getMembersInScope(reconciled, 'All').size).toBe(3);
  });

  it('aorBelongsToScope uses embedded NPN when present', () => {
    expect(aorBelongsToScope('Jason Fine (21055210)', 'Coverall')).toBe(true);
    expect(aorBelongsToScope('Some Other Agent (99999999)', 'Coverall')).toBe(false);
  });

  it('filterCommissionRowsByScope excludes non-commission rows and other entities', () => {
    const { normalizedRecords } = makeFixture();
    expect(filterCommissionRowsByScope(normalizedRecords, 'Coverall').length).toBe(3);
    expect(filterCommissionRowsByScope(normalizedRecords, 'Vix').length).toBe(1);
    expect(filterCommissionRowsByScope(normalizedRecords, 'All').length).toBe(4);
  });
});

describe('canonical/metrics', () => {
  it('Net Paid = gross - clawbacks for Coverall scope', () => {
    const { normalizedRecords } = makeFixture();
    const r = getNetPaidCommission(normalizedRecords, 'Coverall');
    expect(r.gross).toBe(125);
    expect(r.clawbacks).toBe(-10);
    expect(r.net).toBe(115);
    expect(r.rowCount).toBe(3);
  });

  it('Direct vs downline split sums to Net Paid (Coverall)', () => {
    const { normalizedRecords } = makeFixture();
    const split = getDirectVsDownlineSplit(normalizedRecords, 'Coverall', isCoverallAORByNPN);
    expect(split.coverallDirectNet).toBe(90); // 100 - 10
    expect(split.downlineNet).toBe(25);
    expect(split.coverallDirectNet + split.downlineNet).toBe(
      getNetPaidCommission(normalizedRecords, 'Coverall').net,
    );
  });

  it('Eligible cohort excludes members not in BO unless confirmed', () => {
    const { reconciled } = makeFixture();
    const noUpgrade = getEligibleCohort(reconciled, 'Coverall', new Set());
    expect(noUpgrade.map((r) => r.member_key)).toEqual(['m1']);
    const withUpgrade = getEligibleCohort(reconciled, 'Coverall', new Set(['m2']));
    expect(withUpgrade.map((r) => r.member_key).sort()).toEqual(['m1', 'm2']);
  });

  it('Found in BO reflects confirmed weak-match upgrades', () => {
    const { reconciled, filteredEde } = makeFixture();
    const before = getFoundInBackOffice(reconciled, 'Coverall', filteredEde, new Set());
    const after = getFoundInBackOffice(reconciled, 'Coverall', filteredEde, new Set(['m2']));
    expect(after - before).toBe(1);
  });
});

describe('canonical/invariants', () => {
  it('all checks pass on a clean fixture (Coverall scope)', () => {
    const { reconciled, normalizedRecords, filteredEde } = makeFixture();
    const results = runInvariants({
      reconciled,
      normalizedRecords,
      filteredEde,
      confirmedUpgradeMemberKeys: new Set(),
      confirmedWeakMatchOverrideKeys: new Set(),
      weakMatchPendingOverrideKeys: new Set(),
      scope: 'Coverall',
      pickStableKey,
      isCoverallNpn: isCoverallAORByNPN,
    });
    const failures = results.filter((r) => r.status === 'fail');
    expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
  });
});
