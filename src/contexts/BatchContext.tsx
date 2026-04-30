import { createContext, useContext, useState, useEffect, ReactNode, useCallback } from 'react';
import { getBatches, getReconciledMembers, getUploadedFiles, getBatchCounts, getNormalizedRecords } from '@/lib/persistence';
import { reconcile, type MatchDebugStats } from '@/lib/reconcile';
import { fallbackReconcileMonth } from '@/lib/dateRange';
import { loadResolverIndex, type ResolverIndex } from '@/lib/resolvedIdentities';
import { useBatchDataVersion } from '@/hooks/useBatchDataVersion';

interface BatchCounts {
  uploadedFiles: number;
  normalizedRecords: number;
  reconciledMembers: number;
}

interface BatchContextType {
  batches: any[];
  currentBatchId: string | null;
  setCurrentBatchId: (id: string | null) => void;
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

export function BatchProvider({ children }: { children: ReactNode }) {
  const [batches, setBatches] = useState<any[]>([]);
  const [currentBatchId, setCurrentBatchId] = useState<string | null>(null);
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
    const data = await getBatches();
    setBatches(data || []);
    if (!currentBatchId && data && data.length > 0) {
      setCurrentBatchId(data[0].id);
    }
  }, [currentBatchId]);

  const refreshReconciled = useCallback(async () => {
    if (!currentBatchId) { setReconciled([]); setDebugStats(null); return; }
    setLoading(true);
    try {
      const data = await getReconciledMembers(currentBatchId);
      setReconciled(data || []);
      // Compute debug stats from normalized records
      try {
        const normalized = await getNormalizedRecords(currentBatchId);
        const currentBatch = batches.find((b: any) => b.id === currentBatchId);
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
  }, [currentBatchId, batches, resolverIndex]);

  const refreshFiles = useCallback(async () => {
    if (!currentBatchId) { setUploadedFiles([]); return; }
    const data = await getUploadedFiles(currentBatchId);
    setUploadedFiles(data || []);
  }, [currentBatchId]);

  const refreshCounts = useCallback(async () => {
    if (!currentBatchId) {
      setCounts({ uploadedFiles: 0, normalizedRecords: 0, reconciledMembers: 0 });
      return;
    }
    const c = await getBatchCounts(currentBatchId);
    setCounts(c);
  }, [currentBatchId]);

  const refreshAll = useCallback(async () => {
    await Promise.all([refreshFiles(), refreshReconciled(), refreshCounts()]);
  }, [refreshFiles, refreshReconciled, refreshCounts]);

  useEffect(() => { refreshBatches(); refreshResolverIndex(); }, []);
  // On batch switch: refresh BOTH the per-batch data (files/reconciled/counts)
  // AND the batches list itself so per-batch metadata (last_full_rebuild_at,
  // last_rebuild_logic_version) reflects any background rebuilds that ran
  // while this batch was inactive. Fixes stale-on-switch ($0/$0 cache shown
  // for Mar after a Rebuild All landed while Apr was active).
  useEffect(() => { refreshAll(); refreshBatches(); }, [currentBatchId]);

  // Auto-refresh when the active batch is rebuilt (logic version or
  // last_full_rebuild_at changes in upload_batches). Polls every 2s; fires
  // only on transitions, so the initial load does NOT cause a double-fetch.
  // This makes Dashboard cards, header stamp, and the staleness banner
  // auto-update post-rebuild without F5 (resolves #71/#72).
  useBatchDataVersion(currentBatchId, () => {
    refreshBatches();
    refreshAll();
  });

  return (
    <BatchContext.Provider value={{
      batches, currentBatchId, setCurrentBatchId,
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
