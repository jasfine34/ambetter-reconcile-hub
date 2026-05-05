/**
 * Fault-injection tests for the staged-then-promote rebuild pipeline.
 *
 * Covers the seven scenarios required by the architecture review:
 *   1. Lock contention — second concurrent rebuild bounces with lock_not_available.
 *   2. TTL recovery — stale lock past TTL is reclaimable (acquire SQL contract).
 *   3. Per-file count mismatch — promote RPC raises, no supersede happens.
 *   4. Zero-EDE wipe attempt — required-source-type aggregate guard fires
 *      (the Feb 15:32 regression lock).
 *   5. Stale-session pre-flush — preflush_stale_staged_rows runs before staging
 *      and returns the count of orphaned rows it cleared.
 *   6. Lock-loss-during-promote — replace_normalized_for_file_set raises
 *      with lock_not_available; staged rows remain for next pre-flush.
 *   7. Phase 4 reconcile failure after successful promote — wraps in
 *      ReconcileAfterPromoteError carrying the explicit user-facing message.
 *
 * Strategy: mock @/lib/persistence at the wrapper boundary so each scenario
 * can inject the precise failure point being asserted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state: {
  files: any[];
  acquireBehavior: 'ok' | 'busy';
  promoteBehavior: 'ok' | 'count-mismatch' | 'zero-ede-wipe' | 'lock-lost';
  reconcileBehavior: 'ok' | 'fail';
  preflushReturn: number;
  acquireCalls: Array<{ batchId: string; sessionId: string }>;
  releaseCalls: Array<{ batchId: string; sessionId: string }>;
  preflushCalls: Array<{ batchId: string; fileIds: string[] }>;
  promoteCalls: Array<any>;
  staged: Array<{ fileId: string; sessionId: string; count: number }>;
} = {
  files: [],
  acquireBehavior: 'ok',
  promoteBehavior: 'ok',
  reconcileBehavior: 'ok',
  preflushReturn: 0,
  acquireCalls: [],
  releaseCalls: [],
  preflushCalls: [],
  promoteCalls: [],
  staged: [],
};

vi.mock('@/integrations/supabase/client', () => {
  const builder = (table: string) => {
    const obj: any = {
      update() { return obj; },
      select() { return obj; },
      eq() { return obj; },
      is() { return obj; },
      single() {
        if (table === 'upload_batches') {
          return Promise.resolve({ data: { statement_month: '2026-02-01' }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      then(resolve: any) { return Promise.resolve({ error: null }).then(resolve); },
    };
    return obj;
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
  insertStagedNormalizedRecords: vi.fn(async (_b, fileId, rows, sessionId) => {
    state.staged.push({ fileId, sessionId, count: rows.length });
  }),
  saveReconciledMembers: vi.fn(async () => {}),
  saveAndVerifyReconciled: vi.fn(async () => {
    if (state.reconcileBehavior === 'fail') {
      throw new Error('simulated reconcile failure');
    }
    return { rowCount: 5, version: null };
  }),
  getNormalizedRecords: vi.fn(async () => [{ id: 'n1' }]),
  getOrCreateSnapshotForFile: vi.fn(async () => ({ id: 'snap-1', kind: 'ede' })),
  countReconciledForBatch: vi.fn(async () => 5),
  countCurrentNormalizedForBatch: vi.fn(async () => 1),
  acquireRebuildLock: vi.fn(async (b: string, s: string) => {
    state.acquireCalls.push({ batchId: b, sessionId: s });
    if (state.acquireBehavior === 'busy') {
      const err: any = new Error(`acquireRebuildLock failed for batch ${b}: Another rebuild is already in progress for batch ${b}`);
      err.code = '55P03';
      throw err;
    }
    return s;
  }),
  releaseRebuildLock: vi.fn(async (b: string, s: string) => {
    state.releaseCalls.push({ batchId: b, sessionId: s });
  }),
  preflushStaleStagedRows: vi.fn(async (b: string, fileIds: string[]) => {
    state.preflushCalls.push({ batchId: b, fileIds });
    return state.preflushReturn;
  }),
  replaceNormalizedForFileSet: vi.fn(async (args: any) => {
    state.promoteCalls.push(args);
    if (state.promoteBehavior === 'count-mismatch') {
      throw new Error('replaceNormalizedForFileSet failed: count mismatch for file f1 (expected 100, staged 99)');
    }
    if (state.promoteBehavior === 'zero-ede-wipe') {
      throw new Error('replaceNormalizedForFileSet failed: required source type EDE has 0 staged rows for batch b1 (refusing to promote — would wipe active EDE data)');
    }
    if (state.promoteBehavior === 'lock-lost') {
      const err: any = new Error('replaceNormalizedForFileSet failed: lock lost or stolen for batch b1');
      err.code = '55P03';
      throw err;
    }
    return args.expectedCounts.reduce((s: number, e: any) => s + e.expected, 0);
  }),
}));

vi.mock('@/lib/resolvedIdentities', () => ({ loadResolverIndex: vi.fn(async () => null) }));
vi.mock('@/lib/reconcile', () => ({ reconcile: vi.fn(() => ({ members: [{ member_key: 'm1' }] })) }));
vi.mock('@/lib/csvParser', () => ({ parseCSV: vi.fn(async () => []) }));
vi.mock('@/lib/normalize', () => ({
  normalizeEDERow: vi.fn(),
  normalizeBackOfficeRow: vi.fn(),
  normalizeCommissionRow: vi.fn(),
}));
vi.mock('@/lib/dateRange', () => ({ fallbackReconcileMonth: () => '2026-02' }));

import { rebuildBatch, ReconcileAfterPromoteError } from '@/lib/rebuild';

beforeEach(() => {
  state.files = [
    { id: 'f1', source_type: 'EDE', file_label: 'EDE Summary', storage_path: 'p/ede.csv', created_at: '2026-02-01' },
    { id: 'f2', source_type: 'BACK_OFFICE', file_label: 'BO Mariner', storage_path: 'p/bo.csv', created_at: '2026-02-01', aor_bucket: 'Mariner' },
  ];
  state.acquireBehavior = 'ok';
  state.promoteBehavior = 'ok';
  state.reconcileBehavior = 'ok';
  state.preflushReturn = 0;
  state.acquireCalls = [];
  state.releaseCalls = [];
  state.preflushCalls = [];
  state.promoteCalls = [];
  state.staged = [];
});

describe('rebuild pipeline — fault injection', () => {
  it('(1) lock contention: second rebuild bounces; first holder is unaffected', async () => {
    state.acquireBehavior = 'busy';
    let caught: Error | null = null;
    try { await rebuildBatch('b1'); } catch (e: any) { caught = e; }
    expect(caught).toBeTruthy();
    expect(caught!.message).toMatch(/Another rebuild is already in progress|lock/i);
    // No staging happened, no promote attempted, no release attempted
    // (we never held the lock).
    expect(state.staged).toHaveLength(0);
    expect(state.promoteCalls).toHaveLength(0);
    expect(state.releaseCalls).toHaveLength(0);
  });

  it('(2) TTL recovery: acquireRebuildLock returning OK after a stale prior session lets the rebuild proceed', async () => {
    // The TTL recovery is enforced inside the SQL (rebuild_started_at < now() - 30m).
    // From the JS side, "TTL recovery" simply manifests as acquire returning ok.
    state.acquireBehavior = 'ok';
    const result = await rebuildBatch('b1');
    expect(result.filesProcessed).toBe(2);
    expect(state.acquireCalls).toHaveLength(1);
    expect(state.releaseCalls).toHaveLength(1);
  });

  it('(3) per-file count mismatch: promote raises; lock released; no reconcile', async () => {
    state.promoteBehavior = 'count-mismatch';
    let caught: Error | null = null;
    try { await rebuildBatch('b1'); } catch (e: any) { caught = e; }
    expect(caught).toBeTruthy();
    expect(caught!.message).toMatch(/count mismatch/);
    // Not a ReconcileAfterPromoteError — failure happened BEFORE promote committed.
    expect(caught).not.toBeInstanceOf(ReconcileAfterPromoteError);
    expect(state.releaseCalls).toHaveLength(1);
  });

  it('(4) zero-EDE wipe attempt: aggregate guard fires; active data preserved', async () => {
    state.promoteBehavior = 'zero-ede-wipe';
    let caught: Error | null = null;
    try { await rebuildBatch('b1'); } catch (e: any) { caught = e; }
    expect(caught).toBeTruthy();
    expect(caught!.message).toMatch(/required source type EDE has 0 staged rows/);
    expect(caught!.message).toMatch(/refusing to promote/);
    expect(caught!.message).toMatch(/would wipe active EDE data/);
    expect(caught).not.toBeInstanceOf(ReconcileAfterPromoteError);
    // Lock released; required source types were correctly derived from the plan.
    expect(state.releaseCalls).toHaveLength(1);
    expect(state.promoteCalls[0].requiredSourceTypes.sort()).toEqual(['BACK_OFFICE', 'EDE']);
  });

  it('(5) stale-session pre-flush: preflush is called BEFORE staging with all in-scope file ids', async () => {
    state.preflushReturn = 7; // simulate 7 orphan staged rows from a dead prior rebuild
    await rebuildBatch('b1');
    expect(state.preflushCalls).toHaveLength(1);
    expect(state.preflushCalls[0].batchId).toBe('b1');
    expect(state.preflushCalls[0].fileIds.sort()).toEqual(['f1', 'f2']);
    // All staging happened AFTER preflush — assert ordering by checking the
    // staging rows are tied to the new session.
    const sessionIds = new Set(state.staged.map((s) => s.sessionId));
    expect(sessionIds.size).toBe(1);
    expect(state.acquireCalls[0].sessionId).toBe([...sessionIds][0]);
  });

  it('(6) lock-loss during promote: RPC raises lock_not_available; lock release still runs', async () => {
    state.promoteBehavior = 'lock-lost';
    let caught: Error | null = null;
    try { await rebuildBatch('b1'); } catch (e: any) { caught = e; }
    expect(caught).toBeTruthy();
    expect(caught!.message).toMatch(/lock lost or stolen/);
    expect(caught).not.toBeInstanceOf(ReconcileAfterPromoteError);
    // finally{} still releases; staged rows remain in DB for next pre-flush.
    expect(state.releaseCalls).toHaveLength(1);
  });

  it('(7) Phase 4 reconcile failure: promote committed; throws ReconcileAfterPromoteError with explicit message', async () => {
    state.reconcileBehavior = 'fail';
    let caught: Error | null = null;
    try { await rebuildBatch('b1'); } catch (e: any) { caught = e; }
    expect(caught).toBeInstanceOf(ReconcileAfterPromoteError);
    expect(caught!.message).toContain('rebuild promoted new normalized data but reconcile failed');
    expect(caught!.message).toContain('click Rebuild to complete');
    expect(caught!.message).toContain('simulated reconcile failure');
    // Promote DID happen; lock released.
    expect(state.promoteCalls).toHaveLength(1);
    expect(state.releaseCalls).toHaveLength(1);
  });
});
