/**
 * Bundle 13e — Unified estimated_missing_commission resolver.
 *
 * PURE module. No Supabase, no React, no compGridLoader imports. Receives
 * pre-loaded rateRows from the page/report boundary.
 *
 * Replaces the 4-way scattered fallback behavior ($0 / $18 / blank / average)
 * across 8 consumers with a single rate-chart-backed resolver that returns
 * explicit status states instead of silent fallbacks.
 *
 * See codex-comm/directives/bundle-13e for the full contract. Priority order:
 *   1. PARTIAL_CLEARED_REMAINDER  (overlay reduce_dollars wins; precomputed
 *      remainder reflects clearing-time pay_entity that no longer needs
 *      re-derivation)
 *   2. UNSUPPORTED required-input check (first-encountered null wins:
 *      carrier > state > member_count > months > policy_year; plan_variant
 *      null is VALID and passes through to comp-grid)
 *   3. TBD_AMBIGUOUS_PAYEE (Erica AOR with no matched_payee and no partial
 *      remainder — override path can't fire)
 *   4. Rate-chart RESOLVED / RESOLVED_WITH_OVERRIDE via
 *      getExpectedCommissionForClearing
 *   5. NO_RATE_ROW → UNSUPPORTED
 */
import { getExpectedCommissionForClearing } from './expectedCommissionForClearing';
import type { CarrierCompRateRow } from './compGrid';
import type { CanonicalScope } from './scope';
import type { AdjustedRow, ClearingOverlayMap } from './crossBatchOverlay';
import { classifyPolicyOwnerFromCurrentAor } from './policyOwner';
import { canonicalCarrier } from '../carrierCanonical';

export interface EstMissingResolverContext {
  rateRows: CarrierCompRateRow[];
  batchMonth: string;
  scope: CanonicalScope;
  overlayMap?: ClearingOverlayMap;
  sourceEvidenceByMemberKey?: Map<string, EstMissingInputEvidence>;
}

export interface EstMissingInputEvidence {
  carrier: string | null;
  state: string | null;
  member_count: number | null;
  months: number | null;
  policy_year: number | null;
  plan_variant?: string | null;
  current_policy_aor: string | null;
  matched_payee: 'Coverall' | 'Vix' | null;
  policy_identity_key?: string | null;
  target_service_month?: string | null;
  member_count_status?: 'resolved' | 'manual_review' | 'unresolved' | null;
  member_count_conflicts?: number[];
}

export interface ResolveEstMissingInput {
  row: ReconciledMemberLike;
  adjustedRow?: AdjustedRow;
  inputEvidence?: EstMissingInputEvidence;
}

export interface EstMissingResolution {
  amount: number | null;
  status: EstMissingStatus;
  evidence: EstMissingEvidence;
  unsupported_reason?: UnsupportedReason;
}

export type EstMissingStatus =
  | 'RESOLVED'
  | 'RESOLVED_WITH_OVERRIDE'
  | 'PARTIAL_CLEARED_REMAINDER'
  | 'TBD_AMBIGUOUS_PAYEE'
  | 'UNSUPPORTED';

export type UnsupportedReason =
  | 'NO_RATE_ROW'
  | 'MISSING_CARRIER'
  | 'MISSING_STATE'
  | 'MISSING_MEMBER_COUNT'
  | 'MEMBER_COUNT_CONFLICT'
  | 'MISSING_MONTHS'
  | 'MISSING_POLICY_YEAR'
  | 'PLAN_TIER_UNRECOVERABLE';

export interface EstMissingEvidence {
  carrier: string | null;
  state: string | null;
  member_count: number | null;
  months: number | null;
  policy_year: number | null;
  plan_variant: string | null;
  rate_row_id: string | null;
  current_policy_aor: string | null;
  matched_payee: 'Coverall' | 'Vix' | null;
  partial_cleared_amount?: number;
  override_amount?: number;
  override_entity?: 'Coverall' | 'Vix';
  override_evidence_source?: string;
}

export interface ReconciledMemberLike {
  member_key: string;
  current_policy_aor?: string | null;
  effective_date?: string | null;
  target_service_month?: string | null;
  expected_ede_effective_month?: string | null;
  estimated_missing_commission?: number | null;
}

const MEMO_LRU_MAX = 1000;

interface MemoEntry {
  amount: number | null;
  status: EstMissingStatus;
  rate_row_id: string | null;
  isOverride: boolean;
  override_evidence_source?: string;
  unsupported_reason?: UnsupportedReason;
}

