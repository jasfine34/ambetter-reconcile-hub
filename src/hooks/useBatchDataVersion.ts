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
