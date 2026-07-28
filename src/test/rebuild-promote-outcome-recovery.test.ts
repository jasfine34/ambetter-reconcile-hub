/**
 * Fault-injection tests for the promote-outcome recovery path.
 *
 * The February incident: the promote RPC committed server-side but the
 * browser's request failed at ~64s with a transport-class error. The
 * client wrongly treated this as "promote did not happen", skipped
 * reconciliation, and never stamped last_full_rebuild_at.
 *
 * These tests lock the fix (corrective 2 — fail-closed + real fixtures):
 *
 *   (1) RPC throws transport-class error AFTER server commit → durable
 *       inspection shows committed → pipeline continues to reconcile +
 *       stamps last_full_rebuild_at / last_rebuild_logic_version.
 *   (2) RPC throws transport-class error with rows still staged → treated
 *       as failure; no reconcile, no stamp.
 *   (3) RPC throws transport-class error, mixed counts → distinct
 *       PromoteMixedStateError; no continue, no retry.
 *   (4) active-count inspection query errors → PromoteInspectionFailedError
 *       (must NOT classify as committed, must NOT stamp).
 *   (5) staged-count inspection query errors → PromoteInspectionFailedError.
 *   (6) Flat log record uses the locked keys batch_id / rebuild_session_id /
 *       elapsed_ms plus name/message/code/details/hint/status/phase, and is
 *       JSON-serializable (not a collapsed [object Object]).
 *
 * All branch tests assert the promote RPC is called EXACTLY ONCE (no retry).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const ROWS_PER_FILE = 12;

const state: {
  files: any[];
  promoteBehavior: 'ok' | 'transport-fail' | 'pg-fail';
  activeCount: number;
  stagedCount: number;
  activeCountError: any;
  stagedCountError: any;
  reconcileSaved: boolean;
  batchUpdates: any[];
  promoteCalls: any[];
} = {
  files: [],
  promoteBehavior: 'ok',
  activeCount: 0,
  stagedCount: 0,
  activeCountError: null,
  stagedCountError: null,
  reconcileSaved: false,
  batchUpdates: [],
  promoteCalls: [],
};

vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn() } }));

vi.mock('@/integrations/supabase/client', () => {
  const builder = (table: string) => {
    const query: any = {
      _filters: {} as Record<string, any>,
      select(_cols: string, opts?: any) {
        query._head = opts?.head === true;
        query._exactCount = opts?.count === 'exact';
        return query;
      },
      eq(col: string, val: any) { query._filters[col] = val; return query; },
      is() { return query; },
      update(payload: any) {
        if (table === 'upload_batches') state.batchUpdates.push(payload);
        return query;
      },
      single() {
        if (table === 'upload_batches') {
          return Promise.resolve({ data: { statement_month: '2026-02-01' }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      then(resolve: any) {
        if (table === 'normalized_records' && query._head && query._exactCount) {
          const status = query._filters.staging_status;
          if (status === 'active') {
            return Promise.resolve(
              state.activeCountError
                ? { data: null, count: null, error: state.activeCountError }
                : { data: null, count: state.activeCount, error: null },
            ).then(resolve);
          }
          return Promise.resolve(
            state.stagedCountError
              ? { data: null, count: null, error: state.stagedCountError }
              : { data: null, count: state.stagedCount, error: null },
          ).then(resolve);
        }
        return Promise.resolve({ error: null }).then(resolve);
      },
    };
    return query;
  };
  return {
    supabase: {
      from: (t: string) => builder(t),
      storage: { from: () => ({ download: () => Promise.resolve({ data: new Blob(['']), error: null }) }) },
    },
  };
});

vi.mock('@/lib/persistence', () => ({
  getUploadedFiles: vi.fn(async () => state.files),
  insertStagedNormalizedRecords: vi.fn(async () => {}),
  saveReconciledMembers: vi.fn(async () => { state.reconcileSaved = true; }),
  saveAndVerifyReconciled: vi.fn(async () => { state.reconcileSaved = true; return { rowCount: 5, version: null }; }),
  getNormalizedRecords: vi.fn(async () => [{ id: 'n1' }]),
  getOrCreateSnapshotForFile: vi.fn(async () => ({ id: 'snap-1', kind: 'ede' })),
  countReconciledForBatch: vi.fn(async () => 5),
  countCurrentNormalizedForBatch: vi.fn(async () => state.activeCount),
  acquireRebuildLock: vi.fn(async (_b: string, s: string) => s),
  releaseRebuildLock: vi.fn(async () => {}),
  preflushStaleStagedRows: vi.fn(async () => 0),
  replaceNormalizedForFileSet: vi.fn(async (args: any) => {
    state.promoteCalls.push(args);
    if (state.promoteBehavior === 'transport-fail') {
      throw new Error('TypeError: fetch failed');
    }
    if (state.promoteBehavior === 'pg-fail') {
      const err: any = new Error('canceling statement due to statement timeout');
      err.code = '57014';
      throw err;
    }
    return args.expectedCounts.reduce((s: number, e: any) => s + e.expected, 0);
  }),
}));

vi.mock('@/lib/resolvedIdentities', () => ({ loadResolverIndex: vi.fn(async () => null) }));
vi.mock('@/lib/reconcile', () => ({ reconcile: vi.fn(() => ({ members: [{ member_key: 'm1' }] })) }));
// REAL fixtures: every file parses to a nonzero number of rows so the
// pipeline models an actual February-shaped promote (24 expected rows).
vi.mock('@/lib/csvParser', () => ({
  parseCSV: vi.fn(async () => Array.from({ length: ROWS_PER_FILE }, (_, i) => ({ row: i }))),
}));
vi.mock('@/lib/normalize', () => ({
  normalizeEDERow: vi.fn((r: any) => ({ ...r, source_type: 'EDE' })),
  normalizeBackOfficeRow: vi.fn((r: any) => ({ ...r, source_type: 'BACK_OFFICE' })),
  normalizeCommissionRow: vi.fn((r: any) => ({ ...r, source_type: 'COMMISSION' })),
}));
vi.mock('@/lib/dateRange', () => ({ fallbackReconcileMonth: () => '2026-02' }));

import * as rebuildMod from '@/lib/rebuild';
import {
  rebuildBatch,
  PromoteMixedStateError,
  PromoteInspectionFailedError,
  ReconcileAfterPromoteError,
  flattenErrorForLog,
  isTransportClassPromoteError,
} from '@/lib/rebuild';

/** Sum of per-file expected counts the pipeline should be inspecting against. */
const EXPECTED_TOTAL = ROWS_PER_FILE * 2;

