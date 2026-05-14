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

export type BatchSelectionSource =
  | 'init'
  | 'auto-select'
  | 'create'
  | 'delete'
  | 'user-dropdown'
  | 'mce-page-picker';

const KNOWN_SOURCES: ReadonlySet<BatchSelectionSource> = new Set<BatchSelectionSource>([
  'init', 'auto-select', 'create', 'delete', 'user-dropdown', 'mce-page-picker',
]);

interface BatchContextType {
  batches: any[];
  currentBatchId: string | null;
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
  /**
   * Bundle 12.6 — id of the batch whose reconciled-members data is currently
   * committed in `reconciled`. `null` while no commit yet, while a refresh is
   * in flight, or when the most recent refresh failed. Pages that need to
   * gate work on "reconciled is fresh for the active batch" should compare
   * `reconciledLoadedForBatchId === currentBatchId`.
   */
  reconciledLoadedForBatchId: string | null;
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
  reconciledLoadedForBatchId: null,
});

export const useBatch = () => useContext(BatchContext);

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
  setTimeout(() => { _refreshBatchesToastActive = false; }, 5000);
  return t;
}

export function BatchProvider({ children }: { children: ReactNode }) {
  const [batches, setBatches] = useState<any[]>([]);
  const [currentBatchIdState, _setCurrentBatchIdState] = useState<string | null>(null);
  const currentBatchIdRef = useRef<string | null>(null);
  currentBatchIdRef.current = currentBatchIdState;

  const setCurrentBatchId = useCallback((id: string | null, source?: BatchSelectionSource) => {
    const prev = currentBatchIdRef.current;
    if (prev === id) {
      if (source && !KNOWN_SOURCES.has(source)) {
        console.warn('[batch-state] setCurrentBatchId no-op with unknown source', { prev, next: id, source });
      }
      return;
    }
    if (!source || !KNOWN_SOURCES.has(source)) {
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
  const [reconciledLoadedForBatchId, setReconciledLoadedForBatchId] = useState<string | null>(null);

  // Bundle 12.6 — generation guard. Increments on every refreshReconciled
  // invocation AND on every currentBatchId change. Stale resolves (success
  // or failure) drop silently.
  const refreshGenRef = useRef(0);
  const batchesRef = useRef<any[]>([]);
  batchesRef.current = batches;
  const resolverIndexRef = useRef<ResolverIndex | null>(null);
  resolverIndexRef.current = resolverIndex;

  const refreshResolverIndex = useCallback(async () => {
    try {
      const idx = await loadResolverIndex(true);
      setResolverIndex(idx);
    } catch {
      setResolverIndex(null);
    }
  }, []);

  const refreshBatches = useCallback(async () => {
    const data = await getBatches();
    setBatches(data || []);
    if (!currentBatchIdRef.current && data && data.length > 0) {
      setCurrentBatchId(data[0].id, 'auto-select');
    }
  }, [setCurrentBatchId]);

  const refreshReconciled = useCallback(async () => {
    const requestedBatchId = currentBatchIdRef.current;
    // Always invalidate readiness at the START of every refresh.
    refreshGenRef.current += 1;
    const myGen = refreshGenRef.current;

    if (!requestedBatchId) {
      setReconciled([]);
      setDebugStats(null);
      setReconciledLoadedForBatchId(null);
      setLoading(false);
      return;
    }

    setReconciledLoadedForBatchId(null);
    setDebugStats(null);
    setLoading(true);

    const isLatest = () =>
      myGen === refreshGenRef.current && currentBatchIdRef.current === requestedBatchId;

    try {
      const data = await getReconciledMembers(requestedBatchId);
      if (!isLatest()) return; // stale; drop silently
      setReconciled(data || []);

      // DebugStats best-effort — failure does NOT invalidate reconciled rows.
      try {
        const normalized = await getNormalizedRecords(requestedBatchId);
        if (!isLatest()) return;
        const currentBatch = batchesRef.current.find((b: any) => b.id === requestedBatchId);
        const reconcileMonth = currentBatch?.statement_month
          ? String(currentBatch.statement_month).substring(0, 7)
          : fallbackReconcileMonth();
        const { debug } = reconcile(normalized as any[], reconcileMonth, resolverIndexRef.current);
        if (!isLatest()) return;
        setDebugStats(debug);
      } catch {
        if (!isLatest()) return;
        setDebugStats(null);
      }

      if (!isLatest()) return;
      setReconciledLoadedForBatchId(requestedBatchId);
      setLoading(false);
    } catch (err) {
      if (!isLatest()) return;
      // leave reconciledLoadedForBatchId=null + debugStats=null; clear loading.
      setLoading(false);
      throw err;
    }
  }, []);

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
    await Promise.all([
      refreshFiles(),
      refreshReconciled().catch(() => { /* swallow — generation guard handles state */ }),
      refreshCounts(),
    ]);
  }, [refreshFiles, refreshReconciled, refreshCounts]);

  useEffect(() => {
    refreshBatches().catch(notifyRefreshBatchesFailed);
    refreshResolverIndex();
  }, []);

  // On batch switch: bump generation immediately so any in-flight refresh
  // for the prior batch drops on resolve, then trigger fresh loads.
  useEffect(() => {
    refreshGenRef.current += 1;
    setReconciledLoadedForBatchId(null);
    refreshAll();
    refreshBatches().catch(notifyRefreshBatchesFailed);
  }, [currentBatchIdState]);

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
      reconciledLoadedForBatchId,
    }}>
      {children}
    </BatchContext.Provider>
  );
}
