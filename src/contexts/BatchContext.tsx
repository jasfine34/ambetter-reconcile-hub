import { createContext, useContext, useState, useEffect, ReactNode, useCallback } from 'react';
import { getBatches, getReconciledMembers, getUploadedFiles, getBatchCounts } from '@/lib/persistence';

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
  const [loading, setLoading] = useState(false);

  const refreshBatches = useCallback(async () => {
    const data = await getBatches();
    setBatches(data || []);
    if (!currentBatchId && data && data.length > 0) {
      setCurrentBatchId(data[0].id);
    }
  }, [currentBatchId]);

  const refreshReconciled = useCallback(async () => {
    if (!currentBatchId) { setReconciled([]); return; }
    setLoading(true);
    try {
      const data = await getReconciledMembers(currentBatchId);
      setReconciled(data || []);
    } finally {
      setLoading(false);
    }
  }, [currentBatchId]);

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
      reconciled, uploadedFiles, counts,
      refreshBatches, refreshReconciled, refreshFiles, refreshAll,
      loading,
    }}>
      {children}
    </BatchContext.Provider>
  );
}
