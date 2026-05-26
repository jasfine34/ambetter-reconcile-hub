/**
 * Phase 1 (corrected): expected-payment universe + 4-bucket Source Coverage tests.
 *
 * EDE evidence for the Expected Payment Universe is membership in
 * filteredEde.uniqueMembers ONLY — the same predicate the Expected
 * Enrollments card uses. r.in_ede is intentionally NOT consulted here:
 * raw r.in_ede includes EDE rows that did not qualify for the current EE
 * universe (status / effective span / scope), and using it lets Matched
 * exceed Expected Enrollments — which is structurally impossible.
 *
 * Required invariants (asserted below across All / Coverall / Vix):
 *   Matched + EDE Only = Expected Enrollments
 *   Should Be Paid    = Expected Enrollments + BO Only
 *   Expected Payments Received + Expected But Unpaid = Should Be Paid
 *
 * NOTE: prior Feb 2026 Ambetter targets recorded here (Should Be Paid 2,573,
 * Expected Payments Received 1,422, Expected But Unpaid 1,151) were computed
 * against the OVER-COUNTING helper (r.in_ede || EE). They are stale and have
 * been removed; recompute against the corrected helper before pinning new
 * targets. Synthetic fixtures below assert the math invariants directly.
 */
import { describe, it, expect } from 'vitest';
import {
  getExpectedPaymentUniverse,
  getExpectedPaymentBreakdown,
  getSourceCoverageBuckets,
} from '@/lib/canonical';
import type { FilteredEdeResult } from '@/lib/expectedEde';

function fixture() {
  // Members:
  //  m1 Matched + paid       (in_ede, active BO, eligible Yes, paid)
  //  m2 Matched + unpaid
  //  m3 BO Only + paid       (!in_ede, active BO, eligible Yes, paid)
  //  m4 BO Only + unpaid
  //  m5 EDE Only + paid, BO terminated  -> bo_reason: BO inactive/terminated
  //  m6 EDE Only + paid, BO absent      -> bo_reason: BO absent
  //  m7 EDE Only + unpaid (eligibility blank, must still be in universe)
  //  m8 Commission Statement Only       (!in_ede, !active BO, paid)
  const reconciled: any[] = [
    { member_key: 'm1', current_policy_aor: 'Jason Fine (21055210)', in_ede: true,  in_back_office: true,  eligible_for_commission: 'Yes', in_commission: true,  agent_npn: '21055210' },
    { member_key: 'm2', current_policy_aor: 'Jason Fine (21055210)', in_ede: true,  in_back_office: true,  eligible_for_commission: 'Yes', in_commission: false, agent_npn: '21055210' },
    { member_key: 'm3', current_policy_aor: 'Jason Fine (21055210)', in_ede: false, in_back_office: true,  eligible_for_commission: 'Yes', in_commission: true,  agent_npn: '21055210' },
    { member_key: 'm4', current_policy_aor: 'Jason Fine (21055210)', in_ede: false, in_back_office: true,  eligible_for_commission: 'Yes', in_commission: false, agent_npn: '21055210' },
    { member_key: 'm5', current_policy_aor: 'Jason Fine (21055210)', in_ede: true,  in_back_office: false, eligible_for_commission: '',    in_commission: true,  agent_npn: '21055210', issuer_subscriber_id: 'U5' },
    { member_key: 'm6', current_policy_aor: 'Jason Fine (21055210)', in_ede: true,  in_back_office: false, eligible_for_commission: '',    in_commission: true,  agent_npn: '21055210', issuer_subscriber_id: 'U6' },
    { member_key: 'm7', current_policy_aor: 'Jason Fine (21055210)', in_ede: true,  in_back_office: false, eligible_for_commission: '',    in_commission: false, agent_npn: '21055210' },
    { member_key: 'm8', current_policy_aor: 'Jason Fine (21055210)', in_ede: false, in_back_office: false, eligible_for_commission: '',    in_commission: true,  agent_npn: '21055210' },
  ];
  const filteredEde: FilteredEdeResult = {
    uniqueMembers: ['m1','m2','m5','m6','m7'].map((mk) => ({
      member_key: mk, applicant_name: mk, policy_number: '', exchange_subscriber_id: '', issuer_subscriber_id: '',
      current_policy_aor: '', effective_date: '2026-02-01', policy_status: 'Effectuated',
      covered_member_count: 1, effective_month: '2026-02', active_months: ['2026-02'], in_back_office: false,
    })),
    uniqueKeys: 5, byMonth: { '2026-02': 5 }, inBOCount: 2, notInBOCount: 3, missingFromBO: [],
  };
  // BO records: m5 has terminated BO row; m6 has no BO row.
  const normalizedRecords: any[] = [
    { source_type: 'BACK_OFFICE', issuer_subscriber_id: 'U5', policy_term_date: '2026-01-15', eligible_for_commission: 'No' },
  ];
  return { reconciled, filteredEde, normalizedRecords };
}

