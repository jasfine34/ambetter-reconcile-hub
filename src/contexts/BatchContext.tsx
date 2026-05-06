import { createContext, useContext, useState, useEffect, ReactNode, useCallback, useRef } from 'react';
import { getBatches, getReconciledMembers, getUploadedFiles, getBatchCounts, getNormalizedRecords } from '@/lib/persistence';
import { reconcile, type MatchDebugStats } from '@/lib/reconcile';
import { fallbackReconcileMonth } from '@/lib/dateRange';
import { loadResolverIndex, type ResolverIndex } from '@/lib/resolvedIdentities';
import { useBatchDataVersion } from '@/hooks/useBatchDataVersion';
import { toast } from '@/hooks/use-toast';

interface BatchCounts {
  uploadedFiles: number;
  normalizedRecords: number;
  reconciledMembers: number;
}

/**
 * #126-OBS — Known intentional sources for currentBatchId mutations.
 * Any setter call passing a value NOT in this set leaves a console.warn
 * with previous id, next id, and a stack trace so future unexpected
 * resets are easy to trace. Forensic only — does not alter behavior.
 */
export type BatchSelectionSource =
  | 'init'              // initial null state (constructor-style — never actually called)
  | 'auto-select'       // refreshBatches first-load auto-pick
  | 'create'            // BatchSelector after createBatch success
  | 'delete'            // BatchSelector after deleteBatch success
  | 'user-dropdown'     // user picked from main BatchSelector dropdown
  | 'mce-page-picker';  // user picked from Missing Commission Export in-page selector

const KNOWN_SOURCES: ReadonlySet<BatchSelectionSource> = new Set<BatchSelectionSource>([
  'init', 'auto-select', 'create', 'delete', 'user-dropdown', 'mce-page-picker',
]);

interface BatchContextType {
  batches: any[];
  currentBatchId: string | null;
  /**
   * Set the active batch id. The optional `source` label is forensic only:
   * known labels are silent; unlabeled or unknown writes emit a console
   * warning with previous/next/stack. The state change itself is never
   * blocked or altered.
   */
  setCurrentBatchId: (id: string | null, source?: BatchSelectionSource) => void;
  reconciled: any[];
  uploadedFiles: any[];
  counts: BatchCounts;
  debugStats: MatchDebugStats | null;
  resolverIndex: ResolverIndex | null;
  refreshBatches: () => Promise<void>;
  refreshReconciled: () => Promise<void>;
  refreshFiles: () => Promise<void>;
  refreshAll: () => Promise<void>;
  refreshResolverIndex: () => Promise<void>;
  loading: boolean;
}

const BatchContext = createContext<BatchContextType>({
  batches: [], currentBatchId: null, setCurrentBatchId: () => {},
  reconciled: [], uploadedFiles: [],
  counts: { uploadedFiles: 0, normalizedRecords: 0, reconciledMembers: 0 },
  debugStats: null,
  resolverIndex: null,
  refreshBatches: async () => {},
  refreshReconciled: async () => {}, refreshFiles: async () => {},
  refreshAll: async () => {},
  refreshResolverIndex: async () => {},
  loading: false,
});

export const useBatch = () => useContext(BatchContext);

/**
 * #126-OBS — Single visible-toast guard for refreshBatches failures.
 * The three call sites (mount, batch-switch effect, polling callback) all
 * share one toast at a time so a transient outage doesn't stack N copies.
 */
let _refreshBatchesToastActive = false;
function notifyRefreshBatchesFailed(err: unknown) {
  console.error('[batch-state] refreshBatches failed', err);
  if (_refreshBatchesToastActive) return;
  _refreshBatchesToastActive = true;
  const t = toast({
    title: 'Failed to refresh batch list',
    description: 'Existing selection was preserved. Try again.',
    variant: 'warning' as any,
  });
  // Allow another toast after the user dismisses or after a cooldown.
  setTimeout(() => { _refreshBatchesToastActive = false; }, 5000);
  return t;
}

