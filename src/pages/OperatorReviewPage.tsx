/**
 * C2b-2 — Operator Review.
 *
 * Stage 1: read-only projection via projectDiagnoseRoutes.
 * Stage 2: page render (table + filter + name enrichment).
 * Stage 3 (this file): HOLD actions per actionable row + explicit
 *   "Run cycle / apply releases" button.
 *
 * Hold actions land per route:
 *   premium            → hold_premium  (auto_premium)
 *   chase_eligible     → hold_premium  (auto_premium)
 *   dmi                → hold_dmi      (sticky_manual)
 *   prior_balance      → hold_prior_balance (sticky_manual)
 *   amount_discrepancy → hold_amount   (sticky_manual)
 *   manual_review      → hold_amount   (sticky_manual)
 *
 * Deferred (NOT rendered): add_to_chase, dismiss_cr_flag, scope_correct.
 *
 * Guards:
 *   OR1 — the row object is CAPTURED at click time so a refresh / re-sort
 *         cannot retarget the write to a different row.
 *   OR3 — reason_code is a SELECT bound to REASON_CODES_BY_TYPE; free text
 *         goes to internal_note only. validateDecisionInput throws surface
 *         as a failed write (error toast).
 *   OR4 — the per-row action button and the run-cycle button disable while
 *         their write/cycle is pending. No double-write, no overlapping
 *         cycle.
 *
 * After a successful write OR a successful cycle:
 *   invalidateOperatorDecisionCache() + re-project against current truth.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBatch } from '@/contexts/BatchContext';
import { useAllBatchesDataVersion } from '@/hooks/useBatchDataVersion';
import { useCrossBatchOverlay } from '@/hooks/useCrossBatchOverlay';
import { getAllNormalizedRecordsForMemberTimeline } from '@/lib/persistence';
import { getMtAllBatchProjection } from '@/lib/canonical/mtApprovedMceCache';
import { loadCarrierCompRates } from '@/lib/canonical/compGridLoader';
import { buildMonthList } from '@/lib/memberTimeline';
import { assembleDiagnoseRouteRows } from '@/lib/canonical/assembleDiagnoseRouteRows';
import {
  projectDiagnoseRoutes,
  runDiagnoseCycle,
  type DiagnoseRoutesProjection,
  type RouteRowInput,
  type RouteName,
} from '@/lib/canonical/diagnoseAndRoute';
import {
  deriveStableMemberKey,
  recordDecision,
  invalidateOperatorDecisionCache,
  REASON_CODES_BY_TYPE,
  type DecisionType,
  type ReleaseRule,
  type RecordDecisionInput,
} from '@/lib/canonical/operatorDecisions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Loader2, RefreshCw, AlertCircle, Inbox, Play } from 'lucide-react';
import { toast } from 'sonner';

const ACTIONABLE_ROUTES: ReadonlySet<RouteName> = new Set<RouteName>([
  'chase_eligible', 'premium', 'dmi', 'prior_balance', 'amount_discrepancy', 'manual_review',
]);

const ROUTE_VARIANT: Record<RouteName, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  satisfied: 'outline',
  chase_eligible: 'default',
  amount_discrepancy: 'destructive',
  premium: 'secondary',
  dmi: 'secondary',
  prior_balance: 'secondary',
  manual_review: 'destructive',
};

interface HoldActionSpec {
  decision_type: DecisionType;
  release_rule: ReleaseRule;
  defaultReason: string;
  label: string;
}

/** Hold action(s) valid per route. */
const HOLD_ACTIONS_BY_ROUTE: Record<RouteName, HoldActionSpec[]> = {
  satisfied: [],
  chase_eligible: [
    { decision_type: 'hold_premium', release_rule: 'auto_premium', defaultReason: 'awaiting_premium', label: 'Hold premium' },
  ],
  premium: [
    { decision_type: 'hold_premium', release_rule: 'auto_premium', defaultReason: 'awaiting_premium', label: 'Hold premium' },
  ],
  dmi: [
    { decision_type: 'hold_dmi', release_rule: 'sticky_manual', defaultReason: 'data_mismatch_investigation', label: 'Hold DMI' },
  ],
  prior_balance: [
    { decision_type: 'hold_prior_balance', release_rule: 'sticky_manual', defaultReason: 'prior_balance_owed', label: 'Hold prior balance' },
  ],
  amount_discrepancy: [
    { decision_type: 'hold_amount', release_rule: 'sticky_manual', defaultReason: 'amount_discrepancy', label: 'Hold amount' },
  ],
  manual_review: [
    { decision_type: 'hold_amount', release_rule: 'sticky_manual', defaultReason: 'amount_discrepancy', label: 'Hold amount' },
  ],
};

