/**
 * #126-OBS — Batch state observability cleanup
 *
 * Two behaviors under test, NEITHER of which alters batch-selection behavior:
 *
 *   A. refreshBatches() failure surfaces a visible toast and PRESERVES the
 *      existing batches array + currentBatchId (no silent UI degradation).
 *   B. setCurrentBatchId calls without a known `source` label leave forensic
 *      console.warn evidence; calls with known sources stay silent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import React from 'react';

// ---- Mocks ----------------------------------------------------------------

const getBatchesMock = vi.fn();
const getReconciledMembersMock = vi.fn();
const getUploadedFilesMock = vi.fn();
const getBatchCountsMock = vi.fn();
const getNormalizedRecordsMock = vi.fn();
const toastMock = vi.fn();

vi.mock('@/lib/persistence', () => ({
  getBatches: (...a: any[]) => getBatchesMock(...a),
  getReconciledMembers: (...a: any[]) => getReconciledMembersMock(...a),
  getUploadedFiles: (...a: any[]) => getUploadedFilesMock(...a),
  getBatchCounts: (...a: any[]) => getBatchCountsMock(...a),
  getNormalizedRecords: (...a: any[]) => getNormalizedRecordsMock(...a),
}));

vi.mock('@/lib/reconcile', () => ({ reconcile: () => ({ debug: null }) }));
vi.mock('@/lib/dateRange', () => ({ fallbackReconcileMonth: () => '2026-01' }));
vi.mock('@/lib/resolvedIdentities', () => ({ loadResolverIndex: vi.fn().mockResolvedValue(null) }));
vi.mock('@/hooks/useBatchDataVersion', () => ({ useBatchDataVersion: () => null }));
vi.mock('@/hooks/use-toast', () => ({
  toast: (...a: any[]) => toastMock(...a),
  useToast: () => ({ toast: toastMock }),
}));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) },
}));

import { BatchProvider, useBatch, type BatchSelectionSource } from '@/contexts/BatchContext';

const JAN = { id: 'batch-jan', statement_month: '2026-01-01' };
const MAR = { id: 'batch-mar', statement_month: '2026-03-01' };

beforeEach(() => {
  getBatchesMock.mockReset().mockResolvedValue([JAN, MAR]);
  getReconciledMembersMock.mockReset().mockResolvedValue([]);
  getUploadedFilesMock.mockReset().mockResolvedValue([]);
  getBatchCountsMock.mockReset().mockResolvedValue({ uploadedFiles: 0, normalizedRecords: 0, reconciledMembers: 0 });
  getNormalizedRecordsMock.mockReset().mockResolvedValue([]);
  toastMock.mockReset();
});

function Probe({ onCtx }: { onCtx: (ctx: ReturnType<typeof useBatch>) => void }) {
  const ctx = useBatch();
  React.useEffect(() => { onCtx(ctx); });
  return null;
}

// ---------------------------------------------------------------------------
// Part A — refreshBatches failure surfacing
// ---------------------------------------------------------------------------

describe('#126-OBS Part A — refreshBatches failure surfaces a visible toast', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { errSpy = vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { errSpy.mockRestore(); });

  it('mount-time failure: toast fires, batches stays empty, selection preserved (null)', async () => {
    getBatchesMock.mockRejectedValueOnce(new Error('network down'));
    let latestCtx: ReturnType<typeof useBatch> | null = null;
    render(
      <BatchProvider>
        <Probe onCtx={(c) => { latestCtx = c; }} />
      </BatchProvider>
    );
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalled();
    });
    const call = toastMock.mock.calls[0][0];
    expect(String(call.title)).toMatch(/refresh batch list/i);
    expect(String(call.description)).toMatch(/preserved/i);
    // Selection was not yanked.
    expect(latestCtx!.currentBatchId).toBeNull();
    expect(latestCtx!.batches).toEqual([]);
  });

  it('normal mount → no failure toast', async () => {
    render(<BatchProvider><Probe onCtx={() => {}} /></BatchProvider>);
    await waitFor(() => {
      expect(getBatchesMock).toHaveBeenCalled();
    });
    // Give effects a tick to settle.
    await new Promise(r => setTimeout(r, 10));
    // No "Failed to refresh batch list" toast should have fired.
    const failureToasts = toastMock.mock.calls.filter(c =>
      String(c[0]?.title || '').match(/failed to refresh batch list/i)
    );
    expect(failureToasts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Part B — Forensic logging on unknown setCurrentBatchId sources
// ---------------------------------------------------------------------------

describe('#126-OBS Part B — forensic logging for unexpected currentBatchId mutations', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warnSpy.mockRestore(); });

  it('known source labels stay silent (no forensic warn)', async () => {
    let latestCtx: ReturnType<typeof useBatch> | null = null;
    render(
      <BatchProvider>
        <Probe onCtx={(c) => { latestCtx = c; }} />
      </BatchProvider>
    );
    await waitFor(() => expect(latestCtx!.currentBatchId).toBe(JAN.id));
    warnSpy.mockClear(); // ignore any pre-mount noise

    const knownSources: BatchSelectionSource[] = [
      'user-dropdown', 'mce-page-picker', 'create', 'delete',
    ];
    let cursor = JAN.id;
    for (const src of knownSources) {
      const next = cursor === JAN.id ? MAR.id : JAN.id;
      await act(async () => { latestCtx!.setCurrentBatchId(next, src); });
      cursor = next;
    }
    const forensic = warnSpy.mock.calls.filter(c => String(c[0] || '').includes('[batch-state]'));
    expect(forensic).toHaveLength(0);
  });

  it('unlabeled setter call leaves forensic evidence with prev/next/stack', async () => {
    let latestCtx: ReturnType<typeof useBatch> | null = null;
    render(
      <BatchProvider>
        <Probe onCtx={(c) => { latestCtx = c; }} />
      </BatchProvider>
    );
    await waitFor(() => expect(latestCtx!.currentBatchId).toBe(JAN.id));
    warnSpy.mockClear();

    await act(async () => {
      // No source argument — simulates an unknown / accidental mutation path.
      (latestCtx!.setCurrentBatchId as any)(MAR.id);
    });

    const forensic = warnSpy.mock.calls.find(c =>
      String(c[0] || '').includes('[batch-state]') &&
      String(c[0] || '').includes('unknown source')
    );
    expect(forensic).toBeDefined();
    const payload = forensic![1] as any;
    expect(payload.prev).toBe(JAN.id);
    expect(payload.next).toBe(MAR.id);
    expect(payload.source).toBe('(none)');
    // Stack must be present so we can identify the caller.
    expect(typeof payload.stack).toBe('string');
    expect(payload.stack.length).toBeGreaterThan(0);

    // Behavior preserved — state DID change despite the warning.
    await waitFor(() => expect(latestCtx!.currentBatchId).toBe(MAR.id));
  });

  it('explicit unknown-string source also warns (forensic catches typos / new paths)', async () => {
    let latestCtx: ReturnType<typeof useBatch> | null = null;
    render(
      <BatchProvider>
        <Probe onCtx={(c) => { latestCtx = c; }} />
      </BatchProvider>
    );
    await waitFor(() => expect(latestCtx!.currentBatchId).toBe(JAN.id));
    warnSpy.mockClear();

    await act(async () => {
      (latestCtx!.setCurrentBatchId as any)(MAR.id, 'mystery-path');
    });

    const forensic = warnSpy.mock.calls.find(c =>
      String(c[0] || '').includes('[batch-state]') &&
      String(c[0] || '').includes('unknown source')
    );
    expect(forensic).toBeDefined();
    expect((forensic![1] as any).source).toBe('mystery-path');
  });
});
