/**
 * Bundle 13d — Agency-tier override rate seed.
 *
 * PURE module. No DB, no React, no sweep imports.
 *
 * Holds the single source of truth for AOR-tier override commission rates
 * (Erica Fine's Coverall / Vix downline rates against Ambetter 2026 today).
 * The wrapper `getExpectedCommissionForClearing` is the only authorized
 * consumer of this seed via `findAgencyTierOverrideRate`.
 */

export interface AgencyTierOverrideRate {
  aor_npn: string;
  aor_name: string;
  pay_entity: 'Coverall' | 'Vix';
  carrier_key: string;
  carrier_display: string;
  policy_year: number | null;
  state_code: string | null;
  rate_basis: 'per_policy_month' | 'per_member_per_month' | 'fixed_per_payment';
  rate_amount: number;
  confidence:
    | 'observed_constant'
    | 'observed_with_anomalies'
    | 'observed_single_row_plus_business_rule'
    | 'assumed_from_business_rule';
  evidence: {
    observed_rows: number;
    unique_amounts: number[];
    observed_states: string[];
    observed_member_counts: number[];
    source: string;
  };
}

export const AGENCY_TIER_OVERRIDE_RATES: readonly AgencyTierOverrideRate[] = [
  {
    aor_npn: '21277051',
    aor_name: 'Erica Fine',
    pay_entity: 'Coverall',
    carrier_key: 'ambetter',
    carrier_display: 'Ambetter',
    policy_year: 2026,
    state_code: null,
    rate_basis: 'per_policy_month',
    rate_amount: 0.50,
    confidence: 'observed_single_row_plus_business_rule',
    evidence: {
      observed_rows: 1,
      unique_amounts: [0.50],
      observed_states: ['SC'],
      observed_member_counts: [1],
      source: '13d-aor-override-expected-commission-audit',
    },
  },
  {
    aor_npn: '21277051',
    aor_name: 'Erica Fine',
    pay_entity: 'Vix',
    carrier_key: 'ambetter',
    carrier_display: 'Ambetter',
    policy_year: 2026,
    state_code: null,
    rate_basis: 'per_policy_month',
    rate_amount: 4.50,
    confidence: 'observed_single_row_plus_business_rule',
    evidence: {
      observed_rows: 1,
      unique_amounts: [4.50],
      observed_states: ['FL'],
      observed_member_counts: [1],
      source: '13d-aor-override-expected-commission-audit',
    },
  },
] as const;

export interface OverrideRateLookupKey {
  aor_npn: string;
  pay_entity: 'Coverall' | 'Vix';
  carrier_key: string;
  policy_year: number;
  state_code?: string | null;
}

function rowIdentityFields(r: AgencyTierOverrideRate) {
  return JSON.stringify([
    r.rate_amount,
    r.rate_basis,
    r.pay_entity,
    r.carrier_key,
    r.policy_year,
    r.state_code,
  ]);
}

/**
 * See module-level doc for the match-score / disqualifier / tie-break rules.
 */
export function findAgencyTierOverrideRate(
  key: OverrideRateLookupKey,
  rates: readonly AgencyTierOverrideRate[] = AGENCY_TIER_OVERRIDE_RATES,
): AgencyTierOverrideRate | null {
  const keyState = key.state_code ?? null;
  type Scored = { row: AgencyTierOverrideRate; score: number; order: number };
  const scored: Scored[] = [];

  rates.forEach((row, order) => {
    if (row.aor_npn !== key.aor_npn) return;
    if (row.pay_entity !== key.pay_entity) return;
    if (row.carrier_key !== key.carrier_key) return;
    if (row.policy_year !== null && row.policy_year !== key.policy_year) return;
    if (row.state_code !== null && row.state_code !== keyState) return;

    let score = 0;
    if (row.state_code !== null && row.state_code === keyState) score += 2;
    if (row.policy_year !== null && row.policy_year === key.policy_year) score += 1;
    scored.push({ row, score, order });
  });

  if (scored.length === 0) return null;

  scored.sort((a, b) => (b.score - a.score) || (a.order - b.order));
  const top = scored[0];
  if (scored.length === 1) return top.row;
  const next = scored[1];
  if (next.score !== top.score) return top.row;

  // Same top score → return first only if byte-identical on effective fields.
  if (rowIdentityFields(top.row) === rowIdentityFields(next.row)) return top.row;
  return null;
}
