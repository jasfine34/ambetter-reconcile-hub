/**
 * Bundle 13d — Wrapper around `getExpectedCommission` that applies AOR-tier
 * overrides when the policy owner is Erica Fine and the matched payee is
 * concretely Coverall or Vix.
 *
 * PURE module. Allowed imports: sibling compGrid / policyOwner /
 * agencyTierOverrideRates, parent carrierCanonical. No DB, no React, no
 * sweep, no pages/components.
 */
import {
  getExpectedCommission,
  type CarrierCompRateRow,
  type ExpectedCommissionResult,
  type GetExpectedCommissionArgs,
  type ExpectedCommissionEvidence,
} from './compGrid';
import { classifyPolicyOwnerFromCurrentAor } from './policyOwner';
import {
  AGENCY_TIER_OVERRIDE_RATES,
  findAgencyTierOverrideRate,
  type AgencyTierOverrideRate,
} from './agencyTierOverrideRates';
import { canonicalCarrier } from '../carrierCanonical';

export interface ExpectedCommissionForClearingExtraArgs {
  current_policy_aor: string | null;
  matched_payee: 'Coverall' | 'Vix' | null;
  policy_identity_key: string;
  target_service_month: string;
}

function roundToCents(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function computeOverrideAmount(
  rate: AgencyTierOverrideRate,
  args: GetExpectedCommissionArgs,
): number | null {
  switch (rate.rate_basis) {
    case 'per_policy_month':
      return roundToCents(rate.rate_amount * args.months);
    case 'per_member_per_month':
      return roundToCents(rate.rate_amount * args.members * args.months);
    case 'fixed_per_payment':
      return roundToCents(rate.rate_amount);
    default:
      return null;
  }
}

export function getExpectedCommissionForClearing(
  args: GetExpectedCommissionArgs,
  rateRows: CarrierCompRateRow[],
  extra: ExpectedCommissionForClearingExtraArgs,
  overrideRates: readonly AgencyTierOverrideRate[] = AGENCY_TIER_OVERRIDE_RATES,
): ExpectedCommissionResult {
  const owner = classifyPolicyOwnerFromCurrentAor(extra.current_policy_aor);
  const payee = extra.matched_payee;

  if (owner === 'EF' && (payee === 'Coverall' || payee === 'Vix')) {
    const carrierKey = canonicalCarrier(args.carrier) || args.carrier;
    const override = findAgencyTierOverrideRate(
      {
        aor_npn: '21277051',
        pay_entity: payee,
        carrier_key: carrierKey,
        policy_year: args.policyYear,
        state_code: args.state ?? null,
      },
      overrideRates,
    );
    if (override) {
      const amount = computeOverrideAmount(override, args);
      if (amount !== null) {
        const evidence: ExpectedCommissionEvidence = {
          lookupKey: {
            carrier: args.carrier,
            state: args.state,
            effectiveYear: args.policyYear,
            planVariant: args.planVariant ?? null,
          },
          matchedRows: [],
          computation:
            `agency_tier_override(${override.aor_name}/${override.pay_entity}/${override.carrier_key}/${override.policy_year ?? 'year-invariant'}): ` +
            `${override.rate_basis} $${override.rate_amount} → $${amount.toFixed(2)} ` +
            `(members=${args.members}, months=${args.months}, policy=${extra.policy_identity_key}, service_month=${extra.target_service_month})`,
        };
        return {
          expectedAmount: amount,
          rateRecordId: null,
          compBasis: 'pmpm',
          supportStatus: 'supported',
          evidence,
        };
      }
      // Defensive fall-through on unknown rate_basis cast.
    }
  }

  return getExpectedCommission(args, rateRows);
}

/**
 * Step 2 — Erica-AOR typed-review support.
 *
 * Returns the RAW full-PMPM expected (bypassing the Erica override wrapper)
 * for the given clearing args. Used exclusively by the typed-review detector
 * in `blockerFacts.detectTypedReview` to compare actual paid amount against
 * the alternative (non-override) basis. Never used for money resolution.
 *
 * Kept here — rather than in a caller — so the Fix 7 static guard (only
 * this wrapper may import `getExpectedCommission`) remains intact.
 */
export function getFullPmpmExpectedForTypedReview(
  args: GetExpectedCommissionArgs,
  rateRows: CarrierCompRateRow[],
): number | null {
  return getExpectedCommission(args, rateRows).expectedAmount;
}
