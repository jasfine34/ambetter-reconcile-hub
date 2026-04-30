import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import React from 'react';

// ---- Mocks ----------------------------------------------------------------

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
  reconcile: () => ({ debug: null }),
}));

vi.mock('@/lib/dateRange', () => ({
  fallbackReconcileMonth: () => '2026-01',
}));

vi.mock('@/lib/resolvedIdentities', () => ({
  loadResolverIndex: vi.fn().mockResolvedValue(null),
}));

// Stub the polling hook out — it makes its own supabase calls and is not
// what we are testing here.
vi.mock('@/hooks/useBatchDataVersion', () => ({
  useBatchDataVersion: () => null,
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) },
}));

import { BatchProvider, useBatch } from '@/contexts/BatchContext';

// ---- Helpers --------------------------------------------------------------

const MAR = { id: 'batch-mar', statement_month: '2026-03-01' };
const JAN = { id: 'batch-jan', statement_month: '2026-01-01' };

beforeEach(() => {
  getBatchesMock.mockReset().mockResolvedValue([JAN, MAR]); // Jan first → default selected
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

// ---- Test -----------------------------------------------------------------

describe('BatchContext — refresh on batch switch (#71/#72 stale-cache class)', () => {
  it('(b) switching active batch from Jan → Mar triggers refreshAll (re-fetches files/reconciled/counts for Mar)', async () => {
    let latestCtx: ReturnType<typeof useBatch> | null = null;
    render(
      <BatchProvider>
        <Probe onCtx={(c) => { latestCtx = c; }} />
      </BatchProvider>
    );

    // Initial mount: Jan auto-selected, refreshAll fires once for Jan
    await waitFor(() => {
      expect(getReconciledMembersMock).toHaveBeenCalledWith(JAN.id);
      expect(getUploadedFilesMock).toHaveBeenCalledWith(JAN.id);
      expect(getBatchCountsMock).toHaveBeenCalledWith(JAN.id);
    });

    const reconciledCallsBefore = getReconciledMembersMock.mock.calls.length;
    const filesCallsBefore = getUploadedFilesMock.mock.calls.length;
    const countsCallsBefore = getBatchCountsMock.mock.calls.length;
    const batchesCallsBefore = getBatchesMock.mock.calls.length;

    // Switch to Mar
    await act(async () => {
      latestCtx!.setCurrentBatchId(MAR.id);
    });

    // Each refresh fn must have been re-invoked for Mar
    await waitFor(() => {
      expect(getReconciledMembersMock).toHaveBeenCalledWith(MAR.id);
      expect(getUploadedFilesMock).toHaveBeenCalledWith(MAR.id);
      expect(getBatchCountsMock).toHaveBeenCalledWith(MAR.id);
    });
    expect(getReconciledMembersMock.mock.calls.length).toBeGreaterThan(reconciledCallsBefore);
    expect(getUploadedFilesMock.mock.calls.length).toBeGreaterThan(filesCallsBefore);
    expect(getBatchCountsMock.mock.calls.length).toBeGreaterThan(countsCallsBefore);
    // refreshBatches must also fire on switch — picks up background-rebuild
    // metadata (last_full_rebuild_at, last_rebuild_logic_version) for the
    // newly active batch. This is the stale-on-switch fix from the spec.
    await waitFor(() => {
      expect(getBatchesMock.mock.calls.length).toBeGreaterThan(batchesCallsBefore);
    });
  });
});
