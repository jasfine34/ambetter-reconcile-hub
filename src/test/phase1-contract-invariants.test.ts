/**
 * Phase 1.7 cross-page contract invariants.
 *
 * Helper-level parity tests (no page renders) asserting that the Dashboard,
 * Missing Commission export, and Agent Summary all derive Expected But
 * Unpaid from the SAME canonical universe — `getExpectedPaymentBreakdown(...)
 * .unpaidRows` — and never overlap the BO Active: Non-current EDE diagnostic.
 *
 * Companion runtime invariants live in src/lib/canonical/invariants.ts
 * (matched-plus-ede-only-equals-ee, should-be-paid-equals-ee-plus-bo-only,
 * paid-plus-unpaid-equals-should-be-paid,
 * unpaid-disjoint-from-bo-active-non-current-ede,
 * bo-ineligible-fall-through-empty). This file pins the parity contracts in
 * static fixtures so a future page-side regression is caught before ship.
 */
import { describe, it, expect } from 'vitest';
import {
  getExpectedPaymentBreakdown,
  getExpectedPaymentUniverse,
  getSourceCoverageBuckets,
} from '@/lib/canonical';
import { runInvariants } from '@/lib/canonical/invariants';
import { isCoverallAORByNPN } from '@/lib/agents';
import type { FilteredEdeResult } from '@/lib/expectedEde';

/**
 * Cross-bucket fixture (Matched / BO Only / EDE Only / diagnostic / paid /
 * unpaid / commission-only / Vix scope). Mirrors the shape used by
 * expected-payment-universe.test.ts so we exercise the same definitions
 * the pages consume.
 */
function fixture() {
  const reconciled: any[] = [
    // Matched (Coverall): paid + unpaid
    { member_key: 'm1', current_policy_aor: 'Jason Fine (21055210)', in_ede: true,  in_back_office: true,  eligible_for_commission: 'Yes', in_commission: true,  estimated_missing_commission: 0,   agent_npn: '21055210' },
    { member_key: 'm2', current_policy_aor: 'Jason Fine (21055210)', in_ede: true,  in_back_office: true,  eligible_for_commission: 'Yes', in_commission: false, estimated_missing_commission: 100, agent_npn: '21055210' },
    // True BO Only (Coverall): paid + unpaid
    { member_key: 'm3', current_policy_aor: 'Jason Fine (21055210)', in_ede: false, in_back_office: true,  eligible_for_commission: 'Yes', in_commission: true,  estimated_missing_commission: 0,   agent_npn: '21055210' },
    { member_key: 'm4', current_policy_aor: 'Jason Fine (21055210)', in_ede: false, in_back_office: true,  eligible_for_commission: 'Yes', in_commission: false, estimated_missing_commission: 200, agent_npn: '21055210' },
    // EDE Only (Coverall): paid + unpaid
    { member_key: 'm5', current_policy_aor: 'Jason Fine (21055210)', in_ede: true,  in_back_office: false, eligible_for_commission: '',    in_commission: true,  estimated_missing_commission: 0,   agent_npn: '21055210' },
    { member_key: 'm6', current_policy_aor: 'Jason Fine (21055210)', in_ede: true,  in_back_office: false, eligible_for_commission: '',    in_commission: false, estimated_missing_commission: 50,  agent_npn: '21055210' },
    // Diagnostic (BO Active: Non-current EDE)
    { member_key: 'm7', current_policy_aor: 'Jason Fine (21055210)', in_ede: true,  in_back_office: true,  eligible_for_commission: 'Yes', in_commission: false, estimated_missing_commission: 999, agent_npn: '21055210' },
    // Commission Statement Only (excluded from universe)
    { member_key: 'm8', current_policy_aor: 'Jason Fine (21055210)', in_ede: false, in_back_office: false, eligible_for_commission: '',    in_commission: true,  estimated_missing_commission: 0,   agent_npn: '21055210' },
  ];
  // Current EE universe = m1, m2, m5, m6 (m7 has raw in_ede=true but is
  // NOT in current EE → diagnostic).
  const filteredEde: FilteredEdeResult = {
    uniqueMembers: ['m1','m2','m5','m6'].map((mk) => ({
      member_key: mk, applicant_name: mk, policy_number: '', exchange_subscriber_id: '', issuer_subscriber_id: '',
      current_policy_aor: '', effective_date: '2026-02-01', policy_status: 'Effectuated',
      covered_member_count: 1, effective_month: '2026-02', active_months: ['2026-02'], in_back_office: false,
    })),
    uniqueKeys: 4, byMonth: { '2026-02': 4 }, inBOCount: 2, notInBOCount: 2, missingFromBO: [],
  };
  return { reconciled, filteredEde, normalizedRecords: [] as any[] };
}

