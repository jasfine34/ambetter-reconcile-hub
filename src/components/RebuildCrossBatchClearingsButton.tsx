import { useRef, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader,
  AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import { useBatch } from '@/contexts/BatchContext';
import { runCrossBatchClearingSweep, type SweepResult } from '@/lib/sweep/crossBatchClearingSweep';
import { Link2, Loader2 } from 'lucide-react';

export function RebuildCrossBatchClearingsButton() {
  const { batches } = useBatch();
  const { toast } = useToast();
  const generationRef = useRef(0);
  const [loading, setLoading] = useState(false);
  const [, setLastRunAt] = useState<Date | null>(null);
  const [, setError] = useState<string | null>(null);
  const [, setInputErrorCount] = useState(0);
  const [, setClearingRowsWritten] = useState(0);
  const [open, setOpen] = useState(false);

  const disabled = !batches.length || loading;

  const handleConfirm = useCallback(async () => {
    setOpen(false);
    setLoading(true);
    generationRef.current += 1;
    const myGen = generationRef.current;
    try {
      const result: SweepResult = await runCrossBatchClearingSweep({
        generationId: myGen,
        shouldContinue: () => generationRef.current === myGen,
      });
      if (result.aborted) {
        setLoading(false);
        setError(result.errorMessage ?? 'Sweep aborted');
        toast({ title: 'Rebuild Cross-Batch Clearings failed', description: result.errorMessage ?? 'Sweep aborted', variant: 'destructive' });
        return;
      }
      setLoading(false);
      setClearingRowsWritten(result.clearingRowsWritten);
      setInputErrorCount(result.inputErrors.length);
      setLastRunAt(new Date());
      if (result.inputErrors.length > 0) console.log('cross-batch clearing inputErrors', result.inputErrors);
      const desc = `Clearings rebuilt. ${result.clearingRowsWritten} clearing rows written.`
        + (result.inputErrors.length > 0 ? ` ${result.inputErrors.length} inputs could not be evaluated (see console).` : '');
      toast({ title: 'Cross-batch clearings rebuilt', description: desc });
    } catch (err: any) {
      setLoading(false);
      const msg = err?.message ?? String(err);
      setError(msg);
      toast({ title: 'Rebuild Cross-Batch Clearings failed', description: msg, variant: 'destructive' });
    }
  }, [toast]);

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled}>
          {loading ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Link2 className="h-4 w-4 mr-1" />}
          {loading ? 'Rebuilding Clearings…' : 'Rebuild Cross-Batch Clearings'}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Rebuild Cross-Batch Clearings?</AlertDialogTitle>
          <AlertDialogDescription>
            This re-evaluates cross-batch payment clearings for every unpaid policy-month
            across all batches. Existing clearing rows will be superseded and replaced.
            Run this after rebuilding any reconciled batch. This operation may take up to
            a minute.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleConfirm}>Rebuild</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
