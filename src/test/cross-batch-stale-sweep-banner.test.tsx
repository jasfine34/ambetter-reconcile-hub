/**
 * Bundle 13c foundation patch — stale-sweep banner null handling.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { CrossBatchStaleSweepBanner } from '@/components/CrossBatchStaleSweepBanner';

let overlayLastEvaluatedAt: string | null = null;
const selectMock = vi.fn();

vi.mock('@/hooks/useCrossBatchOverlay', () => ({
  useCrossBatchOverlay: () => ({
    overlay: {
      byGrain: new Map(),
      totalActiveCount: 0,
      lastEvaluatedAt: overlayLastEvaluatedAt,
    },
    loading: false,
    error: null,
    reload: vi.fn(),
  }),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: () => ({ select: selectMock }),
  },
}));

function setRebuildRows(rows: Array<{ last_full_rebuild_at: string | null }>) {
  selectMock.mockResolvedValue({ data: rows, error: null });
}

beforeEach(() => {
  overlayLastEvaluatedAt = null;
  selectMock.mockReset();
  try { window.sessionStorage.clear(); } catch { /* ignore */ }
});

describe('CrossBatchStaleSweepBanner', () => {
  it('hides when both overlay and maxRebuild are null', async () => {
    overlayLastEvaluatedAt = null;
    setRebuildRows([]);
    render(<CrossBatchStaleSweepBanner />);
    await waitFor(() => expect(selectMock).toHaveBeenCalled());
    expect(screen.queryByTestId('cross-batch-stale-banner')).toBeNull();
  });

  it('hides when lastEvaluatedAt is non-null but maxRebuild is null (the bug fix)', async () => {
    overlayLastEvaluatedAt = '2026-05-14T09:00:00Z';
    setRebuildRows([{ last_full_rebuild_at: null }]);
    render(<CrossBatchStaleSweepBanner />);
    await waitFor(() => expect(selectMock).toHaveBeenCalled());
    expect(screen.queryByTestId('cross-batch-stale-banner')).toBeNull();
  });

  it('shows never-run banner when lastEvaluatedAt is null but maxRebuild is non-null', async () => {
    overlayLastEvaluatedAt = null;
    setRebuildRows([{ last_full_rebuild_at: '2026-05-14T10:00:00Z' }]);
    render(<CrossBatchStaleSweepBanner />);
    const banner = await screen.findByTestId('cross-batch-stale-banner');
    expect(banner.textContent).toMatch(/have not been run yet/i);
  });

  it('shows stale banner when maxRebuild > lastEvaluatedAt', async () => {
    overlayLastEvaluatedAt = '2026-05-14T09:00:00Z';
    setRebuildRows([{ last_full_rebuild_at: '2026-05-14T10:00:00Z' }]);
    render(<CrossBatchStaleSweepBanner />);
    const banner = await screen.findByTestId('cross-batch-stale-banner');
    expect(banner.textContent).toMatch(/may be stale/i);
  });

  it('hides when maxRebuild <= lastEvaluatedAt (fresh)', async () => {
    overlayLastEvaluatedAt = '2026-05-14T10:00:00Z';
    setRebuildRows([{ last_full_rebuild_at: '2026-05-14T09:00:00Z' }]);
    render(<CrossBatchStaleSweepBanner />);
    await waitFor(() => expect(selectMock).toHaveBeenCalled());
    expect(screen.queryByTestId('cross-batch-stale-banner')).toBeNull();
  });

  it('dismiss persists for the session', async () => {
    overlayLastEvaluatedAt = null;
    setRebuildRows([{ last_full_rebuild_at: '2026-05-14T10:00:00Z' }]);
    const { unmount } = render(<CrossBatchStaleSweepBanner />);
    await screen.findByTestId('cross-batch-stale-banner');
    fireEvent.click(screen.getByTestId('cross-batch-stale-dismiss'));
    expect(screen.queryByTestId('cross-batch-stale-banner')).toBeNull();
    unmount();
    render(<CrossBatchStaleSweepBanner />);
    await waitFor(() => expect(selectMock).toHaveBeenCalled());
    expect(screen.queryByTestId('cross-batch-stale-banner')).toBeNull();
  });

  it('excludes null last_full_rebuild_at rows from max computation', async () => {
    overlayLastEvaluatedAt = '2026-05-14T09:00:00Z';
    setRebuildRows([
      { last_full_rebuild_at: null },
      { last_full_rebuild_at: '2026-05-14T10:00:00Z' },
    ]);
    render(<CrossBatchStaleSweepBanner />);
    const banner = await screen.findByTestId('cross-batch-stale-banner');
    // 10:00 > 09:00 → stale (proves the non-null row was used as max).
    expect(banner.textContent).toMatch(/may be stale/i);
  });
});
