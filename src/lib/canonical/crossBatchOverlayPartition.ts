/**
 * Bundle 13c — surface-side partition + recompute helpers.
 *
 * Pure. Given the canonical `unpaidRows` (Matched + BO Only + EDE Only) and
 * a {@link ClearingOverlayMap}, partition rows into:
 *  - regular (kept in main unpaid) with optional dollar override
 *  - reversed (cleared_then_reversed)
 *  - removed (fully_cleared / zero_expected) — excluded entirely
 *  - needsReview (subset of regular, for chip)
 *
 * Surface code consumes adjustment.remainder via these helpers; never reads
 * overlay.remainder_owed directly.
 */
import {
  adjustmentForReconciledRow,
  type ClearingOverlayMap,
  type RowAdjustment,
} from '@/lib/canonical/crossBatchOverlay';

export interface AdjustedRow {
  row: any;
  adjustment: RowAdjustment;
  /** Effective dollar to use for this row in dollar-sum computations. */
  effectiveEstMissing: number;
}

export interface AdjustedUnpaidPartition {
  regular: AdjustedRow[];
  reversed: AdjustedRow[];
  removed: AdjustedRow[];
  needsReview: AdjustedRow[];
}

function legacyEstMissing(row: any): number {
  const n = Number(row?.estimated_missing_commission);
  return Number.isFinite(n) ? n : 0;
}

export function partitionUnpaidRowsByOverlay(
  unpaidRows: readonly any[],
  overlay: ClearingOverlayMap,
): AdjustedUnpaidPartition {
  const regular: AdjustedRow[] = [];
  const reversed: AdjustedRow[] = [];
  const removed: AdjustedRow[] = [];
  const needsReview: AdjustedRow[] = [];

  for (const row of unpaidRows) {
    const { adjustment } = adjustmentForReconciledRow(row, overlay);
    const legacy = legacyEstMissing(row);
    let effective = legacy;
    if (adjustment.kind === 'reduce_dollars') effective = adjustment.remainder;

    const item: AdjustedRow = { row, adjustment, effectiveEstMissing: effective };

    switch (adjustment.kind) {
      case 'remove_from_unpaid':
        removed.push(item);
        break;
      case 'move_to_reversed_bucket':
        reversed.push(item);
        break;
      case 'mark_needs_review':
        regular.push(item);
        needsReview.push(item);
        break;
      case 'reduce_dollars':
      case 'partial_amount_unavailable':
      case 'no_overlay':
      case 'no_adjustment':
      default:
        regular.push(item);
        break;
    }
  }

  return { regular, reversed, removed, needsReview };
}

export function sumEffectiveEstMissing(items: readonly AdjustedRow[]): number {
  let s = 0;
  for (const it of items) s += it.effectiveEstMissing;
  return s;
}
