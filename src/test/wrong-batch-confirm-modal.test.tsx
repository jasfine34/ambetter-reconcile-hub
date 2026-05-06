import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { WrongBatchConfirmModal } from '@/components/WrongBatchConfirmModal';
import type { FilenameWarning } from '@/lib/filenameDateHeuristic';

function makeFile(name: string, size = 1024): File {
  const blob = new Blob([new Uint8Array(size)], { type: 'text/csv' });
  return new File([blob], name, { type: 'text/csv' });
}

function setup(opts?: {
  open?: boolean;
  warning?: FilenameWarning;
  onConfirm?: () => void;
  onCancel?: () => void;
  fileName?: string;
}) {
  const onConfirm = opts?.onConfirm ?? vi.fn();
  const onCancel = opts?.onCancel ?? vi.fn();
  render(
    <WrongBatchConfirmModal
      open={opts?.open ?? true}
      batchLabel="April 2026 — Ambetter"
      fileLabel="EDE Archived Not Enrolled"
      file={makeFile(opts?.fileName ?? 'ede_2026-04.csv')}
      warning={opts?.warning ?? { kind: 'none' }}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  );
  return { onConfirm, onCancel };
}

describe('WrongBatchConfirmModal (#122)', () => {
  it('renders destination batch, slot, file name, and file size', () => {
    setup();
    expect(screen.getByText(/Confirm upload destination/i)).toBeInTheDocument();
    expect(screen.getByText('April 2026 — Ambetter')).toBeInTheDocument();
    expect(screen.getByText('EDE Archived Not Enrolled')).toBeInTheDocument();
    expect(screen.getByText('ede_2026-04.csv')).toBeInTheDocument();
    expect(screen.getByText(/1\.0 KB|1024 B/)).toBeInTheDocument();
  });

  it('does not render when closed and never invokes confirm/cancel', () => {
    const { onConfirm, onCancel } = setup({ open: false });
    expect(screen.queryByText(/Confirm upload destination/i)).not.toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('Cancel button calls onCancel and not onConfirm', () => {
    const { onConfirm, onCancel } = setup();
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('Confirm Upload button calls onConfirm and not onCancel', () => {
    const { onConfirm, onCancel } = setup();
    fireEvent.click(screen.getByRole('button', { name: /confirm upload/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('Escape key cancels (does not confirm)', () => {
    const { onConfirm, onCancel } = setup();
    fireEvent.keyDown(document.activeElement || document.body, { key: 'Escape', code: 'Escape' });
    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('shows HARD warning styling/copy for EDE month mismatch', () => {
    setup({
      warning: {
        kind: 'hard',
        detectedMonth: '2026-03',
        message: 'Filename appears to be for March 2026, but destination batch is April 2026. Verify before uploading.',
      },
    });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/March 2026/);
    expect(alert).toHaveTextContent(/April 2026/);
  });

  it('shows SOFT warning copy for Commission mismatch', () => {
    setup({
      warning: {
        kind: 'soft',
        message: 'Filename suggests May 2026, but destination batch is April 2026. For commission statements the filename date is often the statement issue date, not the service month — verify if unsure.',
      },
    });
    expect(screen.getByRole('alert')).toHaveTextContent(/statement issue date/);
  });

  it('omits warning panel when warning.kind is none', () => {
    setup({ warning: { kind: 'none' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
