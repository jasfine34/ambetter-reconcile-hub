import { useState, useCallback } from 'react';
import { useBatch } from '@/contexts/BatchContext';
import { BatchSelector } from '@/components/BatchSelector';
import { UploadCard } from '@/components/UploadCard';
import { FILE_LABELS } from '@/lib/constants';
import { parseCSV } from '@/lib/csvParser';
import { normalizeEDERow, normalizeBackOfficeRow, normalizeCommissionRow } from '@/lib/normalize';
import { reconcile } from '@/lib/reconcile';
import { uploadFileToStorage, uploadFileRecord, insertNormalizedRecords, saveReconciledMembers, getNormalizedRecords } from '@/lib/persistence';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { detectSchema, readCSVHeaders, type DetectedSchema } from '@/lib/schemaDetect';
import { fallbackReconcileMonth } from '@/lib/dateRange';
import { loadResolverIndex } from '@/lib/resolvedIdentities';
import { AlertTriangle } from 'lucide-react';
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

/**
 * Per-file upload state. Tracked independently per file_label so concurrent
 * uploads each render their own spinner — fixes FINDING #61 where starting
 * a 2nd upload removed the spinner from the 1st.
 */
type UploadingMap = Record<string, boolean>;

export default function UploadPage() {
  const { currentBatchId, uploadedFiles, refreshAll, batches } = useBatch();
  const [uploading, setUploading] = useState<UploadingMap>({});
  const [pending, setPending] = useState<PendingUpload | null>(null);
  const { toast } = useToast();

  const setSlotUploading = useCallback((label: string, value: boolean) => {
    setUploading(prev => {
      const next = { ...prev };
      if (value) next[label] = true; else delete next[label];
      return next;
    });
  }, []);

  /**
   * Process one upload with FINDING #68 hardening:
   *   - Every async step is wrapped in try/catch and surfaces a toast on
   *     failure (storage upload, CSV parse, normalize, DB insert, reconcile,
   *     save reconciled).
   *   - If the storage upload succeeds but DB insertion fails, we mark the
   *     newly-created uploaded_files row (and its normalized_records, if any
   *     landed) as superseded so the user is left with a clean retry surface
   *     rather than a half-attached file that silently displaces the prior
   *     upload.
   */
  const processUpload = useCallback(async (p: Omit<PendingUpload, 'detected'>) => {
    setSlotUploading(p.fileLabel, true);
    let storagePath: string | null = null;
    let createdFileId: string | null = null;

    const fail = (step: string, err: any) => {
      const msg = err?.message || String(err);
      console.error(`[upload:${p.fileLabel}] ${step} failed:`, err);
      toast({
        title: `Upload failed: ${p.fileLabel}`,
        description: `${step}: ${msg}`,
        variant: 'destructive',
      });
    };

    try {
      // Step 1: Upload raw file to storage.
      try {
        storagePath = await uploadFileToStorage(currentBatchId!, p.fileLabel, p.file);
      } catch (err) { fail('Storage upload', err); return; }

      // Step 2: Parse CSV.
      let rawRows: Record<string, string>[];
      try {
        rawRows = await parseCSV(p.file);
      } catch (err) { fail('CSV parse', err); return; }

      // Step 3: Normalize rows.
      let normalized: any[];
      try {
        if (p.sourceType === 'EDE') {
          normalized = rawRows.map(r => normalizeEDERow(r, p.fileLabel)).filter(Boolean) as any[];
        } else if (p.sourceType === 'BACK_OFFICE') {
          normalized = rawRows.map(r => normalizeBackOfficeRow(r, p.fileLabel, p.aorBucket!));
        } else {
          normalized = rawRows.map(r => normalizeCommissionRow(r, p.fileLabel, p.payEntity!)).filter(Boolean) as any[];
        }
      } catch (err) { fail('Normalize rows', err); return; }

      // Step 4: Insert uploaded_files + snapshot row. After this point, a
      // failure leaves a row attached to the batch — we must roll it back.
      let fileRecord: any;
      let snapshot: any;
      try {
        const result = await uploadFileRecord(
          currentBatchId!, p.fileLabel, p.file.name, p.sourceType,
          p.payEntity, p.aorBucket, storagePath,
        );
        fileRecord = result.file;
        snapshot = result.snapshot;
        createdFileId = fileRecord.id;
      } catch (err) { fail('Register uploaded file', err); return; }

      // Step 5: Insert normalized_records.
      try {
        await insertNormalizedRecords(currentBatchId!, fileRecord.id, normalized, snapshot);
      } catch (err) {
        // Rollback: mark the just-inserted uploaded_files row as superseded
        // so the slot returns to its prior state instead of silently showing
        // a "successful" upload with zero records behind it.
        if (createdFileId) {
          try {
            await supabase
              .from('uploaded_files')
              .update({ superseded_at: new Date().toISOString() })
              .eq('id', createdFileId);
          } catch (rollbackErr) {
            console.error('[upload] rollback failed:', rollbackErr);
          }
        }
        fail('Save normalized records', err);
        return;
      }

      // Step 6: Re-reconcile the batch with the new file included.
      try {
        const allRecords = await getNormalizedRecords(currentBatchId!);
        const currentBatch = batches.find((b: any) => b.id === currentBatchId);
        const reconcileMonth = currentBatch?.statement_month
          ? String(currentBatch.statement_month).substring(0, 7)
          : fallbackReconcileMonth();
        const resolverIndex = await loadResolverIndex(true);
        const { members: reconciledData } = reconcile(allRecords as any[], reconcileMonth, resolverIndex);
        await saveReconciledMembers(currentBatchId!, reconciledData);
      } catch (err) {
        // Reconcile failure is non-fatal for the upload itself; warn the
        // user but keep the file attached — they can re-run reconcile via
        // the Rebuild button.
        fail('Reconcile after upload (file saved — try Rebuild)', err);
        await refreshAll();
        return;
      }

      await refreshAll();
      toast({ title: 'Upload complete', description: `${normalized.length} records · ${p.fileLabel}` });
    } finally {
      setSlotUploading(p.fileLabel, false);
    }
  }, [currentBatchId, refreshAll, toast, batches, setSlotUploading]);

  const handleUpload = useCallback(async (fileLabel: string, sourceType: string, payEntity: string | null, aorBucket: string | null, file: File) => {
    if (!currentBatchId) {
      toast({ title: 'No batch selected', description: 'Create or select a batch before uploading.', variant: 'destructive' });
      return;
    }

    // Detect schema from headers and warn if mismatched.
    try {
      const headers = await readCSVHeaders(file);
      const detected = detectSchema(headers);
      const mismatch = detected !== 'UNKNOWN' && detected !== sourceType;
      if (mismatch || detected === 'UNKNOWN') {
        setPending({ fileLabel, sourceType, payEntity, aorBucket, file, detected });
        return;
      }
    } catch {
      // If header read fails, fall through and attempt processing.
    }

    await processUpload({ fileLabel, sourceType, payEntity, aorBucket, file });
  }, [currentBatchId, processUpload, toast]);

  const getUploadedFileName = (label: string): string | null => {
    const f = uploadedFiles.find((uf: any) => uf.file_label === label);
    // Treat empty / whitespace-only filenames as "not uploaded" — guards
    // against legacy rows where file_name was blank, which previously caused
    // empty slots to render as "filled" (FINDING #62).
    const name = f?.file_name?.trim();
    return name ? name : null;
  };

  const currentBatch = batches.find((b: any) => b.id === currentBatchId);
  const currentBatchLabel = currentBatch?.statement_month
    ? `${new Date(`${currentBatch.statement_month}T00:00:00`).toLocaleDateString('en-US', { year: 'numeric', month: 'long' })} — ${currentBatch.carrier}`
    : null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-foreground">Upload Files</h2>
          <p className="text-sm text-muted-foreground">Upload each CSV individually. Replace any file without affecting others.</p>
        </div>
        <BatchSelector />
      </div>

      {/* Active-batch banner — makes it impossible to mistake which month
          you're uploading into (FINDING #68 root cause: April files were
          uploaded into the March batch with no visual signal). */}
      {currentBatchLabel && (
        <div className="rounded-md border border-primary/30 bg-primary/5 px-4 py-2 text-sm flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-primary" />
          <span className="text-foreground">
            Uploading into batch: <span className="font-semibold">{currentBatchLabel}</span>
          </span>
          <span className="text-muted-foreground ml-2">
            Wrong month? Click <span className="font-medium">+ New Batch</span> above.
          </span>
        </div>
      )}

      {!currentBatchId ? (
        <div className="text-center py-20 text-muted-foreground">Create or select a batch to begin uploading files.</div>
      ) : (
        <>
          <div>
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">EDE Files</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {FILE_LABELS.filter(f => f.sourceType === 'EDE').map(f => (
                <UploadCard key={f.label} label={f.label} uploadedFileName={getUploadedFileName(f.label)}
                  isUploading={!!uploading[f.label]} onUpload={(file) => handleUpload(f.label, f.sourceType, f.payEntity, f.aorBucket, file)} />
              ))}
            </div>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">Back Office Files</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {FILE_LABELS.filter(f => f.sourceType === 'BACK_OFFICE').map(f => (
                <UploadCard key={f.label} label={f.label} uploadedFileName={getUploadedFileName(f.label)}
                  isUploading={!!uploading[f.label]} onUpload={(file) => handleUpload(f.label, f.sourceType, f.payEntity, f.aorBucket, file)} />
              ))}
            </div>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">Commission Statements</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {FILE_LABELS.filter(f => f.sourceType === 'COMMISSION').map(f => (
                <UploadCard key={f.label} label={f.label} uploadedFileName={getUploadedFileName(f.label)}
                  isUploading={!!uploading[f.label]} onUpload={(file) => handleUpload(f.label, f.sourceType, f.payEntity, f.aorBucket, file)} />
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
