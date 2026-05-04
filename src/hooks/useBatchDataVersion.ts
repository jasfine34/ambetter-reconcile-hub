import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';

/**
 * useBatchDataVersion
 *
 * Polls `upload_batches` every `pollMs` for the active batch row and exposes a
 * `dataVersion` string derived from `last_full_rebuild_at` + `last_rebuild_logic_version`.
 *
 * When the version changes (e.g. after a Rebuild Entire Batch or one step of a
 * Rebuild All Batches sequence), the optional `onChange` callback fires so
 * downstream caches/state can invalidate and refetch — no F5 required.
 *
 * Why polling instead of Realtime: Realtime is not enabled on `upload_batches`
 * in this project; a 2s poll on a single-row PK lookup is cheap and reliable
 * across the rebuild-all flow which produces N sequential per-batch updates.
 *
 * Note: the very first observed version does NOT trigger onChange — only true
 * transitions do. This avoids spurious refreshes on mount.
 */
export function useBatchDataVersion(
  batchId: string | null,
  onChange?: (next: string, prev: string | null) => void,
  pollMs: number = 2000
) {
  const [dataVersion, setDataVersion] = useState<string | null>(null);
  const lastSeenRef = useRef<string | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    // Reset on batch switch — the new batch's first observed value is its
    // baseline, not a "change".
    lastSeenRef.current = null;
    setDataVersion(null);

    if (!batchId) return;

    let cancelled = false;

    const tick = async () => {
      const { data, error } = await supabase
        .from('upload_batches')
        .select('last_full_rebuild_at,last_rebuild_logic_version')
        .eq('id', batchId)
        .maybeSingle();
      if (cancelled || error || !data) return;
      const next = `${data.last_full_rebuild_at ?? ''}|${data.last_rebuild_logic_version ?? ''}`;
      const prev = lastSeenRef.current;
      if (prev === null) {
        lastSeenRef.current = next;
        setDataVersion(next);
        return;
      }
      if (next !== prev) {
        lastSeenRef.current = next;
        setDataVersion(next);
        onChangeRef.current?.(next, prev);
      }
    };

    // Run immediately, then on interval.
    tick();
    const id = window.setInterval(tick, pollMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [batchId, pollMs]);

  return dataVersion;
}

/**
 * useAllBatchesDataVersion
 *
 * Same idea as useBatchDataVersion, but watches the MAX(last_full_rebuild_at)
 * + concatenated logic-version fingerprint across ALL upload_batches rows.
 * Use this on screens that aggregate across batches (e.g. Member Timeline
 * with batchScope='all') where a rebuild on ANY batch should invalidate the
 * page's cached fetch — not just the currently selected one.
 *
 * Returned token is referentially stable until a real transition is detected,
 * so it's safe to drop into a useEffect dependency array without causing
 * re-fetch loops.
 */
export function useAllBatchesDataVersion(pollMs: number = 2000) {
  const [dataVersion, setDataVersion] = useState<string | null>(null);
  const lastSeenRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const tick = async () => {
      const { data, error } = await supabase
        .from('upload_batches')
        .select('id,last_full_rebuild_at,last_rebuild_logic_version')
        .order('id', { ascending: true });
      if (cancelled || error || !data) return;
      // Fingerprint the entire fleet — any per-batch stamp change shifts it.
      const next = data
        .map((r: any) => `${r.id}:${r.last_full_rebuild_at ?? ''}:${r.last_rebuild_logic_version ?? ''}`)
        .join('|');
      const prev = lastSeenRef.current;
      if (prev === null) {
        lastSeenRef.current = next;
        setDataVersion(next);
        return;
      }
      if (next !== prev) {
        lastSeenRef.current = next;
        setDataVersion(next);
      }
    };

    tick();
    const id = window.setInterval(tick, pollMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [pollMs]);

  return dataVersion;
}