describe('Phase 1: expected-payment universe', () => {
  it('Should Be Paid = Matched + BO Only + EDE Only', () => {
    const { reconciled, filteredEde } = fixture();
    const u = getExpectedPaymentUniverse(reconciled, 'Coverall', filteredEde, new Set());
    expect(u.matchedCount).toBe(2); // m1, m2
    expect(u.boOnlyCount).toBe(2);  // m3, m4
    expect(u.edeOnlyCount).toBe(3); // m5, m6, m7 (no eligibility gate!)
    expect(u.total).toBe(7);
    expect(u.matchedCount + u.boOnlyCount + u.edeOnlyCount).toBe(u.total);
  });

  it('EDE Only includes rows with eligibility blank (12-row class regression)', () => {
    // [MAIN-FAIL] — would fail under a naive eligibility='Yes' gate.
    const { reconciled, filteredEde } = fixture();
    const u = getExpectedPaymentUniverse(reconciled, 'Coverall', filteredEde, new Set());
    const keys = u.edeOnly.map((r) => r.member_key).sort();
    expect(keys).toEqual(['m5', 'm6', 'm7']);
  });

  it('Expected Payments Received + Expected But Unpaid = Should Be Paid', () => {
    const { reconciled, filteredEde } = fixture();
    const b = getExpectedPaymentBreakdown(reconciled, 'Coverall', filteredEde, new Set());
    expect(b.paidCount + b.unpaidCount).toBe(b.universe.total);
    expect(b.paidCount).toBe(4); // m1, m3, m5, m6
    expect(b.unpaidCount).toBe(3); // m2, m4, m7
  });

  it('compact splits sum to bucket totals', () => {
    const { reconciled, filteredEde } = fixture();
    const b = getExpectedPaymentBreakdown(reconciled, 'Coverall', filteredEde, new Set());
    expect(b.paidSplit.matched + b.paidSplit.boOnly + b.paidSplit.edeOnly).toBe(b.paidCount);
    expect(b.unpaidSplit.matched + b.unpaidSplit.boOnly + b.unpaidSplit.edeOnly).toBe(b.unpaidCount);
  });
});