export function BatchProvider({ children }: { children: ReactNode }) {
  const [batches, setBatches] = useState<any[]>([]);
  const [currentBatchIdState, _setCurrentBatchIdState] = useState<string | null>(null);
  const currentBatchIdRef = useRef<string | null>(null);
  currentBatchIdRef.current = currentBatchIdState;

  // #126-OBS — wrapped setter. Known sources pass a label; unlabeled writes
  // get a forensic console.warn so future unexpected resets leave evidence.
  const setCurrentBatchId = useCallback((id: string | null, source?: BatchSelectionSource) => {
    const prev = currentBatchIdRef.current;
    if (prev === id) {
      // No-op — still log unknown-source attempts so we can see them, but
      // don't trigger a render.
      if (source && !KNOWN_SOURCES.has(source)) {
        console.warn('[batch-state] setCurrentBatchId no-op with unknown source', { prev, next: id, source });
      }
      return;
    }
    if (!source || !KNOWN_SOURCES.has(source)) {
      // Forensic only — capture stack so we can find the caller later.
      const stack = new Error('batch-state forensic trace').stack;
      console.warn('[batch-state] currentBatchId mutated from unknown source', {
        prev, next: id, source: source ?? '(none)', stack,
      });
    }
    _setCurrentBatchIdState(id);
  }, []);

  const [reconciled, setReconciled] = useState<any[]>([]);
  const [uploadedFiles, setUploadedFiles] = useState<any[]>([]);
  const [counts, setCounts] = useState<BatchCounts>({ uploadedFiles: 0, normalizedRecords: 0, reconciledMembers: 0 });
  const [debugStats, setDebugStats] = useState<MatchDebugStats | null>(null);
  const [resolverIndex, setResolverIndex] = useState<ResolverIndex | null>(null);
  const [loading, setLoading] = useState(false);

  const refreshResolverIndex = useCallback(async () => {
    try {
      const idx = await loadResolverIndex(true);
      setResolverIndex(idx);
    } catch {
      setResolverIndex(null);
    }
  }, []);

  const refreshBatches = useCallback(async () => {
    // NOTE: throws on failure. Callers MUST wrap in try/catch and surface
    // the failure via notifyRefreshBatchesFailed — never swallow silently.
    const data = await getBatches();
    setBatches(data || []);
    if (!currentBatchIdRef.current && data && data.length > 0) {
      // Auto-select on first load — labeled so the forensic logger stays quiet.
      setCurrentBatchId(data[0].id, 'auto-select');
    }
  }, [setCurrentBatchId]);

  const refreshReconciled = useCallback(async () => {
    if (!currentBatchIdState) { setReconciled([]); setDebugStats(null); return; }
    setLoading(true);
    try {
      const data = await getReconciledMembers(currentBatchIdState);
      setReconciled(data || []);
      // Compute debug stats from normalized records
      try {
        const normalized = await getNormalizedRecords(currentBatchIdState);
        const currentBatch = batches.find((b: any) => b.id === currentBatchIdState);
        const reconcileMonth = currentBatch?.statement_month
          ? String(currentBatch.statement_month).substring(0, 7)
          : fallbackReconcileMonth();
        const { debug } = reconcile(normalized as any[], reconcileMonth, resolverIndex);
        setDebugStats(debug);
      } catch {
        setDebugStats(null);
      }
    } finally {
      setLoading(false);
    }
  }, [currentBatchIdState, batches, resolverIndex]);

  const refreshFiles = useCallback(async () => {
    if (!currentBatchIdState) { setUploadedFiles([]); return; }
    const data = await getUploadedFiles(currentBatchIdState);
    setUploadedFiles(data || []);
  }, [currentBatchIdState]);

  const refreshCounts = useCallback(async () => {
    if (!currentBatchIdState) {
      setCounts({ uploadedFiles: 0, normalizedRecords: 0, reconciledMembers: 0 });
      return;
    }
    const c = await getBatchCounts(currentBatchIdState);
    setCounts(c);
  }, [currentBatchIdState]);

  const refreshAll = useCallback(async () => {
    await Promise.all([refreshFiles(), refreshReconciled(), refreshCounts()]);
  }, [refreshFiles, refreshReconciled, refreshCounts]);

  // #126-OBS — Mount effect. refreshBatches CAN reject (network/RLS); on
  // failure, surface a toast so operators see "list refresh failed" instead
  // of silently-empty UI. Existing batches/selection are preserved by virtue
  // of refreshBatches throwing BEFORE setBatches is called.
  useEffect(() => {
    refreshBatches().catch(notifyRefreshBatchesFailed);
    refreshResolverIndex();
  }, []);

  // On batch switch: refresh BOTH the per-batch data (files/reconciled/counts)
  // AND the batches list itself so per-batch metadata reflects any background
  // rebuilds. #126-OBS: refreshBatches failure here also gets a visible toast.
  useEffect(() => {
    refreshAll();
    refreshBatches().catch(notifyRefreshBatchesFailed);
  }, [currentBatchIdState]);

  // Auto-refresh when the active batch is rebuilt. #126-OBS: failure inside
  // the polling callback's refreshBatches gets a visible toast.
  useBatchDataVersion(currentBatchIdState, () => {
    refreshBatches().catch(notifyRefreshBatchesFailed);
    refreshAll();
  });

  return (
    <BatchContext.Provider value={{
      batches, currentBatchId: currentBatchIdState, setCurrentBatchId,
      reconciled, uploadedFiles, counts, debugStats,
      resolverIndex,
      refreshBatches, refreshReconciled, refreshFiles, refreshAll,
      refreshResolverIndex,
      loading,
    }}>
      {children}
    </BatchContext.Provider>
  );
}
