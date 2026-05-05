/**
 * Codex pass #2 — stamp-error capture in rebuildBatch.
 *
 * Updated for the staged-then-promote pipeline. The stamp UPDATE still runs
 * inside the Phase-4 reconcile block, so a stamp failure now manifests as a
 * ReconcileAfterPromoteError whose .underlying.message carries the original
 * Postgres diagnostic text.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type StampCall = { patch: any; eqId?: string };

const state: {
  files: any[];
  normalizedRecords: any[];
  reconciledCount: number;
  stampError: any | null;
  stampCalls: StampCall[];
  preflushed: number;
  staged: Array<{ batchId: string; fileId: string; count: number; sessionId: string }>;
  promoted: Array<{ batchId: string; sessionId: string; expected: any; types: string[] }>;
  released: Array<{ batchId: string; sessionId: string }>;
  acquired: Array<{ batchId: string; sessionId: string }>;
} = {
  files: [],
  normalizedRecords: [],
  reconciledCount: 0,
  stampError: null,
  stampCalls: [],
  preflushed: 0,
  staged: [],
  promoted: [],
  released: [],
  acquired: [],
};

vi.mock('@/integrations/supabase/client', () => {
  const builder = (table: string) => {
    let isUpdate = false;
    let pendingPatch: any = null;
    const obj: any = {
      update(patch: any) {
        pendingPatch = patch;
        isUpdate = true;
        return obj;
      },
      select() { return obj; },
      eq(col: string, val: any) {
        if (isUpdate && table === 'upload_batches') {
          state.stampCalls.push({ patch: pendingPatch, eqId: val });
          return Promise.resolve({ error: state.stampError });
        }
        return obj;
      },
      single() {
        if (table === 'upload_batches') {
          return Promise.resolve({ data: { statement_month: '2026-03-01' }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
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
  insertStagedNormalizedRecords: vi.fn(async (b: string, f: string, rows: any[], sessionId: string) => {
    state.staged.push({ batchId: b, fileId: f, count: rows.length, sessionId });
  }),
  saveReconciledMembers: vi.fn(async () => {}),
  saveAndVerifyReconciled: vi.fn(async () => ({ rowCount: state.reconciledCount, version: null })),
  getNormalizedRecords: vi.fn(async () => state.normalizedRecords),
  getOrCreateSnapshotForFile: vi.fn(async () => ({ id: 'snap-1', kind: 'ede' })),
  countReconciledForBatch: vi.fn(async () => state.reconciledCount),
  countCurrentNormalizedForBatch: vi.fn(async () => state.normalizedRecords.length),
  acquireRebuildLock: vi.fn(async (b: string, s: string) => { state.acquired.push({ batchId: b, sessionId: s }); return s; }),
  releaseRebuildLock: vi.fn(async (b: string, s: string) => { state.released.push({ batchId: b, sessionId: s }); }),
  preflushStaleStagedRows: vi.fn(async () => { state.preflushed++; return 0; }),
  replaceNormalizedForFileSet: vi.fn(async (args: any) => {
    state.promoted.push({ batchId: args.batchId, sessionId: args.sessionId, expected: args.expectedCounts, types: args.requiredSourceTypes });
    return args.expectedCounts.reduce((s: number, e: any) => s + e.expected, 0);
  }),
}));

vi.mock('@/lib/resolvedIdentities', () => ({
  loadResolverIndex: vi.fn(async () => null),
}));

vi.mock('@/lib/reconcile', () => ({
  reconcile: vi.fn(() => ({ members: state.normalizedRecords.map((_, i) => ({ member_key: `m${i}` })) })),
}));

vi.mock('@/lib/csvParser', () => ({ parseCSV: vi.fn(async () => []) }));
vi.mock('@/lib/normalize', () => ({
  normalizeEDERow: vi.fn(),
  normalizeBackOfficeRow: vi.fn(),
  normalizeCommissionRow: vi.fn(),
}));
vi.mock('@/lib/dateRange', () => ({ fallbackReconcileMonth: () => '2026-03' }));

import { rebuildBatch, RECONCILE_LOGIC_VERSION, ReconcileAfterPromoteError } from '@/lib/rebuild';

beforeEach(() => {
  state.files = [
    { id: 'f1', source_type: 'EDE', file_label: 'ede.csv', storage_path: 'p/ede.csv', created_at: '2026-03-01' },
  ];
  state.normalizedRecords = [{ id: 'n1' }, { id: 'n2' }];
  state.reconciledCount = 2;
  state.stampError = null;
  state.stampCalls = [];
  state.preflushed = 0;
  state.staged = [];
  state.promoted = [];
  state.released = [];
  state.acquired = [];
});

describe('rebuildBatch — upload_batches stamp error capture', () => {
  it('happy path: stamp succeeds, rebuildBatch resolves, lock released', async () => {
    const result = await rebuildBatch('batch-mar-2026');
    expect(result.membersReconciled).toBe(2);
    expect(state.acquired).toHaveLength(1);
    expect(state.released).toHaveLength(1);
    expect(state.acquired[0].sessionId).toBe(state.released[0].sessionId);
    expect(state.stampCalls).toHaveLength(1);
    expect(state.stampCalls[0].eqId).toBe('batch-mar-2026');
    expect(state.stampCalls[0].patch.last_rebuild_logic_version).toBe(RECONCILE_LOGIC_VERSION);
  });

  it('failure path: stamp UPDATE error → ReconcileAfterPromoteError with underlying diagnostics', async () => {
    state.stampError = {
      message: 'simulated stamp failure',
      code: '42P01',
      details: 'relation does not exist',
      hint: null,
    };
    let caught: Error | null = null;
    try { await rebuildBatch('batch-jan-2026'); } catch (e: any) { caught = e; }
    expect(caught).toBeInstanceOf(ReconcileAfterPromoteError);
    expect(caught!.message).toContain('rebuild promoted new normalized data but reconcile failed');
    expect(caught!.message).toContain('click Rebuild to complete');
    expect(caught!.message).toContain('batch-jan-2026');
    expect(caught!.message).toContain('simulated stamp failure');
    // Lock released even on Phase-4 failure.
    expect(state.released).toHaveLength(1);
  });

  it('regression: logic version constant pinned', () => {
    expect(RECONCILE_LOGIC_VERSION).toBe('2026.05.01-eligible-cohort-current-batch');
  });
});
