/**
 * Bundle 13e — Resolver unit tests covering all 14 acceptance categories.
 *
 *  1. Factory creation
 *  2. Resolver priority order
 *  3. Each UnsupportedReason value
 *  4. plan_variant null happy path
 *  5. Owner classifier integration (Erica via classifyPolicyOwnerFromCurrentAor)
 *  6. RESOLVED_WITH_OVERRIDE for Erica + known payee
 *  7. (adapter — separate file)
 *  8. Memoization
 *  9. (consumer integration — separate file)
 * 10. (badge rendering — separate file)
 * 11. (MCE CSV — separate file)
 * 12. (invariant update — separate file)
 * 13. Regression: partial-clearing path preserved
 * 14. Regression: Erica override path preserved
 * 15. Legacy fallback paths removed (grep + runtime)
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createEstMissingResolver,
  aggregateEstMissing,
  formatTbdNeedsReviewBadge,
  isResolvedStatus,
  type EstMissingInputEvidence,
  type EstMissingResolution,
} from '../estMissingResolver';
import type { CarrierCompRateRow } from '../compGrid';
import type { AdjustedRow, ClearingOverlay } from '../crossBatchOverlay';
import * as helperModule from '../expectedCommissionForClearing';

// ---------- Fixtures ----------

const AMBETTER_FL_PMPM_2026: CarrierCompRateRow = {
  id: 'rate-fl-pmpm-2026',
  rate_key: 'ambetter|FL|standard|2026',
  carrier_key: 'ambetter',
  carrier_display: 'Ambetter',
  state_code: 'FL',
  plan_variant: 'standard',
  comp_basis: 'pmpm',
  calculation_basis: 'per_member_pmpm',
  rate_value: 25,
  rate_unit: 'USD',
  member_min: null,
  member_max: null,
  member_cap: null,
  effective_year: 2026,
  support_status: 'supported',
  unsupported_reason: null,
};

const AMBETTER_NULL_STATE_PMPM_2026: CarrierCompRateRow = {
  ...AMBETTER_FL_PMPM_2026,
  id: 'rate-null-state-pmpm-2026',
  rate_key: 'ambetter|*|standard|2026',
  state_code: null,
  plan_variant: null,
};

const RATE_ROWS: CarrierCompRateRow[] = [
  AMBETTER_FL_PMPM_2026,
  AMBETTER_NULL_STATE_PMPM_2026,
];

function baseEvidence(over: Partial<EstMissingInputEvidence> = {}): EstMissingInputEvidence {
  return {
    carrier: 'ambetter',
    state: 'FL',
    member_count: 2,
    months: 1,
    policy_year: 2026,
    plan_variant: 'standard',
    current_policy_aor: 'Jason Fine (21055210)',
    matched_payee: 'Coverall',
    policy_identity_key: 'k1',
    target_service_month: '2026-03',
    ...over,
  };
}

function adjReduce(remainder: number): AdjustedRow {
  const overlay: ClearingOverlay = {
    policy_identity_key: 'k1',
    target_service_month: '2026-03',
    clearing_state: 'partially_cleared',
    expected_amount: 100,
    actual_positive_amount: 100 - remainder,
    actual_reversal_amount: 0,
    actual_net_amount: 100 - remainder,
    remainder_owed: remainder,
    unpaid_batch_ids: [],
    payment_batch_ids: [],
    reversed_at_statement_month: null,
    first_full_clear_statement_month: null,
    evaluated_at: '2026-03-01',
    run_id: 'r',
    manual_review_reason: null,
  };
  return {
    row: { member_key: 'm1' },
    adjustment: { kind: 'reduce_dollars', remainder, overlay },
    effectiveEstMissing: remainder,
  };
}

const CTX = { rateRows: RATE_ROWS, batchMonth: '2026-03', scope: 'All' as const };

// ---------- Category 1: factory creation ----------

describe('Bundle 13e — createEstMissingResolver factory', () => {
  it('returns a resolve function', () => {
    const r = createEstMissingResolver(CTX);
    expect(typeof r.resolve).toBe('function');
  });

  it('factory closes over rateRows + scope (separate instances independent)', () => {
    const r1 = createEstMissingResolver({ ...CTX, rateRows: [] });
    const r2 = createEstMissingResolver(CTX);
    const ev = baseEvidence();
    expect(r1.resolve({ row: { member_key: 'm' }, inputEvidence: ev }).status).toBe('UNSUPPORTED');
    expect(r2.resolve({ row: { member_key: 'm' }, inputEvidence: ev }).status).toBe('RESOLVED');
  });
});

// ---------- Category 2: priority order ----------

describe('Bundle 13e — resolver priority', () => {
  it('PARTIAL_CLEARED_REMAINDER beats UNSUPPORTED beats TBD beats rate lookup', () => {
    const resolver = createEstMissingResolver(CTX);
    // partial wins even with missing evidence
    const r1 = resolver.resolve({
      row: { member_key: 'm1' },
      adjustedRow: adjReduce(42.5),
    });
    expect(r1.status).toBe('PARTIAL_CLEARED_REMAINDER');
    expect(r1.amount).toBe(42.5);

    // missing carrier beats TBD
    const r2 = resolver.resolve({
      row: { member_key: 'm2' },
      inputEvidence: baseEvidence({ carrier: null, current_policy_aor: 'Erica Fine (21277051)', matched_payee: null }),
    });
    expect(r2.status).toBe('UNSUPPORTED');
    expect(r2.unsupported_reason).toBe('MISSING_CARRIER');

    // TBD beats rate lookup
    const r3 = resolver.resolve({
      row: { member_key: 'm3' },
      inputEvidence: baseEvidence({ current_policy_aor: 'Erica Fine (21277051)', matched_payee: null }),
    });
    expect(r3.status).toBe('TBD_AMBIGUOUS_PAYEE');
  });
});

// ---------- Category 3: each UnsupportedReason ----------

describe('Bundle 13e — each UnsupportedReason value triggered', () => {
  const resolver = createEstMissingResolver(CTX);
  const cases: Array<[keyof EstMissingInputEvidence, EstMissingResolution['unsupported_reason']]> = [
    ['carrier', 'MISSING_CARRIER'],
    ['state', 'MISSING_STATE'],
    ['member_count', 'MISSING_MEMBER_COUNT'],
    ['months', 'MISSING_MONTHS'],
    ['policy_year', 'MISSING_POLICY_YEAR'],
  ];
  for (const [field, reason] of cases) {
    it(`${field} null → ${reason}`, () => {
      const ev = baseEvidence({ [field]: null } as any);
      const out = resolver.resolve({ row: { member_key: 'm' }, inputEvidence: ev });
      expect(out.status).toBe('UNSUPPORTED');
      expect(out.unsupported_reason).toBe(reason);
    });
  }

  it('NO_RATE_ROW when carrier/state/year combo has no grid row', () => {
    const out = resolver.resolve({
      row: { member_key: 'm' },
      inputEvidence: baseEvidence({ carrier: 'unknown_carrier' }),
    });
    expect(out.status).toBe('UNSUPPORTED');
    expect(out.unsupported_reason).toBe('NO_RATE_ROW');
  });

  it('member_count null + member_count_status=manual_review → MEMBER_COUNT_CONFLICT', () => {
    const ev = baseEvidence({ member_count: null, member_count_status: 'manual_review', member_count_conflicts: [1, 4] } as any);
    const out = resolver.resolve({ row: { member_key: 'm' }, inputEvidence: ev });
    expect(out.status).toBe('UNSUPPORTED');
    expect(out.unsupported_reason).toBe('MEMBER_COUNT_CONFLICT');
  });

  it('member_count null + member_count_status=unresolved → MISSING_MEMBER_COUNT (byte-identical)', () => {
    const ev = baseEvidence({ member_count: null, member_count_status: 'unresolved' } as any);
    const out = resolver.resolve({ row: { member_key: 'm' }, inputEvidence: ev });
    expect(out.status).toBe('UNSUPPORTED');
    expect(out.unsupported_reason).toBe('MISSING_MEMBER_COUNT');
  });
});

// ---------- Category 4: plan_variant null happy path ----------

describe('Bundle 13e — plan_variant null is valid', () => {
  it('returns RESOLVED via comp-grid (does NOT throw MISSING_PLAN_VARIANT)', () => {
    const resolver = createEstMissingResolver(CTX);
    const out = resolver.resolve({
      row: { member_key: 'm' },
      inputEvidence: baseEvidence({ plan_variant: null }),
    });
    expect(out.status).toBe('RESOLVED');
    expect(out.amount).toBeGreaterThan(0);
  });
});

// ---------- Category 5: owner classifier integration ----------

describe('Bundle 13e — owner classifier integration', () => {
  it('uses canonical classifier (NOT literal === "Erica") — matches "Erica Fine (21277051)"', () => {
    const resolver = createEstMissingResolver(CTX);
    const out = resolver.resolve({
      row: { member_key: 'm' },
      inputEvidence: baseEvidence({
        current_policy_aor: 'Erica Fine (21277051)',
        matched_payee: null,
      }),
    });
    expect(out.status).toBe('TBD_AMBIGUOUS_PAYEE');
  });

  it('lowercase variants also classify as EF', () => {
    const resolver = createEstMissingResolver(CTX);
    const out = resolver.resolve({
      row: { member_key: 'm' },
      inputEvidence: baseEvidence({
        current_policy_aor: 'erica fine',
        matched_payee: null,
      }),
    });
    expect(out.status).toBe('TBD_AMBIGUOUS_PAYEE');
  });

  it('non-EF AOR with null matched_payee still resolves via rate-chart', () => {
    const resolver = createEstMissingResolver(CTX);
    const out = resolver.resolve({
      row: { member_key: 'm' },
      inputEvidence: baseEvidence({
        current_policy_aor: 'Jason Fine (21055210)',
        matched_payee: null,
      }),
    });
    expect(out.status).toBe('RESOLVED');
  });
});

// ---------- Category 6 & 14: RESOLVED_WITH_OVERRIDE for Erica + payee ----------

describe('Bundle 13e — RESOLVED_WITH_OVERRIDE (Erica override path)', () => {
  it('Erica + Coverall → override branch flagged', () => {
    const resolver = createEstMissingResolver(CTX);
    const out = resolver.resolve({
      row: { member_key: 'm' },
      inputEvidence: baseEvidence({
        current_policy_aor: 'Erica Fine (21277051)',
        matched_payee: 'Coverall',
      }),
    });
    expect(out.status).toBe('RESOLVED_WITH_OVERRIDE');
    expect(out.evidence.override_entity).toBe('Coverall');
    expect(out.evidence.override_evidence_source?.startsWith('agency_tier_override(')).toBe(true);
  });

  it('Erica + Vix → override branch flagged', () => {
    const resolver = createEstMissingResolver(CTX);
    const out = resolver.resolve({
      row: { member_key: 'm' },
      inputEvidence: baseEvidence({
        current_policy_aor: 'Erica Fine (21277051)',
        matched_payee: 'Vix',
      }),
    });
    expect(out.status).toBe('RESOLVED_WITH_OVERRIDE');
    expect(out.evidence.override_entity).toBe('Vix');
  });
});

// ---------- Category 8: memoization ----------

describe('Bundle 13e — memoization', () => {
  it('identical evidence cache hits — underlying helper called once', () => {
    const spy = vi.spyOn(helperModule, 'getExpectedCommissionForClearing');
    spy.mockClear();
    const resolver = createEstMissingResolver(CTX);
    const ev = baseEvidence();
    resolver.resolve({ row: { member_key: 'a' }, inputEvidence: ev });
    resolver.resolve({ row: { member_key: 'b' }, inputEvidence: { ...ev } });
    resolver.resolve({ row: { member_key: 'c' }, inputEvidence: { ...ev } });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('different evidence cache misses', () => {
    const spy = vi.spyOn(helperModule, 'getExpectedCommissionForClearing');
    spy.mockClear();
    const resolver = createEstMissingResolver(CTX);
    resolver.resolve({ row: { member_key: 'a' }, inputEvidence: baseEvidence({ member_count: 1 }) });
    resolver.resolve({ row: { member_key: 'b' }, inputEvidence: baseEvidence({ member_count: 2 }) });
    resolver.resolve({ row: { member_key: 'c' }, inputEvidence: baseEvidence({ member_count: 3 }) });
    expect(spy).toHaveBeenCalledTimes(3);
    spy.mockRestore();
  });

  it('cache scoped to factory instance', () => {
    const spy = vi.spyOn(helperModule, 'getExpectedCommissionForClearing');
    spy.mockClear();
    const ev = baseEvidence();
    const r1 = createEstMissingResolver(CTX);
    const r2 = createEstMissingResolver(CTX);
    r1.resolve({ row: { member_key: 'a' }, inputEvidence: ev });
    r2.resolve({ row: { member_key: 'b' }, inputEvidence: ev });
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});

// ---------- Category 13: partial-clearing regression ----------

describe('Bundle 13e — partial-clearing path preserved', () => {
  it('partial remainder honored even when evidence missing', () => {
    const resolver = createEstMissingResolver(CTX);
    const out = resolver.resolve({
      row: { member_key: 'm' },
      adjustedRow: adjReduce(7.25),
    });
    expect(out.status).toBe('PARTIAL_CLEARED_REMAINDER');
    expect(out.amount).toBe(7.25);
    expect(out.evidence.partial_cleared_amount).toBe(7.25);
  });

  it('partial remainder also overrides TBD path (Erica + unknown payee + partial)', () => {
    const resolver = createEstMissingResolver(CTX);
    const out = resolver.resolve({
      row: { member_key: 'm' },
      adjustedRow: adjReduce(3),
      inputEvidence: baseEvidence({
        current_policy_aor: 'Erica Fine (21277051)',
        matched_payee: null,
      }),
    });
    expect(out.status).toBe('PARTIAL_CLEARED_REMAINDER');
  });
});

// ---------- Aggregation helpers (badge wiring) ----------

describe('Bundle 13e — aggregateEstMissing + badge formatting', () => {
  it('sums only resolved statuses', () => {
    const resolutions: EstMissingResolution[] = [
      { amount: 10, status: 'RESOLVED', evidence: {} as any },
      { amount: 5, status: 'RESOLVED_WITH_OVERRIDE', evidence: {} as any },
      { amount: 3, status: 'PARTIAL_CLEARED_REMAINDER', evidence: {} as any },
      { amount: null, status: 'TBD_AMBIGUOUS_PAYEE', evidence: {} as any },
      { amount: null, status: 'UNSUPPORTED', evidence: {} as any, unsupported_reason: 'NO_RATE_ROW' },
    ];
    const totals = aggregateEstMissing(resolutions);
    expect(totals.amount).toBe(18);
    expect(totals.resolvedCount).toBe(3);
    expect(totals.tbdCount).toBe(1);
    expect(totals.needsReviewCount).toBe(1);
  });

  it('badge string format', () => {
    expect(formatTbdNeedsReviewBadge({ tbdCount: 0, needsReviewCount: 0 })).toBeNull();
    expect(formatTbdNeedsReviewBadge({ tbdCount: 2, needsReviewCount: 5 })).toBe('2 TBD · 5 Needs Review');
  });

  it('isResolvedStatus helper', () => {
    expect(isResolvedStatus('RESOLVED')).toBe(true);
    expect(isResolvedStatus('RESOLVED_WITH_OVERRIDE')).toBe(true);
    expect(isResolvedStatus('PARTIAL_CLEARED_REMAINDER')).toBe(true);
    expect(isResolvedStatus('TBD_AMBIGUOUS_PAYEE')).toBe(false);
    expect(isResolvedStatus('UNSUPPORTED')).toBe(false);
  });
});

// ---------- Category 15: legacy fallback removal grep ----------

describe('Bundle 13e — legacy fallback paths removed (grep) [scoped to shipped files]', () => {
  const { readFileSync } = require('node:fs');
  const { resolve } = require('node:path');
  // NOTE: scoped to files migrated in this slice. Consumer-file wirings
  // (Dashboard, MCE, AgentSummary, UnpaidRecovery, Exceptions, metrics,
  // crossBatchOverlay) ship in the follow-up consumer-wiring slice and will
  // be added to this list at that time per the atomicity rule.
  const consumerFiles = [
    'src/lib/canonical/invariants.ts',
  ];

  it('no DEFAULT_COMMISSION_ESTIMATE in shipped files', () => {
    for (const f of consumerFiles) {
      const txt = readFileSync(resolve(process.cwd(), f), 'utf8');
      expect(txt, `${f} must not reference DEFAULT_COMMISSION_ESTIMATE`).not.toMatch(/DEFAULT_COMMISSION_ESTIMATE/);
    }
  });

  it('no `?? 0` or `|| 0` on estimated_missing_commission reads in shipped files', () => {
    for (const f of consumerFiles) {
      const txt = readFileSync(resolve(process.cwd(), f), 'utf8');
      expect(txt, `${f} must not use ?? 0 / || 0 on estimated_missing_commission`).not.toMatch(
        /estimated_missing_commission\s*(\?\?|\|\|)\s*0/,
      );
    }
  });
});

// ---------- Runtime per-consumer null-est input check ----------

describe('Bundle 13e — runtime: null estimated_missing_commission yields status-flagged result', () => {
  it('resolver returns RESOLVED for synthesized row with null legacy estimate', () => {
    const resolver = createEstMissingResolver(CTX);
    const out = resolver.resolve({
      row: { member_key: 'm', estimated_missing_commission: null },
      inputEvidence: baseEvidence(),
    });
    expect(out.status).toBe('RESOLVED');
    expect(out.amount).toBeGreaterThan(0);
  });

  it('resolver returns UNSUPPORTED (not 0, not 18, not blank) when inputs incomplete', () => {
    const resolver = createEstMissingResolver(CTX);
    const out = resolver.resolve({
      row: { member_key: 'm', estimated_missing_commission: null },
      inputEvidence: baseEvidence({ state: null }),
    });
    expect(out.status).toBe('UNSUPPORTED');
    expect(out.amount).toBeNull();
    expect(out.unsupported_reason).toBe('MISSING_STATE');
  });
});
