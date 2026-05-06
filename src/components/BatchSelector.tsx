import { useMemo, useState } from 'react';
import { useBatch } from '@/contexts/BatchContext';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { createBatch, findExistingBatches, deleteBatch } from '@/lib/persistence';
import { useToast } from '@/hooks/use-toast';
import { Plus, Settings, Trash2, AlertTriangle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

function formatBatchLabel(b: any): string {
  if (!b?.statement_month) return `No date — ${b?.carrier ?? 'unknown'}`;
  return `${new Date(`${b.statement_month}T00:00:00`).toLocaleDateString('en-US', { year: 'numeric', month: 'long' })} — ${b.carrier}`;
}

export function BatchSelector() {
  const { batches, currentBatchId, setCurrentBatchId, refreshBatches } = useBatch();
  const [creating, setCreating] = useState(false);
  const [month, setMonth] = useState('');
  const [managing, setManaging] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; label: string } | null>(null);
  const [duplicateWarning, setDuplicateWarning] = useState<{ month: string; existing: any[] } | null>(null);
  const { toast } = useToast();

  const selectedBatchLabel = useMemo(() => {
    const batch = batches.find((b) => b.id === currentBatchId);
    return batch ? formatBatchLabel(batch) : '';
  }, [batches, currentBatchId]);

  const attemptCreate = async () => {
    if (!month) return;
    try {
      const existing = await findExistingBatches(`${month}-01`);
      if (existing.length > 0) {
        setDuplicateWarning({ month, existing });
        return;
      }
      await doCreate(month);
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    }
  };

  const doCreate = async (targetMonth: string) => {
    // FINDING #68 (corrected): Trace each step. Previously, if createBatch
    // silently no-op'd or the post-refresh setCurrentBatchId lost the race
    // with BatchContext's auto-select, uploads could land in the prior batch
    // (e.g. April files written to the March batch).
    console.debug('[batch-create] start', { targetMonth });
    let batch: any = null;
    try {
      batch = await createBatch(targetMonth + '-01');
    } catch (err: any) {
      console.error('[batch-create] createBatch threw', err);
      toast({
        title: 'Could not create batch',
        description: err?.message || 'Database insert failed. The batch was NOT created — your existing batch is still selected.',
        variant: 'destructive',
      });
      return;
    }

    if (!batch?.id) {
      console.error('[batch-create] createBatch returned no id', batch);
      toast({
        title: 'Could not create batch',
        description: 'No batch id returned. The batch was NOT created — your existing batch is still selected.',
        variant: 'destructive',
      });
      return;
    }
    console.debug('[batch-create] persisted', { id: batch.id, statement_month: batch.statement_month });

    // CRITICAL ORDER: set currentBatchId FIRST, then refresh.
    // If we refresh first, BatchContext.refreshBatches sees a stale
    // currentBatchId and may not auto-select the new batch; the subsequent
    // setCurrentBatchId works but a render can flash the OLD selection,
    // and any upload triggered in that window targets the wrong batch.
    setCurrentBatchId(batch.id, 'create');
    console.debug('[batch-create] setCurrentBatchId called', { newId: batch.id });

    try {
      await refreshBatches();
    } catch (err: any) {
      // Refresh failure does not undo the create — the batch IS in the DB,
      // selection IS pointed at it. We just couldn't reload the dropdown.
      console.error('[batch-create] refreshBatches failed', err);
      toast({
        title: 'Batch created but list failed to refresh',
        description: 'Reload the page to see the full batch list. Your new batch is selected.',
        variant: 'destructive',
      });
    }

    setCreating(false);
    setMonth('');
    setDuplicateWarning(null);
    toast({ title: 'Batch created', description: `Batch for ${targetMonth} is now selected.` });
  };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    const { id, label } = confirmDelete;
    try {
      await deleteBatch(id);
      // If the deleted batch was selected, clear selection; BatchContext's
      // refreshBatches will auto-select the first remaining batch.
      if (currentBatchId === id) setCurrentBatchId(null, 'delete');
      await refreshBatches();
      toast({ title: 'Batch deleted', description: label });
    } catch (err: any) {
      toast({ title: 'Error deleting batch', description: err.message, variant: 'destructive' });
    } finally {
      setConfirmDelete(null);
    }
  };

  // Group batches by statement_month + carrier so duplicates are visually obvious.
  const groupedBatches = useMemo(() => {
    const map = new Map<string, any[]>();
    for (const b of batches) {
      const key = `${b.statement_month ?? 'no-date'}|${b.carrier ?? 'unknown'}`;
      let arr = map.get(key);
      if (!arr) { arr = []; map.set(key, arr); }
      arr.push(b);
    }
    // Sort groups by statement_month descending
    return Array.from(map.entries()).sort(([a], [b]) => b.localeCompare(a));
  }, [batches]);

  const duplicateCount = groupedBatches.filter(([, bs]) => bs.length > 1).length;

  return (
    <div className="flex items-center gap-3">
      <Select value={currentBatchId ?? undefined} onValueChange={(v) => setCurrentBatchId(v, 'user-dropdown')}>
        <SelectTrigger className="w-[220px]">
          <SelectValue placeholder="Select batch...">{selectedBatchLabel}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {batches.map((b) => (
            <SelectItem key={b.id} value={b.id}>
              {formatBatchLabel(b)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {creating ? (
        <div className="flex items-center gap-2 rounded-md border border-warning/40 bg-warning/5 px-2 py-1">
          <span className="text-xs font-medium text-warning-foreground">
            Pending — click Create to save
          </span>
          <Input
            type="month"
            value={month}
            onChange={e => setMonth(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && month) attemptCreate(); }}
            className="w-[160px]"
            autoFocus
          />
          <Button size="sm" onClick={attemptCreate} disabled={!month}>Create</Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => { setCreating(false); setMonth(''); }}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <>
          <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4 mr-1" /> New Batch
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setManaging(true)}>
            <Settings className="h-4 w-4 mr-1" /> Manage
            {duplicateCount > 0 && (
              <span className="ml-1.5 inline-flex items-center gap-1 text-destructive text-xs">
                <AlertTriangle className="h-3 w-3" /> {duplicateCount} dup
              </span>
            )}
          </Button>
        </>
      )}

      {/* Duplicate-warning dialog when creating a batch for an existing month */}
      <AlertDialog open={!!duplicateWarning} onOpenChange={open => { if (!open) setDuplicateWarning(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>A batch already exists for {duplicateWarning?.month}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <div>
                  Creating another batch for the same month will result in duplicate records
                  across Member Timeline and cross-batch views. Consider deleting or renaming
                  the existing batch first.
                </div>
                <div className="mt-2 text-muted-foreground">
                  Existing batch(es):
                </div>
                <ul className="list-disc pl-5 text-xs text-muted-foreground">
                  {duplicateWarning?.existing.map(b => (
                    <li key={b.id} className="font-mono">
                      {formatBatchLabel(b)} · created {new Date(b.created_at).toLocaleDateString()}
                    </li>
                  ))}
                </ul>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { if (duplicateWarning) doCreate(duplicateWarning.month); }}
            >
              Create anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Manage Batches dialog — lets user see and delete duplicates */}
      <Dialog open={managing} onOpenChange={setManaging}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-auto">
          <DialogHeader>
            <DialogTitle>Manage Batches</DialogTitle>
            <DialogDescription>
              Delete old or duplicate batches. Deleting cascades to all uploaded files and reconciled data for that batch.
              {duplicateCount > 0 && (
                <div className="mt-2 text-destructive flex items-center gap-1 font-medium">
                  <AlertTriangle className="h-4 w-4" /> {duplicateCount} duplicate group(s) detected — these inflate cross-batch totals.
                </div>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {groupedBatches.map(([key, bs]) => (
              <div key={key} className={`border rounded-md p-3 ${bs.length > 1 ? 'border-destructive/40 bg-destructive/5' : 'border-border'}`}>
                <div className="flex items-center justify-between mb-2">
                  <div className="font-medium text-sm">
                    {formatBatchLabel(bs[0])}
                    {bs.length > 1 && (
                      <span className="ml-2 text-xs text-destructive font-semibold">
                        {bs.length} duplicates
                      </span>
                    )}
                  </div>
                </div>
                <div className="space-y-1.5">
                  {bs
                    .slice()
                    .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
                    .map((b, idx) => (
                      <div key={b.id} className="flex items-center justify-between text-xs">
                        <div className="font-mono text-muted-foreground">
                          {b.id.substring(0, 8)}… · created {new Date(b.created_at).toLocaleString()}
                          {idx === 0 && bs.length > 1 && <span className="ml-2 text-success font-medium">(most recent — keep)</span>}
                          {currentBatchId === b.id && <span className="ml-2 text-primary font-medium">(selected)</span>}
                        </div>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-destructive hover:text-destructive hover:bg-destructive/10"
                          onClick={() => setConfirmDelete({ id: b.id, label: formatBatchLabel(b) })}
                        >
                          <Trash2 className="h-3.5 w-3.5 mr-1" /> Delete
                        </Button>
                      </div>
                    ))}
                </div>
              </div>
            ))}
            {groupedBatches.length === 0 && (
              <div className="text-center py-8 text-muted-foreground text-sm">No batches exist yet.</div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setManaging(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Per-batch delete confirmation */}
      <AlertDialog open={!!confirmDelete} onOpenChange={open => { if (!open) setConfirmDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this batch?</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-medium text-foreground">{confirmDelete?.label}</span>
              <br />
              This permanently deletes all uploaded files, normalized records, and reconciled data for this batch. Cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete batch
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
