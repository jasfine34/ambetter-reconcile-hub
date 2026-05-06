import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';

// ---- Mocks ----------------------------------------------------------------

const mockUseBatch = vi.fn();
vi.mock('@/contexts/BatchContext', () => ({
  useBatch: () => mockUseBatch(),
}));

const mockRebuild = vi.fn();
vi.mock('@/lib/rebuild', () => {
  // Real ReconcileAfterPromoteError shape preserved so the toast classifier
  // (#123), which does `instanceof ReconcileAfterPromoteError`, still works
  // when the rebuild module is mocked here.
  class ReconcileAfterPromoteError extends Error {
    readonly kind = 'reconcile-after-promote';
    constructor(public readonly underlying: Error) {
      super(`reconcile after promote: ${underlying.message}`);
      this.name = 'ReconcileAfterPromoteError';
    }
  }
  return {
    rebuildBatchWithRetry: (...args: any[]) => mockRebuild(...args),
    ReconcileAfterPromoteError,
  };
});

const mockToast = vi.fn();
vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

import { RebuildBatchButton } from '@/components/RebuildBatchButton';

// ---- Helpers --------------------------------------------------------------

const MAR = {
  id: 'batch-mar',
  statement_month: '2026-03-01',
};
const JAN = {
  id: 'batch-jan',
  statement_month: '2026-01-01',
};

function setBatchContext(currentBatchId: string | null, batches: any[] = [MAR, JAN]) {
  mockUseBatch.mockReturnValue({
    currentBatchId,
    batches,
    refreshAll: vi.fn().mockResolvedValue(undefined),
    refreshBatches: vi.fn().mockResolvedValue(undefined),
  });
}

beforeEach(() => {
  mockUseBatch.mockReset();
  mockRebuild.mockReset();
  mockToast.mockReset();
});

// ---- Tests ----------------------------------------------------------------

describe('RebuildBatchButton — wrong-batch race', () => {
  it('(a) snapshots target batch on dialog open; context flip to Jan does NOT redirect rebuild — still fires against Mar', async () => {
    // Active = Mar when dialog opens
    setBatchContext(MAR.id);
    let resolveRebuild: (v: any) => void = () => {};
    mockRebuild.mockImplementation(
      (_id: string) =>
        new Promise((resolve) => {
          resolveRebuild = resolve;
        })
    );

    const { rerender } = render(<RebuildBatchButton />);

    // Open the dialog (snapshots Mar as target)
    fireEvent.click(screen.getByRole('button', { name: /Rebuild Entire Batch/i }));
    await screen.findByRole('alertdialog');

    // Simulate the polling-driven context flip to Jan BEFORE confirm
    setBatchContext(JAN.id);
    rerender(<RebuildBatchButton />);

    // Confirm
    fireEvent.click(screen.getByRole('button', { name: /Rebuild Now/i }));

    await waitFor(() => expect(mockRebuild).toHaveBeenCalledTimes(1));
    // Critical: must be called with the Mar id captured at open-time, NOT Jan
    expect(mockRebuild.mock.calls[0][0]).toBe(MAR.id);

    await act(async () => {
      resolveRebuild({ filesProcessed: 5, recordsNormalized: 7247, membersReconciled: 3890 });
    });
  });

  it('(c) success toast contains batch label (month) and counts', async () => {
    setBatchContext(MAR.id);
    mockRebuild.mockResolvedValue({
      filesProcessed: 5,
      recordsNormalized: 7247,
      membersReconciled: 3890,
    });

    render(<RebuildBatchButton />);
    fireEvent.click(screen.getByRole('button', { name: /Rebuild Entire Batch/i }));
    await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByRole('button', { name: /Rebuild Now/i }));

    await waitFor(() => expect(mockToast).toHaveBeenCalled());
    const successCall = mockToast.mock.calls.find(
      (c) => c[0]?.title && /Rebuild Complete/i.test(c[0].title)
    );
    expect(successCall).toBeTruthy();
    // Title names the batch month AND member count (spec format)
    expect(successCall![0].title).toMatch(/Mar 2026/);
    expect(successCall![0].title).toMatch(/3,890 members/);
    // Description includes formatted counts
    expect(successCall![0].description).toMatch(/5 files/);
    expect(successCall![0].description).toMatch(/7,247 records/);
    expect(successCall![0].description).toMatch(/3,890 members/);
  });

  it('failure toast also names the targeted batch', async () => {
    setBatchContext(MAR.id);
    mockRebuild.mockRejectedValue(new Error('boom'));

    render(<RebuildBatchButton />);
    fireEvent.click(screen.getByRole('button', { name: /Rebuild Entire Batch/i }));
    await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByRole('button', { name: /Rebuild Now/i }));

    await waitFor(() => {
      const failCall = mockToast.mock.calls.find(
        (c) => c[0]?.title && /Rebuild Failed/i.test(c[0].title)
      );
      expect(failCall).toBeTruthy();
      expect(failCall![0].title).toMatch(/Mar 2026/);
      expect(failCall![0].variant).toBe('destructive');
    });
  });
});
