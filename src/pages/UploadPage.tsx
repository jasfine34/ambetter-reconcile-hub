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
import { detectSchema, readCSVHeaders, type DetectedSchema } from '@/lib/schemaDetect';
import { fallbackReconcileMonth } from '@/lib/dateRange';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';

interface PendingUpload {
  fileLabel: string;
  sourceType: string;
  payEntity: string | null;
  aorBucket: string | null;
  file: File;
  detected: DetectedSchema;
}

const SCHEMA_LABEL: Record<DetectedSchema, string> = {
  EDE: 'EDE (Marketplace export)',
  BACK_OFFICE: 'Back Office report',
  COMMISSION: 'Commission Statement',
  UNKNOWN: 'Unknown / unrecognized',
};

export default function UploadPage() {
  const { currentBatchId, uploadedFiles, refreshAll, batches } = useBatch();
  const [uploading, setUploading] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingUpload | null>(null);
  const { toast } = useToast();

  const processUpload = useCallback(async (p: Omit<PendingUpload, 'detected'>) => {
    setUploading(p.fileLabel);
    try {
      const storagePath = await uploadFileToStorage(currentBatchId!, p.fileLabel, p.file);
      const rawRows = await parseCSV(p.file);

      let normalized;
      if (p.sourceType === 'EDE') {
        normalized = rawRows.map(r => normalizeEDERow(r, p.fileLabel)).filter(Boolean) as any[];
      } else if (p.sourceType === 'BACK_OFFICE') {
        normalized = rawRows.map(r => normalizeBackOfficeRow(r, p.fileLabel, p.aorBucket!));
      } else {
        normalized = rawRows.map(r => normalizeCommissionRow(r, p.fileLabel, p.payEntity!)).filter(Boolean) as any[];
      }

      const { file: fileRecord, snapshot } = await uploadFileRecord(currentBatchId!, p.fileLabel, p.file.name, p.sourceType, p.payEntity, p.aorBucket, storagePath);
      await insertNormalizedRecords(currentBatchId!, fileRecord.id, normalized, snapshot);

      const allRecords = await getNormalizedRecords(currentBatchId!);
      const currentBatch = batches.find((b: any) => b.id === currentBatchId);
      const reconcileMonth = currentBatch?.statement_month
        ? String(currentBatch.statement_month).substring(0, 7)
        : fallbackReconcileMonth();
      const { members: reconciledData } = reconcile(allRecords as any[], reconcileMonth);
      await saveReconciledMembers(currentBatchId!, reconciledData);

      await refreshAll();
      toast({ title: 'Upload Complete', description: `${normalized.length} records from ${p.fileLabel}` });
    } catch (err: any) {
      toast({ title: 'Upload Error', description: err.message, variant: 'destructive' });
    } finally {
      setUploading(null);
    }
  }, [currentBatchId, refreshAll, toast, batches]);

  const handleUpload = useCallback(async (fileLabel: string, sourceType: string, payEntity: string | null, aorBucket: string | null, file: File) => {
    if (!currentBatchId) {
      toast({ title: 'Error', description: 'Please select or create a batch first.', variant: 'destructive' });
      return;
    }

    // Detect schema from headers and warn if mismatched
    try {
      const headers = await readCSVHeaders(file);
      const detected = detectSchema(headers);
      const mismatch = detected !== 'UNKNOWN' && detected !== sourceType;
      if (mismatch || detected === 'UNKNOWN') {
        setPending({ fileLabel, sourceType, payEntity, aorBucket, file, detected });
        return;
      }
    } catch {
      // If header read fails, fall through and attempt processing
    }

    await processUpload({ fileLabel, sourceType, payEntity, aorBucket, file });
  }, [currentBatchId, processUpload, toast]);

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

      <AlertDialog open={!!pending} onOpenChange={(open) => { if (!open) setPending(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Possible wrong file?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <div>
                  You're uploading <span className="font-semibold text-foreground">{pending?.file.name}</span> into the
                  {' '}<span className="font-semibold text-foreground">{pending?.fileLabel}</span> slot
                  {' '}(expected: <span className="font-mono">{pending?.sourceType}</span>).
                </div>
                <div>
                  Based on the column headers, this file looks like a{' '}
                  <span className="font-semibold text-foreground">
                    {pending ? SCHEMA_LABEL[pending.detected] : ''}
                  </span>.
                </div>
                <div className="text-muted-foreground">
                  Uploading the wrong schema can cause records to be miscounted (e.g. eligibility flags missing).
                  Proceed anyway, or cancel and choose the correct file.
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if (!pending) return;
                const p = pending;
                setPending(null);
                await processUpload(p);
              }}
            >
              Proceed anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
