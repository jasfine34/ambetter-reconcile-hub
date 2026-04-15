import { useState, useCallback } from 'react';
import { useBatch } from '@/contexts/BatchContext';
import { BatchSelector } from '@/components/BatchSelector';
import { UploadCard } from '@/components/UploadCard';
import { FILE_LABELS } from '@/lib/constants';
import { parseCSV } from '@/lib/csvParser';
import { normalizeEDERow, normalizeBackOfficeRow, normalizeCommissionRow } from '@/lib/normalize';
import { reconcile } from '@/lib/reconcile';
import { uploadFileToStorage, uploadFileRecord, insertNormalizedRecords, saveReconciledMembers, getNormalizedRecords } from '@/lib/persistence';
import { useToast } from '@/hooks/use-toast';

export default function UploadPage() {
  const { currentBatchId, uploadedFiles, refreshAll } = useBatch();
  const [uploading, setUploading] = useState<string | null>(null);
  const { toast } = useToast();

  const handleUpload = useCallback(async (fileLabel: string, sourceType: string, payEntity: string | null, aorBucket: string | null, file: File) => {
    if (!currentBatchId) {
      toast({ title: 'Error', description: 'Please select or create a batch first.', variant: 'destructive' });
      return;
    }
    setUploading(fileLabel);
    try {
      const storagePath = await uploadFileToStorage(currentBatchId, fileLabel, file);
      const rawRows = await parseCSV(file);

      let normalized;
      if (sourceType === 'EDE') {
        normalized = rawRows.map(r => normalizeEDERow(r, fileLabel)).filter(Boolean) as any[];
      } else if (sourceType === 'BACK_OFFICE') {
        normalized = rawRows.map(r => normalizeBackOfficeRow(r, fileLabel, aorBucket!));
      } else {
        normalized = rawRows.map(r => normalizeCommissionRow(r, fileLabel, payEntity!)).filter(Boolean) as any[];
      }

      const fileRecord = await uploadFileRecord(currentBatchId, fileLabel, file.name, sourceType, payEntity, aorBucket, storagePath);
      await insertNormalizedRecords(currentBatchId, fileRecord.id, normalized);

      // Re-run reconciliation with ALL records
      const allRecords = await getNormalizedRecords(currentBatchId);
      const { members: reconciledData } = reconcile(allRecords as any[]);
      await saveReconciledMembers(currentBatchId, reconciledData);

      await refreshAll();

      toast({ title: 'Upload Complete', description: `${normalized.length} records from ${fileLabel}` });
    } catch (err: any) {
      toast({ title: 'Upload Error', description: err.message, variant: 'destructive' });
    } finally {
      setUploading(null);
    }
  }, [currentBatchId, refreshAll, toast]);

  const getUploadedFileName = (label: string) => {
    const f = uploadedFiles.find((uf: any) => uf.file_label === label);
    return f?.file_name || null;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-foreground">Upload Files</h2>
          <p className="text-sm text-muted-foreground">Upload each CSV individually. Replace any file without affecting others.</p>
        </div>
        <BatchSelector />
      </div>

      {!currentBatchId ? (
        <div className="text-center py-20 text-muted-foreground">Create or select a batch to begin uploading files.</div>
      ) : (
        <>
          <div>
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">EDE Files</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {FILE_LABELS.filter(f => f.sourceType === 'EDE').map(f => (
                <UploadCard key={f.label} label={f.label} uploadedFileName={getUploadedFileName(f.label)}
                  isUploading={uploading === f.label} onUpload={(file) => handleUpload(f.label, f.sourceType, f.payEntity, f.aorBucket, file)} />
              ))}
            </div>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">Back Office Files</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {FILE_LABELS.filter(f => f.sourceType === 'BACK_OFFICE').map(f => (
                <UploadCard key={f.label} label={f.label} uploadedFileName={getUploadedFileName(f.label)}
                  isUploading={uploading === f.label} onUpload={(file) => handleUpload(f.label, f.sourceType, f.payEntity, f.aorBucket, file)} />
              ))}
            </div>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">Commission Statements</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {FILE_LABELS.filter(f => f.sourceType === 'COMMISSION').map(f => (
                <UploadCard key={f.label} label={f.label} uploadedFileName={getUploadedFileName(f.label)}
                  isUploading={uploading === f.label} onUpload={(file) => handleUpload(f.label, f.sourceType, f.payEntity, f.aorBucket, file)} />
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