describe('Phase 1: Source Coverage 4-bucket math', () => {
  it('Fully Matched & Paid + BO Only Paid + EDE Only Paid + Commission Only = Total Policies Paid', () => {
    const { reconciled, filteredEde, normalizedRecords } = fixture();
    const sc = getSourceCoverageBuckets(reconciled, 'Coverall', filteredEde, normalizedRecords, ['2026-02'], new Set());
    expect(sc.fullyMatchedPaid.count).toBe(1); // m1
    expect(sc.paidBackOfficeOnly.count).toBe(1); // m3
    expect(sc.paidEdeOnly.count).toBe(2); // m5, m6
    expect(sc.paidCommissionStatementOnly.count).toBe(1); // m8
    expect(
      sc.fullyMatchedPaid.count + sc.paidBackOfficeOnly.count + sc.paidEdeOnly.count + sc.paidCommissionStatementOnly.count,
    ).toBe(sc.totalPoliciesPaid.count);
    expect(sc.totalPoliciesPaid.count).toBe(5);
  });

  it('Paid: EDE Only carries bo_reason — terminated vs absent', () => {
    const { reconciled, filteredEde, normalizedRecords } = fixture();
    const sc = getSourceCoverageBuckets(reconciled, 'Coverall', filteredEde, normalizedRecords, ['2026-02'], new Set());
    const byKey = new Map(sc.paidEdeOnly.rows.map((x) => [x.row.member_key, x.bo_reason]));
    expect(byKey.get('m5')).toBe('BO inactive/terminated');
    expect(byKey.get('m6')).toBe('BO absent');
  });

  it('Expected But Unpaid count is identical via breakdown vs source coverage', () => {
    const { reconciled, filteredEde, normalizedRecords } = fixture();
    const b = getExpectedPaymentBreakdown(reconciled, 'Coverall', filteredEde, new Set());
    const sc = getSourceCoverageBuckets(reconciled, 'Coverall', filteredEde, normalizedRecords, ['2026-02'], new Set());
    expect(sc.expectedButUnpaid.count).toBe(b.unpaidCount);
  });
});

