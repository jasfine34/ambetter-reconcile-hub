/**
 * TX Ambetter plan-tier expected-basis fix — helper + resolver guard tests.
 *
 * Covers:
 *  1. Value → $24 (Product=TX-Value)
 *  2. Premier → $29 (Product=TX-Premier)
 *  3. Plan Name fallback (Ansil Parajuli shape: Plan Name contains 'VALUE')
 *  4. Casing: helper returns lowercase only (titlecase never emitted)
 *  5. PLAN_TIER_UNRECOVERABLE: TX Ambetter, no tier in any source
 *  6. Non-TX / non-Ambetter unchanged (helper returns null, lookup unaffected)
 *  7. Premier NOT inferred from absence of VALUE in Plan Name
 */
import { describe, it, expect } from 'vitest';
import { deriveAmbetterTxPlanVariant } from '../planVariant';
import {
  createEstMissingResolver,
  type EstMissingInputEvidence,
} from '../estMissingResolver';
import type { CarrierCompRateRow } from '../compGrid';

const TX_VALUE_2026: CarrierCompRateRow = {
  id: 'rate-tx-value-2026',
  rate_key: 'ambetter|TX|value|2026',
  carrier_key: 'ambetter',
  carrier_display: 'Ambetter',
  state_code: 'TX',
  plan_variant: 'value',
  comp_basis: 'pmpm',
  calculation_basis: 'per_member_pmpm',
  rate_value: 24,
  rate_unit: 'USD',
  member_min: null,
  member_max: null,
  member_cap: null,
  effective_year: 2026,
  support_status: 'supported',
  unsupported_reason: null,
};
const TX_PREMIER_2026: CarrierCompRateRow = {
  ...TX_VALUE_2026,
  id: 'rate-tx-premier-2026',
  rate_key: 'ambetter|TX|premier|2026',
  plan_variant: 'premier',
  rate_value: 29,
};
const FL_STANDARD_2026: CarrierCompRateRow = {
  ...TX_VALUE_2026,
  id: 'rate-fl-standard-2026',
  rate_key: 'ambetter|FL|standard|2026',
  state_code: 'FL',
  plan_variant: 'standard',
  rate_value: 25,
};
const TX_RATES = [TX_VALUE_2026, TX_PREMIER_2026];

function ev(over: Partial<EstMissingInputEvidence> = {}): EstMissingInputEvidence {
  return {
    carrier: 'ambetter',
    state: 'TX',
    member_count: 1,
    months: 1,
    policy_year: 2026,
    plan_variant: null,
    current_policy_aor: 'Jason Fine (21055210)',
    matched_payee: 'Coverall',
    policy_identity_key: 'k1',
    target_service_month: '2026-03',
    ...over,
  };
}

describe('deriveAmbetterTxPlanVariant', () => {
  it('1. Product=TX-Value → value', () => {
    expect(
      deriveAmbetterTxPlanVariant({
        carrier: 'Ambetter',
        state: 'TX',
        sources: [{ raw_json: { Product: '2026 Ambetter TX-Value' } }],
      }),
    ).toBe('value');
  });

  it('2. Product=TX-Premier → premier', () => {
    expect(
      deriveAmbetterTxPlanVariant({
        carrier: 'ambetter',
        state: 'TX',
        sources: [{ raw_json: { Product: 'Ambetter TX-Premier' } }],
      }),
    ).toBe('premier');
  });

  it('3. Plan Name fallback (Standard Silver VALUE) → value', () => {
    expect(
      deriveAmbetterTxPlanVariant({
        carrier: 'Ambetter',
        state: 'TX',
        sources: [
          { raw_json: { Product: '2026 Ambetter TX' } },
          { raw_json: { 'Plan Name': 'Standard Silver VALUE' } },
        ],
      }),
    ).toBe('value');
  });

  it('4. Casing — helper output is lowercase only', () => {
    const out = deriveAmbetterTxPlanVariant({
      carrier: 'Ambetter',
      state: 'TX',
      sources: [{ raw_json: { plan_variant: 'Value' } }],
    });
    expect(out).toBe('value');
    expect(out).not.toBe('Value');
  });

  it('5. Absent in every source → null (Premier NOT inferred from no-VALUE)', () => {
    expect(
      deriveAmbetterTxPlanVariant({
        carrier: 'Ambetter',
        state: 'TX',
        sources: [
          { raw_json: { Product: '2026 Ambetter TX' } },
          { raw_json: { 'Plan Name': 'Standard Silver 123' } },
        ],
      }),
    ).toBeNull();
  });

  it('6. Non-TX / non-Ambetter → null (helper does not engage)', () => {
    expect(
      deriveAmbetterTxPlanVariant({
        carrier: 'Ambetter',
        state: 'FL',
        sources: [{ raw_json: { Product: 'TX-Value' } }],
      }),
    ).toBeNull();
    expect(
      deriveAmbetterTxPlanVariant({
        carrier: 'Cigna',
        state: 'TX',
        sources: [{ raw_json: { Product: 'TX-Value' } }],
      }),
    ).toBeNull();
  });
});

describe('estMissingResolver — TX Ambetter plan-tier guard', () => {
  const ctx = {
    rateRows: TX_RATES,
    batchMonth: '2026-03',
    scope: 'Coverall' as const,
  };
  const resolver = createEstMissingResolver(ctx);

  it('Value tier resolves to $24', () => {
    const r = resolver.resolve({
      row: { member_key: 'm1' },
      inputEvidence: ev({ plan_variant: 'value' }),
    });
    expect(r.status).toBe('RESOLVED');
    expect(r.amount).toBe(24);
  });

  it('Premier tier resolves to $29', () => {
    const r = resolver.resolve({
      row: { member_key: 'm1' },
      inputEvidence: ev({ plan_variant: 'premier' }),
    });
    expect(r.status).toBe('RESOLVED');
    expect(r.amount).toBe(29);
  });

  it('5. TX Ambetter no tier + both rows exist → PLAN_TIER_UNRECOVERABLE (NOT $29)', () => {
    const r = resolver.resolve({
      row: { member_key: 'm1' },
      inputEvidence: ev({ plan_variant: null }),
    });
    expect(r.status).toBe('UNSUPPORTED');
    expect(r.unsupported_reason).toBe('PLAN_TIER_UNRECOVERABLE');
    expect(r.amount).toBeNull();
  });

  it('6. Non-TX Ambetter (FL) with plan_variant=null → unchanged, no guard fires', () => {
    const flResolver = createEstMissingResolver({
      rateRows: [FL_STANDARD_2026],
      batchMonth: '2026-03',
      scope: 'Coverall',
    });
    const r = flResolver.resolve({
      row: { member_key: 'm1' },
      inputEvidence: ev({ state: 'FL', plan_variant: null }),
    });
    // FL has a single 'standard' row → resolves normally to $25.
    expect(r.status).toBe('RESOLVED');
    expect(r.amount).toBe(25);
  });
});