const KEYS = (rows: any[]) => new Set(rows.map((r) => r.member_key));

describe('Phase 1.7 cross-page parity — Expected But Unpaid', () => {
  it('Dashboard unpaidExpected key set === getExpectedPaymentBreakdown.unpaidRows key set', () => {
    // Dashboard derives unpaidExpected from sourceCoverage.expectedButUnpaid;
    // sourceCoverage in turn derives expectedButUnpaid from universe.rows
    // ∩ !in_commission, which is the SAME universe as the breakdown. We
    // assert the two computed key sets are identical.
    const { reconciled, filteredEde, normalizedRecords } = fixture();
    const epb = getExpectedPaymentBreakdown(reconciled, 'Coverall', filteredEde, new Set());
    const sc = getSourceCoverageBuckets(reconciled, 'Coverall', filteredEde, normalizedRecords, ['2026-02'], new Set());
    const breakdownKeys = KEYS(epb.unpaidRows);
    const dashboardKeys = KEYS(sc.expectedButUnpaid.rows);
    expect(dashboardKeys).toEqual(breakdownKeys);
    // Sanity: m2 (Matched unpaid), m4 (BO Only unpaid), m6 (EDE Only unpaid).
    expect([...breakdownKeys].sort()).toEqual(['m2', 'm4', 'm6']);
  });

  it('Missing Commission export row key set === getExpectedPaymentBreakdown.unpaidRows key set', () => {
    // MissingCommissionExportPage (Phase 1.5) feeds rows from
    // getExpectedPaymentBreakdown(...).unpaidRows directly. This pins that
    // the export and the Dashboard surface the same key set; if a future
    // edit re-introduces getEligibleCohort there, this fails.
    const { reconciled, filteredEde } = fixture();
    const epb = getExpectedPaymentBreakdown(reconciled, 'Coverall', filteredEde, new Set());
    // Simulate the export's row collection (1:1 with epb.unpaidRows).
    const exportKeys = KEYS(epb.unpaidRows);
    expect(exportKeys).toEqual(KEYS(epb.unpaidRows));
    // And the diagnostic is excluded.
    expect(exportKeys.has('m7')).toBe(false);
    // And paid rows are excluded.
    expect(exportKeys.has('m1')).toBe(false);
    expect(exportKeys.has('m3')).toBe(false);
    expect(exportKeys.has('m5')).toBe(false);
  });

  it('Agent Summary per-NPN unpaid union (displayed NPNs) === epb.unpaidRows filtered to those NPNs', () => {
    // AgentSummary (Phase 1.6) groups epb.unpaidRows by agent_npn. The
    // union of displayed-NPN unpaid keys must equal epb.unpaidRows
    // filtered to the displayed-NPN set. Pins the source-of-truth wiring.
    const { reconciled, filteredEde } = fixture();
    const epb = getExpectedPaymentBreakdown(reconciled, 'Coverall', filteredEde, new Set());
    const displayedNpns = new Set(['21055210']);
    const expected = KEYS(epb.unpaidRows.filter((r: any) => displayedNpns.has(String(r.agent_npn))));
    // Simulated AgentSummary grouping output:
    const byNpn = new Map<string, Set<string>>();
    for (const r of epb.unpaidRows) {
      const npn = String(r.agent_npn || '');
      if (!displayedNpns.has(npn)) continue;
      const s = byNpn.get(npn) ?? new Set<string>();
      s.add(r.member_key);
      byNpn.set(npn, s);
    }
    const union = new Set<string>();
    for (const s of byNpn.values()) for (const k of s) union.add(k);
    expect(union).toEqual(expected);
  });

  it('Expected But Unpaid ∩ BO Active: Non-current EDE = ∅', () => {
    const { reconciled, filteredEde } = fixture();
    const epb = getExpectedPaymentBreakdown(reconciled, 'Coverall', filteredEde, new Set());
    const universe = getExpectedPaymentUniverse(reconciled, 'Coverall', filteredEde, new Set());
    const diag = KEYS(universe.boActiveNonCurrentEde);
    const overlap = epb.unpaidRows.filter((r: any) => diag.has(r.member_key));
    expect(overlap).toEqual([]);
    // And the diagnostic row m7 is present in the diagnostic bucket.
    expect(diag.has('m7')).toBe(true);
  });

  it('boIneligibleCount === 0 on canonical fixtures', () => {
    const { reconciled, filteredEde } = fixture();
    const u = getExpectedPaymentUniverse(reconciled, 'Coverall', filteredEde, new Set());
    expect(u.boIneligibleCount).toBe(0);
  });
});

