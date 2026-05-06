/**
 * #124 — useReportRunner state-machine tests.
 *
 * Covers all five required states (idle / loading / error / empty / ready),
 * the stale-filter flag (filters changed after a run), the single-flight
 * guard, and the "ranFilters snapshot" contract that download/export logic
 * depends on.
 */

import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useReportRunner } from '@/hooks/useReportRunner';

describe('useReportRunner', () => {
  it('starts in idle with no result, no error, not stale', () => {
    const { result } = renderHook(() =>
      useReportRunner({ scope: 'A' }, async () => ['row']),
    );
    expect(result.current.status).toBe('idle');
    expect(result.current.result).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.ranFilters).toBeNull();
    expect(result.current.stale).toBe(false);
  });

  it('idle → loading → ready with rows', async () => {
    const { result } = renderHook(() =>
      useReportRunner({ scope: 'A' }, async () => ['r1', 'r2']),
    );
    await act(async () => { await result.current.run(); });
    expect(result.current.status).toBe('ready');
    expect(result.current.result).toEqual(['r1', 'r2']);
    expect(result.current.ranFilters).toEqual({ scope: 'A' });
    expect(result.current.error).toBeNull();
  });

  it('zero rows → empty (NOT ready, NOT idle — explicit empty state)', async () => {
    const { result } = renderHook(() =>
      useReportRunner({ scope: 'A' }, async () => []),
    );
    await act(async () => { await result.current.run(); });
    expect(result.current.status).toBe('empty');
    expect(result.current.result).toEqual([]);
  });

  it('runner throws → error state, error message preserved, NOT blank', async () => {
    const { result } = renderHook(() =>
      useReportRunner({ scope: 'A' }, async () => { throw new Error('boom'); }),
    );
    await act(async () => { await result.current.run(); });
    expect(result.current.status).toBe('error');
    expect(result.current.error?.message).toBe('boom');
    // ranFilters still captured so the UI can show "failed for these filters"
    expect(result.current.ranFilters).toEqual({ scope: 'A' });
  });

  it('stale = true when filters change after a successful run', async () => {
    let filters = { scope: 'A' };
    const { result, rerender } = renderHook(
      ({ f }: { f: { scope: string } }) =>
        useReportRunner(f, async () => ['row']),
      { initialProps: { f: filters } },
    );
    await act(async () => { await result.current.run(); });
    expect(result.current.stale).toBe(false);
    filters = { scope: 'B' };
    rerender({ f: filters });
    expect(result.current.stale).toBe(true);
    // Old result still visible (download contract).
    expect(result.current.result).toEqual(['row']);
    expect(result.current.ranFilters).toEqual({ scope: 'A' });
  });

  it('re-running with new filters clears stale and refreshes the snapshot', async () => {
    let filters = { scope: 'A' };
    const runner = vi.fn(async (f: { scope: string }) => [`row-${f.scope}`]);
    const { result, rerender } = renderHook(
      ({ f }: { f: { scope: string } }) => useReportRunner(f, runner),
      { initialProps: { f: filters } },
    );
    await act(async () => { await result.current.run(); });
    filters = { scope: 'B' };
    rerender({ f: filters });
    expect(result.current.stale).toBe(true);
    await act(async () => { await result.current.run(); });
    expect(result.current.stale).toBe(false);
    expect(result.current.ranFilters).toEqual({ scope: 'B' });
    expect(result.current.result).toEqual(['row-B']);
  });

  it('stale is false during loading even if filters drift mid-run', async () => {
    let filters = { scope: 'A' };
    let resolve!: (rows: string[]) => void;
    const runner = vi.fn(
      () => new Promise<string[]>((r) => { resolve = r; }),
    );
    const { result, rerender } = renderHook(
      ({ f }: { f: { scope: string } }) => useReportRunner(f, runner),
      { initialProps: { f: filters } },
    );
    act(() => { void result.current.run(); });
    expect(result.current.status).toBe('loading');
    filters = { scope: 'B' };
    rerender({ f: filters });
    // While loading, the on-screen "result" doesn't exist yet, so stale
    // must not flap. The new filter snapshot will be captured on completion.
    expect(result.current.stale).toBe(false);
    await act(async () => { resolve(['row']); });
    await waitFor(() => expect(result.current.status).not.toBe('loading'));
  });

  it('single-flight: a second run() while loading is dropped', async () => {
    const runner = vi.fn(async () => ['row']);
    const { result } = renderHook(() => useReportRunner({ scope: 'A' }, runner));
    await act(async () => {
      // Fire two in quick succession in the same act tick.
      await Promise.all([result.current.run(), result.current.run()]);
    });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('ready');
  });

  it('successful run after a failed run clears the error', async () => {
    let shouldFail = true;
    const runner = vi.fn(async () => {
      if (shouldFail) throw new Error('fail-1');
      return ['ok'];
    });
    const { result } = renderHook(() => useReportRunner({ scope: 'A' }, runner));
    await act(async () => { await result.current.run(); });
    expect(result.current.status).toBe('error');
    expect(result.current.error?.message).toBe('fail-1');
    shouldFail = false;
    await act(async () => { await result.current.run(); });
    expect(result.current.status).toBe('ready');
    expect(result.current.error).toBeNull();
  });

  it('isEmpty option: custom predicate routes structured results to empty state', async () => {
    const { result } = renderHook(() =>
      useReportRunner<{ scope: string }, { rows: string[] }>(
        { scope: 'A' },
        async () => ({ rows: [] }),
        { isEmpty: (r) => r.rows.length === 0 },
      ),
    );
    await act(async () => { await result.current.run(); });
    expect(result.current.status).toBe('empty');
  });

  it('reset() returns to idle', async () => {
    const { result } = renderHook(() =>
      useReportRunner({ scope: 'A' }, async () => ['row']),
    );
    await act(async () => { await result.current.run(); });
    expect(result.current.status).toBe('ready');
    act(() => { result.current.reset(); });
    expect(result.current.status).toBe('idle');
    expect(result.current.result).toBeNull();
    expect(result.current.ranFilters).toBeNull();
  });

  it('shallow-equal filter objects do NOT flap stale (recompute-but-equal safe)', async () => {
    let filters = { scope: 'A', batchId: 'b1' };
    const { result, rerender } = renderHook(
      ({ f }: { f: { scope: string; batchId: string } }) =>
        useReportRunner(f, async () => ['row']),
      { initialProps: { f: filters } },
    );
    await act(async () => { await result.current.run(); });
    expect(result.current.stale).toBe(false);
    // New object, same values — must not become stale.
    filters = { scope: 'A', batchId: 'b1' };
    rerender({ f: filters });
    expect(result.current.stale).toBe(false);
  });
});