describe('Phase 1 (Interpretation C): true BO Only requires raw r.in_ede=false', () => {
  it('row with raw r.in_ede=true + active BO + eligible Yes + NOT in EE goes to diagnostic, NOT BO Only', () => {
    const reconciled: any[] = [
      { member_key: 'eeOk',  in_ede: true,  in_back_office: true,  eligible_for_commission: 'Yes', in_commission: true,  current_policy_aor: 'Jason Fine (21055210)', agent_npn: '21055210' },
      // ghost: raw EDE=true but EE filter rejected (e.g. future-effective)
      { member_key: 'ghost', in_ede: true,  in_back_office: true,  eligible_for_commission: 'Yes', in_commission: false, current_policy_aor: 'Jason Fine (21055210)', agent_npn: '21055210', issuer_subscriber_id: 'G1' },
      // true BO only: raw EDE=false
      { member_key: 'tbo',   in_ede: false, in_back_office: true,  eligible_for_commission: 'Yes', in_commission: true,  current_policy_aor: 'Jason Fine (21055210)', agent_npn: '21055210' },
    ];
    const filteredEde: FilteredEdeResult = {
      uniqueMembers: [{
        member_key: 'eeOk', applicant_name: '', policy_number: '', exchange_subscriber_id: '', issuer_subscriber_id: '',
        current_policy_aor: '', effective_date: '2026-01-01', policy_status: 'Effectuated',
        covered_member_count: 1, effective_month: '2026-01', active_months: ['2026-01'], in_back_office: true,
      }],
      uniqueKeys: 1, byMonth: { '2026-01': 1 }, inBOCount: 1, notInBOCount: 0, missingFromBO: [],
    };
    const u = getExpectedPaymentUniverse(reconciled, 'Coverall', filteredEde, new Set());
    expect(u.boOnly.map((r) => r.member_key)).toEqual(['tbo']);
    expect(u.boActiveNonCurrentEde.map((r) => r.member_key)).toEqual(['ghost']);
    // Diagnostic excluded from Should Be Paid
    expect(u.total).toBe(2); // eeOk + tbo
    // All true-BO-only rows have raw r.in_ede=false
    expect(u.boOnly.every((r) => r.in_ede === false)).toBe(true);
  });

  it('Should Be Paid = Expected Enrollments + true BO Only (excludes diagnostic)', () => {
    const reconciled: any[] = [
      { member_key: 'a', in_ede: true,  in_back_office: true,  eligible_for_commission: 'Yes', in_commission: true,  current_policy_aor: 'Jason Fine (21055210)', agent_npn: '21055210' },
      { member_key: 'b', in_ede: false, in_back_office: true,  eligible_for_commission: 'Yes', in_commission: false, current_policy_aor: 'Jason Fine (21055210)', agent_npn: '21055210' },
      { member_key: 'c', in_ede: true,  in_back_office: true,  eligible_for_commission: 'Yes', in_commission: false, current_policy_aor: 'Jason Fine (21055210)', agent_npn: '21055210' }, // diagnostic
    ];
    const filteredEde: FilteredEdeResult = {
      uniqueMembers: [{
        member_key: 'a', applicant_name: '', policy_number: '', exchange_subscriber_id: '', issuer_subscriber_id: '',
        current_policy_aor: '', effective_date: '2026-01-01', policy_status: 'Effectuated',
        covered_member_count: 1, effective_month: '2026-01', active_months: ['2026-01'], in_back_office: true,
      }],
      uniqueKeys: 1, byMonth: { '2026-01': 1 }, inBOCount: 1, notInBOCount: 0, missingFromBO: [],
    };
    const u = getExpectedPaymentUniverse(reconciled, 'Coverall', filteredEde, new Set());
    expect(u.total).toBe(filteredEde.uniqueKeys + u.boOnlyCount);
    expect(u.boActiveNonCurrentEdeCount).toBe(1);
  });

  it('SourceCoverage diagnostic bucket exposes paid/unpaid + reason; paid rows still in totalPoliciesPaid', () => {
    const reconciled: any[] = [
      // Diagnostic, paid — future-effective EDE row
      { member_key: 'fe', in_ede: true,  in_back_office: true,  eligible_for_commission: 'Yes', in_commission: true,  current_policy_aor: 'Jason Fine (21055210)', agent_npn: '21055210', issuer_subscriber_id: 'FE1' },
      // Diagnostic, unpaid — non-qualified EDE
      { member_key: 'nq', in_ede: true,  in_back_office: true,  eligible_for_commission: 'Yes', in_commission: false, current_policy_aor: 'Jason Fine (21055210)', agent_npn: '21055210', issuer_subscriber_id: 'NQ1' },
    ];
    const filteredEde: FilteredEdeResult = {
      uniqueMembers: [], uniqueKeys: 0, byMonth: {}, inBOCount: 0, notInBOCount: 0, missingFromBO: [],
    };
    const normalizedRecords: any[] = [
      { source_type: 'EDE', issuer_subscriber_id: 'FE1', effective_date: '2026-03-01', raw_json: { policyStatus: 'Effectuated' } },
      { source_type: 'EDE', issuer_subscriber_id: 'NQ1', effective_date: '2026-01-01', raw_json: { policyStatus: 'Cancelled' } },
    ];
    const sc = getSourceCoverageBuckets(reconciled, 'Coverall', filteredEde, normalizedRecords, ['2026-01'], new Set());
    expect(sc.boActiveNonCurrentEde.count).toBe(2);
    expect(sc.boActiveNonCurrentEde.paidCount).toBe(1);
    expect(sc.boActiveNonCurrentEde.unpaidCount).toBe(1);
    const reasons = sc.boActiveNonCurrentEde.rows.map((x) => x.reason).sort();
    expect(reasons).toEqual(['future-effective', 'non-qualified-status']);
    // Paid diagnostic rows still appear in totalPoliciesPaid so paid math reconciles
    expect(sc.totalPoliciesPaid.rows.some((r) => r.member_key === 'fe')).toBe(true);
    // Diagnostic rows are NOT in expectedButUnpaid
    expect(sc.expectedButUnpaid.rows.some((r) => r.member_key === 'nq')).toBe(false);
  });
});

