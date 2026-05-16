/**
 * Bundle 13d — Override-rate seed lookup tests.
 */
import { describe, it, expect } from 'vitest';
import {
  AGENCY_TIER_OVERRIDE_RATES,
  findAgencyTierOverrideRate,
  type AgencyTierOverrideRate,
} from './agencyTierOverrideRates';

const EF = '21277051';

describe('findAgencyTierOverrideRate', () => {
  it('Erica Coverall Ambetter 2026 SC → $0.50 (state-invariant match)', () => {
    const r = findAgencyTierOverrideRate({ aor_npn: EF, pay_entity: 'Coverall', carrier_key: 'ambetter', policy_year: 2026, state_code: 'SC' });
    expect(r?.rate_amount).toBe(0.50);
  });

  it('Erica Coverall Ambetter 2026 FL → $0.50 (state-invariant)', () => {
    const r = findAgencyTierOverrideRate({ aor_npn: EF, pay_entity: 'Coverall', carrier_key: 'ambetter', policy_year: 2026, state_code: 'FL' });
    expect(r?.rate_amount).toBe(0.50);
  });

  it('Erica Vix Ambetter 2026 FL → $4.50', () => {
    const r = findAgencyTierOverrideRate({ aor_npn: EF, pay_entity: 'Vix', carrier_key: 'ambetter', policy_year: 2026, state_code: 'FL' });
    expect(r?.rate_amount).toBe(4.50);
  });

  it('Jason NPN → null', () => {
    const r = findAgencyTierOverrideRate({ aor_npn: '21055210', pay_entity: 'Coverall', carrier_key: 'ambetter', policy_year: 2026, state_code: 'SC' });
    expect(r).toBeNull();
  });

  it('different carrier_key → null', () => {
    const r = findAgencyTierOverrideRate({ aor_npn: EF, pay_entity: 'Coverall', carrier_key: 'bcbs_sc', policy_year: 2026, state_code: 'SC' });
    expect(r).toBeNull();
  });

  it('policy_year 2025 vs seed 2026 → null', () => {
    const r = findAgencyTierOverrideRate({ aor_npn: EF, pay_entity: 'Coverall', carrier_key: 'ambetter', policy_year: 2025, state_code: 'SC' });
    expect(r).toBeNull();
  });

  it('year-invariant synthetic seed matches arbitrary policy_year', () => {
    const synth: AgencyTierOverrideRate[] = [{
      aor_npn: EF, aor_name: 'Erica Fine', pay_entity: 'Coverall',
      carrier_key: 'ambetter', carrier_display: 'Ambetter',
      policy_year: null, state_code: null,
      rate_basis: 'per_policy_month', rate_amount: 0.50,
      confidence: 'assumed_from_business_rule',
      evidence: { observed_rows: 0, unique_amounts: [], observed_states: [], observed_member_counts: [], source: 'test' },
    }];
    const r = findAgencyTierOverrideRate({ aor_npn: EF, pay_entity: 'Coverall', carrier_key: 'ambetter', policy_year: 2099, state_code: 'TX' }, synth);
    expect(r?.rate_amount).toBe(0.50);
  });

  it('most-specific state wins over invariant', () => {
    const synth: AgencyTierOverrideRate[] = [
      { aor_npn: EF, aor_name: 'EF', pay_entity: 'Coverall', carrier_key: 'ambetter', carrier_display: 'Ambetter', policy_year: 2026, state_code: null, rate_basis: 'per_policy_month', rate_amount: 1.00, confidence: 'observed_constant', evidence: { observed_rows: 1, unique_amounts: [1], observed_states: [], observed_member_counts: [], source: 't' } },
      { aor_npn: EF, aor_name: 'EF', pay_entity: 'Coverall', carrier_key: 'ambetter', carrier_display: 'Ambetter', policy_year: 2026, state_code: 'SC', rate_basis: 'per_policy_month', rate_amount: 0.25, confidence: 'observed_constant', evidence: { observed_rows: 1, unique_amounts: [0.25], observed_states: ['SC'], observed_member_counts: [], source: 't' } },
    ];
    const r = findAgencyTierOverrideRate({ aor_npn: EF, pay_entity: 'Coverall', carrier_key: 'ambetter', policy_year: 2026, state_code: 'SC' }, synth);
    expect(r?.rate_amount).toBe(0.25);
  });

  it('same-specificity ambiguity → null', () => {
    const synth: AgencyTierOverrideRate[] = [
      { aor_npn: EF, aor_name: 'EF', pay_entity: 'Coverall', carrier_key: 'ambetter', carrier_display: 'Ambetter', policy_year: 2026, state_code: null, rate_basis: 'per_policy_month', rate_amount: 0.50, confidence: 'observed_constant', evidence: { observed_rows: 1, unique_amounts: [0.5], observed_states: [], observed_member_counts: [], source: 't' } },
      { aor_npn: EF, aor_name: 'EF', pay_entity: 'Coverall', carrier_key: 'ambetter', carrier_display: 'Ambetter', policy_year: 2026, state_code: null, rate_basis: 'per_policy_month', rate_amount: 0.75, confidence: 'observed_constant', evidence: { observed_rows: 1, unique_amounts: [0.75], observed_states: [], observed_member_counts: [], source: 't' } },
    ];
    const r = findAgencyTierOverrideRate({ aor_npn: EF, pay_entity: 'Coverall', carrier_key: 'ambetter', policy_year: 2026, state_code: 'SC' }, synth);
    expect(r).toBeNull();
  });

  it('byte-identical duplicates → first stable order', () => {
    const row: AgencyTierOverrideRate = { aor_npn: EF, aor_name: 'EF', pay_entity: 'Coverall', carrier_key: 'ambetter', carrier_display: 'Ambetter', policy_year: 2026, state_code: null, rate_basis: 'per_policy_month', rate_amount: 0.50, confidence: 'observed_constant', evidence: { observed_rows: 1, unique_amounts: [0.5], observed_states: [], observed_member_counts: [], source: 't' } };
    const r = findAgencyTierOverrideRate({ aor_npn: EF, pay_entity: 'Coverall', carrier_key: 'ambetter', policy_year: 2026 }, [row, { ...row }]);
    expect(r?.rate_amount).toBe(0.50);
  });

  it('built-in seed has no duplicate effective keys at same specificity', () => {
    const keys = new Set<string>();
    for (const r of AGENCY_TIER_OVERRIDE_RATES) {
      const k = JSON.stringify([r.aor_npn, r.pay_entity, r.carrier_key, r.policy_year, r.state_code]);
      expect(keys.has(k), `duplicate key ${k}`).toBe(false);
      keys.add(k);
    }
  });
});
