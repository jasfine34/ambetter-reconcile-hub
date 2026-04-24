import { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ShieldAlert, CheckCircle2, Info } from 'lucide-react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { getResolverConflicts, markResolverConflictReviewed, type ResolvedIdentityRow } from '@/lib/resolvedIdentities';
import { useToast } from '@/hooks/use-toast';

interface ConflictDetail {
  field: 'issuer_subscriber_id' | 'issuer_policy_id' | 'exchange_policy_id';
  winner: { value: string; source_kind?: string; batch_month?: string };
  losers: Array<{ value: string; source_kind?: string; batch_month?: string }>;
}

function fieldLabel(f: string): string {
  switch (f) {
    case 'issuer_subscriber_id': return 'Issuer Sub ID';
    case 'issuer_policy_id': return 'Issuer Policy ID';
    case 'exchange_policy_id': return 'Exchange Policy ID';
    default: return f;
  }
}

function formatSource(s: { source_kind?: string; batch_month?: string }): string {
  const sk = s.source_kind || 'unknown';
  return s.batch_month ? `${sk} · ${s.batch_month}` : sk;
}

export function IdentityResolutionConflictsPanel() {
  const [rows, setRows] = useState<ResolvedIdentityRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [showReviewed, setShowReviewed] = useState(false);
  const [marking, setMarking] = useState<string | null>(null);
  const { toast } = useToast();

  const load = async () => {
    setLoading(true);
    try {
      const data = await getResolverConflicts();
      setRows(data);
    } catch (err: any) {
      toast({ title: 'Could not load conflicts', description: err.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const visibleRows = useMemo(
    () => showReviewed ? rows : rows.filter(r => !r.reviewed_at),
    [rows, showReviewed],
  );
  const unreviewedCount = useMemo(() => rows.filter(r => !r.reviewed_at).length, [rows]);

  // Flatten one row × N conflicting fields into render rows.
  const flattened = useMemo(() => {
    const out: Array<{ row: ResolvedIdentityRow; detail: ConflictDetail }> = [];
    for (const r of visibleRows) {
      const details = (r.conflict_details || []) as ConflictDetail[];
      for (const d of details) out.push({ row: r, detail: d });
    }
    return out;
  }, [visibleRows]);

  const handleMarkReviewed = async (id: string) => {
    setMarking(id);
    try {
      await markResolverConflictReviewed(id);
      await load();
      toast({ title: 'Conflict marked reviewed' });
    } catch (err: any) {
      toast({ title: 'Could not mark reviewed', description: err.message, variant: 'destructive' });
    } finally {
      setMarking(null);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-amber-500" />
              Identity Resolution Conflicts
              {unreviewedCount > 0 && (
                <Badge variant="destructive" className="ml-1">{unreviewedCount} unreviewed</Badge>
              )}
              <TooltipProvider delayDuration={150}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="text-muted-foreground/70 cursor-help inline-flex"><Info className="h-3.5 w-3.5" /></span>
                  </TooltipTrigger>
                  <TooltipContent side="right" className="max-w-[320px] text-xs leading-relaxed">
                    Cases where two or more source files reported different IDs for the same applicant (matched by FFM App ID or Exchange Subscriber ID). The "winning" value is the one applied to reconciliation; "losing" values are recorded for audit. Mark reviewed once you've confirmed the winner.
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </CardTitle>
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
            <Checkbox checked={showReviewed} onCheckedChange={v => setShowReviewed(!!v)} />
            Show reviewed
          </label>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="text-center text-sm text-muted-foreground py-6">Loading conflicts…</div>
        ) : flattened.length === 0 ? (
          <div className="text-center text-sm text-muted-foreground py-8 flex flex-col items-center gap-2">
            <CheckCircle2 className="h-6 w-6 text-success" />
            <span>No identity conflicts — all sources agree.</span>
          </div>
        ) : (
          <div className="rounded-lg border overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="whitespace-nowrap">Match Key</TableHead>
                  <TableHead className="whitespace-nowrap">Field</TableHead>
                  <TableHead className="whitespace-nowrap">Winning Value</TableHead>
                  <TableHead className="whitespace-nowrap">Losing Value(s)</TableHead>
                  <TableHead className="whitespace-nowrap">Resolved At</TableHead>
                  <TableHead className="whitespace-nowrap">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {flattened.map(({ row, detail }, i) => (
                  <TableRow key={`${row.id}-${detail.field}-${i}`}>
                    <TableCell className="text-xs whitespace-nowrap">
                      <div className="font-medium text-foreground">{row.match_key_type}</div>
                      <div className="font-mono text-muted-foreground">{row.match_key_value}</div>
                    </TableCell>
                    <TableCell className="text-xs whitespace-nowrap">{fieldLabel(detail.field)}</TableCell>
                    <TableCell className="text-xs whitespace-nowrap">
                      <div className="font-mono text-foreground">{detail.winner.value}</div>
                      <div className="text-[10px] text-muted-foreground">{formatSource(detail.winner)}</div>
                    </TableCell>
                    <TableCell className="text-xs">
                      <div className="space-y-1">
                        {detail.losers.map((l, li) => (
                          <div key={li}>
                            <span className="font-mono text-foreground">{l.value}</span>
                            <span className="text-[10px] text-muted-foreground ml-1.5">({formatSource(l)})</span>
                          </div>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
                      {row.resolved_at ? new Date(row.resolved_at).toLocaleString() : '—'}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {row.reviewed_at ? (
                        <Badge variant="secondary" className="text-[10px]">
                          Reviewed {new Date(row.reviewed_at).toLocaleDateString()}
                        </Badge>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleMarkReviewed(row.id)}
                          disabled={marking === row.id}
                        >
                          {marking === row.id ? 'Marking…' : 'Mark Reviewed'}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
