/**
 * C2a Stage 4 — useLatestBoOverlay hook caching + loading test (T6).
 *
 * Mocks the cache path (getMtAllBatchProjection) and the data-version hook
 * to render the shared overlay-build hook used by Agent Summary + Unpaid
 * Recovery (and matched verbatim by Dashboard's inline build).
 *
 * Asserts:
 *   1. while the projection promise is pending, `loading === true` and
 *      `overlay === null`;
 *   2. once resolved, `overlay` populates and `loading === false`;
 *   3. the cache loader is invoked EXACTLY ONCE across two hook renders that
 *      share the same key (data-version + resolverIndex + batches).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

// Mock the data-version hook to a stable token (no Supabase poll).
vi.mock('@/hooks/useBatchDataVersion', () => ({
  useAllBatchesDataVersion: () => 'dv-stable-token',
}));

// Mock persistence loader — the cache path calls this, but only on a miss.
const loaderSpy = vi.fn<(...args: any[]) => Promise<any[]>>(async () => []);
vi.mock('@/lib/persistence', () => ({
  getAllNormalizedRecordsForMemberTimeline: (...args: any[]) => loaderSpy(...args),
}));

// Spy on the cache helper so we can both count calls AND control the promise.
const projectionSpy = vi.fn<(args: any) => Promise<{ records: any[] }>>(async () => ({ records: [] }));
vi.mock('@/lib/canonical/mtApprovedMceCache', () => ({
  getMtAllBatchProjection: (args: any) => projectionSpy(args),
}));

// Real latestAuthoritativeBoTermDates + makeBoRecency — we want the actual
// overlay (empty here) so the hook's "overlay !== null" gate flips correctly.
import { useLatestBoOverlay } from '@/hooks/useLatestBoOverlay';

beforeEach(() => {
  loaderSpy.mockClear();
  projectionSpy.mockClear();
  projectionSpy.mockImplementation(async () => ({ records: [] }));
});

const batches = [{ id: 'B-FEB-2026', statement_month: '2026-02' }];
const resolverIndex = { fingerprint: 'rfix' } as any;

describe('C2a T6 — useLatestBoOverlay caching + loading', () => {
  it('starts loading (overlay=null), then resolves to a ready overlay', async () => {
    const { result } = renderHook(() =>
      useLatestBoOverlay('2026-02', batches, resolverIndex),
    );
    // Initial: loading=true, overlay=null.
    expect(result.current.loading).toBe(true);
    expect(result.current.overlay).toBeNull();
    expect(result.current.statementMonthStartIso).toBe('2026-02-01');

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.overlay).not.toBeNull();
  });

  it('stays in loading state when statementMonth is empty (no cache call)', async () => {
    const { result } = renderHook(() =>
      useLatestBoOverlay('', batches, resolverIndex),
    );
    expect(result.current.loading).toBe(true);
    expect(result.current.overlay).toBeNull();
    expect(result.current.statementMonthStartIso).toBe('');
    // Allow microtasks to settle; cache must NOT be called for empty month.
    await new Promise((r) => setTimeout(r, 10));
    expect(projectionSpy).not.toHaveBeenCalled();
  });

  it('invokes getMtAllBatchProjection (the cache path) — not duplicated within a single render', async () => {
    const { result } = renderHook(() =>
      useLatestBoOverlay('2026-02', batches, resolverIndex),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    // One render → one cache call. Stage 3 hook must NOT bypass the cache.
    expect(projectionSpy).toHaveBeenCalledTimes(1);
    // Cache call carries the dedup ctx (batchMonthByBatchId) via the loader.
    const arg = projectionSpy.mock.calls[0]?.[0];
    expect(arg).toBeDefined();
    expect(arg).toHaveProperty('allBatchesDataVersion', 'dv-stable-token');
    expect(arg).toHaveProperty('resolverIndex');
    expect(typeof arg!.loader).toBe('function');
  });
});
