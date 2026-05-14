/**
 * Bundle 13c — Cross-batch clearing overlay hook.
 *
 * Bulk-loads `cross_batch_clearings` (active + non-superseded) once via
 * keyset pagination and exposes a {@link ClearingOverlayMap}. Reloads on:
 * mount, enabled flip false→true, explicit reload(), and the
 * `crossBatchClearings:rebuilt` window event.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import {
  buildClearingOverlayMap,
  EMPTY_CLEARING_OVERLAY_MAP,
  type ClearingOverlayMap,
} from '@/lib/canonical/crossBatchOverlay';

const CLEARING_SELECT = [
  'id', 'policy_identity_key', 'target_service_month', 'clearing_state',
  'expected_amount', 'actual_positive_amount', 'actual_reversal_amount',
  'actual_net_amount', 'remainder_owed', 'unpaid_batch_ids', 'payment_batch_ids',
  'reversed_at_statement_month', 'first_full_clear_statement_month',
  'evaluated_at', 'run_id', 'manual_review_reason',
].join(', ');

const PAGE_SIZE = 500;
const REBUILD_EVENT = 'crossBatchClearings:rebuilt';

export interface UseCrossBatchOverlayResult {
  overlay: ClearingOverlayMap;
  loading: boolean;
  error: Error | null;
  reload: () => Promise<void>;
}

export function useCrossBatchOverlay(opts?: { enabled?: boolean }): UseCrossBatchOverlayResult {
  const enabled = opts?.enabled !== false;
  const [overlay, setOverlay] = useState<ClearingOverlayMap>(EMPTY_CLEARING_OVERLAY_MAP);
  const [loading, setLoading] = useState<boolean>(enabled);
  const [error, setError] = useState<Error | null>(null);
  const isMountedRef = useRef(true);
  const genRef = useRef(0);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  const load = useCallback(async () => {
    genRef.current += 1;
    const myGen = genRef.current;
    setLoading(true);
    setError(null);
    try {
      let lastId: string | null = null;
      const rows: any[] = [];
      // eslint-disable-next-line no-constant-condition
      while (true) {
        let query = (supabase as any)
          .from('cross_batch_clearings')
          .select(CLEARING_SELECT)
          .eq('staging_status', 'active')
          .is('superseded_at', null)
          .order('id', { ascending: true })
          .limit(PAGE_SIZE);
        if (lastId) query = query.gt('id', lastId);
        const { data, error: qErr } = await query;
        if (qErr) throw qErr;
        if (!data || data.length === 0) break;
        rows.push(...data);
        if (data.length < PAGE_SIZE) break;
        lastId = data[data.length - 1].id;
      }
      const map = buildClearingOverlayMap(rows);
      if (!isMountedRef.current || myGen !== genRef.current) return;
      setOverlay(map);
      setLoading(false);
    } catch (err) {
      if (!isMountedRef.current || myGen !== genRef.current) return;
      setError(err instanceof Error ? err : new Error(String(err)));
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setOverlay(EMPTY_CLEARING_OVERLAY_MAP);
      setLoading(false);
      setError(null);
      return;
    }
    void load();
  }, [enabled, load]);

  useEffect(() => {
    if (!enabled) return;
    const handler = () => { void load(); };
    window.addEventListener(REBUILD_EVENT, handler);
    return () => { window.removeEventListener(REBUILD_EVENT, handler); };
  }, [enabled, load]);

  return { overlay, loading, error, reload: load };
}
