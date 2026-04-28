import { useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { useBatch } from '@/contexts/BatchContext';
import { rebuildBatchWithRetry, type RebuildProgress } from '@/lib/rebuild';
import { Hammer, Loader2 } from 'lucide-react';

interface BatchProgress {
  batchId: string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'error';
  error?: string;
  inner?: RebuildProgress;
  membersReconciled?: number;
}

function batchLabel(b: any): string {
  const month = b?.statement_month ? String(b.statement_month).substring(0, 7) : 'Unknown';
  const carrier = b?.carrier ?? 'Carrier';
  // Format YYYY-MM as 'Month YYYY'
  let display = month;
  const parts = month.split('-');
  if (parts.length >= 2) {
    const date = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, 1);
    display = date.toLocaleString('en-US', { month: 'long', year: 'numeric' });
  }
  return `${display} — ${carrier}`;
}

interface Props {
  variant?: 'outline' | 'default';
  label?: string;
}

export function RebuildAllBatchesButton({ variant = 'outline', label = 'Rebuild All Batches' }: Props) {
  const { batches, refreshAll, refreshBatches } = useBatch();
  const [running, setRunning] = useState(false);
  const [progressList, setProgressList] = useState<BatchProgress[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const { toast } = useToast();

  const total = batches.length;

  const handleRebuildAll = useCallback(async () => {
    if (!batches.length) return;
    setRunning(true);
    const initial: BatchProgress[] = batches.map((b: any) => ({
      batchId: b.id,
      label: batchLabel(b),
      status: 'pending',
    }));
    setProgressList(initial);
    setCurrentIndex(0);

    let successCount = 0;
    let errorCount = 0;

    for (let i = 0; i < batches.length; i++) {
      const b: any = batches[i];
      setCurrentIndex(i);
      setProgressList((prev) =>
        prev.map((p, idx) => (idx === i ? { ...p, status: 'running' } : p))
      );
      try {
        const result = await rebuildBatchWithRetry(b.id, (inner) => {
          setProgressList((prev) =>
            prev.map((p, idx) => (idx === i ? { ...p, inner } : p))
          );
        });
        setProgressList((prev) =>
          prev.map((p, idx) =>
            idx === i
              ? { ...p, status: 'done', inner: undefined, membersReconciled: result.membersReconciled }
              : p
          )
        );
        successCount++;
      } catch (err: any) {
        setProgressList((prev) =>
          prev.map((p, idx) =>
            idx === i ? { ...p, status: 'error', error: err?.message ?? 'Unknown error' } : p
          )
        );
        errorCount++;
      }
    }

    await Promise.all([refreshAll(), refreshBatches()]);

    if (errorCount === 0) {
      toast({ title: 'Rebuild Complete', description: `Rebuilt ${successCount} batches.` });
    } else {
      toast({
        title: 'Rebuild Finished with Errors',
        description: `${successCount} succeeded, ${errorCount} failed. See modal for details.`,
        variant: 'destructive',
      });
    }
    setRunning(false);
  }, [batches, refreshAll, refreshBatches, toast]);

  return (
    <>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant={variant} size="sm" disabled={!total || running}>
            {running ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <Hammer className="h-4 w-4 mr-1" />
            )}
            {running ? `Rebuilding (${currentIndex + 1}/${total})...` : label}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rebuild all {total} batches from source files?</AlertDialogTitle>
            <AlertDialogDescription>
              This will sequentially re-download every uploaded CSV across all batches,
              re-normalize using current parser logic, and re-run reconciliation. Each
              batch's existing reconciled records and current normalized records will be
              replaced. This may take several minutes depending on batch size and count.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleRebuildAll}>Rebuild All Now</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={running || (progressList.length > 0 && !running)} onOpenChange={(open) => {
        if (!open && !running) setProgressList([]);
      }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {running
                ? `Rebuilding ${progressList[currentIndex]?.label ?? ''} (${currentIndex + 1} of ${total})...`
                : 'Rebuild Complete'}
            </DialogTitle>
            <DialogDescription>
              {running
                ? 'Each batch is being re-normalized and reconciled with current logic. Please keep this window open.'
                : 'All batches processed. You can close this window.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 max-h-[50vh] overflow-y-auto">
            {progressList.map((p, idx) => (
              <div
                key={p.batchId}
                className="flex items-start gap-2 text-sm border rounded-md px-3 py-2"
              >
                <div className="mt-0.5 shrink-0">
                  {p.status === 'pending' && <span className="text-muted-foreground">·</span>}
                  {p.status === 'running' && (
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  )}
                  {p.status === 'done' && <span className="text-green-600">✓</span>}
                  {p.status === 'error' && <span className="text-destructive">✕</span>}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{p.label}</div>
                  {p.status === 'running' && p.inner && (
                    <div className="text-xs text-muted-foreground">
                      {p.inner.phase === 'normalizing'
                        ? `Normalizing ${p.inner.currentFile} (${p.inner.filesProcessed + 1}/${p.inner.totalFiles})`
                        : p.inner.phase === 'reconciling'
                          ? 'Reconciling members...'
                          : p.inner.phase === 'saving'
                            ? `Saving results${p.inner.attempt && p.inner.attempt > 1 ? ` (attempt ${p.inner.attempt})` : ''}...`
                            : p.inner.phase === 'verifying'
                              ? `Verifying write${p.inner.attempt && p.inner.attempt > 1 ? ` (attempt ${p.inner.attempt})` : ''}...`
                              : p.inner.phase === 'retrying'
                                ? `Retrying save (attempt ${p.inner.attempt ?? '?'})...`
                                : p.inner.phase === 'fetching-files'
                                  ? 'Fetching files...'
                                  : p.inner.phase}
                    </div>
                  )}
                  {p.status === 'done' && (
                    <div className="text-xs text-green-600">
                      {p.membersReconciled?.toLocaleString() ?? 0} members reconciled
                      {p.membersReconciled === 0 && (
                        <span className="text-destructive ml-1">⚠ unexpected zero</span>
                      )}
                    </div>
                  )}
                  {p.status === 'error' && p.error && (
                    <div className="text-xs text-destructive">{p.error}</div>
                  )}
                </div>
                <div className="text-xs text-muted-foreground shrink-0">
                  {idx + 1}/{total}
                </div>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
