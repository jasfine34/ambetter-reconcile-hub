/**
 * Phase 2 Dashboard slice — Tests A-D (runtime BO overlay coverage).
 *
 * These tests assert against the Phase 2 Dashboard data-flow as shipped at
 * commit 64b105e9: applyRuntimeBOActive → adjustedReconciled → boAdjustedReconciled
 * + boAdjustedFilteredEde, with rawFilteredEde preserved source-faithful.
 *
 * Test A — stale BO inactive removed from payment metrics (3 disqualifier classes)
 * Test B — raw Expected Enrollments remains source-faithful
 * Test C — Christopher Ortiz Jan 2026 positive-control (BO-only, NOT Found-in-BO)
 * Test D — Vix scope tuple parity
 */
import { describe, it, expect } from 'vitest';
import {
  applyRuntimeBOActive,
  getExpectedPaymentUniverse,
  getExpectedPaymentBreakdown,
  getSourceCoverageBuckets,
  getFoundInBackOffice,
  getStatementMonthBounds,
} from '@/lib/canonical';
import { computeFilteredEde } from '@/lib/expectedEde';
import type { FilteredEdeResult } from '@/lib/expectedEde';

const MONTH = '2026-02';
const BOUNDS = getStatementMonthBounds(MONTH);

function eeRow(over: any = {}) {
  return {
    member_key: over.member_key,
    applicant_name: over.applicant_name ?? over.member_key,
    policy_number: over.policy_number ?? '',
    exchange_subscriber_id: over.exchange_subscriber_id ?? '',
    issuer_subscriber_id: over.issuer_subscriber_id ?? '',
    current_policy_aor: over.current_policy_aor ?? '',
    effective_date: '2026-02-01',
    policy_status: 'Effectuated',
    covered_member_count: 1,
    effective_month: MONTH,
    active_months: [MONTH],
    in_back_office: over.in_back_office ?? true,
  };
}

// ---------------------------------------------------------------------------
// Test A — three disqualifier classes (each isolated per Standing Guard 3).
// ---------------------------------------------------------------------------

