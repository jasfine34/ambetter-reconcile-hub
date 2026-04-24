import { createContext, useContext, useState, useEffect, ReactNode, useCallback } from 'react';
import { getBatches, getReconciledMembers, getUploadedFiles, getBatchCounts, getNormalizedRecords } from '@/lib/persistence';
import { reconcile, type MatchDebugStats } from '@/lib/reconcile';
import { fallbackReconcileMonth } from '@/lib/dateRange';
import { loadResolverIndex, type ResolverIndex } from '@/lib/resolvedIdentities';

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
  refreshBatches: () => Promise<void>;
  refreshReconciled: () => Promise<void>;
  refreshFiles: () => Promise<void>;
  refreshAll: () => Promise<void>;
  loading: boolean;
}

const BatchContext = createContext<BatchContextType>({
  batches: [], currentBatchId: null, setCurrentBatchId: () => {},
  reconciled: [], uploadedFiles: [],
  counts: { uploadedFiles: 0, normalizedRecords: 0, reconciledMembers: 0 },
  debugStats: null,
  refreshBatches: async () => {},
  refreshReconciled: async () => {}, refreshFiles: async () => {},
  refreshAll: async () => {}, loading: false,
});

export const useBatch = () => useContext(BatchContext);

export function BatchProvider({ children }: { children: ReactNode }) {
  const [batches, setBatches] = useState<any[]>([]);
  const [currentBatchId, setCurrentBatchId] = useState<string | null>(null);
  const [reconciled, setReconciled] = useState<any[]>([]);
  const [uploadedFiles, setUploadedFiles] = useState<any[]>([]);
  const [counts, setCounts] = useState<BatchCounts>({ uploadedFiles: 0, normalizedRecords: 0, reconciledMembers: 0 });
  const [debugStats, setDebugStats] = useState<MatchDebugStats | null>(null);
  const [loading, setLoading] = useState(false);

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
        const { debug } = reconcile(normalized as any[], reconcileMonth);
        setDebugStats(debug);
      } catch {
        setDebugStats(null);
      }
    } finally {
      setLoading(false);
    }
  }, [currentBatchId, batches]);

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

  useEffect(() => { refreshBatches(); }, []);
  useEffect(() => { refreshAll(); }, [currentBatchId]);

  return (
    <BatchContext.Provider value={{
      batches, currentBatchId, setCurrentBatchId,
      reconciled, uploadedFiles, counts, debugStats,
      refreshBatches, refreshReconciled, refreshFiles, refreshAll,
      loading,
    }}>
      {children}
    </BatchContext.Provider>
  );
}
