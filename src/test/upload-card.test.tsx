import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { UploadCard } from '@/components/UploadCard';
import type { FilenameWarning } from '@/lib/filenameDateHeuristic';

function setup(props: Partial<React.ComponentProps<typeof UploadCard>> = {}) {
  const onUpload = props.onUpload ?? vi.fn();
  render(
    <UploadCard
      label="EDE Summary"
      uploadedFileName={null}
      onUpload={onUpload}
      {...props}
    />,
  );
  return { onUpload };
}

describe('UploadCard #127 — last-uploaded display', () => {
  it('empty slot renders "No file uploaded" affordance', () => {
    setup({ uploadedFileName: null });
    expect(screen.getByTestId('upload-tile-empty')).toBeInTheDocument();
    expect(screen.getByText(/No file uploaded/i)).toBeInTheDocument();
    expect(screen.queryByTestId('upload-tile-filename')).not.toBeInTheDocument();
    expect(screen.queryByTestId('upload-tile-rowcount')).not.toBeInTheDocument();
  });

  it('populated tile shows filename, timestamp, and row count', () => {
    setup({
      uploadedFileName: 'ede_2026-04.csv',
      lastUploadedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      rowCount: 1234,
    });
    expect(screen.getByTestId('upload-tile-filename')).toHaveTextContent('ede_2026-04.csv');
    expect(screen.getByTestId('upload-tile-timestamp')).toHaveTextContent(/Uploaded\s+5m ago/);
    expect(screen.getByTestId('upload-tile-rowcount')).toHaveTextContent('1,234 rows');
  });

  it('row count uses singular "row" for 1', () => {
    setup({
      uploadedFileName: 'a.csv',
      lastUploadedAt: new Date().toISOString(),
      rowCount: 1,
    });
    expect(screen.getByTestId('upload-tile-rowcount')).toHaveTextContent('1 row');
  });

  it('renders HARD warning (EDE mismatch) using semantic warning tokens', () => {
    const warning: FilenameWarning = {
      kind: 'hard',
      detectedMonth: '2026-03',
      message: 'Filename appears to be for March 2026, but destination batch is April 2026. Verify before uploading.',
    };
    setup({
      uploadedFileName: 'ede_2026-03.csv',
      lastUploadedAt: new Date().toISOString(),
      rowCount: 10,
      warning,
    });
    const w = screen.getByTestId('upload-tile-warning');
    expect(w).toHaveAttribute('data-warning-kind', 'hard');
    expect(w).toHaveTextContent(/March 2026/);
    expect(w).toHaveTextContent(/April 2026/);
    expect(w.className).toMatch(/warning/);
  });

  it('renders SOFT warning (Commission mismatch) using semantic info tokens', () => {
    const warning: FilenameWarning = {
      kind: 'soft',
      message: 'Filename suggests May 2026, but destination batch is April 2026. For commission statements the filename date is often the statement issue date, not the service month — verify if unsure.',
    };
    setup({
      uploadedFileName: 'coverall_2026-05.csv',
      lastUploadedAt: new Date().toISOString(),
      rowCount: 42,
      warning,
    });
    const w = screen.getByTestId('upload-tile-warning');
    expect(w).toHaveAttribute('data-warning-kind', 'soft');
    expect(w).toHaveTextContent(/statement issue date/);
    expect(w.className).toMatch(/info/);
  });

  it('omits warning panel when warning.kind is none', () => {
    setup({
      uploadedFileName: 'ede_2026-04.csv',
      lastUploadedAt: new Date().toISOString(),
      rowCount: 5,
      warning: { kind: 'none' },
    });
    expect(screen.queryByTestId('upload-tile-warning')).not.toBeInTheDocument();
  });

  it('omits warning panel when warning is undefined', () => {
    setup({
      uploadedFileName: 'ede_2026-04.csv',
      lastUploadedAt: new Date().toISOString(),
      rowCount: 5,
    });
    expect(screen.queryByTestId('upload-tile-warning')).not.toBeInTheDocument();
  });

  it('long filename truncates visually but full name stays in DOM (and tooltip)', () => {
    const longName = 'ede_archived_not_enrolled_full_export_2026-04-15_v3_final_FINAL.csv';
    setup({
      uploadedFileName: longName,
      lastUploadedAt: new Date().toISOString(),
      rowCount: 99,
    });
    const node = screen.getByTestId('upload-tile-filename');
    // Full filename remains in DOM (truncation is purely visual via CSS).
    expect(node).toHaveTextContent(longName);
    expect(node.className).toMatch(/truncate/);
    expect(node.className).toMatch(/max-w-/);
  });

  it('processing state hides filename/timestamp/warning and shows spinner', () => {
    setup({
      uploadedFileName: 'ede_2026-04.csv',
      lastUploadedAt: new Date().toISOString(),
      rowCount: 5,
      isUploading: true,
      warning: { kind: 'hard', message: 'mismatch' },
    });
    expect(screen.getByText(/Processing/i)).toBeInTheDocument();
    expect(screen.queryByTestId('upload-tile-filename')).not.toBeInTheDocument();
    expect(screen.queryByTestId('upload-tile-warning')).not.toBeInTheDocument();
  });
});
