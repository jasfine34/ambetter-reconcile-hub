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
} from './persistence';
import { fallbackReconcileMonth } from './dateRange';
import { loadResolverIndex } from './resolvedIdentities';

/**
 * Bumped whenever normalization or reconciliation logic changes in a way that
 * could produce different results from the same source files. The dashboard
 * compares this to `upload_batches.last_rebuild_logic_version` and shows a
 * warning banner when the stored value is older than the current code.
 */
export const RECONCILE_LOGIC_VERSION = '2026.04.26-ede-span-and-gating-fix';

/**
 * Alias kept for the cross-batch staleness banner / "Rebuild All" feature.
 * Same value as RECONCILE_LOGIC_VERSION — bump that constant whenever
 * classifier, attribution, span, or matching logic changes and every
 * batch's stored `last_rebuild_logic_version` will surface as stale.
 */
export const LOGIC_VERSION = RECONCILE_LOGIC_VERSION;

export interface RebuildProgress {
  phase: 'init' | 'fetching-files' | 'normalizing' | 'reconciling' | 'saving' | 'done';
  currentFile?: string;
  filesProcessed: number;
  totalFiles: number;
  recordsNormalized: number;
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
  await deleteReconciledForBatch(batchId);
  await deleteCommissionEstimatesForBatch(batchId);
  await deleteCurrentNormalizedForBatch(batchId);

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

  // 6. Re-run reconciliation from scratch
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

  emit({
    phase: 'saving',
    filesProcessed: files.length,
    totalFiles: files.length,
    recordsNormalized: totalNormalized,
  });

  await saveReconciledMembers(batchId, members);

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
  });

  return {
    filesProcessed: files.length,
    recordsNormalized: totalNormalized,
    membersReconciled: members.length,
  };
}
