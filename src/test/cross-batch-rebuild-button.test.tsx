import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const toastMock = vi.fn();
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: toastMock }) }));

const useBatchMock = vi.fn();
vi.mock('@/contexts/BatchContext', () => ({ useBatch: () => useBatchMock() }));

const sweepMock = vi.fn();
vi.mock('@/lib/sweep/crossBatchClearingSweep', () => ({
  runCrossBatchClearingSweep: (...a: any[]) => sweepMock(...a),
}));

import { RebuildCrossBatchClearingsButton } from '@/components/RebuildCrossBatchClearingsButton';

beforeEach(() => {
  toastMock.mockReset();
  sweepMock.mockReset();
  useBatchMock.mockReturnValue({ batches: [{ id: 'B1' }] });
});

describe('RebuildCrossBatchClearingsButton', () => {
  it('disabled when no batches loaded', () => {
    useBatchMock.mockReturnValue({ batches: [] });
    render(<RebuildCrossBatchClearingsButton />);
    expect(screen.getByRole('button', { name: /Rebuild Cross-Batch Clearings/i })).toBeDisabled();
  });

  it('enabled when batches loaded', () => {
    render(<RebuildCrossBatchClearingsButton />);
    expect(screen.getByRole('button', { name: /Rebuild Cross-Batch Clearings/i })).not.toBeDisabled();
  });

  it('opens AlertDialog on click', async () => {
    render(<RebuildCrossBatchClearingsButton />);
    fireEvent.click(screen.getByRole('button', { name: /Rebuild Cross-Batch Clearings/i }));
    await waitFor(() => expect(screen.getByText(/Rebuild Cross-Batch Clearings\?/i)).toBeInTheDocument());
  });

  it('cancel closes dialog without calling sweep', async () => {
    render(<RebuildCrossBatchClearingsButton />);
    fireEvent.click(screen.getByRole('button', { name: /Rebuild Cross-Batch Clearings/i }));
    await waitFor(() => screen.getByText(/Rebuild Cross-Batch Clearings\?/i));
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(sweepMock).not.toHaveBeenCalled();
  });

  it('confirm runs sweep + success toast', async () => {
    sweepMock.mockResolvedValueOnce({ run_id: 'r', clearingRowsWritten: 5, inputErrors: [], aborted: false });
    render(<RebuildCrossBatchClearingsButton />);
    fireEvent.click(screen.getByRole('button', { name: /Rebuild Cross-Batch Clearings/i }));
    await waitFor(() => screen.getByText(/Rebuild Cross-Batch Clearings\?/i));
    fireEvent.click(screen.getByRole('button', { name: /^Rebuild$/ }));
    await waitFor(() => expect(sweepMock).toHaveBeenCalled());
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
      description: expect.stringContaining('5 clearing rows written'),
    })));
  });

  it('success toast appends inputErrors count when > 0', async () => {
    const ie = [{ reconciled_member_id: 'M', batch_id: 'B', reason: 'no_carrier' as const, evidence: {} }];
    sweepMock.mockResolvedValueOnce({ run_id: 'r', clearingRowsWritten: 1, inputErrors: ie, aborted: false });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    render(<RebuildCrossBatchClearingsButton />);
    fireEvent.click(screen.getByRole('button', { name: /Rebuild Cross-Batch Clearings/i }));
    await waitFor(() => screen.getByText(/Rebuild Cross-Batch Clearings\?/i));
    fireEvent.click(screen.getByRole('button', { name: /^Rebuild$/ }));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
      description: expect.stringContaining('1 inputs could not be evaluated'),
    })));
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('aborted result → error toast', async () => {
    sweepMock.mockResolvedValueOnce({
      run_id: 'r', clearingRowsWritten: 0, inputErrors: [], aborted: true,
      abortReason: 'no_upload_batches', errorMessage: 'No upload batches loaded; aborting sweep to prevent accidental clearing wipe.',
    });
    render(<RebuildCrossBatchClearingsButton />);
    fireEvent.click(screen.getByRole('button', { name: /Rebuild Cross-Batch Clearings/i }));
    await waitFor(() => screen.getByText(/Rebuild Cross-Batch Clearings\?/i));
    fireEvent.click(screen.getByRole('button', { name: /^Rebuild$/ }));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
      variant: 'destructive',
      description: expect.stringContaining('No upload batches'),
    })));
  });

  it('rejected promise → error toast', async () => {
    sweepMock.mockRejectedValueOnce(new Error('boom'));
    render(<RebuildCrossBatchClearingsButton />);
    fireEvent.click(screen.getByRole('button', { name: /Rebuild Cross-Batch Clearings/i }));
    await waitFor(() => screen.getByText(/Rebuild Cross-Batch Clearings\?/i));
    fireEvent.click(screen.getByRole('button', { name: /^Rebuild$/ }));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
      variant: 'destructive', description: 'boom',
    })));
  });

  it('passes shouldContinue closure to sweep', async () => {
    sweepMock.mockResolvedValueOnce({ run_id: 'r', clearingRowsWritten: 0, inputErrors: [], aborted: false });
    render(<RebuildCrossBatchClearingsButton />);
    fireEvent.click(screen.getByRole('button', { name: /Rebuild Cross-Batch Clearings/i }));
    await waitFor(() => screen.getByText(/Rebuild Cross-Batch Clearings\?/i));
    fireEvent.click(screen.getByRole('button', { name: /^Rebuild$/ }));
    await waitFor(() => expect(sweepMock).toHaveBeenCalled());
    const arg = sweepMock.mock.calls[0][0];
    expect(typeof arg.shouldContinue).toBe('function');
    expect(arg.shouldContinue()).toBe(true);
  });
});
