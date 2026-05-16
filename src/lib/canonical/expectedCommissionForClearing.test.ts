/**
 * Bundle 13d — Wrapper behavior tests.
 */
import { describe, it, expect } from 'vitest';
import { getExpectedCommissionForClearing } from './expectedCommissionForClearing';
import type { CarrierCompRateRow } from './compGrid';
import type { AgencyTierOverrideRate } from './agencyTierOverrideRates';

const EF_AOR = 'Erica Fine (21277051)';
const JF_AOR = 'Jason Fine (21055210)';
const BS_AOR = 'Becky Shuta (16531877)';

// Synthetic Ambetter SC PMPM $34 rate row so non-override paths produce a known value.
const compRates: CarrierCompRateRow[] = [
  {
    id: 'amb-sc-2026',
    rate_key: 'ambetter|SC|2026',
    carrier_key: 'ambetter',
    carrier_display: 'Ambetter',
    state_code: 'SC',
    plan_variant: null,
    comp_basis: 'pmpm',
    calculation_basis: 'per_member_pmpm',
    rate_value: 34,
    rate_unit: 'pmpm',
    member_min: null,
    member_max: null,
    member_cap: null,
    effective_year: 2026,
    support_status: 'supported',
    unsupported_reason: null,
  },
  {
    id: 'amb-fl-2026',
    rate_key: 'ambetter|FL|2026',
    carrier_key: 'ambetter',
    carrier_display: 'Ambetter',
    state_code: 'FL',
    plan_variant: null,
    comp_basis: 'pmpm',
    calculation_basis: 'per_member_pmpm',
    rate_value: 34,
    rate_unit: 'pmpm',
    member_min: null,
    member_max: null,
    member_cap: null,
    effective_year: 2026,
    support_status: 'supported',
    unsupported_reason: null,
  },
];

function args(over: Partial<Parameters<typeof getExpectedCommissionForClearing>[0]> = {}) {
  return {
    carrier: 'ambetter',
    state: 'SC',
    members: 1,
    months: 1,
    planVariant: null,
    policyYear: 2026,
    ...over,
  } as Parameters<typeof getExpectedCommissionForClearing>[0];
}

function extra(over: Partial<Parameters<typeof getExpectedCommissionForClearing>[2]> = {}) {
  return {
    current_policy_aor: EF_AOR,
    matched_payee: 'Coverall' as 'Coverall' | 'Vix' | null,
    policy_identity_key: 'ambetter|p1',
    target_service_month: '2026-02',
    ...over,
  };
}

describe('getExpectedCommissionForClearing — override path', () => {
  it('EF + Coverall + Ambetter 2026 m=1 months=1 → $0.50', () => {
    const r = getExpectedCommissionForClearing(args(), compRates, extra());
    expect(r.expectedAmount).toBe(0.50);
    expect(r.supportStatus).toBe('supported');
    expect(r.compBasis).toBe('pmpm');
    expect(r.evidence.computation).toContain('agency_tier_override');
    expect(r.rateRecordId).toBeNull();
  });

  it('EF + Vix + Ambetter 2026 FL → $4.50', () => {
    const r = getExpectedCommissionForClearing(args({ state: 'FL' }), compRates, extra({ matched_payee: 'Vix' }));
    expect(r.expectedAmount).toBe(4.50);
  });

  it('EF + Coverall months=3 (per_policy_month basis) → $1.50', () => {
    const r = getExpectedCommissionForClearing(args({ months: 3 }), compRates, extra());
    expect(r.expectedAmount).toBe(1.50);
  });

  it('override evidence has lookupKey / matchedRows / computation', () => {
    const r = getExpectedCommissionForClearing(args(), compRates, extra());
    expect(r.evidence.lookupKey).toBeDefined();
    expect(Array.isArray(r.evidence.matchedRows)).toBe(true);
    expect(typeof r.evidence.computation).toBe('string');
  });
});

describe('getExpectedCommissionForClearing — fallthrough path', () => {
  it('EF + null payee → carrier comp grid $34', () => {
    const r = getExpectedCommissionForClearing(args(), compRates, extra({ matched_payee: null }));
    expect(r.expectedAmount).toBe(34);
  });

  it('JF + Coverall → comp grid $34', () => {
    const r = getExpectedCommissionForClearing(args(), compRates, extra({ current_policy_aor: JF_AOR }));
    expect(r.expectedAmount).toBe(34);
  });

  it('BS + Coverall → comp grid $34', () => {
    const r = getExpectedCommissionForClearing(args(), compRates, extra({ current_policy_aor: BS_AOR }));
    expect(r.expectedAmount).toBe(34);
  });

  it('EF + Coverall + BCBS_SC 2026 (carrier not in override seed) → comp grid fallthrough', () => {
    const r = getExpectedCommissionForClearing(args({ carrier: 'bcbs_sc' }), compRates, extra());
    // No bcbs_sc rate row → not_found, but the key point is we fell through.
    expect(r.supportStatus).toBe('not_found');
  });

  it('EF + Coverall + Ambetter 2025 (year not in override) → comp grid fallthrough $34', () => {
    const r = getExpectedCommissionForClearing(args({ policyYear: 2025 }), compRates, extra());
    expect(r.expectedAmount).toBe(34);
  });

  it('null current_policy_aor (Other) → comp grid', () => {
    const r = getExpectedCommissionForClearing(args(), compRates, extra({ current_policy_aor: null }));
    expect(r.expectedAmount).toBe(34);
  });

  it('fallthrough preserves comp-grid evidence shape', () => {
    const r = getExpectedCommissionForClearing(args(), compRates, extra({ matched_payee: null }));
    expect(r.evidence.lookupKey).toBeDefined();
    expect(Array.isArray(r.evidence.matchedRows)).toBe(true);
    expect(typeof r.evidence.computation).toBe('string');
  });

  it('unknown rate_basis cast → falls through to comp grid', () => {
    const synth: AgencyTierOverrideRate[] = [{
      aor_npn: '21277051', aor_name: 'EF', pay_entity: 'Coverall',
      carrier_key: 'ambetter', carrier_display: 'Ambetter',
      policy_year: 2026, state_code: null,
      rate_basis: 'unknown_basis' as any, rate_amount: 0.50,
      confidence: 'assumed_from_business_rule',
      evidence: { observed_rows: 0, unique_amounts: [], observed_states: [], observed_member_counts: [], source: 't' },
    }];
    const r = getExpectedCommissionForClearing(args(), compRates, extra(), synth);
    expect(r.expectedAmount).toBe(34);
  });
});
