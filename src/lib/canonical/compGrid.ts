/**
 * Bundle 13a — Comp grid lookup (PURE, no DB I/O).
 *
 * getExpectedCommission selects a single carrier_comp_rates row for a
 * (carrier, state, planVariant, members, months) tuple and computes the
 * expected commission per its calculation_basis.
 *
 * SAFETY RULES (enforced by compGrid.static.test.ts):
 * - No imports from @supabase, reconcile, metrics, or expectedEde.
 * - No references to DEFAULT_COMMISSION_ESTIMATE, estimated_missing_commission,
 *   or batch_average. This helper has no opinion on legacy fallbacks.
 */

export interface CarrierCompRateRow {
  rate_key: string;
  carrier_key: string;
  carrier_display: string;
  state_code: string | null;
  plan_variant: string | null;
  comp_basis: string;
  calculation_basis:
    | 'per_member_pmpm'
    | 'capped_member_pmpm'
    | 'per_policy_monthly_bracket'
    | 'pmpy'
    | 'percent_premium_unsupported'
    | 'zero_rate'
    | string;
  rate_value: number | null;
  rate_unit: string | null;
  member_min: number | null;
  member_max: number | null;
  member_cap: number | null;
  effective_year: number;
  support_status: 'supported' | 'unsupported_v1' | string;
  unsupported_reason: string | null;
}

export type ExpectedCommissionResult =
  | {
      ok: true;
      expectedCommission: number;
      matchedRow: CarrierCompRateRow;
      basis: CarrierCompRateRow['calculation_basis'];
    }
  | {
      ok: false;
      reason:
        | 'no_carrier_year_rows'
        | 'no_state_rows'
        | 'plan_variant_not_found'
        | 'no_bracket_match'
        | 'unsupported_v1'
        | 'percent_premium_unsupported'
        | 'missing_rate_value'
        | 'no_rows';
      matchedRow?: CarrierCompRateRow;
    };

export interface GetExpectedCommissionArgs {
  carrier: string;
  state: string | null;
  members: number;
  months: number;
  planVariant?: string | null;
  effectiveYear: number;
}

/**
 * Pure synchronous lookup. Caller supplies the full rate table (typically
 * from compGridLoader.loadCarrierCompRates).
 */
export function getExpectedCommission(
  args: GetExpectedCommissionArgs,
  rateRows: CarrierCompRateRow[],
): ExpectedCommissionResult {
  const { carrier, state, members, months, planVariant, effectiveYear } = args;

  // Step 1 — carrier + year filter
  const carrierYear = rateRows.filter(
    r => r.carrier_key === carrier && r.effective_year === effectiveYear,
  );
  if (carrierYear.length === 0) return { ok: false, reason: 'no_carrier_year_rows' };

  // Step 2 — state filter with state_code IS NULL fallback
  let stateRows = carrierYear.filter(r => r.state_code === state);
  if (stateRows.length === 0) {
    stateRows = carrierYear.filter(r => r.state_code === null);
  }
  if (stateRows.length === 0) return { ok: false, reason: 'no_state_rows' };

  // Step 3 — plan_variant resolution
  let candidates: CarrierCompRateRow[];
  if (planVariant != null && planVariant !== '') {
    candidates = stateRows.filter(r => r.plan_variant === planVariant);
    if (candidates.length === 0) return { ok: false, reason: 'plan_variant_not_found' };
  } else {
    // null planVariant — bracket priority FIRST
    const bracketRows = stateRows.filter(
      r => r.calculation_basis === 'per_policy_monthly_bracket',
    );
    if (bracketRows.length > 0) {
      candidates = bracketRows;
    } else {
      const distinctBases = new Set(stateRows.map(r => r.calculation_basis));
      if (distinctBases.size === 1) {
        // Same-basis highest-rate
        const sorted = [...stateRows].sort(
          (a, b) => (b.rate_value ?? -Infinity) - (a.rate_value ?? -Infinity),
        );
        candidates = [sorted[0]];
      } else {
        // Mixed-basis — prefer plan_variant === 'standard'
        const standardRows = stateRows.filter(r => r.plan_variant === 'standard');
        if (standardRows.length > 0) {
          candidates = standardRows;
        } else {
          // Last-resort: highest-rate within state set
          const sorted = [...stateRows].sort(
            (a, b) => (b.rate_value ?? -Infinity) - (a.rate_value ?? -Infinity),
          );
          candidates = [sorted[0]];
        }
      }
    }
  }

  if (candidates.length === 0) return { ok: false, reason: 'no_rows' };

  // Step 4 — bracket math BEFORE highest-rate fallback
  const bracketCands = candidates.filter(
    r => r.calculation_basis === 'per_policy_monthly_bracket',
  );
  let chosen: CarrierCompRateRow;
  if (bracketCands.length > 0) {
    const match = bracketCands.find(r => {
      const lo = r.member_min ?? 0;
      const hi = r.member_max ?? Number.POSITIVE_INFINITY;
      return members >= lo && members <= hi;
    });
    if (!match) return { ok: false, reason: 'no_bracket_match' };
    chosen = match;
  } else if (candidates.length === 1) {
    chosen = candidates[0];
  } else {
    // Same-basis multi-row — highest rate wins.
    const sorted = [...candidates].sort(
      (a, b) => (b.rate_value ?? -Infinity) - (a.rate_value ?? -Infinity),
    );
    chosen = sorted[0];
  }

  // Step 5 — short-circuits on the chosen row
  if (chosen.support_status === 'unsupported_v1') {
    if (chosen.calculation_basis === 'percent_premium_unsupported') {
      return { ok: false, reason: 'percent_premium_unsupported', matchedRow: chosen };
    }
    return { ok: false, reason: 'unsupported_v1', matchedRow: chosen };
  }
  if (chosen.calculation_basis === 'zero_rate') {
    return { ok: true, expectedCommission: 0, matchedRow: chosen, basis: 'zero_rate' };
  }

  if (chosen.rate_value == null) {
    return { ok: false, reason: 'missing_rate_value', matchedRow: chosen };
  }

  // Step 6 — math by basis
  const rate = Number(chosen.rate_value);
  let expected: number;
  switch (chosen.calculation_basis) {
    case 'per_member_pmpm':
      expected = rate * members * months;
      break;
    case 'capped_member_pmpm': {
      const cap = chosen.member_cap ?? Number.POSITIVE_INFINITY;
      expected = rate * Math.min(members, cap) * months;
      break;
    }
    case 'per_policy_monthly_bracket':
      expected = rate * months;
      break;
    case 'pmpy':
      expected = rate * members;
      break;
    default:
      return { ok: false, reason: 'missing_rate_value', matchedRow: chosen };
  }

  return { ok: true, expectedCommission: expected, matchedRow: chosen, basis: chosen.calculation_basis };
}