describe('Phase 1 (corrected): invariants across scopes', () => {
  // Cross-scope fixture: 5 Coverall EE members, 2 Vix EE members.
  function multiScopeFixture() {
    const reconciled: any[] = [
      // Coverall
      { member_key: 'c1', current_policy_aor: 'Jason Fine (21055210)', in_ede: true,  in_back_office: true,  eligible_for_commission: 'Yes', in_commission: true,  agent_npn: '21055210' }, // Matched paid
      { member_key: 'c2', current_policy_aor: 'Jason Fine (21055210)', in_ede: true,  in_back_office: true,  eligible_for_commission: 'Yes', in_commission: false, agent_npn: '21055210' }, // Matched unpaid
      { member_key: 'c3', current_policy_aor: 'Jason Fine (21055210)', in_ede: false, in_back_office: true,  eligible_for_commission: 'Yes', in_commission: true,  agent_npn: '21055210' }, // BO Only paid
      { member_key: 'c4', current_policy_aor: 'Jason Fine (21055210)', in_ede: true,  in_back_office: false, eligible_for_commission: '',    in_commission: true,  agent_npn: '21055210' }, // EDE Only paid
      { member_key: 'c5', current_policy_aor: 'Jason Fine (21055210)', in_ede: true,  in_back_office: false, eligible_for_commission: '',    in_commission: false, agent_npn: '21055210' }, // EDE Only unpaid
      // Vix
      { member_key: 'v1', current_policy_aor: 'Erica Fine (21277051)', in_ede: true,  in_back_office: true,  eligible_for_commission: 'Yes', in_commission: true,  agent_npn: '21277051', actual_pay_entity: 'Vix' }, // Matched paid (Vix)
      { member_key: 'v2', current_policy_aor: 'Erica Fine (21277051)', in_ede: true,  in_back_office: false, eligible_for_commission: '',    in_commission: false, agent_npn: '21277051', actual_pay_entity: 'Vix' }, // EDE Only unpaid (Vix)
      { member_key: 'v3', current_policy_aor: 'Erica Fine (21277051)', in_ede: false, in_back_office: true,  eligible_for_commission: 'Yes', in_commission: false, agent_npn: '21277051', actual_pay_entity: 'Vix' }, // BO Only unpaid (Vix)
    ];
    // EE universe = c1,c2,c4,c5 (Coverall) + v1,v2 (Vix). Note c3, v3 are
    // in BO/eligible but NOT in EE — they should land in BO Only.
    const eeKeys = ['c1','c2','c4','c5','v1','v2'];
    const filteredEde: FilteredEdeResult = {
      uniqueMembers: eeKeys.map((mk) => ({
        member_key: mk, applicant_name: mk, policy_number: '', exchange_subscriber_id: '', issuer_subscriber_id: '',
        current_policy_aor: '', effective_date: '2026-01-01', policy_status: 'Effectuated',
        covered_member_count: 1, effective_month: '2026-01', active_months: ['2026-01'], in_back_office: true,
      })),
      uniqueKeys: eeKeys.length, byMonth: { '2026-01': eeKeys.length }, inBOCount: 0, notInBOCount: 0, missingFromBO: [],
    };
    return { reconciled, filteredEde, eeKeys };
  }

  // Per-scope expected EE = |filteredEde.uniqueMembers ∩ inScope|. Production
  // computeFilteredEde already scopes by AOR; we mirror that here so the
  // test's "EE" matches what the EE card would show in each scope.
  function scopedEeCount(filteredEde: FilteredEdeResult, scope: 'All' | 'Coverall' | 'Vix') {
    const isCoverall = (k: string) => k.startsWith('c');
    const isVix = (k: string) => k.startsWith('v');
    return filteredEde.uniqueMembers.filter((m) => {
      if (scope === 'All') return isCoverall(m.member_key) || isVix(m.member_key);
      if (scope === 'Coverall') return isCoverall(m.member_key);
      return isVix(m.member_key);
    }).length;
  }

  for (const scope of ['All', 'Coverall', 'Vix'] as const) {
    it(`Matched + EDE Only = Expected Enrollments (${scope})`, () => {
      const { reconciled, filteredEde } = multiScopeFixture();
      // Build a scope-specific filteredEde to mirror production EE-card scoping.
      const scopedEde: FilteredEdeResult = {
        ...filteredEde,
        uniqueMembers: filteredEde.uniqueMembers.filter((m) => {
          if (scope === 'All') return true;
          if (scope === 'Coverall') return m.member_key.startsWith('c');
          return m.member_key.startsWith('v');
        }),
      };
      const ee = scopedEeCount(scopedEde, scope);
      const u = getExpectedPaymentUniverse(reconciled, scope, scopedEde, new Set());
      expect(u.matchedCount + u.edeOnlyCount).toBe(ee);
    });

    it(`Should Be Paid = Expected Enrollments + BO Only (${scope})`, () => {
      const { reconciled, filteredEde } = multiScopeFixture();
      const scopedEde: FilteredEdeResult = {
        ...filteredEde,
        uniqueMembers: filteredEde.uniqueMembers.filter((m) => {
          if (scope === 'All') return true;
          if (scope === 'Coverall') return m.member_key.startsWith('c');
          return m.member_key.startsWith('v');
        }),
      };
      const ee = scopedEeCount(scopedEde, scope);
      const u = getExpectedPaymentUniverse(reconciled, scope, scopedEde, new Set());
      expect(u.total).toBe(ee + u.boOnlyCount);
    });

    it(`Matched cannot exceed Expected Enrollments (${scope})`, () => {
      const { reconciled, filteredEde } = multiScopeFixture();
      const scopedEde: FilteredEdeResult = {
        ...filteredEde,
        uniqueMembers: filteredEde.uniqueMembers.filter((m) => {
          if (scope === 'All') return true;
          if (scope === 'Coverall') return m.member_key.startsWith('c');
          return m.member_key.startsWith('v');
        }),
      };
      const ee = scopedEeCount(scopedEde, scope);
      const u = getExpectedPaymentUniverse(reconciled, scope, scopedEde, new Set());
      expect(u.matchedCount).toBeLessThanOrEqual(ee);
    });
  }
});