type Status = 'idle' | 'loading' | 'ready' | 'error';

interface HoldPromptState {
  row: RouteRowInput;             // OR1: captured at click time
  spec: HoldActionSpec;
  reasonCode: string;
  internalNote: string;
  submitting: boolean;
}

export default function OperatorReviewPage() {
  const { batches, resolverIndex } = useBatch();
  const allBatchesDataVersion = useAllBatchesDataVersion();
  const { overlay: clearingOverlay } = useCrossBatchOverlay();

  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<Error | null>(null);
  const [rows, setRows] = useState<RouteRowInput[]>([]);
  const [projection, setProjection] = useState<DiagnoseRoutesProjection | null>(null);
  const [nameByStableKey, setNameByStableKey] = useState<Map<string, string>>(new Map());
  const [showSatisfied, setShowSatisfied] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [prompt, setPrompt] = useState<HoldPromptState | null>(null);
  const [pendingRowKey, setPendingRowKey] = useState<string | null>(null);
  const [cycleRunning, setCycleRunning] = useState(false);
  const [lastCycleSummary, setLastCycleSummary] = useState<
    null | { applied: string[]; noopCount: number }
  >(null);
  const genRef = useRef(0);

  const { batchMonthByBatchIdObj, monthList, batchMonths } = useMemo(() => {
    const obj: Record<string, string> = {};
    const months: string[] = [];
    for (const b of batches) {
      const ym = b.statement_month ? String(b.statement_month).substring(0, 7) : '';
      if (b.id) obj[b.id] = ym;
      if (ym) months.push(ym);
    }
    months.sort();
    const start = months[0];
    const end = months[months.length - 1];
    return {
      batchMonthByBatchIdObj: obj,
      monthList: start && end ? buildMonthList(start, end) : [],
      batchMonths: Array.from(new Set(months)),
    };
  }, [batches]);

  useEffect(() => {
    if (batches.length === 0) return;
    genRef.current += 1;
    const myGen = genRef.current;
    const isLatest = () => myGen === genRef.current;

    (async () => {
      setStatus('loading');
      setError(null);
      try {
        const dedupCtx = { batchMonthByBatchId: batchMonthByBatchIdObj };
        const projectionResult = await getMtAllBatchProjection({
          allBatchesDataVersion,
          resolverIndex,
          loader: () => getAllNormalizedRecordsForMemberTimeline(dedupCtx),
        });
        if (!isLatest()) return;
        const projRecords = projectionResult.records || [];

        const yearFromMonth = Number((batchMonths[batchMonths.length - 1] ?? '').substring(0, 4));
        const effectiveYear = Number.isFinite(yearFromMonth) && yearFromMonth > 0
          ? yearFromMonth
          : 2026;
        let rateRows: Awaited<ReturnType<typeof loadCarrierCompRates>> = [];
        try {
          rateRows = await loadCarrierCompRates({ effectiveYear });
        } catch (e) {
          console.warn('OperatorReview: loadCarrierCompRates failed; resolver will return UNSUPPORTED.', e);
          rateRows = [];
        }
        if (!isLatest()) return;

        const today = (() => {
          const d = new Date();
          const y = d.getFullYear();
          const m = String(d.getMonth() + 1).padStart(2, '0');
          const day = String(d.getDate()).padStart(2, '0');
          return `${y}-${m}-${day}`;
        })();

        const assembled = assembleDiagnoseRouteRows({
          allBatchRecords: projRecords as any,
          monthList,
          serviceMonths: batchMonths,
          targetScopes: ['Coverall', 'Vix'],
          batchMonthByBatchId: batchMonthByBatchIdObj,
          today,
          rateRows,
          clearingOverlay,
        });
        if (!isLatest()) return;

        const proj = await projectDiagnoseRoutes({
          rows: assembled.rows,
          forceDecisionIndex: true,
        });
        if (!isLatest()) return;

        const nameMap = new Map<string, string>();
        for (const r of projRecords as any[]) {
          const stable = deriveStableMemberKey({
            carrier: r.carrier ?? null,
            issuer_subscriber_id: r.issuer_subscriber_id ?? null,
            exchange_subscriber_id: r.exchange_subscriber_id ?? null,
            policy_number: r.policy_number ?? null,
          });
          if (!stable) continue;
          if (!nameMap.has(stable) && r.applicant_name) {
            nameMap.set(stable, r.applicant_name);
          }
        }

        setRows(assembled.rows);
        setProjection(proj);
        setNameByStableKey(nameMap);
        setStatus('ready');
      } catch (err) {
        if (!isLatest()) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setStatus('error');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batches, allBatchesDataVersion, resolverIndex, refreshTick]);

  const visibleRows = useMemo(() => {
    if (!projection) return [] as RouteRowInput[];
    return rows.filter((r) => {
      const route = projection.routes.get(r.rowKey)?.route;
      if (!route) return false;
      return showSatisfied ? route === 'satisfied' : ACTIONABLE_ROUTES.has(route);
    });
  }, [rows, projection, showSatisfied]);

  /** Re-project against the CURRENT decision index (no write). */
  const reproject = useCallback(async () => {
    const snap = rows;
    if (snap.length === 0) return;
    const proj = await projectDiagnoseRoutes({ rows: snap, forceDecisionIndex: true });
    setProjection(proj);
  }, [rows]);

  const openHoldPrompt = useCallback((row: RouteRowInput, spec: HoldActionSpec) => {
    // OR1: capture the CLICKED row object at click time.
    setPrompt({ row, spec, reasonCode: spec.defaultReason, internalNote: '', submitting: false });
  }, []);

  const submitHold = useCallback(async () => {
    if (!prompt) return;
    if (pendingRowKey || cycleRunning) return; // OR4
    const { row, spec } = prompt;
    setPendingRowKey(row.rowKey);
    setPrompt({ ...prompt, submitting: true });
    const input: RecordDecisionInput = {
      identity: row.identity,
      service_month: row.serviceMonth,
      target_scope: row.targetScope,
      decision_type: spec.decision_type,
      reason_code: prompt.reasonCode,
      release_rule: spec.release_rule,
      internal_note: prompt.internalNote?.trim() ? prompt.internalNote.trim() : null,
    };
    try {
      await recordDecision(input);
      invalidateOperatorDecisionCache();
      await reproject();
      toast.success(`${spec.label} recorded`);
      setPrompt(null);
    } catch (err) {
      // OR3: validation/throw surfaces as a failed write.
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Hold failed: ${msg}`);
      setPrompt((p) => (p ? { ...p, submitting: false } : null));
    } finally {
      setPendingRowKey(null);
    }
  }, [prompt, pendingRowKey, cycleRunning, reproject]);

  const runCycle = useCallback(async () => {
    if (cycleRunning || pendingRowKey) return; // OR4
    if (rows.length === 0) return;
    setCycleRunning(true);
    try {
      const result = await runDiagnoseCycle({ rows });
      invalidateOperatorDecisionCache();
      await reproject();
      const applied = result.appliedReleases.map((r) => r.id);
      setLastCycleSummary({ applied, noopCount: result.observedNoopSignals.length });
      toast.success(
        `Cycle: ${applied.length} release(s), ${result.observedNoopSignals.length} no-op signal(s)`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Cycle failed: ${msg}`);
    } finally {
      setCycleRunning(false);
    }
  }, [rows, cycleRunning, pendingRowKey, reproject]);

  if (status === 'loading' || status === 'idle') {
    return (
      <div className="flex items-center justify-center py-20 text-muted-foreground">
        <Loader2 className="h-5 w-5 mr-2 animate-spin" />
        Loading operator review…
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="flex items-center gap-3 p-6 rounded-lg border border-destructive/40 bg-destructive/5">
        <AlertCircle className="h-5 w-5 text-destructive" />
        <div>
          <div className="text-sm font-semibold">Failed to load operator review</div>
          <div className="text-xs text-muted-foreground">{error?.message ?? 'Unknown error'}</div>
        </div>
      </div>
    );
  }

  const allowedReasonCodes = prompt ? REASON_CODES_BY_TYPE[prompt.spec.decision_type] : [];

  return (
    <TooltipProvider>
      <div className="space-y-4">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold tracking-tight">Operator Review</h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Read-only projection of the diagnose-and-route engine. Holds write
              through C0; "Run cycle" is the only path that applies releases.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant={showSatisfied ? 'default' : 'outline'}
              onClick={() => setShowSatisfied((v) => !v)}
              data-testid="filter-satisfied"
            >
              {showSatisfied ? 'Satisfied / FYI' : 'Actionable only'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setRefreshTick((t) => t + 1)}
              data-testid="refresh"
              disabled={cycleRunning || pendingRowKey !== null}
            >
              <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Refresh
            </Button>
            <Button
              size="sm"
              onClick={runCycle}
              data-testid="run-cycle"
              disabled={cycleRunning || pendingRowKey !== null}
            >
              {cycleRunning
                ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                : <Play className="h-3.5 w-3.5 mr-1.5" />}
              Run cycle / apply releases
            </Button>
          </div>
        </header>

        {lastCycleSummary && (
          <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs" data-testid="cycle-summary">
            <span className="font-medium">Last cycle:</span>{' '}
            applied {lastCycleSummary.applied.length} release(s)
            {lastCycleSummary.applied.length > 0 && (
              <> [{lastCycleSummary.applied.join(', ')}]</>
            )}
            {' '}· {lastCycleSummary.noopCount} no-op signal(s)
          </div>
        )}

        {visibleRows.length === 0 ? (
          <div className="flex items-center gap-2 p-6 rounded-lg border bg-card text-muted-foreground">
            <Inbox className="h-4 w-4" />
            <span className="text-sm">No rows match the current filter.</span>
          </div>
        ) : (
          <MirroredScrollTable>
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card shadow-[0_1px_0_0_hsl(var(--border))]">
                <TableRow>
                  <TableHead className="bg-card">Member</TableHead>
                  <TableHead className="bg-card">Scope</TableHead>
                  <TableHead className="bg-card">Service month</TableHead>
                  <TableHead className="bg-card">Pop</TableHead>
                  <TableHead className="bg-card">Route</TableHead>
                  <TableHead className="bg-card">Actions</TableHead>
                  <TableHead className="bg-card">FYI</TableHead>
                  <TableHead className="bg-card">Amount evidence</TableHead>
                  <TableHead className="bg-card">DMI</TableHead>
                  <TableHead className="bg-card">Premium / Count</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleRows.map((r) => {
                  const decision = projection!.routes.get(r.rowKey)!;
                  const fyi = projection!.fyi.get(r.rowKey) ?? [];
                  const name = nameByStableKey.get(r.stableMemberKey) ?? r.stableMemberKey;
                  const actions = HOLD_ACTIONS_BY_ROUTE[decision.route] ?? [];
                  const rowPending = pendingRowKey === r.rowKey;
                  const anyPending = pendingRowKey !== null || cycleRunning;
                  return (
                    <TableRow
                      key={r.rowKey}
                      data-testid="op-row"
                      data-route={decision.route}
                      data-row-key={r.rowKey}
                    >
                      <TableCell className="text-xs">
                        <div className="font-medium">{name}</div>
                        <div className="text-muted-foreground">{r.carrier}</div>
                      </TableCell>
                      <TableCell className="text-xs">{r.targetScope}</TableCell>
                      <TableCell className="text-xs">{r.serviceMonth}</TableCell>
                      <TableCell className="text-xs">{r.population}</TableCell>
                      <TableCell className="text-xs">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="inline-block">
                              <Badge variant={ROUTE_VARIANT[decision.route]} data-testid="route-badge">
                                {decision.route}
                              </Badge>
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>{decision.rationale}</TooltipContent>
                        </Tooltip>
                      </TableCell>
                      <TableCell className="text-xs space-x-1">
                        {actions.map((spec) => (
                          <Button
                            key={spec.decision_type}
                            size="sm"
                            variant="outline"
                            data-testid={`action-${spec.decision_type}`}
                            disabled={anyPending}
                            onClick={() => openHoldPrompt(r, spec)}
                          >
                            {rowPending
                              ? <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                              : null}
                            {spec.label}
                          </Button>
                        ))}
                      </TableCell>
                      <TableCell className="text-xs space-x-1">
                        {fyi.length === 0 ? <span className="text-muted-foreground">—</span> : null}
                        {fyi.map((f) => (
                          <Badge key={f} variant="outline" data-testid="fyi-badge">{f}</Badge>
                        ))}
                      </TableCell>
                      <TableCell className="text-xs">
                        <AmountEvidence facts={r.facts} />
                      </TableCell>
                      <TableCell className="text-xs">
                        <DmiEvidence facts={r.facts} />
                      </TableCell>
                      <TableCell className="text-xs">
                        <PremiumCountEvidence facts={r.facts} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </MirroredScrollTable>
        )}


        <Dialog open={prompt !== null} onOpenChange={(open) => { if (!open && !prompt?.submitting) setPrompt(null); }}>
          <DialogContent data-testid="hold-prompt">
            {prompt && (
              <>
                <DialogHeader>
                  <DialogTitle>{prompt.spec.label}</DialogTitle>
                  <DialogDescription>
                    {prompt.row.targetScope} · {prompt.row.serviceMonth} · {prompt.row.stableMemberKey}
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Reason code</Label>
                    <Select
                      value={prompt.reasonCode}
                      onValueChange={(v) => setPrompt((p) => (p ? { ...p, reasonCode: v } : null))}
                    >
                      <SelectTrigger data-testid="hold-reason-select"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {allowedReasonCodes.map((code) => (
                          <SelectItem key={code} value={code} data-testid={`reason-${code}`}>
                            {code}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Internal note (optional, free-text)</Label>
                    <Textarea
                      data-testid="hold-internal-note"
                      value={prompt.internalNote}
                      onChange={(e) => setPrompt((p) => (p ? { ...p, internalNote: e.target.value } : null))}
                      rows={3}
                    />
                  </div>
                </div>
                <DialogFooter>
                  <Button
                    variant="outline"
                    onClick={() => setPrompt(null)}
                    disabled={prompt.submitting}
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={submitHold}
                    disabled={prompt.submitting}
                    data-testid="hold-submit"
                  >
                    {prompt.submitting
                      ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                      : null}
                    Record hold
                  </Button>
                </DialogFooter>
              </>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </TooltipProvider>
  );
}

function AmountEvidence({ facts }: { facts: any }) {
  const a = facts?.amount;
  const ce = facts?.crossEntitySatisfied;
  if (a && a.kind === 'wrong_amount') {
    return <span>actual ${a.actual} ≠ expected ${a.expected}</span>;
  }
  if (a && a.kind === 'correct') return <span className="text-muted-foreground">target paid (correct)</span>;
  if (a && a.kind === 'indeterminate') return <span className="text-muted-foreground">indet: {a.reason}</span>;
  if (ce?.satisfied) {
    const s = ce.amountStatus;
    if (s?.kind === 'wrong_amount') return <span>cross-entity ${s.actual} ≠ ${s.expected}</span>;
    if (s?.kind === 'correct') return <span className="text-muted-foreground">cross-entity correct</span>;
    if (s?.kind === 'indeterminate') return <span className="text-muted-foreground">cross-entity indet: {s.reason}</span>;
    return <span className="text-muted-foreground">cross-entity</span>;
  }
  return <span className="text-muted-foreground">—</span>;
}

function DmiEvidence({ facts }: { facts: any }) {
  const d = facts?.dmi;
  if (!d?.active) return <span className="text-muted-foreground">—</span>;
  return (
    <span>
      {d.issueType ?? 'DMI'}{d.expired ? ' (expired)' : ''}
      {d.verificationEndDate ? ` · ${d.verificationEndDate}` : ''}
    </span>
  );
}

function PremiumCountEvidence({ facts }: { facts: any }) {
  const parts: string[] = [];
  if (facts?.premium?.kind && facts.premium.kind !== 'chase_candidate') parts.push(`premium: ${facts.premium.kind}`);
  if (facts?.memberCount?.status === 'manual_review') {
    parts.push(`count conflict: [${(facts.memberCount.conflicts ?? []).join(',')}]`);
  } else if (facts?.memberCount?.status === 'ok') {
    parts.push('count: ok');
  }
  return parts.length === 0
    ? <span className="text-muted-foreground">—</span>
    : <span>{parts.join(' · ')}</span>;
}

/**
 * Wraps a wide table with a mirrored top scrollbar that stays in sync with
 * the table's own bottom overflow-x scroll. Purely presentational.
 */
function MirroredScrollTable({ children }: { children: React.ReactNode }) {
  const topRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const [innerWidth, setInnerWidth] = useState(0);
  const syncing = useRef<'top' | 'bottom' | null>(null);

  useEffect(() => {
    const el = bottomRef.current;
    if (!el) return;
    const measure = () => setInnerWidth(el.scrollWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild as Element);
    return () => ro.disconnect();
  }, [children]);

  const onTopScroll = () => {
    if (syncing.current === 'bottom') { syncing.current = null; return; }
    if (!topRef.current || !bottomRef.current) return;
    syncing.current = 'top';
    bottomRef.current.scrollLeft = topRef.current.scrollLeft;
  };
  const onBottomScroll = () => {
    if (syncing.current === 'top') { syncing.current = null; return; }
    if (!topRef.current || !bottomRef.current) return;
    syncing.current = 'bottom';
    topRef.current.scrollLeft = bottomRef.current.scrollLeft;
  };

  return (
    <div className="border rounded-lg bg-card">
      <div
        ref={topRef}
        onScroll={onTopScroll}
        className="overflow-x-auto overflow-y-hidden"
        aria-hidden="true"
        data-testid="op-top-scrollbar"
      >
        <div style={{ width: innerWidth || 1, height: 1 }} />
      </div>
      <div
        ref={bottomRef}
        onScroll={onBottomScroll}
        className="overflow-x-auto max-h-[70vh] overflow-y-auto"
        data-testid="op-table-scroll"
      >
        {children}
      </div>
    </div>
  );
}

