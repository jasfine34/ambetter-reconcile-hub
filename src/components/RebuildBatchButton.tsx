import { useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import { useBatch } from '@/contexts/BatchContext';
import { rebuildBatch, type RebuildProgress } from '@/lib/rebuild';
import { Hammer, Loader2 } from 'lucide-react';

export function RebuildBatchButton() {
  const { currentBatchId, refreshAll, refreshBatches } = useBatch();
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<RebuildProgress | null>(null);
  const { toast } = useToast();

  const handleRebuild = useCallback(async () => {
    if (!currentBatchId) return;
    setRunning(true);
    setProgress(null);
    try {
      const result = await rebuildBatch(currentBatchId, (p) => setProgress(p));
      await Promise.all([refreshAll(), refreshBatches()]);
      toast({
        title: 'Rebuild Complete',
        description: `${result.filesProcessed} files · ${result.recordsNormalized} records · ${result.membersReconciled} members`,
      });
    } catch (err: any) {
      toast({ title: 'Rebuild Failed', description: err.message, variant: 'destructive' });
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }, [currentBatchId, refreshAll, refreshBatches, toast]);

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
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={!currentBatchId || running}>
          {running ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Hammer className="h-4 w-4 mr-1" />}
          {running ? phaseLabel : 'Rebuild Entire Batch'}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Rebuild entire batch from source files?</AlertDialogTitle>
          <AlertDialogDescription>
            This will <strong>delete all normalized records and reconciled members</strong> for this batch,
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
