import { createContext, useContext, useState, useEffect, ReactNode, useCallback } from 'react';
import { getBatches, getReconciledMembers, getUploadedFiles } from '@/lib/persistence';

interface BatchContextType {
  batches: any[];
  currentBatchId: string | null;
  setCurrentBatchId: (id: string | null) => void;
  reconciled: any[];
  uploadedFiles: any[];
  refreshBatches: () => Promise<void>;
  refreshReconciled: () => Promise<void>;
  refreshFiles: () => Promise<void>;
  loading: boolean;
}

const BatchContext = createContext<BatchContextType>({
  batches: [], currentBatchId: null, setCurrentBatchId: () => {},
  reconciled: [], uploadedFiles: [], refreshBatches: async () => {},
  refreshReconciled: async () => {}, refreshFiles: async () => {}, loading: false,
});

export const useBatch = () => useContext(BatchContext);

export function BatchProvider({ children }: { children: ReactNode }) {
  const [batches, setBatches] = useState<any[]>([]);
  const [currentBatchId, setCurrentBatchId] = useState<string | null>(null);
  const [reconciled, setReconciled] = useState<any[]>([]);
  const [uploadedFiles, setUploadedFiles] = useState<any[]>([]);
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
    const data = await getReconciledMembers(currentBatchId);
    setReconciled(data || []);
    setLoading(false);
  }, [currentBatchId]);

  const refreshFiles = useCallback(async () => {
    if (!currentBatchId) { setUploadedFiles([]); return; }
    const data = await getUploadedFiles(currentBatchId);
    setUploadedFiles(data || []);
  }, [currentBatchId]);

  useEffect(() => { refreshBatches(); }, []);
  useEffect(() => { refreshReconciled(); refreshFiles(); }, [currentBatchId]);

  return (
    <BatchContext.Provider value={{ batches, currentBatchId, setCurrentBatchId, reconciled, uploadedFiles, refreshBatches, refreshReconciled, refreshFiles, loading }}>
      {children}
    </BatchContext.Provider>
  );
}