function buildBaseEvidence(ev: EstMissingInputEvidence | undefined): EstMissingEvidence {
  return {
    carrier: ev?.carrier ?? null,
    state: ev?.state ?? null,
    member_count: ev?.member_count ?? null,
    months: ev?.months ?? null,
    policy_year: ev?.policy_year ?? null,
    plan_variant: ev?.plan_variant ?? null,
    rate_row_id: null,
    current_policy_aor: ev?.current_policy_aor ?? null,
    matched_payee: ev?.matched_payee ?? null,
  };
}

function checkRequiredInputs(ev: EstMissingInputEvidence): UnsupportedReason | null {
  if (ev.carrier == null) return 'MISSING_CARRIER';
  if (ev.state == null) return 'MISSING_STATE';
  if (ev.member_count == null) {
    return ev.member_count_status === 'manual_review'
      ? 'MEMBER_COUNT_CONFLICT'
      : 'MISSING_MEMBER_COUNT';
  }
  if (ev.months == null) return 'MISSING_MONTHS';
  if (ev.policy_year == null) return 'MISSING_POLICY_YEAR';
  return null;
}

function memoKey(ev: EstMissingInputEvidence): string {
  return [
    ev.carrier,
    ev.state,
    ev.plan_variant ?? '__null__',
    ev.policy_year,
    ev.member_count,
    ev.months,
    ev.current_policy_aor,
    ev.matched_payee ?? '__null__',
  ].join('|');
}

export function createEstMissingResolver(ctx: EstMissingResolverContext): {
  resolve(input: ResolveEstMissingInput): EstMissingResolution;
} {
  const cache = new Map<string, MemoEntry>();

  function memoGet(key: string): MemoEntry | undefined {
    const v = cache.get(key);
    if (v !== undefined) {
      // LRU touch
      cache.delete(key);
      cache.set(key, v);
    }
    return v;
  }
  function memoSet(key: string, v: MemoEntry) {
    if (cache.size >= MEMO_LRU_MAX) {
      const first = cache.keys().next().value;
      if (first !== undefined) cache.delete(first);
    }
    cache.set(key, v);
  }

  function resolve(input: ResolveEstMissingInput): EstMissingResolution {
    const ev =
      input.inputEvidence ??
      ctx.sourceEvidenceByMemberKey?.get(input.row.member_key) ??
      undefined;
    const baseEvidence = buildBaseEvidence(ev);
    const adj = input.adjustedRow?.adjustment;
    const hasPartialRemainder = adj?.kind === 'reduce_dollars';

    // 1. PARTIAL_CLEARED_REMAINDER — overlay wins.
    if (adj && adj.kind === 'reduce_dollars') {
      const remainder = adj.remainder;
      return {
        amount: remainder,
        status: 'PARTIAL_CLEARED_REMAINDER',
        evidence: { ...baseEvidence, partial_cleared_amount: remainder },
      };
    }

    if (!ev) {
      return {
        amount: null,
        status: 'UNSUPPORTED',
        evidence: baseEvidence,
        unsupported_reason: 'MISSING_CARRIER',
      };
    }

    // 2. Required-input check.
    const missing = checkRequiredInputs(ev);
    if (missing) {
      return {
        amount: null,
        status: 'UNSUPPORTED',
        evidence: baseEvidence,
        unsupported_reason: missing,
      };
    }

    // 2b. TX Ambetter plan-tier safety net: when both 'value' and 'premier'
    //     rows exist for TX Ambetter in the policy year and we cannot derive
    //     the tier, refuse to fall through to comp-grid (which would silently
    //     pick the highest-rate row). Route to manual_review via the engine.
    if (
      ev.plan_variant == null &&
      canonicalCarrier(ev.carrier) === 'ambetter' &&
      String(ev.state).toUpperCase() === 'TX'
    ) {
      const txAmbetterRows = ctx.rateRows.filter(
        (r) =>
          r.carrier_key === 'ambetter' &&
          r.state_code === 'TX' &&
          r.effective_year === ev.policy_year &&
          r.support_status === 'supported',
      );
      const hasValue = txAmbetterRows.some((r) => r.plan_variant === 'value');
      const hasPremier = txAmbetterRows.some((r) => r.plan_variant === 'premier');
      if (hasValue && hasPremier) {
        return {
          amount: null,
          status: 'UNSUPPORTED',
          evidence: baseEvidence,
          unsupported_reason: 'PLAN_TIER_UNRECOVERABLE',
        };
      }
    }

    const owner = classifyPolicyOwnerFromCurrentAor(ev.current_policy_aor);

    // 3. TBD_AMBIGUOUS_PAYEE — Erica with unknown payee blocks override
    //    AND blocks rate-chart resolution (we don't know which payee to bill).
    if (owner === 'EF' && ev.matched_payee == null && !hasPartialRemainder) {
      return {
        amount: null,
        status: 'TBD_AMBIGUOUS_PAYEE',
        evidence: baseEvidence,
      };
    }

    // 4. Rate-chart lookup (with memoization).
    const key = memoKey(ev);
    let entry = memoGet(key);
    if (!entry) {
      const result = getExpectedCommissionForClearing(
        {
          carrier: ev.carrier as string,
          state: ev.state as string,
          members: ev.member_count as number,
          months: ev.months as number,
          planVariant: ev.plan_variant ?? null,
          policyYear: ev.policy_year as number,
        },
        ctx.rateRows,
        {
          current_policy_aor: ev.current_policy_aor,
          matched_payee: ev.matched_payee,
          policy_identity_key: ev.policy_identity_key ?? '',
          target_service_month: ev.target_service_month ?? '',
        },
        undefined,
      );

      const computation =
        typeof result.evidence?.computation === 'string'
          ? result.evidence.computation
          : '';
      const isOverride =
        owner === 'EF' &&
        (ev.matched_payee === 'Coverall' || ev.matched_payee === 'Vix') &&
        result.supportStatus === 'supported' &&
        computation.startsWith('agency_tier_override(');

      if (result.expectedAmount == null) {
        entry = {
          amount: null,
          status: 'UNSUPPORTED',
          rate_row_id: null,
          isOverride: false,
          unsupported_reason: 'NO_RATE_ROW',
        };
      } else {
        entry = {
          amount: result.expectedAmount,
          status: isOverride ? 'RESOLVED_WITH_OVERRIDE' : 'RESOLVED',
          rate_row_id: result.rateRecordId,
          isOverride,
          override_evidence_source: isOverride ? computation : undefined,
        };
      }
      memoSet(key, entry);
    }

    if (entry.status === 'UNSUPPORTED') {
      return {
        amount: null,
        status: 'UNSUPPORTED',
        evidence: baseEvidence,
        unsupported_reason: entry.unsupported_reason ?? 'NO_RATE_ROW',
      };
    }

    const evidence: EstMissingEvidence = {
      ...baseEvidence,
      rate_row_id: entry.rate_row_id,
    };
    if (entry.isOverride && entry.amount != null) {
      evidence.override_amount = entry.amount;
      evidence.override_entity = ev.matched_payee as 'Coverall' | 'Vix';
      if (entry.override_evidence_source) {
        evidence.override_evidence_source = entry.override_evidence_source;
      }
    }
    return { amount: entry.amount, status: entry.status, evidence };
  }

  return { resolve };
}

