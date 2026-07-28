import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
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
 * Distinct error class for the "promote left mixed durable state" case:
 * the promote RPC call threw a transport-class error, and post-hoc
 * inspection of normalized_records for the same (batch, session) found
 * counts that match neither the fully-committed nor fully-rolled-back
 * shape. Operator must inspect before retrying.
 */
export class PromoteMixedStateError extends Error {
  readonly kind = 'promote-mixed-state';
  constructor(
    message: string,
    public readonly batchId: string,
    public readonly sessionId: string,
    public readonly activeCount: number,
    public readonly stagedCount: number,
    public readonly expectedTotal: number,
  ) {
    super(message);
    this.name = 'PromoteMixedStateError';
  }
}

/**
 * A promote call is "transport-class" (recoverable via durable-state
 * inspection) when supabase-js surfaces it without a Postgres SQLSTATE
 * code — typically fetch-failed / network / gateway timeouts where the
 * server may have committed but the response never reached us. Errors
 * carrying a definitive Postgres code (57014, 55P03, 23xxx, ...) are
 * NOT recoverable this way and keep today's failure semantics.
 */
export function isTransportClassPromoteError(err: unknown): boolean {
  const anyErr = err as any;
  const code = anyErr?.code;
  if (code && String(code).trim().length > 0) return false;
  const text = String(anyErr?.message ?? err ?? '').toLowerCase();
  if (!text) return true;
  return /fetch failed|failed to fetch|networkerror|network error|load failed|timeout|timed out|gateway|socket|econnreset|abort/i.test(text);
}

/**
 * Flatten an arbitrary thrown value into a serializable log record.
 * Replaces the collapsed-`Object` output that hid the true February
 * error from diagnosis.
 */
export function flattenErrorForLog(err: unknown, ctx: Record<string, unknown> = {}): Record<string, unknown> {
  const anyErr = err as any;
  return {
    ...ctx,
    name: anyErr?.name ?? (err instanceof Error ? err.name : typeof err),
    message: typeof anyErr?.message === 'string' ? anyErr.message : extractErrorMessage(err),
    code: anyErr?.code ?? null,
    details: anyErr?.details ?? null,
    hint: anyErr?.hint ?? null,
    status: anyErr?.status ?? anyErr?.statusCode ?? null,
  };
}

/**
 * Distinct error class for "durable-state inspection itself failed".
 * Raised when either count query used by `inspectPromoteOutcome` errors.
 * We must NOT coerce a failed count to zero — doing so could falsely
 * classify a promote as committed and stamp the batch without ever
 * establishing staged === 0. Fail closed instead.
 */
export class PromoteInspectionFailedError extends Error {
  readonly kind = 'promote-inspection-failed';
  constructor(
    message: string,
    public readonly batchId: string,
    public readonly sessionId: string,
    public readonly inspectionError: unknown,
    public readonly underlying: unknown,
  ) {
    super(message);
    this.name = 'PromoteInspectionFailedError';
  }
}

/**
 * Query durable state for the promoted session and classify.
 *   committed   — active session rows == expectedTotal AND staged == 0
 *   rolled-back — active == 0 AND staged == expectedTotal (or ≥ expected)
 *   mixed       — anything else
 *
 * Fail-closed: if either count query errors, we throw rather than
 * classify from missing counts.
 */
