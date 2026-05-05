import { supabase } from '@/integrations/supabase/client';
import { parseCSV } from './csvParser';
import { normalizeEDERow, normalizeBackOfficeRow, normalizeCommissionRow } from './normalize';
import { reconcile } from './reconcile';
import {
  getUploadedFiles,
  insertStagedNormalizedRecords,
  saveReconciledMembers,
  saveAndVerifyReconciled,
  getNormalizedRecords,
  getOrCreateSnapshotForFile,
  countReconciledForBatch,
  countCurrentNormalizedForBatch,
  acquireRebuildLock,
  releaseRebuildLock,
  preflushStaleStagedRows,
  replaceNormalizedForFileSet,
} from './persistence';
import { fallbackReconcileMonth } from './dateRange';
import { loadResolverIndex } from './resolvedIdentities';

/**
 * Distinct error class for "promote succeeded, reconcile failed" failures.
 * Surfaced verbatim by the UI banner so the user knows that the
 * normalized-records side is fresh and only Phase 4 needs a retry.
 */
export class ReconcileAfterPromoteError extends Error {
  readonly kind = 'reconcile-after-promote';
  constructor(public readonly underlying: Error) {
    super(
      'rebuild promoted new normalized data but reconcile failed — click Rebuild to complete. ' +
      `Underlying error: ${underlying.message}`,
    );
    this.name = 'ReconcileAfterPromoteError';
  }
}

/**
 * Bumped whenever normalization or reconciliation logic changes in a way that
 * could produce different results from the same source files. The dashboard
 * compares this to `upload_batches.last_rebuild_logic_version` and shows a
 * warning banner when the stored value is older than the current code.
 */
export const RECONCILE_LOGIC_VERSION = '2026.05.01-eligible-cohort-current-batch';

/**
 * Alias kept for the cross-batch staleness banner / "Rebuild All" feature.
 * Same value as RECONCILE_LOGIC_VERSION — bump that constant whenever
 * classifier, attribution, span, or matching logic changes and every
 * batch's stored `last_rebuild_logic_version` will surface as stale.
 */
export const LOGIC_VERSION = RECONCILE_LOGIC_VERSION;

export interface RebuildProgress {
  phase: 'init' | 'fetching-files' | 'normalizing' | 'reconciling' | 'saving' | 'verifying' | 'retrying' | 'done';
  currentFile?: string;
  filesProcessed: number;
  totalFiles: number;
  recordsNormalized: number;
  /** Populated once the post-save verification has run (final attempt). */
  membersReconciled?: number;
  /** Current attempt number for the reconcile+save step (1-based). */
  attempt?: number;
}

type ProgressCb = (p: RebuildProgress) => void;