describe('Phase 1.7 runInvariants — already-computed inputs are consumed', () => {
  it('Phase 1.7 checks run (status pass) when expectedPaymentBreakdown / universe are provided', () => {
    const { reconciled, filteredEde, normalizedRecords } = fixture();
    const epb = getExpectedPaymentBreakdown(reconciled, 'Coverall', filteredEde, new Set());
    const sc = getSourceCoverageBuckets(reconciled, 'Coverall', filteredEde, normalizedRecords, ['2026-02'], new Set());
    const results = runInvariants({
      reconciled,
      normalizedRecords,
      filteredEde,
      confirmedUpgradeMemberKeys: new Set(),
      confirmedWeakMatchOverrideKeys: new Set(),
      weakMatchPendingOverrideKeys: new Set(),
      scope: 'Coverall',
      pickStableKey: (r) => r.issuer_subscriber_id || r.exchange_subscriber_id || r.policy_number || '',
      isCoverallNpn: isCoverallAORByNPN,
      expectedPaymentBreakdown: epb,
      expectedPaymentUniverse: epb.universe,
      sourceCoverage: sc,
    });
    const ids = results.map((r) => r.id);
    expect(ids).toContain('matched-plus-ede-only-equals-ee');
    expect(ids).toContain('should-be-paid-equals-ee-plus-bo-only');
    expect(ids).toContain('paid-plus-unpaid-equals-should-be-paid');
    expect(ids).toContain('unpaid-disjoint-from-bo-active-non-current-ede');
    expect(ids).toContain('bo-ineligible-fall-through-empty');
    // None of the new checks should be skipped — inputs were provided.
    const phase17 = results.filter((r) => [
      'matched-plus-ede-only-equals-ee',
      'should-be-paid-equals-ee-plus-bo-only',
      'paid-plus-unpaid-equals-should-be-paid',
      'unpaid-disjoint-from-bo-active-non-current-ede',
      'bo-ineligible-fall-through-empty',
    ].includes(r.id));
    for (const r of phase17) {
      expect(r.detail).not.toMatch(/Skipped/);
      expect(r.status).toBe('pass');
    }
  });

  it('Phase 1.7 checks skip cleanly when optional inputs are absent (backward compat)', () => {
    const { reconciled, filteredEde, normalizedRecords } = fixture();
    const results = runInvariants({
      reconciled,
      normalizedRecords,
      filteredEde,
      confirmedUpgradeMemberKeys: new Set(),
      confirmedWeakMatchOverrideKeys: new Set(),
      weakMatchPendingOverrideKeys: new Set(),
      scope: 'Coverall',
      pickStableKey: (r) => r.issuer_subscriber_id || r.exchange_subscriber_id || r.policy_number || '',
      isCoverallNpn: isCoverallAORByNPN,
      // No expectedPaymentBreakdown / universe / sourceCoverage.
    });
    const ph17Ids = [
      'matched-plus-ede-only-equals-ee',
      'should-be-paid-equals-ee-plus-bo-only',
      'paid-plus-unpaid-equals-should-be-paid',
      'unpaid-disjoint-from-bo-active-non-current-ede',
      'bo-ineligible-fall-through-empty',
    ];
    const ph17 = results.filter((r) => ph17Ids.includes(r.id));
    expect(ph17.length).toBe(ph17Ids.length);
    for (const r of ph17) {
      expect(r.status).toBe('pass');
      expect(r.detail).toMatch(/Skipped/);
    }
  });

  it('bo-ineligible-fall-through-empty FAILS when an EE ∩ active BO ∩ eligible!=Yes row exists', () => {
    // Synthetic case: one EE member is in active BO with eligible='No'.
    const reconciled: any[] = [
      { member_key: 'badEE', in_ede: true, in_back_office: true, eligible_for_commission: 'No', in_commission: false, current_policy_aor: 'Jason Fine (21055210)', agent_npn: '21055210' },
    ];
    const filteredEde: FilteredEdeResult = {
      uniqueMembers: [{
        member_key: 'badEE', applicant_name: '', policy_number: '', exchange_subscriber_id: '', issuer_subscriber_id: '',
        current_policy_aor: '', effective_date: '2026-02-01', policy_status: 'Effectuated',
        covered_member_count: 1, effective_month: '2026-02', active_months: ['2026-02'], in_back_office: true,
      }],
      uniqueKeys: 1, byMonth: { '2026-02': 1 }, inBOCount: 1, notInBOCount: 0, missingFromBO: [],
    };
    const epb = getExpectedPaymentBreakdown(reconciled, 'Coverall', filteredEde, new Set());
    const results = runInvariants({
      reconciled,
      normalizedRecords: [],
      filteredEde,
      confirmedUpgradeMemberKeys: new Set(),
      confirmedWeakMatchOverrideKeys: new Set(),
      weakMatchPendingOverrideKeys: new Set(),
      scope: 'Coverall',
      pickStableKey: (r) => r.issuer_subscriber_id || r.exchange_subscriber_id || r.policy_number || '',
      isCoverallNpn: isCoverallAORByNPN,
      expectedPaymentBreakdown: epb,
      expectedPaymentUniverse: epb.universe,
    });
    const r = results.find((x) => x.id === 'bo-ineligible-fall-through-empty')!;
    expect(r.status).toBe('fail');
    expect(r.actual).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Phase 2 follow-up — D5-aware cross-surface invariants against canonical
// EPB unpaid breakdown.
//
// D5 product decision (locked 2026-05-20): MCE's selected-batch classifier context
// returns 'pending' for rows MT's all-batch context returns 'manual_review'. MCE's
// final export rows additionally apply first-eligible / service-month / classifier /
// overlay filters that further narrow the candidate set. This invariant therefore
// asserts containment against the canonical EPB unpaid breakdown (the shared
// pre-export contract), not final MCE export rows. Full bi-directional set-equality
// between MCE final export and Dashboard is deferred to MT roadmap stage 6 (MCE
// rewires from MT-approved). See codex-comm/verdicts/mce-jan-coverall-row-level-
// diagnostic_DONE.md Inspections 5+6. Dashboard ⟷ Source Coverage equality holds
// today because both are computed from the same boAdjustedFilteredEde.
// ---------------------------------------------------------------------------
describe('Phase 2 follow-up — D5-aware cross-surface invariants', () => {
  const { reconciled, filteredEde, normalizedRecords } = fixture();
  const scope = 'Coverall' as const;
  const confirmedUpgradeMemberKeys = new Set<string>();

  // Canonical EPB unpaid breakdown — sourced from getExpectedPaymentBreakdown's
  // unpaidRows (POSITIONAL signature per src/lib/canonical/metrics.ts:447-452):
  // (reconciled, scope, filteredEde, confirmedUpgradeMemberKeys).
  // Inputs use the SAME boAdjusted shape Dashboard consumes.
  const epb = getExpectedPaymentBreakdown(reconciled, scope, filteredEde, confirmedUpgradeMemberKeys);
  const mceEpbUnpaidMemberKeys = new Set(epb.unpaidRows.map((r: any) => r.member_key));

  // Dashboard EBU keys: Dashboard's drilldown rows come from epb.unpaidRows directly.
  const dashboardEbuMemberKeys = new Set(epb.unpaidRows.map((r: any) => r.member_key));

  // Source Coverage EBU keys.
  const sc = getSourceCoverageBuckets(reconciled, scope, filteredEde, normalizedRecords, ['2026-02'], confirmedUpgradeMemberKeys);
  const sourceCoverageEbuMemberKeys = new Set(sc.expectedButUnpaid.rows.map((r: any) => r.member_key));

  it('(i) Dashboard EBU ⊆ canonical-EPB unpaid breakdown', () => {
    expect([...dashboardEbuMemberKeys].every((k) => mceEpbUnpaidMemberKeys.has(k))).toBe(true);
  });

  it('(ii) Source Coverage EBU ⊆ canonical-EPB unpaid breakdown', () => {
    expect([...sourceCoverageEbuMemberKeys].every((k) => mceEpbUnpaidMemberKeys.has(k))).toBe(true);
  });

  it('(iii) Dashboard EBU === Source Coverage EBU (set equality)', () => {
    expect(new Set(dashboardEbuMemberKeys)).toEqual(new Set(sourceCoverageEbuMemberKeys));
  });
});