export async function inspectPromoteOutcome(
  batchId: string,
  sessionId: string,
  expectedTotal: number,
): Promise<{ outcome: 'committed' | 'rolled-back' | 'mixed'; activeCount: number; stagedCount: number }> {
  const client: any = supabase;
  const [activeRes, stagedRes] = await Promise.all([
    client
      .from('normalized_records')
      .select('id', { count: 'exact', head: true })
      .eq('batch_id', batchId)
      .eq('rebuild_session_id', sessionId)
      .eq('staging_status', 'active'),
    client
      .from('normalized_records')
      .select('id', { count: 'exact', head: true })
      .eq('batch_id', batchId)
      .eq('rebuild_session_id', sessionId)
      .eq('staging_status', 'staged'),
  ]);

  const inspectionError = (activeRes as any)?.error ?? (stagedRes as any)?.error ?? null;
  const activeCountRaw = (activeRes as any)?.count;
  const stagedCountRaw = (stagedRes as any)?.count;
  if (
    inspectionError ||
    activeCountRaw == null ||
    stagedCountRaw == null ||
    !Number.isFinite(Number(activeCountRaw)) ||
    !Number.isFinite(Number(stagedCountRaw))
  ) {
    const which = (activeRes as any)?.error || activeCountRaw == null ? 'active' : 'staged';
    throw new PromoteInspectionFailedError(
      `Promote-outcome inspection failed for batch ${batchId} (session ${sessionId}): the ${which} row-count query did not return a usable count. ` +
        `Promote outcome is UNKNOWN — do NOT retry blindly; inspect normalized_records for this session before rebuilding.`,
      batchId,
      sessionId,
      inspectionError,
      null,
    );
  }

  const activeCount = Number(activeCountRaw);
  const stagedCount = Number(stagedCountRaw);
  let outcome: 'committed' | 'rolled-back' | 'mixed';
  if (activeCount === expectedTotal && stagedCount === 0) outcome = 'committed';
  else if (activeCount === 0 && stagedCount >= expectedTotal) outcome = 'rolled-back';
  else outcome = 'mixed';
  return { outcome, activeCount, stagedCount };
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
    const promoteStart = performance.now();
    try {
      await replaceNormalizedForFileSet({
        batchId,
        sessionId,
        expectedCounts,
        requiredSourceTypes,
      });
      promoted = true;
    } catch (promoteErr) {
      const elapsedMs = Math.round(performance.now() - promoteStart);
      const flat = flattenErrorForLog(promoteErr, {
        phase: 'promote',
        batch_id: batchId,
        rebuild_session_id: sessionId,
        elapsed_ms: elapsedMs,
      });
      console.error('[rebuild-diag] promote call threw', flat);

      // Definitive Postgres errors (with a SQLSTATE code) keep today's
      // behavior — rethrow so the caller / classifier handles them.
      if (!isTransportClassPromoteError(promoteErr)) {
        throw promoteErr;
      }

      // Transport-class error: the server may have committed while the
      // response never reached us (the February case). Query durable
      // state for this (batch, session) and branch on the outcome.
      let inspection: { outcome: 'committed' | 'rolled-back' | 'mixed'; activeCount: number; stagedCount: number };
      try {
        inspection = await inspectPromoteOutcome(batchId, sessionId, totalNormalized);
      } catch (inspectErr) {
        console.error(
          '[rebuild-diag] promote-outcome inspection failed',
          flattenErrorForLog(inspectErr, {
            phase: 'promote-inspection',
            batch_id: batchId,
            rebuild_session_id: sessionId,
            elapsed_ms: Math.round(performance.now() - promoteStart),
          }),
        );
        try {
          toast.error('Rebuild outcome unknown', {
            description:
              'Could not verify whether the promote committed. Do NOT retry blindly — inspect normalized_records for this rebuild session.',
          });
        } catch { /* toast is best-effort */ }
        if (inspectErr instanceof PromoteInspectionFailedError) {
          throw new PromoteInspectionFailedError(
            `${inspectErr.message} Underlying promote error: ${flat.message}`,
            batchId,
            sessionId,
            inspectErr.inspectionError,
            promoteErr,
          );
        }
        throw new PromoteInspectionFailedError(
          `Promote-outcome inspection failed for batch ${batchId} (session ${sessionId}). ` +
            `Promote outcome is UNKNOWN — do NOT retry blindly; inspect normalized_records for this session before rebuilding. ` +
            `Underlying promote error: ${flat.message}`,
          batchId,
          sessionId,
          inspectErr,
          promoteErr,
        );
      }
      console.info('[rebuild-diag] promote-outcome recovery inspection', {
        batch_id: batchId,
        rebuild_session_id: sessionId,
        expectedTotal: totalNormalized,
        ...inspection,
      });


      if (inspection.outcome === 'committed') {
        // Recovery path — the RPC succeeded server-side. Continue into
        // reconciliation and metadata stamping instead of failing the run.
        promoted = true;
        try {
          toast.info('Normalized promote completed', {
            description: 'Continuing reconciliation.',
          });
        } catch { /* toast is best-effort */ }
      } else if (inspection.outcome === 'rolled-back') {
        // Genuine rollback — preserve existing failed-promote behavior.
        throw promoteErr;
      } else {
        // Mixed: refuse to guess.
        try {
          toast.error('Rebuild left mixed durable state', {
            description:
              'Do NOT retry blindly. Inspect normalized_records for this rebuild session before rebuilding.',
          });
        } catch { /* toast is best-effort */ }
        throw new PromoteMixedStateError(
          `Promote left mixed durable state for batch ${batchId} (session ${sessionId}): ` +
            `active=${inspection.activeCount}, staged=${inspection.stagedCount}, expected=${totalNormalized}. ` +
            `Do NOT retry blindly — inspect normalized_records for this session before rebuilding. ` +
            `Underlying: ${flat.message}`,
          batchId,
          sessionId,
          inspection.activeCount,
          inspection.stagedCount,
          totalNormalized,
        );
      }
    }

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
      console.info('[rebuild-diag] Phase4 ENTER reconcile()', { batchId, sessionId });
      const reconcileStart = performance.now();
      const allRecords = await getNormalizedRecords(batchId);
      console.info('[rebuild-diag] Phase4 fetched normalized_records', {
        batchId,
        normalizedRows: allRecords.length,
      });

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
      const reconcileMs = Math.round(performance.now() - reconcileStart);

      const inBoTrue = members.filter((m: any) => m.in_back_office === true).length;
      console.info('[rebuild-diag] Phase4 EXIT reconcile()', {
        batchId,
        reconcileMonth,
        memberCount: members.length,
        inBackOfficeTrue: inBoTrue,
        reconcileMs,
      });

      const persistedNormalizedCount = await countCurrentNormalizedForBatch(batchId);
      const expectingRows = members.length > 0 && persistedNormalizedCount > 0;
      console.info('[rebuild-diag] Phase4 pre-save state', {
        batchId,
        memberCount: members.length,
        persistedNormalizedCount,
        expectingRows,
      });

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
          console.info('[rebuild-diag] Phase4 save attempt', {
            batchId,
            attempt,
            expectingRows,
            memberCount: members.length,
          });
          if (expectingRows) {
            const { rowCount } = await saveAndVerifyReconciled(batchId, members);
            verifiedCount = rowCount;
          } else {
            await saveReconciledMembers(batchId, members);
            verifiedCount = await countReconciledForBatch(batchId);
          }
          console.info('[rebuild-diag] Phase4 save attempt OK', {
            batchId,
            attempt,
            verifiedCount,
          });
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
          console.error('[rebuild-diag] Phase4 save attempt FAILED', {
            batchId,
            attempt,
            errorMessage: lastError.message,
            errorName: lastError.name,
            code: (err as any)?.code,
            details: (err as any)?.details,
            hint: (err as any)?.hint,
          });
        }
      }

      if (lastError && expectingRows) {
        throw new Error(
          `Rebuild failed: 0 reconciled members written after ${MAX_ATTEMPTS} attempts ` +
            `(expected ${members.length}). Last error: ${lastError.message}`,
        );
      }

      // Stamp metadata only after a clean reconcile.
      console.info('[rebuild-diag] Phase4 stamp ENTER', { batchId, verifiedCount });
      const { error: stampError } = await supabase
        .from('upload_batches')
        .update({
          last_full_rebuild_at: new Date().toISOString(),
          last_rebuild_logic_version: RECONCILE_LOGIC_VERSION,
        })
        .eq('id', batchId);
      if (stampError) {
        console.error('[rebuild-diag] Phase4 stamp FAILED', {
          batchId,
          message: (stampError as any)?.message,
          code: (stampError as any)?.code,
        });
        throw new Error(
          `Failed to stamp rebuild metadata for batch ${batchId}: ${extractErrorMessage(stampError)}`,
        );
      }
      console.info('[rebuild-diag] Phase4 stamp OK', { batchId });
    } catch (reconcileErr) {
      // Promote succeeded; reconcile/stamp did not. Surface the distinct
      // ReconcileAfterPromoteError so the UI banner can show the explicit
      // "click Rebuild to complete" message.
      const underlying = reconcileErr instanceof Error
        ? reconcileErr
        : new Error(extractErrorMessage(reconcileErr));
      const isReconcileAfterPromote = reconcileErr instanceof ReconcileAfterPromoteError;
      console.error('[rebuild-diag] Phase4 CAUGHT error', {
        batchId,
        promoted,
        errorClass: isReconcileAfterPromote ? 'ReconcileAfterPromoteError' : underlying.name,
        message: underlying.message,
      });
      throw new ReconcileAfterPromoteError(underlying);
    }
  } finally {
    if (lockHeld) {
      lockHeld = false;
      // Best-effort release. releaseRebuildLock only logs on failure (it
      // doesn't throw) so a release-time error never masks an upstream one.
      console.info('[rebuild-diag] releasing rebuild lock', { batchId, sessionId });
      try {
        await releaseRebuildLock(batchId, sessionId);
        console.info('[rebuild-diag] lock released OK', { batchId, sessionId });
      } catch (relErr: any) {
        console.error('[rebuild-diag] lock release FAILED', {
          batchId,
          sessionId,
          message: relErr?.message,
        });
      }
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