// ---------------------------------------------------------------------------
// Aggregation helpers consumed by tile/badge surfaces.
// ---------------------------------------------------------------------------

export interface EstMissingTileTotals {
  /** Sum of amounts where status ∈ {RESOLVED, RESOLVED_WITH_OVERRIDE, PARTIAL_CLEARED_REMAINDER}. */
  amount: number;
  resolvedCount: number;
  tbdCount: number;
  needsReviewCount: number;
}

const RESOLVED_STATUSES: ReadonlySet<EstMissingStatus> = new Set<EstMissingStatus>([
  'RESOLVED',
  'RESOLVED_WITH_OVERRIDE',
  'PARTIAL_CLEARED_REMAINDER',
]);

export function isResolvedStatus(status: EstMissingStatus): boolean {
  return RESOLVED_STATUSES.has(status);
}

export function aggregateEstMissing(
  resolutions: readonly EstMissingResolution[],
): EstMissingTileTotals {
  let amount = 0;
  let resolvedCount = 0;
  let tbdCount = 0;
  let needsReviewCount = 0;
  for (const r of resolutions) {
    if (RESOLVED_STATUSES.has(r.status)) {
      if (r.amount != null) amount += r.amount;
      resolvedCount += 1;
    } else if (r.status === 'TBD_AMBIGUOUS_PAYEE') {
      tbdCount += 1;
    } else {
      needsReviewCount += 1;
    }
  }
  return { amount, resolvedCount, tbdCount, needsReviewCount };
}

export function formatTbdNeedsReviewBadge(totals: {
  tbdCount: number;
  needsReviewCount: number;
}): string | null {
  if (totals.tbdCount === 0 && totals.needsReviewCount === 0) return null;
  return `${totals.tbdCount} TBD · ${totals.needsReviewCount} Needs Review`;
}
