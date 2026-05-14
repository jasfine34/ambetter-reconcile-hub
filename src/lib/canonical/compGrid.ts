/**
 * Bundle 13a — Comp grid lookup (PURE, no DB I/O). v9 return-shape.
 *
 * SAFETY (enforced by compGrid.static.test.ts):
 * - No imports from @supabase, reconcile, metrics, or expectedEde.
 * - No legacy estimate-fallback constants.
 */

export interface CarrierCompRateRow {
  id: string;
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

export type V9UnsupportedReason =
  | 'percent_of_premium_not_implemented'
  | 'carrier_state_not_in_grid'
  | 'missing_required_input'
  | 'no_matching_member_bracket'
  | 'ambiguous_member_bracket'
  | 'bracket_math_not_confirmed'
  | 'carrier_canonical_unresolved'
  | 'comp_for_missing'
  | 'ambiguous_rate_variant'
  | 'plan_variant_not_found'
  | 'data_inconsistency_supported_unsupported_basis';

const V9_REASON_SET: ReadonlySet<string> = new Set<V9UnsupportedReason>([
  'percent_of_premium_not_implemented',
  'carrier_state_not_in_grid',
  'missing_required_input',
  'no_matching_member_bracket',
  'ambiguous_member_bracket',
  'bracket_math_not_confirmed',
  'carrier_canonical_unresolved',
  'comp_for_missing',
  'ambiguous_rate_variant',
  'plan_variant_not_found',
  'data_inconsistency_supported_unsupported_basis',
]);

// Row-level reasons are reasons that mean we selected a single row but cannot
// process it in v1. Selection-failure reasons leave us with no row.
const ROW_LEVEL_REASONS: ReadonlySet<V9UnsupportedReason> = new Set<V9UnsupportedReason>([
  'percent_of_premium_not_implemented',
  'bracket_math_not_confirmed',
  'carrier_canonical_unresolved',
  'comp_for_missing',
]);

export type CompBasisOut = 'pmpm' | 'pmpy' | 'percent_premium' | 'unsupported' | null;

export interface ExpectedCommissionEvidence {
  lookupKey: { carrier: string; state: string; effectiveYear: number; planVariant?: string | null };
  matchedRows: Array<{
    id: string;
    rate_key: string;
    rate_value: number | null;
    comp_basis: string;
    calculation_basis: string;
    member_min: number | null;
    member_max: number | null;
    member_cap: number | null;
    plan_variant: string | null;
  }>;
  availablePlanVariants?: Array<string | null>;
  computation: string;
}

export interface ExpectedCommissionResult {
  expectedAmount: number | null;
  rateRecordId: string | null;
  compBasis: CompBasisOut;
  supportStatus: 'supported' | 'unsupported_v1' | 'not_found';
  unsupportedReason?: V9UnsupportedReason;
  evidence: ExpectedCommissionEvidence;
}

export interface GetExpectedCommissionArgs {
  carrier: string;
  state: string;
  members: number;
  months: number;
  planVariant?: string | null;
  policyYear: number;
}

/** Map a policy year to the grid year that applies. v1 only seeds 2026. */
export function mapPolicyYearTo2026Grid(_policyYear: number): number {
  return 2026;
}

function summarizeRow(r: CarrierCompRateRow) {
  return {
    id: r.id,
    rate_key: r.rate_key,
    rate_value: r.rate_value,
    comp_basis: r.comp_basis,
    calculation_basis: r.calculation_basis,
    member_min: r.member_min,
    member_max: r.member_max,
    member_cap: r.member_cap,
    plan_variant: r.plan_variant,
  };
}

function compBasisFromRow(r: CarrierCompRateRow): CompBasisOut {
  const cb = (r.comp_basis ?? '').toLowerCase();
  if (cb === 'pmpm') return 'pmpm';
  if (cb === 'pmpy') return 'pmpy';
  if (cb === 'percent_premium') return 'percent_premium';
  return 'unsupported';
}

function notFound(
  reason: V9UnsupportedReason,
  evidence: ExpectedCommissionEvidence,
): ExpectedCommissionResult {
  return {
    expectedAmount: null,
    rateRecordId: null,
    compBasis: null,
    supportStatus: 'not_found',
    unsupportedReason: reason,
    evidence,
  };
}

/** Resolve an unsupported_v1 row's row-level reason per Addition L. */
function resolveRowLevelReason(raw: string | null | undefined): V9UnsupportedReason {
  if (raw == null) return 'data_inconsistency_supported_unsupported_basis';
  const trimmed = String(raw).trim();
  if (trimmed === '') return 'data_inconsistency_supported_unsupported_basis';
  if (!V9_REASON_SET.has(trimmed)) return 'data_inconsistency_supported_unsupported_basis';
  return trimmed as V9UnsupportedReason;
}

/**
 * Apply Correction C: deterministic resolution for an all-unsupported candidate
 * set (no supported row available to select).
 */
function resolveAllUnsupported(
  unsupportedRows: CarrierCompRateRow[],
  evidenceBase: ExpectedCommissionEvidence,
): ExpectedCommissionResult {
  if (unsupportedRows.length === 0) {
    return notFound('carrier_state_not_in_grid', {
      ...evidenceBase,
      computation: `${evidenceBase.computation} | resolveAllUnsupported called with 0 rows`,
    });
  }

  if (unsupportedRows.length === 1) {
    const row = unsupportedRows[0];
    const reason = resolveRowLevelReason(row.unsupported_reason);
    const evidence: ExpectedCommissionEvidence = {
      ...evidenceBase,
      computation:
        reason === 'data_inconsistency_supported_unsupported_basis' &&
        row.unsupported_reason !== 'data_inconsistency_supported_unsupported_basis'
          ? `${evidenceBase.computation} | unrecognized unsupported_reason raw=${JSON.stringify(row.unsupported_reason)}`
          : `${evidenceBase.computation} | single unsupported_v1 row reason=${reason}`,
    };
    if (ROW_LEVEL_REASONS.has(reason)) {
      return {
        expectedAmount: null,
        rateRecordId: row.id,
        compBasis: compBasisFromRow(row),
        supportStatus: 'unsupported_v1',
        unsupportedReason: reason,
        evidence,
      };
    }
    // Per Addition L: unknown/blank unsupported_reason → not_found data_inconsistency, rateRecordId=null.
    return notFound(reason, evidence);
  }

  // Multiple unsupported rows.
  const reasons = unsupportedRows.map(r => resolveRowLevelReason(r.unsupported_reason));
  const allSame = reasons.every(r => r === reasons[0]);
  if (allSame && ROW_LEVEL_REASONS.has(reasons[0])) {
    return {
      expectedAmount: null,
      rateRecordId: null,
      compBasis: 'unsupported',
      supportStatus: 'unsupported_v1',
      unsupportedReason: reasons[0],
      evidence: {
        ...evidenceBase,
        computation: `${evidenceBase.computation} | ${unsupportedRows.length} unsupported_v1 rows share reason=${reasons[0]}`,
      },
    };
  }
  return notFound('ambiguous_rate_variant', {
    ...evidenceBase,
    computation: `${evidenceBase.computation} | ${unsupportedRows.length} unsupported_v1 rows with mixed/unrecognized reasons`,
  });
}

/**
 * Resolve a final candidate set into a single chosen row (or a not_found result).
 * Handles bracket-priority + bracket overlap detection (Fix 5).
 */
function selectFromCandidates(
  candidates: CarrierCompRateRow[],
  members: number,
  evidenceBase: ExpectedCommissionEvidence,
): { chosen: CarrierCompRateRow } | { error: ExpectedCommissionResult } {
  const brackets = candidates.filter(r => r.calculation_basis === 'per_policy_monthly_bracket');
  if (brackets.length > 0) {
    const matches = brackets.filter(r => {
      const lo = r.member_min ?? 0;
      const hi = r.member_max ?? Number.POSITIVE_INFINITY;
      return members >= lo && members <= hi;
    });
    if (matches.length === 0) {
      return {
        error: notFound('no_matching_member_bracket', {
          ...evidenceBase,
          computation: `${evidenceBase.computation} | bracket rows present (${brackets.length}) but no range covers members=${members}`,
        }),
      };
    }
    if (matches.length > 1) {
      return {
        error: notFound('ambiguous_member_bracket', {
          ...evidenceBase,
          computation: `${evidenceBase.computation} | ${matches.length} bracket rows overlap for members=${members}`,
        }),
      };
    }
    return { chosen: matches[0] };
  }

  if (candidates.length === 1) {
    return { chosen: candidates[0] };
  }

  // Multiple non-bracket candidates: same calculation_basis → highest rate.
  const distinctBases = new Set(candidates.map(r => r.calculation_basis));
  if (distinctBases.size === 1) {
    const sorted = [...candidates].sort(
      (a, b) => (b.rate_value ?? -Infinity) - (a.rate_value ?? -Infinity),
    );
    return { chosen: sorted[0] };
  }

  // Mixed-basis among supported rows: data inconsistency.
  return {
    error: notFound('data_inconsistency_supported_unsupported_basis', {
      ...evidenceBase,
      computation: `${evidenceBase.computation} | mixed calculation_basis among ${candidates.length} candidates: ${[...distinctBases].join(',')}`,
    }),
  };
}

function computeMath(
  chosen: CarrierCompRateRow,
  members: number,
  months: number,
  evidenceBase: ExpectedCommissionEvidence,
): ExpectedCommissionResult {
  // Unsupported_v1 short-circuit on the chosen row.
  if (chosen.support_status === 'unsupported_v1') {
    const reason = resolveRowLevelReason(chosen.unsupported_reason);
    const evidence: ExpectedCommissionEvidence = {
      ...evidenceBase,
      computation:
        reason === 'data_inconsistency_supported_unsupported_basis' &&
        chosen.unsupported_reason !== 'data_inconsistency_supported_unsupported_basis'
          ? `${evidenceBase.computation} | chosen unsupported_v1 with unrecognized reason raw=${JSON.stringify(chosen.unsupported_reason)}`
          : `${evidenceBase.computation} | chosen unsupported_v1 reason=${reason}`,
    };
    if (ROW_LEVEL_REASONS.has(reason)) {
      return {
        expectedAmount: null,
        rateRecordId: chosen.id,
        compBasis: compBasisFromRow(chosen),
        supportStatus: 'unsupported_v1',
        unsupportedReason: reason,
        evidence,
      };
    }
    return notFound(reason, evidence);
  }

  if (chosen.calculation_basis === 'zero_rate') {
    return {
      expectedAmount: 0,
      rateRecordId: chosen.id,
      compBasis: compBasisFromRow(chosen),
      supportStatus: 'supported',
      evidence: { ...evidenceBase, computation: `${evidenceBase.computation} | zero_rate → 0` },
    };
  }

  if (chosen.rate_value == null) {
    return notFound('data_inconsistency_supported_unsupported_basis', {
      ...evidenceBase,
      computation: `${evidenceBase.computation} | supported row missing rate_value`,
    });
  }

  const rate = Number(chosen.rate_value);
  let expected: number;
  let formula: string;
  switch (chosen.calculation_basis) {
    case 'per_member_pmpm':
      expected = rate * members * months;
      formula = `${rate} * ${members} * ${months}`;
      break;
    case 'capped_member_pmpm': {
      const cap = chosen.member_cap ?? Number.POSITIVE_INFINITY;
      const eff = Math.min(members, cap);
      expected = rate * eff * months;
      formula = `${rate} * min(${members},${chosen.member_cap}) * ${months}`;
      break;
    }
    case 'per_policy_monthly_bracket':
      expected = rate * months;
      formula = `${rate} * ${months} (bracket ${chosen.member_min}-${chosen.member_max ?? '∞'})`;
      break;
    case 'pmpy':
      expected = rate * members;
      formula = `${rate} * ${members} (pmpy, months ignored)`;
      break;
    default:
      return notFound('data_inconsistency_supported_unsupported_basis', {
        ...evidenceBase,
        computation: `${evidenceBase.computation} | supported row with unknown calculation_basis=${chosen.calculation_basis}`,
      });
  }

  return {
    expectedAmount: expected,
    rateRecordId: chosen.id,
    compBasis: compBasisFromRow(chosen),
    supportStatus: 'supported',
    evidence: { ...evidenceBase, computation: `${evidenceBase.computation} | ${formula}` },
  };
}

export function getExpectedCommission(
  args: GetExpectedCommissionArgs,
  rateRows: CarrierCompRateRow[],
): ExpectedCommissionResult {
  const lookupKey = {
    carrier: args.carrier,
    state: args.state,
    effectiveYear: 0,
    planVariant: args.planVariant ?? null,
  };

  // Fix 6 — Missing input validation.
  const failures: string[] = [];
  if (typeof args.carrier !== 'string' || args.carrier.length === 0) failures.push('carrier');
  if (typeof args.state !== 'string' || args.state.length === 0) failures.push('state');
  if (
    typeof args.policyYear !== 'number' ||
    !Number.isInteger(args.policyYear) ||
    args.policyYear <= 0
  ) {
    failures.push('policyYear');
  }
  if (
    typeof args.members !== 'number' ||
    !Number.isInteger(args.members) ||
    args.members <= 0
  ) {
    failures.push('members');
  }
  if (
    typeof args.months !== 'number' ||
    !Number.isInteger(args.months) ||
    args.months <= 0
  ) {
    failures.push('months');
  }
  if (failures.length > 0) {
    return notFound('missing_required_input', {
      lookupKey,
      matchedRows: [],
      computation: `missing/invalid inputs: ${failures.join(',')}`,
    });
  }

  const effectiveYear = mapPolicyYearTo2026Grid(args.policyYear);
  lookupKey.effectiveYear = effectiveYear;

  // Step 1 — carrier + effective year.
  const carrierYear = rateRows.filter(
    r => r.carrier_key === args.carrier && r.effective_year === effectiveYear,
  );
  if (carrierYear.length === 0) {
    return notFound('carrier_state_not_in_grid', {
      lookupKey,
      matchedRows: [],
      computation: `no rows for carrier=${args.carrier} effectiveYear=${effectiveYear}`,
    });
  }

  // Step 2 — state filter with state_code IS NULL fallback.
  let stateRows = carrierYear.filter(r => r.state_code === args.state);
  let usedStateFallback = false;
  if (stateRows.length === 0) {
    stateRows = carrierYear.filter(r => r.state_code === null);
    usedStateFallback = stateRows.length > 0;
  }
  if (stateRows.length === 0) {
    return notFound('carrier_state_not_in_grid', {
      lookupKey,
      matchedRows: [],
      computation: `no state rows for state=${args.state} (and no state_code IS NULL fallback)`,
    });
  }

  const matchedRowsSummary = stateRows.map(summarizeRow);
  const evidenceBase: ExpectedCommissionEvidence = {
    lookupKey,
    matchedRows: matchedRowsSummary,
    availablePlanVariants: Array.from(new Set(stateRows.map(r => r.plan_variant))),
    computation: `step1=${carrierYear.length} step2=${stateRows.length}${usedStateFallback ? ' (state_code IS NULL fallback)' : ''}`,
  };

  // Step 3 — plan_variant resolution.
  const explicit = args.planVariant != null && args.planVariant !== '';

  if (explicit) {
    const exactMatchRows = stateRows.filter(r => r.plan_variant === args.planVariant);
    if (exactMatchRows.length === 0) {
      return notFound('plan_variant_not_found', {
        ...evidenceBase,
        computation: `${evidenceBase.computation} | no rows match planVariant=${args.planVariant}`,
      });
    }
    const supportedExact = exactMatchRows.filter(r => r.support_status === 'supported');
    if (supportedExact.length === 0) {
      return resolveAllUnsupported(exactMatchRows, {
        ...evidenceBase,
        computation: `${evidenceBase.computation} | explicit planVariant=${args.planVariant} all unsupported`,
      });
    }
    // Run selection on supportedExact only.
    const selectionEvidence: ExpectedCommissionEvidence = {
      ...evidenceBase,
      computation: `${evidenceBase.computation} | explicit planVariant=${args.planVariant} supportedExact=${supportedExact.length}`,
    };
    const sel = selectFromCandidates(supportedExact, args.members, selectionEvidence);
    if ('error' in sel) return sel.error;
    return computeMath(sel.chosen, args.members, args.months, selectionEvidence);
  }

  // planVariant null/undefined.
  const supportedRows = stateRows.filter(r => r.support_status === 'supported');
  const unsupportedRows = stateRows.filter(r => r.support_status === 'unsupported_v1');

  if (supportedRows.length === 0) {
    return resolveAllUnsupported(unsupportedRows, {
      ...evidenceBase,
      computation: `${evidenceBase.computation} | planVariant=null all unsupported`,
    });
  }

  // Bracket priority FIRST among supportedRows.
  const supportedBrackets = supportedRows.filter(
    r => r.calculation_basis === 'per_policy_monthly_bracket',
  );
  if (supportedBrackets.length > 0) {
    const sel = selectFromCandidates(supportedBrackets, args.members, evidenceBase);
    if ('error' in sel) return sel.error;
    return computeMath(sel.chosen, args.members, args.months, evidenceBase);
  }

  // Same-basis among supportedRows → highest-rate wins.
  const distinctBases = new Set(supportedRows.map(r => r.calculation_basis));
  if (distinctBases.size === 1) {
    const sel = selectFromCandidates(supportedRows, args.members, evidenceBase);
    if ('error' in sel) return sel.error;
    return computeMath(sel.chosen, args.members, args.months, evidenceBase);
  }

  // Mixed-basis among supportedRows: prefer plan_variant === 'standard'.
  const standardRows = supportedRows.filter(r => r.plan_variant === 'standard');
  if (standardRows.length === 1) {
    return computeMath(standardRows[0], args.members, args.months, {
      ...evidenceBase,
      computation: `${evidenceBase.computation} | mixed-basis resolved by plan_variant=standard`,
    });
  }
  if (standardRows.length > 1) {
    const sel = selectFromCandidates(standardRows, args.members, evidenceBase);
    if ('error' in sel) return sel.error;
    return computeMath(sel.chosen, args.members, args.months, evidenceBase);
  }
  // No 'standard' tag — ambiguous.
  return notFound('ambiguous_rate_variant', {
    ...evidenceBase,
    computation: `${evidenceBase.computation} | mixed-basis with no plan_variant=standard tag among supportedRows (bases=${[...distinctBases].join(',')})`,
  });
}