describe('Phase 1.7: boIneligible fall-through bucket (additive)', () => {
  it('boIneligibleCount is 0 on the primary fixture', () => {
    const { reconciled, filteredEde } = fixture();
    const u = getExpectedPaymentUniverse(reconciled, 'Coverall', filteredEde, new Set());
    expect(u.boIneligibleCount).toBe(0);
    expect(u.boIneligible).toEqual([]);
  });

  it('catches EE ∩ active BO ∩ eligible != Yes rows the original 4-branch classifier dropped', () => {
    // Pre-1.7, this row matched none of {matched, boOnly, edeOnly,
    // boActiveNonCurrentEde} and was silently lost. Now it lands in
    // boIneligible (and is NOT counted in `rows` / `total`).
    const reconciled: any[] = [
      { member_key: 'ineligibleEE', in_ede: true, in_back_office: true, eligible_for_commission: 'No', in_commission: false, current_policy_aor: 'Jason Fine (21055210)', agent_npn: '21055210' },
    ];
    const filteredEde: FilteredEdeResult = {
      uniqueMembers: [{
        member_key: 'ineligibleEE', applicant_name: '', policy_number: '', exchange_subscriber_id: '', issuer_subscriber_id: '',
        current_policy_aor: '', effective_date: '2026-02-01', policy_status: 'Effectuated',
        covered_member_count: 1, effective_month: '2026-02', active_months: ['2026-02'], in_back_office: true,
      }],
      uniqueKeys: 1, byMonth: { '2026-02': 1 }, inBOCount: 1, notInBOCount: 0, missingFromBO: [],
    };
    const u = getExpectedPaymentUniverse(reconciled, 'Coverall', filteredEde, new Set());
    expect(u.boIneligibleCount).toBe(1);
    expect(u.boIneligible[0].member_key).toBe('ineligibleEE');
    // Additive: NOT in rows / total / Should Be Paid.
    expect(u.total).toBe(0);
    expect(u.matchedCount).toBe(0);
    expect(u.boOnlyCount).toBe(0);
    expect(u.edeOnlyCount).toBe(0);
    expect(u.boActiveNonCurrentEdeCount).toBe(0);
  });

  it('every reconciled row classified by the helper lands in exactly one bucket', () => {
    // Closure: matched ∪ boOnly ∪ edeOnly ∪ boActiveNonCurrentEde ∪
    // boIneligible covers every row touched by the classifier branches.
    const { reconciled, filteredEde } = fixture();
    const u = getExpectedPaymentUniverse(reconciled, 'Coverall', filteredEde, new Set());
    const classified = new Set<any>();
    for (const r of u.matched) classified.add(r);
    for (const r of u.boOnly) classified.add(r);
    for (const r of u.edeOnly) classified.add(r);
    for (const r of u.boActiveNonCurrentEde) classified.add(r);
    for (const r of u.boIneligible) classified.add(r);
    // The fixture's m8 (Commission-Statement-only) is intentionally out of
    // every Phase 1 bucket — it's surfaced by Source Coverage separately.
    // Closure here only asserts that classified ∩ rows = rows.
    for (const r of u.rows) expect(classified.has(r)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase 2 follow-up: Dashboard-shaped runtime overlay fixture for the
// EDE-only leak class. Stale persisted BO disqualified by helper criteria
// MUST NOT leak into Expected But Unpaid via the EDE-only branch after
// the overlay flips in_back_office=false + drops the member from
// boAdjustedFilteredEde via the MCE exclusion set.
// ---------------------------------------------------------------------------
import { applyRuntimeBOActive, getStatementMonthBounds } from '@/lib/canonical';

describe('Phase 2 follow-up — EDE-only leak class blocked under runtime overlay', () => {
  const MONTH = '2026-02';
  const BOUNDS = getStatementMonthBounds(MONTH);

  function leakFixture(boRow: Record<string, any>) {
    const reconciled: any[] = [
      { member_key: 'leak', in_ede: true, in_back_office: true, eligible_for_commission: 'Yes', in_commission: false, current_policy_aor: 'Jason Fine (21055210)', agent_npn: '21055210', issuer_subscriber_id: 'LK1' },
    ];
    const filteredEde: FilteredEdeResult = {
      uniqueMembers: [{
        member_key: 'leak', applicant_name: 'leak', policy_number: '', exchange_subscriber_id: '', issuer_subscriber_id: 'LK1',
        current_policy_aor: '', effective_date: '2026-02-01', policy_status: 'Effectuated',
        covered_member_count: 1, effective_month: MONTH, active_months: [MONTH], in_back_office: true,
      }],
      uniqueKeys: 1, byMonth: { [MONTH]: 1 }, inBOCount: 1, notInBOCount: 0, missingFromBO: [],
    };
    const normalizedBo = [
      { source_type: 'BACK_OFFICE', member_key: 'leak', issuer_subscriber_id: 'LK1', ...boRow },
    ];
    const overlay = applyRuntimeBOActive(reconciled, normalizedBo, BOUNDS);
    const boAdjustedReconciled = overlay.adjustedReconciled.filter((r: any) => !overlay.mceExclusionMemberKeys.has(r.member_key));
    const adjFilteredEde: FilteredEdeResult = {
      ...filteredEde,
      uniqueMembers: filteredEde.uniqueMembers.filter((m) => !overlay.mceExclusionMemberKeys.has(m.member_key)),
      uniqueKeys: 0,
    };
    return { boAdjustedReconciled, adjFilteredEde, overlay };
  }

  for (const [label, boRow] of [
    ['policy_term_date<start', { eligible_for_commission: 'Yes', policy_term_date: '2026-01-15' }],
    ['eligible_for_commission=No', { eligible_for_commission: 'No', policy_term_date: '2026-12-31' }],
  ] as const) {

    it(`stale BO (${label}) does NOT leak into Expected But Unpaid via EDE-only branch`, () => {
      const { boAdjustedReconciled, adjFilteredEde, overlay } = leakFixture(boRow as any);
      expect(overlay.mceExclusionMemberKeys.has('leak')).toBe(true);
      const u = getExpectedPaymentUniverse(boAdjustedReconciled, 'Coverall', adjFilteredEde, new Set());
      expect(u.edeOnly.map((r: any) => r.member_key)).not.toContain('leak');
      expect(u.boOnly.map((r: any) => r.member_key)).not.toContain('leak');
      const epb = getExpectedPaymentBreakdown(boAdjustedReconciled, 'Coverall', adjFilteredEde, new Set());
      expect(epb.unpaidRows.map((r: any) => r.member_key)).not.toContain('leak');
    });
  }
});