function runTestA(
  label: string,
  boRow: any,
): void {
  describe(`Test A — Dashboard stale BO inactive removed (${label})`, () => {
    // Member has stale persisted in_back_office=true but BO record is disqualified.
    const reconciled = [
      // Stale flag — should be flipped to false by overlay.
      { member_key: 'stale', in_ede: true, in_back_office: true, eligible_for_commission: 'Yes', in_commission: false, current_policy_aor: 'Jason Fine (21055210)', agent_npn: '21055210', issuer_subscriber_id: 'STALE1' },
      // Positive control — active BO row, must remain.
      { member_key: 'live', in_ede: true, in_back_office: true, eligible_for_commission: 'Yes', in_commission: true, current_policy_aor: 'Jason Fine (21055210)', agent_npn: '21055210', issuer_subscriber_id: 'LIVE1' },
    ];
    const filteredEde: FilteredEdeResult = {
      uniqueMembers: [
        eeRow({ member_key: 'stale', issuer_subscriber_id: 'STALE1', in_back_office: true }),
        eeRow({ member_key: 'live', issuer_subscriber_id: 'LIVE1', in_back_office: true }),
      ],
      uniqueKeys: 2, byMonth: { [MONTH]: 2 }, inBOCount: 2, notInBOCount: 0, missingFromBO: [],
    };
    const normalizedBo = [
      { source_type: 'BACK_OFFICE', member_key: 'stale', issuer_subscriber_id: 'STALE1', ...boRow },
      // live: fully active
      { source_type: 'BACK_OFFICE', member_key: 'live', issuer_subscriber_id: 'LIVE1', eligible_for_commission: 'Yes', policy_term_date: '2026-12-31', paid_through_date: '2025-01-01' },
    ];

    const overlay = applyRuntimeBOActive(reconciled, normalizedBo, BOUNDS);
    const boAdjustedReconciled = overlay.adjustedReconciled.filter((r: any) => !overlay.mceExclusionMemberKeys.has(r.member_key));
    const adjFilteredEde: FilteredEdeResult = {
      ...filteredEde,
      uniqueMembers: filteredEde.uniqueMembers.filter((m) => !overlay.mceExclusionMemberKeys.has(m.member_key)),
      uniqueKeys: filteredEde.uniqueMembers.filter((m) => !overlay.mceExclusionMemberKeys.has(m.member_key)).length,
    };

    it('stale member is in MCE exclusion set (overlay marked all matching BO rows inactive)', () => {
      expect(overlay.mceExclusionMemberKeys.has('stale')).toBe(true);
      expect(overlay.mceExclusionMemberKeys.has('live')).toBe(false);
    });

    it('stale member EXCLUDED from Dashboard EBU / Found / Source Coverage; live member RETAINED', () => {
      const epb = getExpectedPaymentBreakdown(boAdjustedReconciled, 'Coverall', adjFilteredEde, new Set());
      const unpaidKeys = epb.unpaidRows.map((r: any) => r.member_key);
      expect(unpaidKeys).not.toContain('stale');
      const universeKeys = epb.universe.rows.map((r: any) => r.member_key);
      expect(universeKeys).toContain('live');

      const found = getFoundInBackOffice(boAdjustedReconciled, 'Coverall', adjFilteredEde, new Set());
      // Only the live active BO row counts as Found.
      expect(found).toBe(1);

      const sc = getSourceCoverageBuckets(boAdjustedReconciled, 'Coverall', adjFilteredEde, [], [MONTH], new Set());
      expect(sc.expectedButUnpaid.rows.map((r: any) => r.member_key)).not.toContain('stale');
    });

    it('stale member does NOT re-enter via EDE-only branch after exclusion', () => {
      const u = getExpectedPaymentUniverse(boAdjustedReconciled, 'Coverall', adjFilteredEde, new Set());
      expect(u.edeOnly.map((r: any) => r.member_key)).not.toContain('stale');
      expect(u.boOnly.map((r: any) => r.member_key)).not.toContain('stale');
      expect(u.matched.map((r: any) => r.member_key)).not.toContain('stale');
    });
  });
}

runTestA('terminated (policy_term_date < statementMonthStart)', {
  eligible_for_commission: 'Yes',
  policy_term_date: '2026-01-15', // before Feb start
  paid_through_date: '2025-01-01',
});
// v5 Fix 1 — paid_through removed from disqualifier. Replaced original
// paid-through-covered case with a broker_effective_date future case (Fix 5).
runTestA('broker_effective_date future (Fix 5)', {
  eligible_for_commission: 'Yes',
  policy_term_date: '2026-12-31',
  broker_effective_date: '2026-06-15',
});

runTestA('ineligible (eligible_for_commission=No)', {
  eligible_for_commission: 'No',
  policy_term_date: '2026-12-31',
  paid_through_date: '2025-01-01',
});

// ---------------------------------------------------------------------------
// Test B — raw Expected Enrollments remains source-faithful.
// ---------------------------------------------------------------------------

