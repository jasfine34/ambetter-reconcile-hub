/**
 * Bundle 13c — Cross-batch clearing overlay helper.
 *
 * Pure module. No DB, no React. All helpers exported.
 *
 * Maps `cross_batch_clearings` rows (sidecar grain) onto reconciled-member
 * rows via grain key `${policy_identity_key}|${expected_ede_effective_month}`.
 * Surface code derives a per-row {@link RowAdjustment} via
 * {@link classifyOverlay} and consumes its instructions to recompute counts
 * and dollars.
 */
import { derivePolicyIdentityKey } from '@/lib/canonical/policyIdentityKey';
import { isValidMonthKey } from '@/lib/canonical/monthKey';

export type ClearingState =
  | 'fully_cleared'
  | 'partially_cleared'
  | 'not_cleared'
  | 'cleared_then_reversed'
  | 'zero_expected_no_payment_required'
  | 'manual_review_required';

export interface ClearingOverlay {
  policy_identity_key: string;
  target_service_month: string;
  clearing_state: ClearingState;
  expected_amount: number | null;
  actual_positive_amount: number | null;
  actual_reversal_amount: number | null;
  actual_net_amount: number | null;
  remainder_owed: number | null;
  unpaid_batch_ids: string[];
  payment_batch_ids: string[];
  reversed_at_statement_month: string | null;
  first_full_clear_statement_month: string | null;
  evaluated_at: string;
  run_id: string;
  manual_review_reason: string | null;
}

export interface ClearingOverlayMap {
  byGrain: Map<string, ClearingOverlay>;
  lastEvaluatedAt: string | null;
  totalActiveCount: number;
}

export function coerceStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * CRITICAL: null/undefined/empty-string → null, NOT 0.
 * Number(null) === 0 is the trap this guard exists to prevent.
 */
export function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function deriveRemainder(overlay: ClearingOverlay): number | null {
  const explicit = finiteNumber(overlay.remainder_owed);
  if (explicit !== null) return explicit;
  const expected = finiteNumber(overlay.expected_amount);
  const actualNet = finiteNumber(overlay.actual_net_amount);
  if (expected !== null && actualNet !== null) return Math.max(expected - actualNet, 0);
  return null;
}

export function buildClearingOverlayMap(rows: any[]): ClearingOverlayMap {
  const byGrain = new Map<string, ClearingOverlay>();
  let lastEvaluatedAt: string | null = null;
  for (const r of rows ?? []) {
    if (!r || !r.policy_identity_key || !r.target_service_month) continue;
    const key = `${r.policy_identity_key}|${r.target_service_month}`;
    byGrain.set(key, {
      policy_identity_key: r.policy_identity_key,
      target_service_month: r.target_service_month,
      clearing_state: r.clearing_state,
      expected_amount: finiteNumber(r.expected_amount),
      actual_positive_amount: finiteNumber(r.actual_positive_amount),
      actual_reversal_amount: finiteNumber(r.actual_reversal_amount),
      actual_net_amount: finiteNumber(r.actual_net_amount),
      remainder_owed: finiteNumber(r.remainder_owed),
      unpaid_batch_ids: coerceStringArray(r.unpaid_batch_ids),
      payment_batch_ids: coerceStringArray(r.payment_batch_ids),
      reversed_at_statement_month: r.reversed_at_statement_month ?? null,
      first_full_clear_statement_month: r.first_full_clear_statement_month ?? null,
      evaluated_at: r.evaluated_at,
      run_id: r.run_id,
      manual_review_reason: r.manual_review_reason ?? null,
    });
    if (r.evaluated_at && (!lastEvaluatedAt || r.evaluated_at > lastEvaluatedAt)) {
      lastEvaluatedAt = r.evaluated_at;
    }
  }
  return { byGrain, lastEvaluatedAt, totalActiveCount: byGrain.size };
}

export const EMPTY_CLEARING_OVERLAY_MAP: ClearingOverlayMap = {
  byGrain: new Map(),
  lastEvaluatedAt: null,
  totalActiveCount: 0,
};

export function deriveGrainKeyForReconciledRow(row: {
  carrier?: string | null;
  policy_number?: string | null;
  issuer_subscriber_id?: string | null;
  expected_ede_effective_month?: string | null;
}): string | null {
  const identity = derivePolicyIdentityKey({
    carrier: row.carrier ?? null,
    policy_number: row.policy_number ?? null,
    issuer_subscriber_id: row.issuer_subscriber_id ?? null,
  });
  if (identity.status !== 'resolved') return null;
  const targetServiceMonth = row.expected_ede_effective_month ?? null;
  if (!targetServiceMonth || !isValidMonthKey(targetServiceMonth)) return null;
  return `${identity.key}|${targetServiceMonth}`;
}

export type RowAdjustment =
  | { kind: 'no_overlay' }
  | { kind: 'remove_from_unpaid'; reason: 'fully_cleared' | 'zero_expected'; overlay: ClearingOverlay }
  | { kind: 'move_to_reversed_bucket'; overlay: ClearingOverlay }
  | { kind: 'reduce_dollars'; remainder: number; overlay: ClearingOverlay }
  | { kind: 'partial_amount_unavailable'; overlay: ClearingOverlay }
  | { kind: 'mark_needs_review'; overlay: ClearingOverlay }
  | { kind: 'no_adjustment'; overlay?: ClearingOverlay };

export function classifyOverlay(overlay: ClearingOverlay | undefined): RowAdjustment {
  if (!overlay) return { kind: 'no_overlay' };
  switch (overlay.clearing_state) {
    case 'fully_cleared':
      return { kind: 'remove_from_unpaid', reason: 'fully_cleared', overlay };
    case 'zero_expected_no_payment_required':
      return { kind: 'remove_from_unpaid', reason: 'zero_expected', overlay };
    case 'cleared_then_reversed':
      return { kind: 'move_to_reversed_bucket', overlay };
    case 'partially_cleared': {
      const remainder = deriveRemainder(overlay);
      return remainder === null
        ? { kind: 'partial_amount_unavailable', overlay }
        : { kind: 'reduce_dollars', remainder, overlay };
    }
    case 'manual_review_required':
      return { kind: 'mark_needs_review', overlay };
    case 'not_cleared':
    default:
      return { kind: 'no_adjustment', overlay };
  }
}

/**
 * Convenience: derive a row's grain key + adjustment in one call.
 */
export function adjustmentForReconciledRow(
  row: any,
  overlayMap: ClearingOverlayMap,
): { grainKey: string | null; adjustment: RowAdjustment } {
  const grainKey = deriveGrainKeyForReconciledRow(row);
  if (!grainKey) return { grainKey: null, adjustment: { kind: 'no_overlay' } };
  return { grainKey, adjustment: classifyOverlay(overlayMap.byGrain.get(grainKey)) };
}
