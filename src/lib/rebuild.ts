import { supabase } from '@/integrations/supabase/client';
import { parseCSV } from './csvParser';
import { normalizeEDERow, normalizeBackOfficeRow, normalizeCommissionRow } from './normalize';
import { reconcile } from './reconcile';
import {
  getUploadedFiles,
  insertNormalizedRecords,
  saveReconciledMembers,
  saveAndVerifyReconciled,
  getNormalizedRecords,
  getOrCreateSnapshotForFile,
  deleteCurrentNormalizedForBatch,
  countReconciledForBatch,
  countCurrentNormalizedForBatch,
} from './persistence';
import { fallbackReconcileMonth } from './dateRange';
import { loadResolverIndex } from './resolvedIdentities';

/**
 * Bumped whenever normalization or reconciliation logic changes in a way that
 * could produce different results from the same source files. The dashboard
 * compares this to `upload_batches.last_rebuild_logic_version` and shows a
 * warning banner when the stored value is older than the current code.
 */
export const RECONCILE_LOGIC_VERSION = '2026.05.01-page-data-version-subscription';

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
 * DELETE-then-verify-zero discipline. Run the supplied delete, count remaining
 * rows for the batch, retry once on non-zero with a short backoff, then throw.
 * This is what prevents the "doubling" failure mode where a partial prior
 * insert leaves rows behind that the next rebuild stacks on top of (the
 * commission_estimates incident, Apr 2026).
 *
 * See ARCHITECTURE_PLAN.md § Rebuild Discipline.
 */
