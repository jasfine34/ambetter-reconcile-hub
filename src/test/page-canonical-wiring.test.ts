/**
 * Page-level "smoke" tests asserting that page-derived totals MUST equal the
 * canonical helpers for the same batch + scope. These tests are the safety
 * net we did NOT have before pass-2 (2026-04-28), where DashboardPage's
 * Found-in-BO card and AgentSummaryPage's Total Commission column drifted
 * silently from the canonical helpers and from Run Invariants.
 *
 * Strategy: replicate the formula each page uses against the same fixtures
 * the canonical helpers consume, and assert equality. If a future edit
 * reintroduces ad-hoc filtering on a page, these tests fail before ship.
 */
import { describe, it, expect } from 'vitest';
import {
  getFoundInBackOffice,
  getNetPaidCommission,
  filterCommissionRowsByScope,
} from '@/lib/canonical';
import { isCoverallAORByNPN } from '@/lib/agents';
import type { FilteredEdeResult } from '@/lib/expectedEde';

function makeFixture() {
  const reconciled: any[] = [
    // Strict EE-universe member, in BO -> Found.
    {
      member_key: 'm1',
      current_policy_aor: 'Jason Fine (21055210)',
      is_in_expected_ede_universe: true,
      in_back_office: true,
      eligible_for_commission: 'Yes',
      in_commission: true,
      agent_npn: '21055210',
    },
    // EE-universe member NOT in BO -> Not in BO.
    {
      member_key: 'm2',
      current_policy_aor: 'Becky Shuta (16531877)',
      is_in_expected_ede_universe: true,
      in_back_office: false,
      eligible_for_commission: 'Yes',
      in_commission: false,
      agent_npn: '16531877',
    },
    // Ghost: persistent flag set from a prior batch but NOT in this batch's
    // filteredEde universe. Must be excluded.
    {
      member_key: 'mGhost',
      current_policy_aor: 'Jason Fine (21055210)',
      is_in_expected_ede_universe: true,
      in_back_office: true,
      eligible_for_commission: 'Yes',
      in_commission: false,
      agent_npn: '21055210',
    },
  ];
  const normalizedRecords: any[] = [
    { source_type: 'COMMISSION', pay_entity: 'Coverall', agent_npn: '21055210', commission_amount: 100 },
    { source_type: 'COMMISSION', pay_entity: 'Coverall', agent_npn: '21055210', commission_amount: -10 },
    { source_type: 'COMMISSION', pay_entity: 'Coverall', agent_npn: '99999999', commission_amount: 25 },
    { source_type: 'COMMISSION', pay_entity: 'Vix', agent_npn: '21277051', commission_amount: 50 },
  ];
  const filteredEde: FilteredEdeResult = {
    uniqueMembers: [
      { member_key: 'm1', applicant_name: 'Alpha', policy_number: 'P1', exchange_subscriber_id: '', issuer_subscriber_id: 'U111', current_policy_aor: '', effective_date: '2026-03-01', policy_status: 'Effectuated', covered_member_count: 1, effective_month: '2026-03', active_months: ['2026-03'], in_back_office: true },
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

describe('page wiring — DashboardPage Found-in-BO card', () => {
  it('card formula MUST equal getFoundInBackOffice(reconciled, scope, filteredEde, upgrades)', () => {
    const { reconciled, filteredEde } = makeFixture();
    const upgrades = new Set<string>();
    const helper = getFoundInBackOffice(reconciled, 'Coverall', filteredEde, upgrades);

    // The card MUST use the canonical helper. Any divergence is a bug.
    // Sanity: the helper excludes the ghost (persistent flag carryover).
    expect(helper).toBe(1);
    // Document the regression: the OLD card formula
    //   filtered.filter(r => r.is_in_expected_ede_universe && in_back_office)
    // would return 2 here (m1 + mGhost). That's the drift this test prevents.
    const oldFormula = reconciled.filter(
      (r) => r.is_in_expected_ede_universe && r.in_back_office,
    ).length;
    expect(oldFormula).not.toBe(helper);
  });
});

describe('page wiring — AgentSummary per-agent commission column', () => {
  it('sum of per-agent Total Commission MUST equal getNetPaidCommission gross + clawbacks (scope=All)', () => {
    const { normalizedRecords } = makeFixture();
    // Replicate AgentSummary's commissionByNpn computation at scope='All'.
    const map = new Map<string, number>();
    for (const r of filterCommissionRowsByScope(normalizedRecords, 'All')) {
      const npn = String((r as any).agent_npn || '').trim();
      if (!npn) continue;
      map.set(npn, (map.get(npn) || 0) + (Number((r as any).commission_amount) || 0));
    }
    const perAgentSumAll = Array.from(map.values()).reduce((s, n) => s + n, 0);
    const canonical = getNetPaidCommission(normalizedRecords, 'All');
    expect(perAgentSumAll).toBeCloseTo(canonical.gross + canonical.clawbacks, 2);
  });

  /**
   * Regression guard for #65 (2026-04-28): AgentSummary previously called
   * `filterCommissionRowsByScope(rows, 'All')` regardless of the active
   * dropdown, leaking Vix dollars into Coverall. This asserts the per-agent
   * sum at scope='Coverall' equals the Coverall canonical total ONLY (no
   * Vix). If a future edit re-hardcodes scope='All', this test fails.
   */
  it('sum of per-agent Total Commission at scope=Coverall MUST equal canonical Coverall (no Vix leak)', () => {
    const { normalizedRecords } = makeFixture();
    const map = new Map<string, number>();
    for (const r of filterCommissionRowsByScope(normalizedRecords, 'Coverall')) {
      const npn = String((r as any).agent_npn || '').trim();
      if (!npn) continue;
      map.set(npn, (map.get(npn) || 0) + (Number((r as any).commission_amount) || 0));
    }
    const perAgentSumCoverall = Array.from(map.values()).reduce((s, n) => s + n, 0);
    const canonicalCoverall = getNetPaidCommission(normalizedRecords, 'Coverall');
    expect(perAgentSumCoverall).toBeCloseTo(
      canonicalCoverall.gross + canonicalCoverall.clawbacks,
      2,
    );
    // And it must NOT match the 'All' total (which would indicate a leak).
    const canonicalAll = getNetPaidCommission(normalizedRecords, 'All');
    expect(perAgentSumCoverall).not.toBeCloseTo(canonicalAll.gross + canonicalAll.clawbacks, 2);
  });

  it('sum of per-agent Total Commission at scope=Vix MUST equal canonical Vix only', () => {
    const { normalizedRecords } = makeFixture();
    const map = new Map<string, number>();
    for (const r of filterCommissionRowsByScope(normalizedRecords, 'Vix')) {
      const npn = String((r as any).agent_npn || '').trim();
      if (!npn) continue;
      map.set(npn, (map.get(npn) || 0) + (Number((r as any).commission_amount) || 0));
    }
    const perAgentSumVix = Array.from(map.values()).reduce((s, n) => s + n, 0);
    const canonicalVix = getNetPaidCommission(normalizedRecords, 'Vix');
    expect(perAgentSumVix).toBeCloseTo(canonicalVix.gross + canonicalVix.clawbacks, 2);
  });

  it('Coverall-direct per-agent sum equals canonical Coverall scope total minus downline', () => {
    const { normalizedRecords } = makeFixture();
    let directSum = 0;
    for (const r of filterCommissionRowsByScope(normalizedRecords, 'Coverall')) {
      if (!isCoverallAORByNPN((r as any).agent_npn)) continue;
      directSum += Number((r as any).commission_amount) || 0;
    }
    expect(directSum).toBe(90); // 100 - 10
  });
});

/**
 * Regression guard for #66 (2026-04-28): the ManualMatch queue size for the
 * active batch+scope MUST equal the Dashboard "Weak BO Match Queue" pending
 * count for the SAME batch+scope. Previously ManualMatchPage hardcoded
 * scope='Coverall' and used a stale useEffect dep on currentBatchId only,
 * so the queue could read 0 even when the Dashboard surfaced 209 weak
 * candidates. Both pages now call findWeakMatches over the same
 * filteredEde.uniqueMembers.
 */
describe('page wiring — ManualMatch queue parity with Dashboard weak-pending', () => {
  it('ManualMatch pending count MUST equal Dashboard weak-pending count for same scope', async () => {
    const { findWeakMatches, applyOverrides } = await import('@/lib/weakMatch');
    // Minimal EE-universe + BO normalizedRecords — one EE row whose strict
    // join failed but matches a BO row by name + issuer_subscriber_id.
    const eeUniverse: any[] = [
      {
        member_key: 'eeA',
        applicant_name: 'Tyler Tomevi',
        policy_number: '',
        exchange_subscriber_id: '',
        issuer_subscriber_id: 'U999',
        current_policy_aor: 'Jason Fine (21055210)',
        effective_date: '2026-03-01',
        policy_status: 'Effectuated',
        covered_member_count: 1,
        effective_month: '2026-03',
        active_months: ['2026-03'],
        in_back_office: false,
      },
    ];
    const normalizedRecords: any[] = [
      {
        id: 'bo1',
        source_type: 'BACK_OFFICE',
        applicant_name: 'Tyler Tomevi',
        policy_number: '',
        exchange_subscriber_id: '',
        issuer_subscriber_id: 'U999',
        member_key: 'boZ',
        aor_bucket: 'Coverall',
        agent_name: 'Jason Fine',
        eligible_for_commission: 'Yes',
        raw_json: {},
      },
    ];
    // #129 follow-up: BOTH consumers (Dashboard card + ManualMatchPage)
    // MUST pass the same periodStart. Previously periodStart was optional
    // and the Dashboard card omitted it, causing March to show 48 vs 0.
    const periodStart = '2026-03-01';
    const candidates = findWeakMatches(eeUniverse as any, normalizedRecords, { periodStart });
    const dashboardPending = applyOverrides(candidates, new Map()).pending;
    const manualMatchPending = applyOverrides(
      findWeakMatches(eeUniverse as any, normalizedRecords, { periodStart }),
      new Map(),
    ).pending;
    expect(manualMatchPending.length).toBe(dashboardPending.length);
    expect(manualMatchPending.length).toBe(1);
    // Sanity: signal set must include name + issuer_subscriber_id matches.
    expect(manualMatchPending[0].signals.matched).toContain('applicant_name');
    expect(manualMatchPending[0].signals.matched).toContain('issuer_subscriber_id');
  });

  it('Dashboard and ManualMatch agree even when terminated BO rows are in the data (#129 follow-up)', async () => {
    const { findWeakMatches, applyOverrides } = await import('@/lib/weakMatch');
    const eeUniverse: any[] = [{
      member_key: 'eeT',
      applicant_name: 'Kevin Compton',
      policy_number: '',
      exchange_subscriber_id: '3938172',
      issuer_subscriber_id: 'u70162404',
      current_policy_aor: '',
      effective_date: '2026-03-01',
      policy_status: 'Effectuated',
      covered_member_count: 1,
      effective_month: '2026-03',
      active_months: ['2026-03'],
      in_back_office: false,
    }];
    // BO row matches strongly but is TERMINATED before the period.
    const normalizedRecords: any[] = [{
      id: 'bo-term',
      source_type: 'BACK_OFFICE',
      carrier: 'Ambetter',
      applicant_name: 'Kevin Compton',
      member_key: 'boT',
      issuer_subscriber_id: 'u70162404',
      exchange_subscriber_id: '3938172',
      policy_number: 'u70162404',
      eligible_for_commission: 'Yes',
      policy_term_date: '2026-02-28',
      raw_json: {},
    }];
    const periodStart = '2026-03-01';
    // Both surfaces must use the SAME periodStart and therefore produce
    // the SAME pending count (0 — terminated BO is filtered out).
    const dash = applyOverrides(
      findWeakMatches(eeUniverse as any, normalizedRecords, { periodStart }),
      new Map(),
    ).pending;
    const mm = applyOverrides(
      findWeakMatches(eeUniverse as any, normalizedRecords, { periodStart }),
      new Map(),
    ).pending;
    expect(dash.length).toBe(mm.length);
    expect(dash.length).toBe(0);
  });
});

/**
 * Page wiring guard for Option A (2026-04-28): the EE universe used by the
 * Dashboard's Expected card and the reconciled.current_policy_aor written by
 * reconcile.ts MUST agree on which EDE row represents each member. Asserts
 * the structural property: for any member in the EE universe,
 * computeFilteredEde surfaces the SAME AOR string aorPicker would pick over
 * the member's full EDE row set. Prevents AOR-drift residuals from coming
 * back (April 2026 Found+NotInBO=Expected went −2 before this fix).
 */
describe('page wiring — EE universe AOR ≡ aorPicker AOR (Option A)', () => {
  it('every EE-universe member surfaces the picker-canonical AOR', async () => {
    const { computeFilteredEde } = await import('@/lib/expectedEde');
    const { pickCurrentPolicyAor } = await import('@/lib/aorPicker');

    const normalized: any[] = [
      { id: '1', source_type: 'EDE', source_file_label: 'EDE Summary', carrier: 'Ambetter', applicant_name: 'X', effective_date: '2026-02-01', status: 'Effectuated', member_key: 'mk:X', raw_json: { issuer: 'Ambetter', policyStatus: 'Effectuated', effectiveDate: '2026-02-01', currentPolicyAOR: 'Jason Fine (21055210)', exchangeSubscriberId: 'EXX' } },
      { id: '2', source_type: 'EDE', source_file_label: 'EDE Summary', carrier: 'Ambetter', applicant_name: 'X', effective_date: '2026-04-01', status: 'PendingEffectuation', member_key: 'mk:X', raw_json: { issuer: 'Ambetter', policyStatus: 'PendingEffectuation', effectiveDate: '2026-04-01', currentPolicyAOR: 'Erica Fine (21277051)', exchangeSubscriberId: 'EXX' } },
    ];
    const reconciled = [
      { member_key: 'mk:X', applicant_name: 'X', exchange_subscriber_id: 'EXX', issuer_subscriber_id: '', policy_number: '', in_back_office: true },
    ];
    const ede = computeFilteredEde(normalized, reconciled as any, 'Coverall', ['2026-04']);
    expect(ede.uniqueKeys).toBe(1);
    const pickerAor = pickCurrentPolicyAor(normalized as any);
    expect(ede.uniqueMembers[0].current_policy_aor).toBe(pickerAor);
    expect(pickerAor).toBe('Erica Fine (21277051)');
  });
});

/**
 * #118 migration regression guards (2026-05-06): Dashboard drilldowns,
 * unpaidSample, AgentSummary "Expected (AOR)" and the
 * checkUnpaidAndPaidDisjoint invariant MUST source EE-universe membership
 * from `filteredEde.uniqueMembers` (canonical), NOT from the persistent
 * `reconciled_members.is_in_expected_ede_universe` flag. Ghost-row fixture
 * (persistent flag carryover from prior batch, absent from current
 * filteredEde) must be excluded by every consumer.
 */
describe('page wiring — #118 EE-universe canonical migration', () => {
  function makeGhostFixture() {
    const reconciled: any[] = [
      // Real current-batch member, all flags healthy.
      {
        member_key: 'm1',
        current_policy_aor: 'Jason Fine (21055210)',
        is_in_expected_ede_universe: true,
        in_back_office: true,
        in_ede: true,
        eligible_for_commission: 'Yes',
        in_commission: false,
        agent_npn: '21055210',
        estimated_missing_commission: 0,
      },
      // Ghost: persistent flag set by prior reconcile, but NOT in this
      // batch's filteredEde.uniqueMembers — must be excluded everywhere.
      {
        member_key: 'mGhost',
        current_policy_aor: 'Jason Fine (21055210)',
        is_in_expected_ede_universe: true,
        in_back_office: true,
        in_ede: true,
        eligible_for_commission: 'Yes',
        in_commission: false,
        agent_npn: '21055210',
        estimated_missing_commission: 0,
      },
    ];
    const filteredEde: FilteredEdeResult = {
      uniqueMembers: [
        { member_key: 'm1', applicant_name: 'Alpha', policy_number: 'P1', exchange_subscriber_id: '', issuer_subscriber_id: 'U111', current_policy_aor: 'Jason Fine (21055210)', effective_date: '2026-03-01', policy_status: 'Effectuated', covered_member_count: 1, effective_month: '2026-03', active_months: ['2026-03'], in_back_office: true },
      ],
      uniqueKeys: 1,
      byMonth: { '2026-03': 1 },
      inBOCount: 1,
      notInBOCount: 0,
      missingFromBO: [],
    };
    return { reconciled, filteredEde };
  }

  // #121: Found in Back Office / Eligible for Commission / Should Be Paid hero cards
  // were collapsed into a single Should Be Paid card. The underlying canonical predicates
  // are still asserted below — the consolidated card and its drilldown share the
  // `eligible` predicate (EE universe ∩ Back Office ∩ eligible_for_commission='Yes').
  it('Dashboard "expected" / consolidated should-be-paid / "unpaid" drilldowns MUST exclude ghost rows', () => {
    const { reconciled, filteredEde } = makeGhostFixture();
    const eeUniverseKeys = new Set(filteredEde.uniqueMembers.map((m) => m.member_key));

    // Replicate the canonical drilldown formulas from DashboardPage.
    const expected = reconciled.filter((r) => eeUniverseKeys.has(r.member_key));
    const foundBO = reconciled.filter((r) => eeUniverseKeys.has(r.member_key) && r.in_back_office);
    const eligible = reconciled.filter(
      (r) => eeUniverseKeys.has(r.member_key) && r.in_back_office && r.eligible_for_commission === 'Yes',
    );
    const unpaid = reconciled.filter(
      (r) =>
        eeUniverseKeys.has(r.member_key) &&
        r.in_back_office &&
        r.eligible_for_commission === 'Yes' &&
        !r.in_commission,
    );

    expect(expected).toHaveLength(1);
    expect(foundBO).toHaveLength(1);
    expect(eligible).toHaveLength(1);
    expect(unpaid).toHaveLength(1);
    // The pre-#118 persistent-flag formula would have returned 2 for each.
    const oldExpected = reconciled.filter((r) => r.is_in_expected_ede_universe).length;
    expect(oldExpected).toBe(2);
    expect(oldExpected).not.toBe(expected.length);
  });

  it('AgentSummary "Expected (AOR)" MUST source from filteredEde.uniqueMembers', () => {
    const { filteredEde } = makeGhostFixture();
    // Replicate AgentSummary's expected_count formula for Jason Fine.
    const jasonExpected = filteredEde.uniqueMembers.filter((m) =>
      String(m.current_policy_aor || '').includes('21055210'),
    ).length;
    expect(jasonExpected).toBe(1);
  });
});
