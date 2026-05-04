import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useBatchDataVersion, useAllBatchesDataVersion } from '@/hooks/useBatchDataVersion';

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

const POLL = 30; // tight poll so tests stay fast on real timers

describe('useBatchDataVersion / useAllBatchesDataVersion — page-data-version subscription', () => {
  afterEach(() => {
    mockResponse = { data: null, error: null };
    mockListResponse = { data: [], error: null };
  });

  it('emits an initial token without firing onChange (baseline = no transition)', async () => {
    mockResponse = { data: { last_full_rebuild_at: 't1', last_rebuild_logic_version: 'v1' }, error: null };
    const onChange = vi.fn();
    const { result } = renderHook(() => useBatchDataVersion('batch-A', onChange, POLL));
    await waitFor(() => expect(result.current).toBe('t1|v1'));
    // Allow several polls — onChange must STILL not fire because the state
    // hasn't transitioned away from baseline.
    await new Promise(r => setTimeout(r, POLL * 3));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('fires onChange when the active batch stamp transitions', async () => {
    mockResponse = { data: { last_full_rebuild_at: 't1', last_rebuild_logic_version: 'v1' }, error: null };
    const onChange = vi.fn();
    const { result } = renderHook(() => useBatchDataVersion('batch-A', onChange, POLL));
    await waitFor(() => expect(result.current).toBe('t1|v1'));

    mockResponse = { data: { last_full_rebuild_at: 't2', last_rebuild_logic_version: 'v1' }, error: null };
    await waitFor(() => expect(result.current).toBe('t2|v1'));
    expect(onChange).toHaveBeenCalledWith('t2|v1', 't1|v1');
  });

  it('returns a referentially stable token when no transition occurred', async () => {
    mockResponse = { data: { last_full_rebuild_at: 't1', last_rebuild_logic_version: 'v1' }, error: null };
    const { result } = renderHook(() => useBatchDataVersion('batch-A', undefined, POLL));
    await waitFor(() => expect(result.current).toBe('t1|v1'));
    const first = result.current;
    // Several polls with no upstream change — token must remain identical.
    await new Promise(r => setTimeout(r, POLL * 4));
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
    const { result } = renderHook(() => useAllBatchesDataVersion(POLL));
    await waitFor(() => expect(result.current).not.toBeNull());
    const initial = result.current;

    // Rebuild on B only — fleet token MUST shift.
    mockListResponse = {
      data: [
        { id: 'A', last_full_rebuild_at: 't1', last_rebuild_logic_version: 'v1' },
        { id: 'B', last_full_rebuild_at: 't2', last_rebuild_logic_version: 'v1' },
      ],
      error: null,
    };
    await waitFor(() => expect(result.current).not.toBe(initial));
  });
});
