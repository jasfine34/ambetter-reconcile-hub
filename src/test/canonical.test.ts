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
      // Not in EE-universe fixture — kept out of Found/Eligible counts so the
      // Coverall-scope invariant balances against the 2-member filteredEde.
      is_in_expected_ede_universe: false,
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
  it('Coverall scope = AOR is any Coverall NPN (Jason/Erica/Becky)', () => {
    const { reconciled } = makeFixture();
    const keys = getMembersInScope(reconciled, 'Coverall');
    // Per canonical rule (2026.04.27): Erica's NPN is a Coverall NPN, so a
    // member with Erica AOR is in Coverall scope regardless of pay entity.
    expect(keys.has('m1')).toBe(true);
    expect(keys.has('m2')).toBe(true);
    expect(keys.has('m3')).toBe(true);
  });

  it('Vix scope = AOR is Erica AND member appears on Vix commission', () => {
    const { reconciled } = makeFixture();
    const keys = getMembersInScope(reconciled, 'Vix');
    expect(keys.has('m1')).toBe(false);
    expect(keys.has('m2')).toBe(false);
    expect(keys.has('m3')).toBe(true);
  });

  it('All scope = AOR is Coverall NPN OR pay-entity is Vix', () => {
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

  it('Found in BO uses filteredEde universe, NOT persistent is_in_expected_ede_universe flag', () => {
    // Regression for 2026.04.28-ee-universe-align: a member flagged
    // is_in_expected_ede_universe=true from a prior batch but absent from
    // THIS batch's filteredEde.uniqueMembers must be EXCLUDED from Found.
    const reconciled: any[] = [
      // m1: in filteredEde + in BO -> counted.
      {
        member_key: 'm1',
        current_policy_aor: 'Jason Fine (21055210)',
        is_in_expected_ede_universe: true,
        in_back_office: true,
        eligible_for_commission: 'Yes',
      },
      // mGhost: persistent flag=true (carryover from prior batch), in BO,
      // but NOT in filteredEde for THIS batch. Must be excluded.
      {
        member_key: 'mGhost',
        current_policy_aor: 'Jason Fine (21055210)',
        is_in_expected_ede_universe: true,
        in_back_office: true,
        eligible_for_commission: 'Yes',
      },
    ];
    const filteredEde: FilteredEdeResult = {
      uniqueMembers: [
        { member_key: 'm1', applicant_name: 'Alpha', policy_number: 'P1', exchange_subscriber_id: '', issuer_subscriber_id: 'U111', current_policy_aor: '', effective_date: '2026-03-01', policy_status: 'Effectuated', covered_member_count: 1, effective_month: '2026-03', active_months: ['2026-03'], in_back_office: true },
      ],
      uniqueKeys: 1,
      byMonth: { '2026-03': 1 },
      inBOCount: 1,
      notInBOCount: 0,
      missingFromBO: [],
    };
    const found = getFoundInBackOffice(reconciled, 'Coverall', filteredEde, new Set());
    expect(found).toBe(1); // only m1, NOT mGhost
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

/**
 * Option A alignment regression (2026-04-28): computeFilteredEde must use
 * aorPicker.pickCurrentPolicyAor as the single source of truth for "which
 * EDE row represents this member" — same sort order reconcile.ts uses to
 * write reconciled.current_policy_aor.
 *
 * Fixture mirrors the Marjorie McCoy / Anselmo Fishburne shape on April 2026:
 *   - Row A: Effectuated, past-month effective_date, NON-Coverall AOR.
 *   - Row B: PendingEffectuation, current-month effective_date, Coverall AOR.
 * The picker prefers Row A (Effectuated > PendingEffectuation), so the
 * canonical AOR is non-Coverall ⇒ member is OUT of EE universe under
 * Coverall scope. Pre-fix, the per-row scope filter would let Row B in and
 * the member would appear in EE universe but get a non-Coverall AOR in
 * reconciled (the AOR-drift residual that produced the −2 invariant on April).
 */
describe('expectedEde — Option A alignment with aorPicker', () => {
  it('multi-EDE Marjorie/Anselmo shape: member excluded from Coverall EE universe', async () => {
    const { computeFilteredEde } = await import('@/lib/expectedEde');
    const normalized: any[] = [
      {
        id: 'r1', source_type: 'EDE', source_file_label: 'EDE Summary',
        carrier: 'Ambetter', applicant_name: 'Marjorie McCoy',
        effective_date: '2026-02-01', status: 'Effectuated',
        member_key: 'mk:marjorie',
        raw_json: { issuer: 'Ambetter', policyStatus: 'Effectuated', effectiveDate: '2026-02-01', currentPolicyAOR: 'Some Other Agent (99999999)', exchangeSubscriberId: 'EX-1' },
      },
      {
        id: 'r2', source_type: 'EDE', source_file_label: 'EDE Summary',
        carrier: 'Ambetter', applicant_name: 'Marjorie McCoy',
        effective_date: '2026-04-01', status: 'PendingEffectuation',
        member_key: 'mk:marjorie',
        raw_json: { issuer: 'Ambetter', policyStatus: 'PendingEffectuation', effectiveDate: '2026-04-01', currentPolicyAOR: 'Jason Fine (21055210)', exchangeSubscriberId: 'EX-1' },
      },
    ];
    const reconciled = [
      { member_key: 'mk:marjorie', applicant_name: 'Marjorie McCoy', exchange_subscriber_id: 'EX-1', issuer_subscriber_id: '', policy_number: '', in_back_office: false },
    ];
    const result = computeFilteredEde(normalized, reconciled as any, 'Coverall', ['2026-04']);
    // Picker selects the Effectuated row → AOR is non-Coverall → member OUT.
    // Pre-fix this would be 1 (per-row scope filter let the Pending row in).
    expect(result.uniqueKeys).toBe(0);
  });

  it('multi-EDE member with Effectuated Coverall row IS in Coverall EE universe', async () => {
    const { computeFilteredEde } = await import('@/lib/expectedEde');
    const normalized: any[] = [
      {
        id: 'r1', source_type: 'EDE', source_file_label: 'EDE Summary',
        carrier: 'Ambetter', applicant_name: 'Test Member',
        effective_date: '2026-02-01', status: 'Effectuated',
        member_key: 'mk:t',
        raw_json: { issuer: 'Ambetter', policyStatus: 'Effectuated', effectiveDate: '2026-02-01', currentPolicyAOR: 'Jason Fine (21055210)', exchangeSubscriberId: 'EX-2' },
      },
      {
        id: 'r2', source_type: 'EDE', source_file_label: 'EDE Summary',
        carrier: 'Ambetter', applicant_name: 'Test Member',
        effective_date: '2026-04-01', status: 'PendingEffectuation',
        member_key: 'mk:t',
        raw_json: { issuer: 'Ambetter', policyStatus: 'PendingEffectuation', effectiveDate: '2026-04-01', currentPolicyAOR: 'Some Other Agent (99999999)', exchangeSubscriberId: 'EX-2' },
      },
    ];
    const reconciled = [
      { member_key: 'mk:t', applicant_name: 'Test Member', exchange_subscriber_id: 'EX-2', issuer_subscriber_id: '', policy_number: '', in_back_office: true },
    ];
    const result = computeFilteredEde(normalized, reconciled as any, 'Coverall', ['2026-04']);
    expect(result.uniqueKeys).toBe(1);
    // Surfaced AOR == picker's choice (the Effectuated/Coverall row).
    expect(result.uniqueMembers[0].current_policy_aor).toBe('Jason Fine (21055210)');
  });

  it('alignment guarantee: EE universe AOR == aorPicker AOR for every member', async () => {
    const { computeFilteredEde } = await import('@/lib/expectedEde');
    const { pickCurrentPolicyAor } = await import('@/lib/aorPicker');

    const normalized: any[] = [
      // Member A: Marjorie shape (out of Coverall scope)
      { id: 'a1', source_type: 'EDE', source_file_label: 'EDE Summary', carrier: 'Ambetter', applicant_name: 'A', effective_date: '2026-02-01', status: 'Effectuated', member_key: 'mk:A', raw_json: { issuer: 'Ambetter', policyStatus: 'Effectuated', effectiveDate: '2026-02-01', currentPolicyAOR: 'Other Agent (99999999)', exchangeSubscriberId: 'EXA' } },
      { id: 'a2', source_type: 'EDE', source_file_label: 'EDE Summary', carrier: 'Ambetter', applicant_name: 'A', effective_date: '2026-04-01', status: 'PendingEffectuation', member_key: 'mk:A', raw_json: { issuer: 'Ambetter', policyStatus: 'PendingEffectuation', effectiveDate: '2026-04-01', currentPolicyAOR: 'Jason Fine (21055210)', exchangeSubscriberId: 'EXA' } },
      // Member B: single-row Coverall (in scope)
      { id: 'b1', source_type: 'EDE', source_file_label: 'EDE Summary', carrier: 'Ambetter', applicant_name: 'B', effective_date: '2026-04-01', status: 'Effectuated', member_key: 'mk:B', raw_json: { issuer: 'Ambetter', policyStatus: 'Effectuated', effectiveDate: '2026-04-01', currentPolicyAOR: 'Becky Shuta (16531877)', exchangeSubscriberId: 'EXB' } },
    ];
    const reconciled = [
      { member_key: 'mk:A', applicant_name: 'A', exchange_subscriber_id: 'EXA', issuer_subscriber_id: '', policy_number: '', in_back_office: false },
      { member_key: 'mk:B', applicant_name: 'B', exchange_subscriber_id: 'EXB', issuer_subscriber_id: '', policy_number: '', in_back_office: true },
    ];
    const ede = computeFilteredEde(normalized, reconciled as any, 'Coverall', ['2026-04']);

    // Structural alignment: every surfaced AOR must equal the picker's AOR
    // computed over the member's full EDE row set.
    for (const m of ede.uniqueMembers) {
      const memberRows = normalized.filter((r) => r.member_key === m.member_key);
      const pickerAor = pickCurrentPolicyAor(memberRows as any);
      expect(m.current_policy_aor).toBe(pickerAor);
    }
    expect(ede.uniqueKeys).toBe(1);
    expect(ede.uniqueMembers[0].member_key).toBe('mk:B');
  });
});
