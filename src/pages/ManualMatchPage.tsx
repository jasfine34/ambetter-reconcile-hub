import { useState, useEffect, useMemo } from 'react';
import { useBatch } from '@/contexts/BatchContext';
import { BatchSelector } from '@/components/BatchSelector';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { getNormalizedRecords, saveManualOverride } from '@/lib/persistence';
import { useToast } from '@/hooks/use-toast';
import { Link2 } from 'lucide-react';

export default function ManualMatchPage() {
  const { currentBatchId, refreshReconciled } = useBatch();
  const [records, setRecords] = useState<any[]>([]);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<{ left: any; right: any } | null>(null);
  const [reason, setReason] = useState('');
  const { toast } = useToast();

  useEffect(() => {
    if (!currentBatchId) return;
    getNormalizedRecords(currentBatchId).then(setRecords);
  }, [currentBatchId]);

  // Find unmatched - records whose member_key starts with NAME: (weak match)
  const unmatched = useMemo(() =>
    records.filter(r => r.member_key?.startsWith('NAME:') || r.member_key?.startsWith('UNK:')),
  [records]);

  const ede = useMemo(() => unmatched.filter(r => r.source_type === 'EDE'), [unmatched]);
  const candidates = useMemo(() => {
    if (!search) return records.filter(r => r.source_type !== 'EDE').slice(0, 50);
    const s = search.toLowerCase();
    return records.filter(r => r.source_type !== 'EDE' && (
      (r.applicant_name || '').toLowerCase().includes(s) ||
      (r.policy_number || '').toLowerCase().includes(s) ||
      (r.exchange_subscriber_id || '').toLowerCase().includes(s)
    )).slice(0, 50);
  }, [records, search]);

  const handleSave = async () => {
    if (!selected) return;
    try {
      await saveManualOverride(selected.left.id, selected.right.id, reason);
      toast({ title: 'Override Saved', description: 'Manual match recorded.' });
      setSelected(null);
      setReason('');
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-foreground">Manual Match Review</h2>
          <p className="text-sm text-muted-foreground">{unmatched.length} weak/unmatched records</p>
        </div>
        <BatchSelector />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div>
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">Unmatched EDE Records</h3>
          <div className="border rounded-lg overflow-auto max-h-[500px]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>DOB</TableHead>
                  <TableHead>Sub ID</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ede.length === 0 ? (
                  <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground py-8">No unmatched EDE records</TableCell></TableRow>
                ) : ede.map(r => (
                  <TableRow key={r.id}>
                    <TableCell className="text-sm">{r.applicant_name}</TableCell>
                    <TableCell className="text-sm">{r.dob}</TableCell>
                    <TableCell className="text-sm">{r.exchange_subscriber_id}</TableCell>
                    <TableCell>
                      <Button size="sm" variant="ghost" onClick={() => setSelected({ left: r, right: null })}>
                        <Link2 className="h-3 w-3" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>

        <div>
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">Candidate Matches</h3>
          <Input placeholder="Search candidates..." value={search} onChange={e => setSearch(e.target.value)} className="mb-3" />
          <div className="border rounded-lg overflow-auto max-h-[500px]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Policy #</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {candidates.map(r => (
                  <TableRow key={r.id}>
                    <TableCell className="text-sm">{r.applicant_name}</TableCell>
                    <TableCell className="text-sm">{r.source_type}</TableCell>
                    <TableCell className="text-sm">{r.policy_number}</TableCell>
                    <TableCell>
                      {selected?.left && (
                        <Button size="sm" variant="ghost" onClick={() => setSelected(prev => prev ? { ...prev, right: r } : null)}>
                          <Link2 className="h-3 w-3" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      </div>

      <Dialog open={!!selected?.right} onOpenChange={() => setSelected(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm Manual Match</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p><strong>Left:</strong> {selected?.left?.applicant_name} ({selected?.left?.source_type})</p>
            <p><strong>Right:</strong> {selected?.right?.applicant_name} ({selected?.right?.source_type})</p>
            <Textarea placeholder="Override reason..." value={reason} onChange={e => setReason(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSelected(null)}>Cancel</Button>
            <Button onClick={handleSave}>Save Override</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
