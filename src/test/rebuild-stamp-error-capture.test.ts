/**
 * Codex pass #2 — stamp-error capture in rebuildBatch.
 *
 * The final UPDATE on upload_batches that writes last_full_rebuild_at +
 * last_rebuild_logic_version used to ignore the {error} field. A failed
 * stamp would let rebuildBatch return success, leaving the staleness
 * banner inaccurate. These tests pin the new contract:
 *
 *   1. Happy path — stamp returns {error: null}: rebuildBatch resolves,
 *      and the upload_batches UPDATE patch carries the current logic version.
 *   2. Failure path — stamp returns {error: PostgrestError}: rebuildBatch
 *      throws an Error whose message includes the batchId AND the underlying
 *      Postgres error text (so the dashboard toast surfaces real diagnostics).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type StampCall = { patch: any; eqId?: string };

const state: {
  files: any[];
  normalizedRecords: any[];
  reconciledCount: number;
  stampError: any | null;
  stampCalls: StampCall[];
  deleteCount: number;
} = {
  files: [],
  normalizedRecords: [],
  reconciledCount: 0,
  stampError: null,
  stampCalls: [],
  deleteCount: 0,
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
      storage: { from: () => ({ download: () => Promise.resolve({ data: null, error: null }) }) },
    },
  };
});

vi.mock('@/lib/persistence', () => ({
  getUploadedFiles: vi.fn(async () => state.files),
  insertNormalizedRecords: vi.fn(async () => {}),
  saveReconciledMembers: vi.fn(async () => {}),
  saveAndVerifyReconciled: vi.fn(async () => ({ rowCount: state.reconciledCount, version: null })),
  getNormalizedRecords: vi.fn(async () => state.normalizedRecords),
  getOrCreateSnapshotForFile: vi.fn(async () => ({ id: 'snap-1' })),
  deleteCurrentNormalizedForBatch: vi.fn(async () => { state.deleteCount++; }),
  countReconciledForBatch: vi.fn(async () => state.reconciledCount),
  // Returns 0 right after a delete (so deleteAndVerifyZero is satisfied),
  // then >0 once inserts have run (so post-INSERT verification passes).
  countCurrentNormalizedForBatch: vi.fn(async () =>
    state.deleteCount > 0 ? state.normalizedRecords.length : 0,
  ),
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

import { rebuildBatch, RECONCILE_LOGIC_VERSION } from '@/lib/rebuild';

beforeEach(() => {
  state.files = [
    { id: 'f1', source_type: 'EDE', file_label: 'ede.csv', storage_path: 'p/ede.csv', created_at: '2026-03-01' },
  ];
  state.normalizedRecords = [{ id: 'n1' }, { id: 'n2' }];
  state.reconciledCount = 2;
  state.stampError = null;
  state.stampCalls = [];
});

describe('rebuildBatch — upload_batches stamp error capture (Codex pass #2)', () => {
  it('happy path: stamp succeeds and rebuildBatch resolves with current logic version', async () => {
    state.stampError = null;
    const result = await rebuildBatch('batch-mar-2026');
    expect(result.membersReconciled).toBe(2);
    expect(state.stampCalls).toHaveLength(1);
    expect(state.stampCalls[0].eqId).toBe('batch-mar-2026');
    expect(state.stampCalls[0].patch.last_rebuild_logic_version).toBe(RECONCILE_LOGIC_VERSION);
    expect(state.stampCalls[0].patch.last_full_rebuild_at).toBeTruthy();
  });

  it('failure path: stamp UPDATE returns PostgrestError → rebuildBatch throws with batchId + underlying error', async () => {
    state.stampError = {
      message: 'simulated stamp failure',
      code: '42P01',
      details: 'relation does not exist',
      hint: null,
    };
    await expect(rebuildBatch('batch-mar-2026')).rejects.toThrow(/batch-mar-2026/);

    state.stampCalls = [];
    state.stampError = {
      message: 'simulated stamp failure',
      code: '42P01',
      details: null,
      hint: null,
    };
    let caught: Error | null = null;
    try {
      await rebuildBatch('batch-jan-2026');
    } catch (e: any) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect(caught!.message).toContain('batch-jan-2026');
    expect(caught!.message).toContain('simulated stamp failure');
    expect(caught!.message).toContain('42P01');
  });

  it('regression: logic version constant is the new stamp-error-capture token', () => {
    expect(RECONCILE_LOGIC_VERSION).toBe('2026.04.30-stamp-error-capture');
  });
});
