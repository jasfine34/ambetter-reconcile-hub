/**
 * Centralized error → toast classifier (#123: Toast UX Rewrite by Failure Mode).
 *
 * Every upload / rebuild failure surface in the UI must answer three operator
 * questions in the toast that follows:
 *
 *   1. Was source / normalized data saved or not?
 *   2. Is old active data preserved, or are derived metrics stale?
 *   3. What should the operator do next?
 *
 * The classes below map each *known* failure mode (from existing error
 * surfaces — no new detection logic is introduced here) to a deterministic
 * (variant, title, description) tuple. Variant matches severity:
 *
 *   - destructive : data was NOT saved or rebuild was rolled back.
 *   - warning     : data WAS saved but a downstream step failed; metrics may
 *                   be stale; old active data is intact. Recoverable by
 *                   re-running Rebuild.
 *   - info        : non-failure operator notice (e.g. lock contention).
 *
 * Anything that does not match a known signature falls through to class 7
 * (network / unexpected error). If that bucket grows, classify the new
 * failure mode here instead of letting it stay generic.
 *
 * NOTE: This module is pure — it imports nothing from React or the toast
 * runtime — so it can be unit-tested in isolation.
 */

import { ReconcileAfterPromoteError } from './rebuild';

export type ToastVariant = 'destructive' | 'warning' | 'info' | 'default';

export interface ClassifiedToast {
  variant: ToastVariant;
  title: string;
  description: string;
  /** Stable identifier for the matched failure-mode bucket. Tests assert on this. */
  classId:
    | 'upload-rpc-failed'
    | 'upload-saved-reconcile-failed'
    | 'rebuild-staging-failed'
    | 'rebuild-aggregate-guard'
    | 'rebuild-count-mismatch'
    | 'rebuild-lock-cross-check'
    | 'rebuild-promoted-reconcile-failed'
    | 'rebuild-lock-contention'
    | 'unexpected';
}

interface ClassifyOpts {
  /** Optional file label / filename to interpolate into the description. */
  fileLabel?: string | null;
  /** Optional batch label for context. */
  batchLabel?: string | null;
}

function extractMessage(err: unknown): string {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message ?? '';
  const anyErr = err as any;
  return String(anyErr?.message ?? anyErr?.details ?? anyErr?.hint ?? '');
}

function lower(err: unknown): string {
  return extractMessage(err).toLowerCase();
}

/**
 * Class 2 — auto-reconcile after a successful upload_replace_file.
 * The upload page tags this failure with the literal "(file saved" prefix
 * (see UploadPage.fail step "Reconcile after upload (file saved — try
 * Rebuild)"). When you call this classifier from the upload-reconcile catch
 * block, set `phase: 'after-upload'` so the message can be more specific.
 */
export function classifyUploadError(
  err: unknown,
  opts: ClassifyOpts & { phase: 'rpc' | 'after-upload' },
): ClassifiedToast {
  const fileSuffix = opts.fileLabel ? ` · ${opts.fileLabel}` : '';

  if (opts.phase === 'after-upload') {
    return {
      variant: 'warning',
      classId: 'upload-saved-reconcile-failed',
      title: `Upload saved${fileSuffix}`,
      description:
        'Auto-reconcile failed, so dashboard metrics may be stale. Click Rebuild to refresh.',
    };
  }

  // Phase = 'rpc' — the upload pipeline failed before / during
  // upload_replace_file. The RPC is transactional, so on failure no source
  // or normalized data was saved.
  return {
    variant: 'destructive',
    classId: 'upload-rpc-failed',
    title: `Upload failed${fileSuffix}`,
    description: 'Data was not saved. Try again.',
  };
}

/**
 * Classify a rebuild-pipeline error. Examines the error class and message
 * shape produced by `src/lib/rebuild.ts` + `replace_normalized_for_file_set`
 * to pick the right bucket.
 */
export function classifyRebuildError(
  err: unknown,
  opts: ClassifyOpts = {},
): ClassifiedToast {
  const batchSuffix = opts.batchLabel ? ` — ${opts.batchLabel}` : '';
  const msg = lower(err);

  // Class 5 — promote committed, reconcile/stamp failed.
  // Identified by class instance, NOT message text, because rebuild.ts wraps
  // the underlying Phase-4 error in ReconcileAfterPromoteError exactly to
  // make this bucket distinguishable from total rebuild failure.
  if (err instanceof ReconcileAfterPromoteError) {
    return {
      variant: 'warning',
      classId: 'rebuild-promoted-reconcile-failed',
      title: `Rebuild partially completed${batchSuffix}`,
      description:
        'New normalized data was promoted, but reconcile failed. Dashboard metrics may be stale. Click Rebuild to complete.',
    };
  }

  // Class 6 — single-flight lock contention. acquire_rebuild_lock raises
  // SQLSTATE 55P03 with the literal "lock_not_available" token; the same
  // token also appears if the in-TX cross-check inside
  // replace_normalized_for_file_set loses the lock mid-promote.
  if (msg.includes('lock_not_available') || (err as any)?.code === '55P03') {
    return {
      variant: 'info',
      classId: 'rebuild-lock-contention',
      title: 'Rebuild already running',
      description:
        'Another rebuild is already running for this batch. Wait for it to finish, then retry.',
    };
  }

  // Class 4a — required-source-type aggregate guard.
  // The DB function raises with the literal "required source type X has 0
  // staged rows" message (see fault-injection test (4)).
  if (msg.includes('required source type') && msg.includes('0 staged rows')) {
    // Try to extract the source type for a more specific copy.
    const m = extractMessage(err).match(/required source type (\w+)/i);
    const sourceType = m?.[1] ?? 'Source';
    return {
      variant: 'destructive',
      classId: 'rebuild-aggregate-guard',
      title: `Rebuild aborted${batchSuffix}`,
      description: `${sourceType} row count was zero. Old active data was preserved. Verify uploads before retrying.`,
    };
  }

  // Class 4b — per-file count mismatch (see fault-injection test (3)).
  // DB raises "count mismatch for file X (expected N, staged M)".
  if (msg.includes('count mismatch')) {
    return {
      variant: 'destructive',
      classId: 'rebuild-count-mismatch',
      title: `Rebuild aborted${batchSuffix}`,
      description:
        'Staged row count did not match expected. Old active data was preserved.',
    };
  }

  // Class 3 — failure during staging / parsing, before promote.
  // Heuristics: errors thrown by parseCSV / normalize* / download /
  // insertStagedNormalizedRecords land here. We detect by phase keywords
  // present in the surfaced messages.
  if (
    msg.includes('storage download failed') ||
    msg.includes('csv') ||
    msg.includes('parse') ||
    msg.includes('normalize') ||
    msg.includes('insertstagednormalizedrecords') ||
    msg.includes('staged') ||
    msg.includes('preflushstalestagedrows')
  ) {
    const fileSuffix = opts.fileLabel ? ` (${opts.fileLabel})` : '';
    return {
      variant: 'destructive',
      classId: 'rebuild-staging-failed',
      title: `Rebuild failed during staging${batchSuffix}`,
      description: `Old active data was preserved. Fix the file${fileSuffix} or try Rebuild again.`,
    };
  }

  // Class 7 — unknown / network / unexpected.
  return {
    variant: 'destructive',
    classId: 'unexpected',
    title: `Operation failed unexpectedly${batchSuffix}`,
    description: 'Check console details and retry.',
  };
}
