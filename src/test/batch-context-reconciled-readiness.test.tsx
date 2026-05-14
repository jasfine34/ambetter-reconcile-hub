/**
 * Bundle 12.6 v14 — BatchContext race-surface tests.
 *
 * Exercises the real BatchProvider generation guard and
 * `reconciledLoadedForBatchId` readiness state. Mocks ONLY the persistence
 * + reconcile boundary so we can drive deterministic resolve/reject orderings
 * via deferred promises.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import React from 'react';

// ---- Mocks (boundary only) -----------------------------------------------

const getBatchesMock = vi.fn();
const getReconciledMembersMock = vi.fn();
const getUploadedFilesMock = vi.fn();
const getBatchCountsMock = vi.fn();
const getNormalizedRecordsMock = vi.fn();

vi.mock('@/lib/persistence', () => ({
  getBatches: (...a: any[]) => getBatchesMock(...a),
  getReconciledMembers: (...a: any[]) => getReconciledMembersMock(...a),
  getUploadedFiles: (...a: any[]) => getUploadedFilesMock(...a),
  getBatchCounts: (...a: any[]) => getBatchCountsMock(...a),
  getNormalizedRecords: (...a: any[]) => getNormalizedRecordsMock(...a),
}));

vi.mock('@/lib/reconcile', () => ({
  reconcile: () => ({ debug: { ok: true } }),
}));

vi.mock('@/lib/dateRange', () => ({
  fallbackReconcileMonth: () => '2026-01',
}));

vi.mock('@/lib/resolvedIdentities', () => ({
  loadResolverIndex: vi.fn().mockResolvedValue(null),
}));

// Capture the useBatchDataVersion callback so tests can invoke it.
let capturedDataVersionCb: ((next: string, prev: string | null) => void) | null = null;
vi.mock('@/hooks/useBatchDataVersion', () => ({
  useBatchDataVersion: (_id: string | null, cb?: any) => {
    capturedDataVersionCb = cb ?? null;
    return null;
  },
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) },
}));

import { BatchProvider, useBatch } from '@/contexts/BatchContext';

// ---- Helpers --------------------------------------------------------------

function createDeferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: any) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const A = { id: 'batch-A', statement_month: '2026-01-01' };
const B = { id: 'batch-B', statement_month: '2026-02-01' };

beforeEach(() => {
  capturedDataVersionCb = null;
  getBatchesMock.mockReset().mockResolvedValue([A, B]);
  getReconciledMembersMock.mockReset().mockResolvedValue([]);
  getUploadedFilesMock.mockReset().mockResolvedValue([]);
  getBatchCountsMock.mockReset().mockResolvedValue({ uploadedFiles: 0, normalizedRecords: 0, reconciledMembers: 0 });
  getNormalizedRecordsMock.mockReset().mockResolvedValue([]);
});

function Probe({ onCtx }: { onCtx: (ctx: ReturnType<typeof useBatch>) => void }) {
  const ctx = useBatch();
  React.useEffect(() => { onCtx(ctx); });
  return null;
}

function snapshotReconciliation(ctx: ReturnType<typeof useBatch>) {
  return {
    reconciled: ctx.reconciled,
    debugStats: ctx.debugStats,
    reconciledLoadedForBatchId: ctx.reconciledLoadedForBatchId,
    loading: ctx.loading,
  };
}

async function flushMicrotasks() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

// ---- Tests ----------------------------------------------------------------

describe('BatchContext — reconciledLoadedForBatchId basic lifecycle', () => {
  it('initial null → A loaded → switch to B clears → B loaded', async () => {
    let ctx: ReturnType<typeof useBatch> | null = null;
    render(<BatchProvider><Probe onCtx={(c) => { ctx = c; }} /></BatchProvider>);

    await waitFor(() => expect(getReconciledMembersMock).toHaveBeenCalledWith(A.id));
    await waitFor(() => expect(ctx!.reconciledLoadedForBatchId).toBe(A.id));

    // Defer B's load so we can observe the cleared state immediately after switch.
    const dB = createDeferred<any[]>();
    getReconciledMembersMock.mockImplementationOnce(() => dB.promise);

    await act(async () => { ctx!.setCurrentBatchId(B.id, 'user-dropdown'); });
    expect(ctx!.reconciledLoadedForBatchId).toBe(null);

    await act(async () => { dB.resolve([]); });
    await waitFor(() => expect(ctx!.reconciledLoadedForBatchId).toBe(B.id));
  });
});

describe('BatchContext — generation guard for stale resolves/rejects', () => {
  it('stale resolve from prior batch does NOT mutate state after switch', async () => {
    const dA = createDeferred<any[]>();
    const dB = createDeferred<any[]>();
    getReconciledMembersMock.mockImplementationOnce(() => dA.promise)
                            .mockImplementationOnce(() => dB.promise);

    let ctx: ReturnType<typeof useBatch> | null = null;
    render(<BatchProvider><Probe onCtx={(c) => { ctx = c; }} /></BatchProvider>);
    await waitFor(() => expect(getReconciledMembersMock).toHaveBeenCalledWith(A.id));

    // Switch to B; B's loader starts.
    await act(async () => { ctx!.setCurrentBatchId(B.id, 'user-dropdown'); });
    await waitFor(() => expect(getReconciledMembersMock).toHaveBeenCalledWith(B.id));

    const snap = snapshotReconciliation(ctx!);

    // Resolve stale A.
    await act(async () => { dA.resolve([{ stale: true }]); });
    await flushMicrotasks();

    expect(ctx!.reconciled).toEqual(snap.reconciled);
    expect(ctx!.debugStats).toEqual(snap.debugStats);
    expect(ctx!.reconciledLoadedForBatchId).toEqual(snap.reconciledLoadedForBatchId);
    expect(ctx!.loading).toEqual(snap.loading);

    // Resolve B → B commits.
    await act(async () => { dB.resolve([{ b: 1 }]); });
    await waitFor(() => expect(ctx!.reconciledLoadedForBatchId).toBe(B.id));
    expect(ctx!.reconciled).toEqual([{ b: 1 }]);
    expect(ctx!.loading).toBe(false);
  });

  it('stale reject from prior batch does NOT mutate state after switch', async () => {
    const dA = createDeferred<any[]>();
    const dB = createDeferred<any[]>();
    getReconciledMembersMock.mockImplementationOnce(() => dA.promise)
                            .mockImplementationOnce(() => dB.promise);

    let ctx: ReturnType<typeof useBatch> | null = null;
    render(<BatchProvider><Probe onCtx={(c) => { ctx = c; }} /></BatchProvider>);
    await waitFor(() => expect(getReconciledMembersMock).toHaveBeenCalledWith(A.id));

    await act(async () => { ctx!.setCurrentBatchId(B.id, 'user-dropdown'); });
    await waitFor(() => expect(getReconciledMembersMock).toHaveBeenCalledWith(B.id));

    const snap = snapshotReconciliation(ctx!);

    await act(async () => { dA.reject(new Error('stale A failed')); });
    await flushMicrotasks();

    expect(ctx!.reconciled).toEqual(snap.reconciled);
    expect(ctx!.debugStats).toEqual(snap.debugStats);
    expect(ctx!.reconciledLoadedForBatchId).toEqual(snap.reconciledLoadedForBatchId);
    expect(ctx!.loading).toEqual(snap.loading);

    await act(async () => { dB.resolve([]); });
    await waitFor(() => expect(ctx!.reconciledLoadedForBatchId).toBe(B.id));
  });

  it('rapid A → B → A: stale A1 resolve does NOT mutate after second A starts', async () => {
    const dA1 = createDeferred<any[]>();
    const dB = createDeferred<any[]>();
    const dA2 = createDeferred<any[]>();
    getReconciledMembersMock
      .mockImplementationOnce(() => dA1.promise)
      .mockImplementationOnce(() => dB.promise)
      .mockImplementationOnce(() => dA2.promise);

    let ctx: ReturnType<typeof useBatch> | null = null;
    render(<BatchProvider><Probe onCtx={(c) => { ctx = c; }} /></BatchProvider>);
    await waitFor(() => expect(getReconciledMembersMock).toHaveBeenCalledTimes(1));

    await act(async () => { ctx!.setCurrentBatchId(B.id, 'user-dropdown'); });
    await waitFor(() => expect(getReconciledMembersMock).toHaveBeenCalledTimes(2));

    await act(async () => { ctx!.setCurrentBatchId(A.id, 'user-dropdown'); });
    await waitFor(() => expect(getReconciledMembersMock).toHaveBeenCalledTimes(3));

    const snap = snapshotReconciliation(ctx!);

    await act(async () => { dA1.resolve([{ stale: 1 }]); });
    await flushMicrotasks();

    expect(ctx!.reconciled).toEqual(snap.reconciled);
    expect(ctx!.reconciledLoadedForBatchId).toEqual(snap.reconciledLoadedForBatchId);
    expect(ctx!.loading).toEqual(snap.loading);

    await act(async () => { dA2.resolve([{ a2: true }]); });
    await waitFor(() => expect(ctx!.reconciledLoadedForBatchId).toBe(A.id));
    expect(ctx!.reconciled).toEqual([{ a2: true }]);
  });
});

describe('BatchContext — same-batch refresh invalidation via useBatchDataVersion', () => {
  it('invalidates readiness on refresh start, restores it on success', async () => {
    let ctx: ReturnType<typeof useBatch> | null = null;
    render(<BatchProvider><Probe onCtx={(c) => { ctx = c; }} /></BatchProvider>);
    await waitFor(() => expect(ctx!.reconciledLoadedForBatchId).toBe(A.id));
    expect(typeof capturedDataVersionCb).toBe('function');

    // Defer the next refresh's reconciled load.
    const d = createDeferred<any[]>();
    getReconciledMembersMock.mockImplementationOnce(() => d.promise);

    await act(async () => { capturedDataVersionCb!('v2', 'v1'); });
    // Immediately after callback: invalidated.
    expect(ctx!.reconciledLoadedForBatchId).toBe(null);
    expect(ctx!.loading).toBe(true);

    await act(async () => { d.resolve([{ row: 1 }]); });
    await waitFor(() => expect(ctx!.reconciledLoadedForBatchId).toBe(A.id));
    expect(ctx!.loading).toBe(false);
  });

  it('on refresh failure: readiness stays null, loading clears, no stale state', async () => {
    let ctx: ReturnType<typeof useBatch> | null = null;
    render(<BatchProvider><Probe onCtx={(c) => { ctx = c; }} /></BatchProvider>);
    await waitFor(() => expect(ctx!.reconciledLoadedForBatchId).toBe(A.id));

    const d = createDeferred<any[]>();
    getReconciledMembersMock.mockImplementationOnce(() => d.promise);

    await act(async () => { capturedDataVersionCb!('v2', 'v1'); });
    expect(ctx!.reconciledLoadedForBatchId).toBe(null);

    await act(async () => { d.reject(new Error('boom')); });
    await flushMicrotasks();

    expect(ctx!.reconciledLoadedForBatchId).toBe(null);
    expect(ctx!.loading).toBe(false);
    expect(ctx!.debugStats).toBe(null);
  });
});

describe('BatchContext — debugStats non-blocking failure', () => {
  it('reconciled commits even if normalized-records load fails', async () => {
    getReconciledMembersMock.mockResolvedValue([{ row: 1 }]);
    getNormalizedRecordsMock.mockRejectedValue(new Error('normalized boom'));

    let ctx: ReturnType<typeof useBatch> | null = null;
    render(<BatchProvider><Probe onCtx={(c) => { ctx = c; }} /></BatchProvider>);

    await waitFor(() => expect(ctx!.reconciledLoadedForBatchId).toBe(A.id));
    expect(ctx!.reconciled).toEqual([{ row: 1 }]);
    expect(ctx!.debugStats).toBe(null);
    expect(ctx!.loading).toBe(false);
  });
});

describe('BatchContext — empty reconciled array', () => {
  it('legitimately empty rows still mark batch as loaded', async () => {
    getReconciledMembersMock.mockResolvedValue([]);
    let ctx: ReturnType<typeof useBatch> | null = null;
    render(<BatchProvider><Probe onCtx={(c) => { ctx = c; }} /></BatchProvider>);
    await waitFor(() => expect(ctx!.reconciledLoadedForBatchId).toBe(A.id));
    expect(ctx!.reconciled).toEqual([]);
    expect(ctx!.loading).toBe(false);
  });
});