export function isTransientRebuildError(err: unknown): boolean {
  const anyErr = err as any;
  const text = [
    anyErr?.message,
    anyErr?.details,
    anyErr?.hint,
    anyErr?.code,
    typeof err === 'string' ? err : undefined,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return anyErr?.code === '57014' || [
    'canceling statement due to statement timeout',
    'statement timeout',
    'timeout',
    'timed out',
    'fetch failed',
    'failed to fetch',
    'networkerror',
    'temporarily unavailable',
    'gateway timeout',
  ].some((pattern) => text.includes(pattern));
}

/**
 * Extract a human-readable message from an arbitrary thrown value.
 *
 * Background: PostgrestError objects from supabase-js are NOT `instanceof Error`
 * — wrapping them with `new Error(String(err))` collapses to "[object Object]"
 * and hides the actual Postgres failure (e.g. "canceling statement due to
 * statement timeout"). We unwrap .message / .details / .hint / .code first,
 * then fall back to JSON.stringify so the surfaced message always carries
 * real diagnostic text.
 */
export function extractErrorMessage(err: unknown): string {
  if (err == null) return 'unknown error';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message || err.toString();
  const anyErr = err as any;
  const parts: string[] = [];
  if (anyErr.message) parts.push(String(anyErr.message));
  if (anyErr.details && anyErr.details !== anyErr.message) parts.push(`details: ${anyErr.details}`);
  if (anyErr.hint) parts.push(`hint: ${anyErr.hint}`);
  if (anyErr.code) parts.push(`code: ${anyErr.code}`);
  if (parts.length > 0) return parts.join(' | ');
  try {
    const json = JSON.stringify(err);
    if (json && json !== '{}') return json;
  } catch {
    // fallthrough
  }
  return String(err);
}

export async function rebuildBatchWithRetry(
  batchId: string,
  onProgress?: ProgressCb,
  maxAttempts = 3,
): Promise<{
  filesProcessed: number;
  recordsNormalized: number;
  membersReconciled: number;
}> {
  let lastError: unknown;
  const backoffsMs = [0, 1500, 4000];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      await new Promise((r) => setTimeout(r, backoffsMs[attempt - 1] ?? 4000));
      onProgress?.({
        phase: 'retrying',
        filesProcessed: 0,
        totalFiles: 0,
        recordsNormalized: 0,
        attempt,
      });
    }

    try {
      return await rebuildBatch(batchId, onProgress);
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts || !isTransientRebuildError(err)) throw err;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function downloadFileFromStorage(storagePath: string): Promise<File> {
  const { data, error } = await supabase.storage
    .from('commission-files')
    .download(storagePath);
  if (error) throw new Error(`Storage download failed for ${storagePath}: ${error.message}`);
  if (!data) throw new Error(`No data for ${storagePath}`);
  // Convert Blob to File so PapaParse is happy
  const fileName = storagePath.split('/').pop() ?? 'file.csv';
  return new File([data], fileName, { type: 'text/csv' });
}

/**
 * Rebuild a batch using the staged-then-promote pipeline.
 *
 * INVARIANT (the Feb 15:32 regression lock):
 *   A rebuild can NEVER promote zero rows for any source_type that the plan
 *   declared it would re-stage. The aggregate guard inside
 *   `replace_normalized_for_file_set` raises before supersede, so a parser
 *   failure that drops every EDE row to zero rolls the rebuild back instead
 *   of wiping active EDE data.
 *
 * Pipeline:
 *   (1) acquire_rebuild_lock         — single-flight per batch (TTL 30m)
 *   (2) preflush_stale_staged_rows   — wipe orphan staged rows from the
 *                                      previous dead rebuild for these files
 *   (3) per-file: download → parse → normalize → insertStagedNormalizedRecords
 *                                      (rows land as 'staged' tied to session)
 *   (4) replace_normalized_for_file_set — in-TX lock check + per-file count +
 *                                      required-source-type aggregate guard +
 *                                      supersede + promote
 *   (5) reconcile + saveAndVerifyReconciled
 *   (6) release_rebuild_lock         — ALWAYS in a finally block
 *
 * Phase-4 failure semantics:
 *   If steps (1)–(4) succeed but (5) fails, normalized_records is the new
 *   generation but reconciled_members is stale. We throw a
 *   ReconcileAfterPromoteError so the UI can render the explicit message
 *   "rebuild promoted new normalized data but reconcile failed — click
 *   Rebuild to complete." instead of a generic stale-data warning.
 */
export async function rebuildBatch(batchId: string, onProgress?: ProgressCb): Promise<{
  filesProcessed: number;
  recordsNormalized: number;
  membersReconciled: number;
}> {
  const emit = (p: Partial<RebuildProgress>) =>
    onProgress?.({
      phase: 'init',
      filesProcessed: 0,
      totalFiles: 0,
      recordsNormalized: 0,
      ...p,
    } as RebuildProgress);

  emit({ phase: 'fetching-files' });

  // 1. Load files BEFORE acquiring the lock so we fail fast if the batch is
  //    empty and never claim the lock unnecessarily.
  const files = await getUploadedFiles(batchId);
  if (!files || files.length === 0) {
    throw new Error('No uploaded files found for this batch. Upload files first.');
  }
  const missingPaths = files.filter((f: any) => !f.storage_path);
  if (missingPaths.length > 0) {
    throw new Error(
      `Cannot rebuild: ${missingPaths.length} file(s) have no storage path (uploaded before storage support). Re-upload: ${missingPaths.map((f: any) => f.file_label).join(', ')}`,
    );
  }

  // The plan: every file we will re-stage in this rebuild.
  const fileIds: string[] = files.map((f: any) => f.id);
  // Required source types = unique set actually present in the rebuild plan.
  // The aggregate guard fires if any of these end up with 0 staged rows,
  // catching the parser-failure-wipes-EDE class of bug at promote time.
  const requiredSourceTypes = Array.from(
    new Set(files.map((f: any) => f.source_type).filter(Boolean)),
  ) as string[];

  // Allocate a session id for this rebuild. The id is written into every
  // staged row (via insertStagedNormalizedRecords) so the promote RPC can
  // verify the rows belong to this session and not a stale dead one.
  const sessionId = crypto.randomUUID();

  // 2. Acquire the single-flight lock. Throws lock_not_available (SQLSTATE
  //    55P03) if another rebuild is in flight and inside its 30-minute TTL.
  await acquireRebuildLock(batchId, sessionId);

  let lockHeld = true;
  let promoted = false;
  let totalNormalized = 0;
  let verifiedCount = 0;

  try {
    // 3. Pre-flush any orphan staged rows for these file ids. Idempotent:
    //    the SQL only deletes rows with staging_status='staged', so active
    //    data is untouched. Recovers from a prior rebuild that died after
    //    staging but before promote.
    await preflushStaleStagedRows(batchId, fileIds);

    // 4. Stage per file.
    const expectedCounts: Array<{ file_id: string; expected: number }> = [];
    for (let i = 0; i < files.length; i++) {
      const f: any = files[i];
      emit({
        phase: 'normalizing',
        currentFile: f.file_label,
        filesProcessed: i,
        totalFiles: files.length,
        recordsNormalized: totalNormalized,
      });

      const file = await downloadFileFromStorage(f.storage_path);
      const rawRows = await parseCSV(file);

      let normalized: any[];
      if (f.source_type === 'EDE') {
        normalized = rawRows.map(r => normalizeEDERow(r, f.file_label)).filter(Boolean) as any[];
      } else if (f.source_type === 'BACK_OFFICE') {
        normalized = rawRows.map(r => normalizeBackOfficeRow(r, f.file_label, f.aor_bucket || ''));
      } else {
        normalized = rawRows.map(r => normalizeCommissionRow(r, f.file_label, f.pay_entity || '')).filter(Boolean) as any[];
      }

      const snapshot = await getOrCreateSnapshotForFile({
        id: f.id,
        source_type: f.source_type,
        aor_bucket: f.aor_bucket ?? null,
        file_label: f.file_label,
        created_at: f.created_at,
      });
      // Stage rows; they sit at staging_status='staged' tied to sessionId
      // until the promote RPC succeeds.
      await insertStagedNormalizedRecords(batchId, f.id, normalized, sessionId, snapshot);

      expectedCounts.push({ file_id: f.id, expected: normalized.length });
      totalNormalized += normalized.length;
    }

    // 5. Promote: in a single TX the RPC re-checks lock ownership, verifies
    //    every per-file staged count, runs the required-source-type aggregate
    //    guard (Feb 15:32 lock), then supersede + promote. Any check fail =
    //    full rollback; staged rows remain for the next rebuild's pre-flush.
    emit({
      phase: 'saving',
      filesProcessed: files.length,
      totalFiles: files.length,
      recordsNormalized: totalNormalized,
    });
    await replaceNormalizedForFileSet({
      batchId,
      sessionId,
      expectedCounts,
      requiredSourceTypes,
    });
    promoted = true;

    // Sanity assertion: if any source file produced normalized rows, the
    // active count must be > 0 after promote.
    if (totalNormalized > 0) {
      const persistedAfterPromote = await countCurrentNormalizedForBatch(batchId);
      if (persistedAfterPromote === 0) {
        throw new Error(
          `Post-promote verification failed: expected ≥${totalNormalized} active rows but found 0 for batch ${batchId}.`,
        );
      }
    }

    // 6. Reconcile (Phase 4). Failures past this point are
    //    ReconcileAfterPromoteError so the UI can surface the distinct
    //    "promoted but reconcile failed" message.
    emit({
      phase: 'reconciling',
      filesProcessed: files.length,
      totalFiles: files.length,
      recordsNormalized: totalNormalized,
    });

    try {
      const allRecords = await getNormalizedRecords(batchId);

      const { data: batchData } = await supabase
        .from('upload_batches')
        .select('statement_month')
        .eq('id', batchId)
        .single();

      const reconcileMonth = batchData?.statement_month
        ? String(batchData.statement_month).substring(0, 7)
        : fallbackReconcileMonth();

      const resolverIndex = await loadResolverIndex(true);
      const { members } = reconcile(allRecords as any[], reconcileMonth, resolverIndex);

      const persistedNormalizedCount = await countCurrentNormalizedForBatch(batchId);
      const expectingRows = members.length > 0 && persistedNormalizedCount > 0;

      const MAX_ATTEMPTS = 3;
      const BACKOFFS_MS = [0, 1000, 3000];
      let lastError: Error | null = null;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (BACKOFFS_MS[attempt - 1] > 0) {
          await new Promise((r) => setTimeout(r, BACKOFFS_MS[attempt - 1]));
        }
        emit({
          phase: attempt === 1 ? 'saving' : 'retrying',
          filesProcessed: files.length,
          totalFiles: files.length,
          recordsNormalized: totalNormalized,
          attempt,
        });

        try {
          if (expectingRows) {
            const { rowCount } = await saveAndVerifyReconciled(batchId, members);
            verifiedCount = rowCount;
          } else {
            await saveReconciledMembers(batchId, members);
            verifiedCount = await countReconciledForBatch(batchId);
          }
          emit({
            phase: 'verifying',
            filesProcessed: files.length,
            totalFiles: files.length,
            recordsNormalized: totalNormalized,
            attempt,
          });
          lastError = null;
          break;
        } catch (err: any) {
          lastError = err instanceof Error ? err : new Error(extractErrorMessage(err));
        }
      }

      if (lastError && expectingRows) {
        throw new Error(
          `Rebuild failed: 0 reconciled members written after ${MAX_ATTEMPTS} attempts ` +
            `(expected ${members.length}). Last error: ${lastError.message}`,
        );
      }

      // Stamp metadata only after a clean reconcile.
      const { error: stampError } = await supabase
        .from('upload_batches')
        .update({
          last_full_rebuild_at: new Date().toISOString(),
          last_rebuild_logic_version: RECONCILE_LOGIC_VERSION,
        })
        .eq('id', batchId);
      if (stampError) {
        throw new Error(
          `Failed to stamp rebuild metadata for batch ${batchId}: ${extractErrorMessage(stampError)}`,
        );
      }
    } catch (reconcileErr) {
      // Promote succeeded; reconcile/stamp did not. Surface the distinct
      // ReconcileAfterPromoteError so the UI banner can show the explicit
      // "click Rebuild to complete" message.
      const underlying = reconcileErr instanceof Error
        ? reconcileErr
        : new Error(extractErrorMessage(reconcileErr));
      throw new ReconcileAfterPromoteError(underlying);
    }
  } finally {
    if (lockHeld) {
      lockHeld = false;
      // Best-effort release. releaseRebuildLock only logs on failure (it
      // doesn't throw) so a release-time error never masks an upstream one.
      await releaseRebuildLock(batchId, sessionId);
    }
  }

  void promoted; // pin reference (used implicitly by ReconcileAfterPromoteError path)

  emit({
    phase: 'done',
    filesProcessed: files.length,
    totalFiles: files.length,
    recordsNormalized: totalNormalized,
    membersReconciled: verifiedCount,
  });

  return {
    filesProcessed: files.length,
    recordsNormalized: totalNormalized,
    membersReconciled: verifiedCount,
  };
}