describe('Test B — Dashboard raw Expected Enrollments remains source-faithful', () => {
  const reconciled = [
    { member_key: 'rawOnly', in_ede: true, in_back_office: true, eligible_for_commission: 'Yes', in_commission: false, current_policy_aor: 'Jason Fine (21055210)', agent_npn: '21055210', issuer_subscriber_id: 'R1' },
  ];
  const filteredEde: FilteredEdeResult = {
    uniqueMembers: [eeRow({ member_key: 'rawOnly', issuer_subscriber_id: 'R1' })],
    uniqueKeys: 1, byMonth: { [MONTH]: 1 }, inBOCount: 1, notInBOCount: 0, missingFromBO: [],
  };
  const normalizedBo = [
    // Terminated BO — overlay should disqualify.
    { source_type: 'BACK_OFFICE', member_key: 'rawOnly', issuer_subscriber_id: 'R1', eligible_for_commission: 'Yes', policy_term_date: '2026-01-15' },
  ];
  const overlay = applyRuntimeBOActive(reconciled, normalizedBo, BOUNDS);
  const adjustedFilteredEdeUniqueMembers = filteredEde.uniqueMembers.filter((m) => !overlay.mceExclusionMemberKeys.has(m.member_key));

  it('rawFilteredEde.uniqueMembers STILL contains the member', () => {
    expect(filteredEde.uniqueMembers.map((m) => m.member_key)).toContain('rawOnly');
    expect(filteredEde.uniqueKeys).toBe(1);
  });

  it('boAdjustedFilteredEde.uniqueMembers does NOT contain the member', () => {
    expect(adjustedFilteredEdeUniqueMembers.map((m) => m.member_key)).not.toContain('rawOnly');
  });

  it('raw byMonth + uniqueKeys reflect raw universe (override-aware tiles can diverge)', () => {
    expect(filteredEde.byMonth[MONTH]).toBe(1);
    // Override-aware view has 0.
    expect(adjustedFilteredEdeUniqueMembers.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test C — Christopher Ortiz Jan 2026 positive-control (BO-only).
// Synthetic fixture mirroring his live shape — synthetic identifiers ONLY.
// ---------------------------------------------------------------------------

describe('Test C — Christopher Ortiz Jan 2026 BO-only positive control', () => {
  const JAN = '2026-01';
  const JAN_BOUNDS = getStatementMonthBounds(JAN);
  // in_ede=false (BO-only), active BO, eligible Yes, unpaid.
  const reconciled = [
    {
      member_key: 'synth-ortiz',
      in_ede: false,
      in_back_office: true,
      eligible_for_commission: 'Yes',
      in_commission: false,
      current_policy_aor: 'Becky Shuta (16531877)',
      agent_npn: '16531877',
      issuer_subscriber_id: 'SYNTH-ORTIZ-1',
      policy_number: 'SYNTH-POL-1',
    },
  ];
  // EE universe does NOT include him (in_ede=false → not in current EE).
  const filteredEde: FilteredEdeResult = {
    uniqueMembers: [],
    uniqueKeys: 0, byMonth: { [JAN]: 0 }, inBOCount: 0, notInBOCount: 0, missingFromBO: [],
  };
  const normalizedBo = [
    {
      source_type: 'BACK_OFFICE',
      member_key: 'synth-ortiz',
      issuer_subscriber_id: 'SYNTH-ORTIZ-1',
      eligible_for_commission: 'Yes',
      policy_term_date: '2026-12-31',
      paid_through_date: '2025-01-01', // before Jan 2026 start — does NOT cover Jan
    },
  ];
  const overlay = applyRuntimeBOActive(reconciled, normalizedBo, JAN_BOUNDS);
  const boAdjustedReconciled = overlay.adjustedReconciled.filter((r: any) => !overlay.mceExclusionMemberKeys.has(r.member_key));

  it('NOT demoted by runtime overlay (active BO row)', () => {
    expect(overlay.mceExclusionMemberKeys.has('synth-ortiz')).toBe(false);
    const adj = overlay.adjustedReconciled.find((r: any) => r.member_key === 'synth-ortiz');
    expect(adj?.in_back_office).toBe(true);
  });

  it('MUST NOT appear in Found-in-BO (Found = EE-universe ∩ BO; in_ede=false)', () => {
    const found = getFoundInBackOffice(boAdjustedReconciled, 'Coverall', filteredEde, new Set());
    expect(found).toBe(0);
  });

  it('DOES appear in Expected Payment Universe as BO Only (Coverall + All)', () => {
    for (const scope of ['Coverall', 'All'] as const) {
      const u = getExpectedPaymentUniverse(boAdjustedReconciled, scope as any, filteredEde, new Set());
      expect(u.boOnly.map((r: any) => r.member_key)).toContain('synth-ortiz');
    }
  });

  it('Appears in Expected But Unpaid AND in Source Coverage Unpaid: Back Office Only', () => {
    const epb = getExpectedPaymentBreakdown(boAdjustedReconciled, 'Coverall', filteredEde, new Set());
    expect(epb.unpaidRows.map((r: any) => r.member_key)).toContain('synth-ortiz');
    const sc = getSourceCoverageBuckets(boAdjustedReconciled, 'Coverall', filteredEde, [], [JAN], new Set());
    expect(sc.expectedButUnpaid.rows.map((r: any) => r.member_key)).toContain('synth-ortiz');
  });
});

// ---------------------------------------------------------------------------
// Test D — Vix scope tuple parity.
// ---------------------------------------------------------------------------

describe('Test D — Vix scope tuple parity (runtime BO overlay is scope-blind)', () => {
  // One Vix row (Erica AOR + actual_pay_entity=Vix) and one Coverall row.
  const reconciled = [
    { member_key: 'vix1', in_ede: true, in_back_office: true, eligible_for_commission: 'Yes', in_commission: false, current_policy_aor: 'Erica Fine (21277051)', agent_npn: '21277051', actual_pay_entity: 'Vix', issuer_subscriber_id: 'VIX1' },
    { member_key: 'cov1', in_ede: true, in_back_office: true, eligible_for_commission: 'Yes', in_commission: false, current_policy_aor: 'Jason Fine (21055210)', agent_npn: '21055210', actual_pay_entity: 'Coverall', issuer_subscriber_id: 'COV1' },
  ];
  const filteredEde: FilteredEdeResult = {
    uniqueMembers: [
      eeRow({ member_key: 'vix1', issuer_subscriber_id: 'VIX1' }),
      eeRow({ member_key: 'cov1', issuer_subscriber_id: 'COV1' }),
    ],
    uniqueKeys: 2, byMonth: { [MONTH]: 2 }, inBOCount: 2, notInBOCount: 0, missingFromBO: [],
  };
  // Both have terminated BO rows — overlay should disqualify both regardless of scope.
  const normalizedBo = [
    { source_type: 'BACK_OFFICE', member_key: 'vix1', issuer_subscriber_id: 'VIX1', eligible_for_commission: 'Yes', policy_term_date: '2026-01-15' },
    { source_type: 'BACK_OFFICE', member_key: 'cov1', issuer_subscriber_id: 'COV1', eligible_for_commission: 'Yes', policy_term_date: '2026-01-15' },
  ];
  const overlay = applyRuntimeBOActive(reconciled, normalizedBo, BOUNDS);

  it('Vix-scoped row receives the SAME runtime BO semantics as a Coverall row', () => {
    // Helper is scope-blind: both disqualified.
    expect(overlay.mceExclusionMemberKeys.has('vix1')).toBe(true);
    expect(overlay.mceExclusionMemberKeys.has('cov1')).toBe(true);
  });

  it('Non-Vix Coverall row does NOT leak into Vix tile values (scope filtering preserved)', () => {
    const boAdjustedReconciled = overlay.adjustedReconciled.filter((r: any) => !overlay.mceExclusionMemberKeys.has(r.member_key));
    const adjFilteredEde: FilteredEdeResult = {
      ...filteredEde,
      uniqueMembers: filteredEde.uniqueMembers.filter((m) => !overlay.mceExclusionMemberKeys.has(m.member_key)),
      uniqueKeys: 0,
    };
    const vixUniverse = getExpectedPaymentUniverse(boAdjustedReconciled, 'Vix', adjFilteredEde, new Set());
    const vixKeys = vixUniverse.rows.map((r: any) => r.member_key);
    expect(vixKeys).not.toContain('cov1');
  });

  it('Found / Eligible / NotInBO Vix tuple reflects override-aware membership', () => {
    const boAdjustedReconciled = overlay.adjustedReconciled.filter((r: any) => !overlay.mceExclusionMemberKeys.has(r.member_key));
    const adjFilteredEde: FilteredEdeResult = {
      ...filteredEde,
      uniqueMembers: filteredEde.uniqueMembers.filter((m) => !overlay.mceExclusionMemberKeys.has(m.member_key)),
      uniqueKeys: 0,
    };
    // After overlay disqualifies the Vix row, Found-in-BO Vix = 0.
    expect(getFoundInBackOffice(boAdjustedReconciled, 'Vix' as any, adjFilteredEde, new Set())).toBe(0);
  });
});
