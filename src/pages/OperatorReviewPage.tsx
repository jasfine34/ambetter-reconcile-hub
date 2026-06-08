/**
 * C2b-2 — Operator Review (read-only on load).
 *
 * Mirrors the MCE async boundary:
 *   1. useBatch + useAllBatchesDataVersion + useCrossBatchOverlay supply
 *      the cached all-batch projection inputs.
 *   2. getMtAllBatchProjection reuses the SAME memoized projection MCE uses
 *      (no second all-batch loader).
 *   3. loadCarrierCompRates feeds the headless assembler.
 *   4. assembleDiagnoseRouteRows composes the certified MT helpers into
 *      RouteRowInput[] (no helper edits).
 *   5. projectDiagnoseRoutes({ rows, forceDecisionIndex: true }) routes
 *      against the CURRENT decision index — READ-ONLY. NEVER calls
 *      runDiagnoseCycle (no C0 writes on mount).
 *
 * Stage 2 of 3 — actions (hold buttons + run-cycle) land in Stage 3.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
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
  type DiagnoseRoutesProjection,
  type RouteRowInput,
  type RouteName,
} from '@/lib/canonical/diagnoseAndRoute';
import { deriveStableMemberKey } from '@/lib/canonical/operatorDecisions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Loader2, RefreshCw, AlertCircle, Inbox } from 'lucide-react';

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

type Status = 'idle' | 'loading' | 'ready' | 'error';

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
  const genRef = useRef(0);

  // Build batch-month maps + monthList (MCE pattern).
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

  // Main load (deps include refreshTick for explicit Refresh button).
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

        // READ-ONLY projection — current decision index, no C0 writes.
        const proj = await projectDiagnoseRoutes({
          rows: assembled.rows,
          forceDecisionIndex: true,
        });
        if (!isLatest()) return;

        // Enrich names: stableMemberKey → applicant_name from projection.records.
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

  return (
    <TooltipProvider>
      <div className="space-y-4">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold tracking-tight">Operator Review</h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Read-only projection of the diagnose-and-route engine over the current decision index.
              Actions land in Stage 3.
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
            >
              <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Refresh
            </Button>
          </div>
        </header>

        {visibleRows.length === 0 ? (
          <div className="flex items-center gap-2 p-6 rounded-lg border bg-card text-muted-foreground">
            <Inbox className="h-4 w-4" />
            <span className="text-sm">No rows match the current filter.</span>
          </div>
        ) : (
          <div className="border rounded-lg bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Member</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead>Service month</TableHead>
                  <TableHead>Pop</TableHead>
                  <TableHead>Route</TableHead>
                  <TableHead>FYI</TableHead>
                  <TableHead>Amount evidence</TableHead>
                  <TableHead>DMI</TableHead>
                  <TableHead>Premium / Count</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleRows.map((r) => {
                  const decision = projection!.routes.get(r.rowKey)!;
                  const fyi = projection!.fyi.get(r.rowKey) ?? [];
                  const name = nameByStableKey.get(r.stableMemberKey) ?? r.stableMemberKey;
                  return (
                    <TableRow key={r.rowKey} data-testid="op-row" data-route={decision.route}>
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
                            <Badge variant={ROUTE_VARIANT[decision.route]} data-testid="route-badge">
                              {decision.route}
                            </Badge>
                          </TooltipTrigger>
                          <TooltipContent>{decision.rationale}</TooltipContent>
                        </Tooltip>
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
          </div>
        )}
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
