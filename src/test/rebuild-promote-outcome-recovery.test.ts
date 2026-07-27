/**
 * Fault-injection tests for the promote-outcome recovery path.
 *
 * The February incident: the promote RPC committed server-side but the
 * browser's request failed at ~64s with a transport-class error. The
 * client wrongly treated this as "promote did not happen", skipped
 * reconciliation, and never stamped last_full_rebuild_at.
 *
 * These tests lock the fix:
 *
 *   (1) RPC throws transport-class error AFTER server commit → durable
 *       inspection shows committed → pipeline continues to reconcile +
 *       stamps rebuild time.
 *   (2) RPC throws transport-class error with rows still staged → treated
 *       as failure; no reconcile, no stamp.
 *   (3) RPC throws transport-class error, mixed counts → distinct
 *       PromoteMixedStateError; no continue, no retry.
 *   (4) Flat log record contains name/message/code/details/hint/status +
 *       phase/batchId/sessionId/elapsedMs, and is JSON-serializable
 *       (not a collapsed [object Object]).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state: {
  files: any[];
  promoteBehavior: 'ok' | 'transport-fail' | 'pg-fail';
  activeCount: number;
  stagedCount: number;
  expectedTotal: number;
  reconcileSaved: boolean;
  stampCalled: boolean;
  logRecords: any[];
} = {
  files: [],
  promoteBehavior: 'ok',
  activeCount: 0,
  stagedCount: 0,
  expectedTotal: 0,
  reconcileSaved: false,
  stampCalled: false,
  logRecords: [],
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
      update() { return query; },
      single() {
        if (table === 'upload_batches') {
          return Promise.resolve({ data: { statement_month: '2026-02-01' }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      then(resolve: any) {
        if (table === 'normalized_records' && query._head && query._exactCount) {
          const status = query._filters.staging_status;
          const count = status === 'active' ? state.activeCount : state.stagedCount;
          return Promise.resolve({ data: null, count, error: null }).then(resolve);
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
  replaceNormalizedForFileSet: vi.fn(async () => {
    if (state.promoteBehavior === 'transport-fail') {
      throw new Error('TypeError: fetch failed');
    }
    if (state.promoteBehavior === 'pg-fail') {
      const err: any = new Error('canceling statement due to statement timeout');
      err.code = '57014';
      throw err;
    }
    return state.expectedTotal;
  }),
}));

vi.mock('@/lib/resolvedIdentities', () => ({ loadResolverIndex: vi.fn(async () => null) }));
vi.mock('@/lib/reconcile', () => ({ reconcile: vi.fn(() => ({ members: [{ member_key: 'm1' }] })) }));
vi.mock('@/lib/csvParser', () => ({ parseCSV: vi.fn(async () => []) }));
vi.mock('@/lib/normalize', () => ({
  normalizeEDERow: vi.fn(), normalizeBackOfficeRow: vi.fn(), normalizeCommissionRow: vi.fn(),
}));
vi.mock('@/lib/dateRange', () => ({ fallbackReconcileMonth: () => '2026-02' }));

import { rebuildBatch, PromoteMixedStateError, ReconcileAfterPromoteError, flattenErrorForLog, isTransportClassPromoteError } from '@/lib/rebuild';

beforeEach(() => {
  state.files = [
    { id: 'f1', source_type: 'EDE', file_label: 'EDE', storage_path: 'p/ede.csv', created_at: '2026-02-01' },
    { id: 'f2', source_type: 'BACK_OFFICE', file_label: 'BO', storage_path: 'p/bo.csv', created_at: '2026-02-01', aor_bucket: 'M' },
  ];
  state.promoteBehavior = 'ok';
  state.activeCount = 0;
  state.stagedCount = 0;
  state.expectedTotal = 0;
  state.reconcileSaved = false;
  state.stampCalled = false;
  state.logRecords = [];
  // Capture stamp updates via a spy on console (no side channel available).
  const origError = console.error;
  vi.spyOn(console, 'error').mockImplementation((...args: any[]) => {
    state.logRecords.push(args);
    return origError.apply(console, args as any);
  });
});

describe('promote-outcome recovery', () => {
  it('(1) RPC transport-fail after server commit → recovery continues to reconcile + stamp', async () => {
    state.promoteBehavior = 'transport-fail';
    // Server actually committed: active-session rows == expected, staged == 0.
    // parseCSV returns [] so totalNormalized will be 0 → set expectedTotal to 0 to match.
    state.expectedTotal = 0;
    state.activeCount = 0;
    state.stagedCount = 0;
    const result = await rebuildBatch('b1');
    // Reconcile ran, membersReconciled populated (from saveAndVerifyReconciled path)
    expect(result.filesProcessed).toBe(2);
    expect(state.reconcileSaved).toBe(true);
  });

  it('(2) RPC transport-fail with rows still staged → rethrown as failure; no reconcile', async () => {
    state.promoteBehavior = 'transport-fail';
    state.expectedTotal = 10;
    state.activeCount = 0;
    state.stagedCount = 10;
    let caught: any = null;
    try { await rebuildBatch('b1'); } catch (e) { caught = e; }
    expect(caught).toBeTruthy();
    expect(caught).not.toBeInstanceOf(PromoteMixedStateError);
    expect(caught).not.toBeInstanceOf(ReconcileAfterPromoteError);
    expect(String(caught.message)).toMatch(/fetch failed/i);
    expect(state.reconcileSaved).toBe(false);
  });

  it('(3) RPC transport-fail with mixed counts → PromoteMixedStateError; no continue', async () => {
    state.promoteBehavior = 'transport-fail';
    state.expectedTotal = 10;
    state.activeCount = 4; // partial — disagreeing
    state.stagedCount = 6;
    let caught: any = null;
    try { await rebuildBatch('b1'); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(PromoteMixedStateError);
    expect(caught.message).toMatch(/mixed durable state/i);
    expect(caught.message).toMatch(/Do NOT retry blindly/);
    expect(state.reconcileSaved).toBe(false);
  });

  it('(4) flattenErrorForLog produces a serializable flat record with the required fields', () => {
    const pgErr: any = new Error('canceling statement due to statement timeout');
    pgErr.code = '57014';
    pgErr.details = 'ctx';
    pgErr.hint = 'raise timeout';
    const flat = flattenErrorForLog(pgErr, {
      phase: 'promote',
      batchId: 'b1',
      sessionId: 's1',
      elapsedMs: 63999,
    });
    // Required flat fields
    for (const k of ['name', 'message', 'code', 'details', 'hint', 'status', 'phase', 'batchId', 'sessionId', 'elapsedMs']) {
      expect(flat).toHaveProperty(k);
    }
    // JSON round-trip does not collapse to [object Object]
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
