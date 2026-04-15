import { useState } from 'react';
import { useBatch } from '@/contexts/BatchContext';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { createBatch } from '@/lib/persistence';
import { useToast } from '@/hooks/use-toast';
import { Plus } from 'lucide-react';

export function BatchSelector() {
  const { batches, currentBatchId, setCurrentBatchId, refreshBatches } = useBatch();
  const [creating, setCreating] = useState(false);
  const [month, setMonth] = useState('');
  const { toast } = useToast();

  const handleCreate = async () => {
    if (!month) return;
    try {
      const batch = await createBatch(month + '-01');
      await refreshBatches();
      setCurrentBatchId(batch.id);
      setCreating(false);
      setMonth('');
      toast({ title: 'Batch created', description: `Batch for ${month}` });
    } catch (err: any) {
      console.error('Failed to create batch:', err);
      toast({ title: 'Error creating batch', description: err.message, variant: 'destructive' });
    }
  };

  return (
    <div className="flex items-center gap-3">
      <Select value={currentBatchId || ''} onValueChange={setCurrentBatchId}>
        <SelectTrigger className="w-[220px]">
          <SelectValue placeholder="Select batch..." />
        </SelectTrigger>
        <SelectContent>
          {batches.map(b => (
            <SelectItem key={b.id} value={b.id}>
              {b.statement_month ? new Date(b.statement_month + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'long' }) : 'No date'} — {b.carrier}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {creating ? (
        <div className="flex items-center gap-2">
          <Input type="month" value={month} onChange={e => setMonth(e.target.value)} className="w-[180px]" />
          <Button size="sm" onClick={handleCreate}>Create</Button>
          <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
        </div>
      ) : (
        <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4 mr-1" /> New Batch
        </Button>
      )}
    </div>
  );
}