async function deleteAndVerifyZero(
  tableLabel: string,
  doDelete: () => Promise<void>,
  countRemaining: () => Promise<number>,
): Promise<void> {
  const MAX = 2;
  let lastCount = -1;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    await doDelete();
    lastCount = await countRemaining();
    if (lastCount === 0) return;
    if (attempt < MAX) await new Promise((r) => setTimeout(r, 750));
  }
  throw new Error(
    `Pre-INSERT clear failed for ${tableLabel}: ${lastCount} rows remained after ` +
      `${MAX} delete attempts. Refusing to INSERT on top of stale rows.`,
  );
}


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

  // 1. Load all uploaded_files for the batch
  const files = await getUploadedFiles(batchId);
  if (!files || files.length === 0) {
    throw new Error('No uploaded files found for this batch. Upload files first.');
  }

  const missingPaths = files.filter((f: any) => !f.storage_path);
  if (missingPaths.length > 0) {
    throw new Error(
      `Cannot rebuild: ${missingPaths.length} file(s) have no storage path (uploaded before storage support). Re-upload: ${missingPaths.map((f: any) => f.file_label).join(', ')}`
    );
  }

  // 3 + 4. Delete CURRENT normalized records only.
  // Superseded normalized_records (from prior snapshot uploads) are preserved
  // as history — rebuild only regenerates the current working set.
  //
  // CHUNKED DELETES: A single unbounded DELETE on the Feb batch (~7.3k
  // normalized_records rows) was exceeding the Supabase PostgREST statement
  // timeout ("canceling statement due to statement timeout"). We now page
  // through ids in 500-row chunks so each individual DELETE is small enough
  // to finish well under the timeout. Smaller batches (Jan/Mar) just take a
  // few extra round-trips; correctness is unchanged.
  // Reconciled rows and commission estimates are intentionally NOT cleared
  // here. saveReconciledMembers() performs the final replacement atomically,
  // so a save timeout rolls back to the prior state instead of leaving a
  // half-broken batch with 0 reconciled members.
  await deleteAndVerifyZero(
    'normalized_records (current)',
    () => deleteCurrentNormalizedForBatch(batchId),
    () => countCurrentNormalizedForBatch(batchId),
  );

  // 2 + 5. Re-download + re-normalize each file
  let totalNormalized = 0;
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

    // Find the snapshot for this uploaded file; create one dated to the
    // original upload date if it predates Phase 1a (lazy backfill).
    const snapshot = await getOrCreateSnapshotForFile({
      id: f.id,
      source_type: f.source_type,
      aor_bucket: f.aor_bucket ?? null,
      file_label: f.file_label,
      created_at: f.created_at,
    });
    await insertNormalizedRecords(batchId, f.id, normalized, snapshot);
    totalNormalized += normalized.length;
  }

  // Post-loop assertion: if any source file produced normalized rows, the
  // current (non-superseded) normalized_records count must be > 0. Catches
  // the case where every per-file insert silently returned without writing.
  if (totalNormalized > 0) {
    const persistedAfterInsert = await countCurrentNormalizedForBatch(batchId);
    if (persistedAfterInsert === 0) {
      throw new Error(
        `Post-INSERT verification failed for normalized_records: expected ≥${totalNormalized} ` +
          `but found 0 current rows for batch ${batchId}.`,
      );
    }
  }

  // 6. Re-run reconciliation from scratch — wrapped in a retry loop with a
  // post-save sanity assertion. The Jan 2026 bug was a silent SAVE-step
  // failure: reconcile() returned ~3,800 members, saveReconciledMembers()
  // appeared to succeed, but the table was empty after the run. The Rebuild
  // All flow then reported "Rebuilt 3 batches" because nothing threw. We now
  // verify by counting rows post-save and retry up to 3 attempts total
  // (1s, 3s backoff) before treating it as a hard failure.
  emit({
    phase: 'reconciling',
    filesProcessed: files.length,
    totalFiles: files.length,
    recordsNormalized: totalNormalized,
  });

  const allRecords = await getNormalizedRecords(batchId);

  const { data: batchData } = await supabase
    .from('upload_batches')
    .select('statement_month')
    .eq('id', batchId)
    .single();

  const reconcileMonth = batchData?.statement_month
    ? String(batchData.statement_month).substring(0, 7)
    : fallbackReconcileMonth();

  // Pull the cross-batch identity sidecar — read-through only; never mutates
  // the originals on disk.
  const resolverIndex = await loadResolverIndex(true);
  const { members } = reconcile(allRecords as any[], reconcileMonth, resolverIndex);

  // How many normalized rows DID we actually persist? If this is 0, "0
  // reconciled" is the correct outcome and we should NOT retry.
  const persistedNormalizedCount = await countCurrentNormalizedForBatch(batchId);

  const MAX_ATTEMPTS = 3;
  const BACKOFFS_MS = [0, 1000, 3000]; // first attempt no wait
  let verifiedCount = 0;
  let lastError: Error | null = null;

  // Special case: if we wrote zero normalized rows OR reconcile produced no
  // members, "0 reconciled" is the correct outcome. Skip the verify-throw in
  // saveAndVerifyReconciled by calling saveReconciledMembers directly so we
  // don't false-positive on legitimately empty batches.
  const expectingRows = members.length > 0 && persistedNormalizedCount > 0;

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
        // Canonical path: save + verify-row-count + (defer stamp until after
        // the retry loop succeeds). saveAndVerifyReconciled throws on
        // silent-zero-write, which the catch below treats as a transient
        // failure and retries with backoff (the rebuild-specific behavior).
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
      // Success — exit retry loop.
      lastError = null;
      break;
    } catch (err: any) {
      lastError = err instanceof Error ? err : new Error(extractErrorMessage(err));
      // continue → retry
    }
  }

  if (lastError && expectingRows) {
    // Hard failure: do NOT stamp last_rebuild_logic_version so the staleness
    // banner stays up and the user is prompted to retry.
    throw new Error(
      `Rebuild failed: 0 reconciled members written after ${MAX_ATTEMPTS} attempts ` +
        `(expected ${members.length}). Last error: ${lastError.message}`,
    );
  }

  // Stamp the batch with rebuild metadata. CAPTURE the error from the
  // UPDATE — a silent stamp failure would otherwise let rebuildBatch report
  // success while leaving last_rebuild_logic_version stale and the
  // staleness banner inaccurate (Codex pass #2, sibling of the supersede
  // capture in persistence.ts:#89).
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
