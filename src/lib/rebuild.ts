import { supabase } from '@/integrations/supabase/client';
import { parseCSV } from './csvParser';
import { normalizeEDERow, normalizeBackOfficeRow, normalizeCommissionRow } from './normalize';
import { reconcile } from './reconcile';
import {
  getUploadedFiles,
  insertNormalizedRecords,
  saveReconciledMembers,
  getNormalizedRecords,
  getOrCreateSnapshotForFile,
  deleteReconciledForBatch,
  deleteCommissionEstimatesForBatch,
  deleteCurrentNormalizedForBatch,
  countReconciledForBatch,
  countCurrentNormalizedForBatch,
  countCommissionEstimatesForBatch,
} from './persistence';
import { fallbackReconcileMonth } from './dateRange';
import { loadResolverIndex } from './resolvedIdentities';

/**
 * Bumped whenever normalization or reconciliation logic changes in a way that
 * could produce different results from the same source files. The dashboard
 * compares this to `upload_batches.last_rebuild_logic_version` and shows a
 * warning banner when the stored value is older than the current code.
 */
export const RECONCILE_LOGIC_VERSION = '2026.04.28-ee-universe-align';

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

  // 3 + 4. Delete reconciled + CURRENT normalized records.
  // Superseded normalized_records (from prior snapshot uploads) are preserved
  // as history — rebuild only regenerates the current working set.
  //
  // CHUNKED DELETES: A single unbounded DELETE on the Feb batch (~7.3k
  // normalized_records rows) was exceeding the Supabase PostgREST statement
  // timeout ("canceling statement due to statement timeout"). We now page
  // through ids in 500-row chunks so each individual DELETE is small enough
  // to finish well under the timeout. Smaller batches (Jan/Mar) just take a
  // few extra round-trips; correctness is unchanged.
  // DELETE-then-verify-zero discipline (see ARCHITECTURE_PLAN.md §
  // Rebuild Discipline). The doubling incident on Apr 2026 happened when a
  // partial prior insert left rows behind that the next rebuild stacked on
  // top of. Each clear is now followed by a count assertion and a single
  // retry before the rebuild aborts.
  await deleteAndVerifyZero(
    'reconciled_members',
    () => deleteReconciledForBatch(batchId),
    () => countReconciledForBatch(batchId),
  );
  await deleteAndVerifyZero(
    'commission_estimates',
    () => deleteCommissionEstimatesForBatch(batchId),
    () => countCommissionEstimatesForBatch(batchId),
  );
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
      await saveReconciledMembers(batchId, members);
    } catch (err: any) {
      lastError = err instanceof Error ? err : new Error(String(err));
      continue; // retry
    }

    emit({
      phase: 'verifying',
      filesProcessed: files.length,
      totalFiles: files.length,
      recordsNormalized: totalNormalized,
      attempt,
    });

    verifiedCount = await countReconciledForBatch(batchId);

    // Pass: nothing was expected (no normalized rows OR reconcile produced 0
    // legitimately) — accept and break.
    if (members.length === 0 || persistedNormalizedCount === 0) break;

    // Pass: rows landed in the table.
    if (verifiedCount > 0) break;

    // Fail: we expected rows and got 0. Treat as transient and retry.
    lastError = new Error(
      `Rebuild produced 0 reconciled members for batch ${batchId} despite ` +
        `${persistedNormalizedCount} normalized records and ${members.length} reconcile() outputs ` +
        `— likely a transient backend write failure.`,
    );
  }

  if (
    members.length > 0 &&
    persistedNormalizedCount > 0 &&
    verifiedCount === 0
  ) {
    // Hard failure: do NOT stamp last_rebuild_logic_version so the staleness
    // banner stays up and the user is prompted to retry.
    throw new Error(
      `Rebuild failed: 0 reconciled members written after ${MAX_ATTEMPTS} attempts ` +
        `(expected ${members.length}). Last error: ${lastError?.message ?? 'unknown'}`,
    );
  }

  // Stamp the batch with rebuild metadata
  await supabase
    .from('upload_batches')
    .update({
      last_full_rebuild_at: new Date().toISOString(),
      last_rebuild_logic_version: RECONCILE_LOGIC_VERSION,
    })
    .eq('id', batchId);

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
