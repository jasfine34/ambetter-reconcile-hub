import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useBatchDataVersion, useAllBatchesDataVersion } from '@/hooks/useBatchDataVersion';

// Mock the supabase client. We swap the response shape per-test so we can
// simulate stamp transitions without standing up a real DB.
let mockResponse: any = { data: null, error: null };
let mockListResponse: any = { data: [], error: null };

vi.mock('@/integrations/supabase/client', () => {
  return {
    supabase: {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => mockResponse,
          }),
          order: async () => mockListResponse,
        }),
      }),
    },
  };
});

describe('useBatchDataVersion / useAllBatchesDataVersion — page-data-version subscription', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    mockResponse = { data: null, error: null };
    mockListResponse = { data: [], error: null };
  });

  it('emits an initial token without firing onChange (baseline = no transition)', async () => {
    mockResponse = { data: { last_full_rebuild_at: 't1', last_rebuild_logic_version: 'v1' }, error: null };
    const onChange = vi.fn();
    const { result } = renderHook(() => useBatchDataVersion('batch-A', onChange, 1000));
    await waitFor(() => expect(result.current).toBe('t1|v1'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('fires onChange when the active batch stamp transitions', async () => {
    mockResponse = { data: { last_full_rebuild_at: 't1', last_rebuild_logic_version: 'v1' }, error: null };
    const onChange = vi.fn();
    const { result } = renderHook(() => useBatchDataVersion('batch-A', onChange, 1000));
    await waitFor(() => expect(result.current).toBe('t1|v1'));

    // Simulate a stamp update — the next poll picks it up.
    mockResponse = { data: { last_full_rebuild_at: 't2', last_rebuild_logic_version: 'v1' }, error: null };
    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });

    await waitFor(() => expect(result.current).toBe('t2|v1'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('t2|v1', 't1|v1');
  });

  it('returns a referentially stable token when no transition occurred', async () => {
    mockResponse = { data: { last_full_rebuild_at: 't1', last_rebuild_logic_version: 'v1' }, error: null };
    const { result } = renderHook(() => useBatchDataVersion('batch-A', undefined, 1000));
    await waitFor(() => expect(result.current).toBe('t1|v1'));
    const first = result.current;
    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    expect(result.current).toBe(first);
  });

  it('useAllBatchesDataVersion fingerprints the entire fleet — transition on ANY batch shifts token', async () => {
    mockListResponse = {
      data: [
        { id: 'A', last_full_rebuild_at: 't1', last_rebuild_logic_version: 'v1' },
        { id: 'B', last_full_rebuild_at: 't1', last_rebuild_logic_version: 'v1' },
      ],
      error: null,
    };
    const { result } = renderHook(() => useAllBatchesDataVersion(1000));
    await waitFor(() => expect(result.current).not.toBeNull());
    const initial = result.current;

    // Simulate a rebuild on batch B only — token MUST change.
    mockListResponse = {
      data: [
        { id: 'A', last_full_rebuild_at: 't1', last_rebuild_logic_version: 'v1' },
        { id: 'B', last_full_rebuild_at: 't2', last_rebuild_logic_version: 'v1' },
      ],
      error: null,
    };
    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    await waitFor(() => expect(result.current).not.toBe(initial));
  });
});