beforeEach(() => {
  vi.restoreAllMocks();
  state.files = [
    { id: 'f1', source_type: 'EDE', file_label: 'EDE', storage_path: 'p/ede.csv', created_at: '2026-02-01' },
    { id: 'f2', source_type: 'BACK_OFFICE', file_label: 'BO', storage_path: 'p/bo.csv', created_at: '2026-02-01', aor_bucket: 'M' },
  ];
  state.promoteBehavior = 'ok';
  state.activeCount = 0;
  state.stagedCount = 0;
  state.activeCountError = null;
  state.stagedCountError = null;
  state.reconcileSaved = false;
  state.batchUpdates = [];
  state.promoteCalls = [];
});

describe('promote-outcome recovery', () => {
  it('(1) RPC transport-fail after server commit → recovery continues to reconcile + stamps rebuild metadata', async () => {
    state.promoteBehavior = 'transport-fail';
    // Server actually committed: active-session rows == expected, staged == 0.
    state.activeCount = EXPECTED_TOTAL;
    state.stagedCount = 0;

    const inspectSpy = vi.spyOn(rebuildMod, 'inspectPromoteOutcome');
    const result = await rebuildBatch('b1');

    // Nonzero fixture actually flowed through the pipeline.
    expect(result.filesProcessed).toBe(2);
    expect(result.recordsNormalized).toBe(EXPECTED_TOTAL);
    expect(state.promoteCalls).toHaveLength(1);
    expect(
      state.promoteCalls[0].expectedCounts.reduce((s: number, e: any) => s + e.expected, 0),
    ).toBe(EXPECTED_TOTAL);
    if (inspectSpy.mock.calls.length > 0) {
      expect(inspectSpy.mock.calls[0][2]).toBe(EXPECTED_TOTAL);
    }

    // Reconcile ran…
    expect(state.reconcileSaved).toBe(true);
    // …and the batch was stamped.
    const stamp = state.batchUpdates.find((u) => u && 'last_full_rebuild_at' in u);
    expect(stamp).toBeTruthy();
    expect(typeof stamp.last_full_rebuild_at).toBe('string');
    expect(stamp.last_rebuild_logic_version).toBeDefined();
  });

  it('(2) RPC transport-fail with rows still staged → rethrown as failure; no reconcile, no stamp, promote called once', async () => {
    state.promoteBehavior = 'transport-fail';
    state.activeCount = 0;
    state.stagedCount = EXPECTED_TOTAL;
    let caught: any = null;
    try { await rebuildBatch('b1'); } catch (e) { caught = e; }
    expect(caught).toBeTruthy();
    expect(caught).not.toBeInstanceOf(PromoteMixedStateError);
    expect(caught).not.toBeInstanceOf(PromoteInspectionFailedError);
    expect(caught).not.toBeInstanceOf(ReconcileAfterPromoteError);
    expect(String(caught.message)).toMatch(/fetch failed/i);
    expect(state.promoteCalls).toHaveLength(1);
    expect(state.reconcileSaved).toBe(false);
    expect(state.batchUpdates.find((u) => u && 'last_full_rebuild_at' in u)).toBeUndefined();
  });

  it('(3) RPC transport-fail with mixed counts → PromoteMixedStateError; no continue, promote called once', async () => {
    state.promoteBehavior = 'transport-fail';
    state.activeCount = 10; // partial — disagreeing
    state.stagedCount = 14;
    let caught: any = null;
    try { await rebuildBatch('b1'); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(PromoteMixedStateError);
    expect(caught.message).toMatch(/mixed durable state/i);
    expect(caught.message).toMatch(/Do NOT retry blindly/);
    expect(state.promoteCalls).toHaveLength(1);
    expect(state.reconcileSaved).toBe(false);
    expect(state.batchUpdates.find((u) => u && 'last_full_rebuild_at' in u)).toBeUndefined();
  });

  it('(4) active-count inspection query errors → PromoteInspectionFailedError, never classified committed', async () => {
    state.promoteBehavior = 'transport-fail';
    state.activeCountError = { message: 'canceling statement due to statement timeout', code: '57014' };
    state.stagedCount = 0; // would have looked "committed" if active coerced to 0/expected
    let caught: any = null;
    try { await rebuildBatch('b1'); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(PromoteInspectionFailedError);
    expect(caught.message).toMatch(/do NOT retry blindly/i);
    expect(state.promoteCalls).toHaveLength(1);
    expect(state.reconcileSaved).toBe(false);
    expect(state.batchUpdates.find((u) => u && 'last_full_rebuild_at' in u)).toBeUndefined();
  });

  it('(5) staged-count inspection query errors → PromoteInspectionFailedError, never classified committed', async () => {
    state.promoteBehavior = 'transport-fail';
    // Active count matches expected — the dangerous case: with the old
    // `?? 0` coercion the failed staged query would read as 0 and the
    // promote would be falsely classified as committed and stamped.
    state.activeCount = EXPECTED_TOTAL;
    state.stagedCountError = { message: 'query failed', code: '57014' };
    let caught: any = null;
    try { await rebuildBatch('b1'); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(PromoteInspectionFailedError);
    expect(state.promoteCalls).toHaveLength(1);
    expect(state.reconcileSaved).toBe(false);
    expect(state.batchUpdates.find((u) => u && 'last_full_rebuild_at' in u)).toBeUndefined();
  });

  it('(6) flattenErrorForLog uses the locked flat keys and stays serializable', () => {
    const pgErr: any = new Error('canceling statement due to statement timeout');
    pgErr.code = '57014';
    pgErr.details = 'ctx';
    pgErr.hint = 'raise timeout';
    const flat = flattenErrorForLog(pgErr, {
      phase: 'promote',
      batch_id: 'b1',
      rebuild_session_id: 's1',
      elapsed_ms: 63999,
    });
    for (const k of ['name', 'message', 'code', 'details', 'hint', 'status', 'phase', 'batch_id', 'rebuild_session_id', 'elapsed_ms']) {
      expect(flat).toHaveProperty(k);
    }
    // Old camelCase keys must be gone.
    expect(flat).not.toHaveProperty('batchId');
    expect(flat).not.toHaveProperty('sessionId');
    expect(flat).not.toHaveProperty('elapsedMs');
    const json = JSON.stringify(flat);
    expect(json).toContain('57014');
    expect(json).toContain('canceling statement');
    expect(json).not.toContain('[object Object]');
  });

  it('isTransportClassPromoteError: PG errors with code are NOT transport-class; fetch failures ARE', () => {
    const pg: any = new Error('boom'); pg.code = '57014';
    expect(isTransportClassPromoteError(pg)).toBe(false);
    expect(isTransportClassPromoteError(new Error('TypeError: fetch failed'))).toBe(true);
    expect(isTransportClassPromoteError(new Error('NetworkError when attempting to fetch resource'))).toBe(true);
  });
});
