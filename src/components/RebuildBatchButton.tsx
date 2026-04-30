import { useState, useCallback, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import { useBatch } from '@/contexts/BatchContext';
import { rebuildBatchWithRetry, type RebuildProgress } from '@/lib/rebuild';
import { Hammer, Loader2 } from 'lucide-react';

function formatBatchLabel(batch: any): string {
  if (!batch) return 'batch';
  const sm = batch.statement_month ? String(batch.statement_month).substring(0, 7) : null;
  if (sm) {
    const [y, m] = sm.split('-');
    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const idx = parseInt(m, 10) - 1;
    if (idx >= 0 && idx < 12) return `${monthNames[idx]} ${y}`;
    return sm;
  }
  return batch.name || batch.id?.substring(0, 8) || 'batch';
}

export function RebuildBatchButton() {
  const { currentBatchId, batches, refreshAll, refreshBatches } = useBatch();
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<RebuildProgress | null>(null);
  // Snapshot the targeted batch when the dialog opens, so polling-driven
  // context shifts (useBatchDataVersion) cannot redirect the rebuild
  // mid-flight to a different batch. See diagnostic notes for the
  // wrong-batch race that caused March clicks to execute on January.
  const [targetBatchId, setTargetBatchId] = useState<string | null>(null);
  const [targetBatchLabel, setTargetBatchLabel] = useState<string>('batch');
  const { toast } = useToast();

  const currentBatch = useMemo(
    () => batches.find((b: any) => b.id === currentBatchId) ?? null,
    [batches, currentBatchId]
  );
  const currentBatchLabel = useMemo(() => formatBatchLabel(currentBatch), [currentBatch]);

  const handleOpenChange = useCallback((open: boolean) => {
    if (open && currentBatchId) {
      setTargetBatchId(currentBatchId);
      setTargetBatchLabel(formatBatchLabel(currentBatch));
    }
  }, [currentBatchId, currentBatch]);

  const handleRebuild = useCallback(async () => {
    // Use the snapshotted target, NOT the live currentBatchId — prevents
    // the polling hook from redirecting the rebuild to a different batch.
    const batchId = targetBatchId;
    const label = targetBatchLabel;
    if (!batchId) return;
    setRunning(true);
    setProgress(null);
    try {
      const result = await rebuildBatchWithRetry(batchId, (p) => setProgress(p));
      await Promise.all([refreshAll(), refreshBatches()]);
      const fmt = (n: number) => n.toLocaleString('en-US');
      toast({
        title: `Rebuild Complete: ${label} — ${fmt(result.membersReconciled)} members`,
        description: `${fmt(result.filesProcessed)} files · ${fmt(result.recordsNormalized)} records · ${fmt(result.membersReconciled)} members`,
      });
    } catch (err: any) {
      // eslint-disable-next-line no-console
      console.error('[RebuildBatchButton] rebuild failed', { batchId, label, err });
      const description = (err && (err.message || String(err))) || 'Unknown error';
      toast({ title: `Rebuild Failed: ${label}`, description, variant: 'destructive' });
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }, [targetBatchId, targetBatchLabel, refreshAll, refreshBatches, toast]);

  const phaseLabel = (() => {
    if (!progress) return 'Working...';
    const attemptSuffix = progress.attempt && progress.attempt > 1 ? ` (attempt ${progress.attempt})` : '';
    switch (progress.phase) {
      case 'fetching-files': return 'Fetching files...';
      case 'normalizing': return `Normalizing ${progress.currentFile} (${progress.filesProcessed + 1}/${progress.totalFiles})`;
      case 'reconciling': return 'Reconciling members...';
      case 'saving': return `Saving results${attemptSuffix}...`;
      case 'verifying': return `Verifying write${attemptSuffix}...`;
      case 'retrying': return `Retrying save (attempt ${progress.attempt ?? '?'})...`;
      case 'done': return 'Done';
      default: return 'Working...';
    }
  })();

  return (
    <AlertDialog onOpenChange={handleOpenChange}>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={!currentBatchId || running}>
          {running ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Hammer className="h-4 w-4 mr-1" />}
          {running ? phaseLabel : 'Rebuild Entire Batch'}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Rebuild {currentBatchLabel} from source files?</AlertDialogTitle>
          <AlertDialogDescription>
            This will <strong>delete all normalized records and reconciled members</strong> for <strong>{currentBatchLabel}</strong>,
            re-download every uploaded CSV from storage, re-normalize each file using the current parser
            logic, and re-run reconciliation from scratch. Use this after parser/reconciliation logic changes
            to refresh stale data without re-uploading. This may take a minute for large batches.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleRebuild}>Rebuild Now</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
