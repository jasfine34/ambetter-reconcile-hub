import { useState, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useBatch } from '@/contexts/BatchContext';
import { BatchSelector } from '@/components/BatchSelector';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { getNormalizedRecords } from '@/lib/persistence';
import { computeFilteredEde } from '@/lib/expectedEde';
import {
  findWeakMatches,
  loadWeakMatchOverrides,
  recordWeakMatchOverride,
  applyOverrides,
  type WeakMatchCandidate,
  type WeakMatchOverride,
} from '@/lib/weakMatch';
import { useToast } from '@/hooks/use-toast';
import { CheckCircle2, XCircle, Clock, Link2 } from 'lucide-react';
import { getCoveredMonths } from '@/lib/dateRange';
import { usePayEntityScope } from '@/hooks/usePayEntityScope';

export default function ManualMatchPage() {
  const { currentBatchId, reconciled, batches, resolverIndex } = useBatch();
  const [searchParams] = useSearchParams();
  const filterMode = searchParams.get('filter') === 'weak' ? 'weak' : 'weak';
  const [normalizedRecords, setNormalizedRecords] = useState<any[]>([]);
  const [overrides, setOverrides] = useState<Map<string, WeakMatchOverride>>(new Map());
  const [sessionDecisions, setSessionDecisions] = useState(0);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const { toast } = useToast();

  const currentBatch = useMemo(
    () => batches.find((b: any) => b.id === currentBatchId),
    [batches, currentBatchId]
  );
  const coveredMonths = useMemo(
    () => getCoveredMonths(currentBatch?.statement_month),
    [currentBatch?.statement_month]
  );

  // Use the SHARED pay-entity scope so this page mirrors the Dashboard's
  // current selection (and vice versa). Previously this page hardcoded
  // 'Coverall' which made the queue invisible whenever the user was
  // looking at Vix or All on the Dashboard. (#66, 2026-04-28.)
  const [scope, setScope] = usePayEntityScope();

  // Refetch normalized records on batch change AND when reconciled data
  // updates (rebuild / re-run / upload completion all bump reconciled.length
  // without changing currentBatchId). Mirrors the same fix applied to
  // EntitySummaryPage / AgentSummaryPage in #64.
  useEffect(() => {
    if (!currentBatchId) { setNormalizedRecords([]); return; }
    let cancelled = false;
    getNormalizedRecords(currentBatchId)
      .then((recs) => { if (!cancelled) setNormalizedRecords(recs as any[]); })
      .catch(() => { if (!cancelled) setNormalizedRecords([]); });
    return () => { cancelled = true; };
  }, [currentBatchId, reconciled.length]);

  const refreshOverrides = async () => {
    try {
      const map = await loadWeakMatchOverrides();
      setOverrides(map);
    } catch {
      setOverrides(new Map());
    }
  };
  useEffect(() => { refreshOverrides(); }, [currentBatchId]);

  const candidates: WeakMatchCandidate[] = useMemo(() => {
    if (!normalizedRecords.length || !reconciled.length) return [];
    const fe = computeFilteredEde(normalizedRecords, reconciled, scope, coveredMonths, resolverIndex);
    const cands = findWeakMatches(fe.uniqueMembers, normalizedRecords);
    // Diagnostic: log so a future scope/dep mismatch is visible in console
    // immediately rather than presenting as an empty queue.
    // eslint-disable-next-line no-console
    console.debug('[ManualMatch] batch=%s scope=%s ee=%d candidates=%d',
      currentBatchId, scope, fe.uniqueMembers.length, cands.length);
    return cands;
  }, [normalizedRecords, reconciled, scope, coveredMonths, resolverIndex, currentBatchId]);

  const { pending, confirmedKeys, rejectedKeys } = useMemo(
    () => applyOverrides(candidates, overrides),
    [candidates, overrides]
  );

  const decide = async (
    c: WeakMatchCandidate,
    decision: 'confirmed' | 'rejected' | 'deferred',
  ) => {
    setBusyKey(c.override_key);
    try {
      await recordWeakMatchOverride({
        override_key: c.override_key,
        candidate_bo_member_key: c.boCandidate.member_key,
        candidate_bo_stable_key: c.boCandidate.stable_key,
        decision,
        signals: c.signals,
      });
      setSessionDecisions((n) => n + 1);
      await refreshOverrides();
      toast({
        title:
          decision === 'confirmed' ? 'Match confirmed'
          : decision === 'rejected' ? 'Match rejected'
          : 'Deferred',
        description:
          decision === 'confirmed'
            ? `${c.ede.applicant_name} → upgraded to Found-in-BO on next dashboard load.`
            : decision === 'rejected'
              ? `${c.ede.applicant_name} → moved to actionable Not-in-BO.`
              : `${c.ede.applicant_name} → kept in queue.`,
      });
    } catch (err: any) {
      toast({ title: 'Error saving decision', description: err.message, variant: 'destructive' });
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-foreground">Manual Match Review</h2>
          <p className="text-sm text-muted-foreground">
            {pending.length} weak BO match{pending.length === 1 ? '' : 'es'} awaiting review
            {' · '}
            <span className="text-success">{confirmedKeys.size} confirmed</span>
            {' · '}
            <span className="text-destructive">{rejectedKeys.size} rejected</span>
            {' · scope: '}<span className="font-medium">{scope}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          {sessionDecisions > 0 && (
            <Badge variant="secondary" className="gap-1">
              <Link2 className="h-3 w-3" />
              {sessionDecisions} override{sessionDecisions === 1 ? '' : 's'} this session
            </Badge>
          )}
          <Select value={scope} onValueChange={(v) => setScope(v as any)}>
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="Pay entity" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="Coverall">Coverall</SelectItem>
              <SelectItem value="Vix">Vix</SelectItem>
              <SelectItem value="All">All Combined</SelectItem>
            </SelectContent>
          </Select>
          <BatchSelector />
        </div>
      </div>

      <Card className="border-dashed">
        <CardContent className="px-4 py-3 text-xs text-muted-foreground">
          Weak match = an EE-universe member where the strict member_key join to Back Office failed
          BUT a BO record matches on at least 2 fuzzy signals (name, exchange sub ID, issuer sub ID,
          or policy number). Confirmed matches upgrade the member to Found-in-BO; rejected matches
          move them back to actionable Not-in-BO. Decisions persist across rebuilds via stable
          identifiers (issuer sub ID → exchange sub ID → policy #).
        </CardContent>
      </Card>

      {pending.length === 0 ? (
        <div className="text-center py-20">
          <CheckCircle2 className="h-12 w-12 text-success mx-auto mb-3" />
          <p className="text-muted-foreground">
            {candidates.length === 0
              ? 'No weak matches detected for this batch.'
              : 'All weak matches have been resolved. Good work!'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {pending.map((c) => (
            <Card key={c.override_key} className="border-border">
              <CardContent className="p-4 space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* EDE side */}
                  <div className="space-y-1">
                    <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      EDE Row (Expected Enrollment)
                    </div>
                    <div className="font-semibold">{c.ede.applicant_name || '—'}</div>
                    <div className="text-xs text-muted-foreground space-y-0.5">
                      <div>Policy: <span className="font-mono">{c.ede.policy_number || '—'}</span></div>
                      <div>Exchange Sub: <span className="font-mono">{c.ede.exchange_subscriber_id || '—'}</span></div>
                      <div>Issuer Sub: <span className="font-mono">{c.ede.issuer_subscriber_id || '—'}</span></div>
                      <div>AOR: {c.ede.current_policy_aor || '—'}</div>
                      <div>Effective: {c.ede.effective_date || '—'} · Status: {c.ede.policy_status || '—'}</div>
                    </div>
                  </div>
                  {/* BO candidate */}
                  <div className="space-y-1">
                    <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      Back Office Candidate
                    </div>
                    <div className="font-semibold">{c.boCandidate.applicant_name || '—'}</div>
                    <div className="text-xs text-muted-foreground space-y-0.5">
                      <div>Policy: <span className="font-mono">{c.boCandidate.policy_number || '—'}</span></div>
                      <div>Exchange Sub: <span className="font-mono">{c.boCandidate.exchange_subscriber_id || '—'}</span></div>
                      <div>Issuer Sub: <span className="font-mono">{c.boCandidate.issuer_subscriber_id || '—'}</span></div>
                      <div>AOR Bucket: {c.boCandidate.aor_bucket || '—'} · State: {c.boCandidate.state || '—'}</div>
                      <div>Eligible: {c.boCandidate.eligible_for_commission || '—'}</div>
                    </div>
                  </div>
                </div>

                {/* Signals */}
                <div className="flex flex-wrap items-center gap-1.5 text-xs border-t pt-2">
                  <span className="text-muted-foreground font-medium mr-1">Signals:</span>
                  {c.signals.matched.map((f) => (
                    <Badge key={f} variant="secondary" className="bg-success/15 text-success border-success/30">
                      ✓ {f}
                    </Badge>
                  ))}
                  {c.signals.differed.map((f) => (
                    <Badge key={f} variant="secondary" className="bg-destructive/15 text-destructive border-destructive/30">
                      ✗ {f}
                    </Badge>
                  ))}
                  {c.signals.unknown.map((f) => (
                    <Badge key={f} variant="outline" className="text-muted-foreground">
                      ? {f}
                    </Badge>
                  ))}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 pt-1">
                  <Button
                    size="sm"
                    variant="default"
                    disabled={busyKey === c.override_key}
                    onClick={() => decide(c, 'confirmed')}
                    className="bg-success hover:bg-success/90"
                  >
                    <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Confirm match
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={busyKey === c.override_key}
                    onClick={() => decide(c, 'rejected')}
                  >
                    <XCircle className="h-3.5 w-3.5 mr-1" /> Not the same
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busyKey === c.override_key}
                    onClick={() => decide(c, 'deferred')}
                  >
                    <Clock className="h-3.5 w-3.5 mr-1" /> Defer
                  </Button>
                  <span className="ml-auto text-[11px] text-muted-foreground font-mono">
                    {c.override_key}
                  </span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
