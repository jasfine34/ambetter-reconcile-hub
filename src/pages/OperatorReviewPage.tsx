/**
 * C2b-2 — Operator Review.
 *
 * C2c adds (presentation-only):
 *   - Reason-typed filter CHIPS with disjoint counts (replaces the binary
 *     Actionable/Satisfied toggle).
 *   - DMI work-surface controls (issue-type chips, status subfilter,
 *     deadline sort) when the DMI chip is selected.
 *   - Per-row evidence DRAWER (lean explainCell trace + route facts).
 *
 * Hold action handlers, the hold Dialog, OR1/OR3/OR4 guards, runCycle,
 * reproject, the read-only-load contract, MirroredScrollTable + sticky
 * header — all unchanged. Only write path remains the existing hold
 * recordDecision.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBatch } from '@/contexts/BatchContext';
import { useAllBatchesDataVersion } from '@/hooks/useBatchDataVersion';
import { useCrossBatchOverlay } from '@/hooks/useCrossBatchOverlay';
import { getAllNormalizedRecordsForMemberTimeline } from '@/lib/persistence';
import { getMtAllBatchProjection } from '@/lib/canonical/mtApprovedMceCache';
import { loadCarrierCompRates } from '@/lib/canonical/compGridLoader';
import { buildMonthList } from '@/lib/memberTimeline';
import {
  assembleDiagnoseRouteRows,
  type AssembleDiagnoseRouteRowsResult,
} from '@/lib/canonical/assembleDiagnoseRouteRows';
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
import { explainCell as defaultExplainCell } from '@/lib/explainCell';
import type { CellTrace } from '@/lib/explainCellTypes';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from '@/components/ui/sheet';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import {
  Loader2, RefreshCw, AlertCircle, Inbox, Play, FileSearch, Info,
  ChevronRight, ChevronDown, X, Download,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  assembleCommissionSubmission,
} from '@/lib/canonical/assembleCommissionSubmission';
import {
  buildCommissionSubmissionCsv,
  toCommissionSubmissionCsvRow,
} from '@/lib/canonical/commissionSubmissionCsv';
import type { NormalizedRecord } from '@/lib/normalize';
import type { CarrierCompRateRow } from '@/lib/canonical/compGrid';
import { WideDataTable } from '@/components/WideDataTable';

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

type FilterKey =
  | 'all_actionable'
  | 'chase'
  | 'premium'
  | 'amount'
  | 'prior_balance'
  | 'dmi'
  | 'manual_review'
  | 'satisfied';

interface HoldPromptState {
  row: RouteRowInput;
  spec: HoldActionSpec;
  reasonCode: string;
  internalNote: string;
  submitting: boolean;
}

interface DrawerState {
  row: RouteRowInput;
  loading: boolean;
  trace: CellTrace | null;
  error: string | null;
}

// C2c — DMI issue-type groupings.
const DMI_GROUPS = [
  'NONESCMEC',
  'ANNUAL_INCOME',
  'CITIZENSHIP',
  'SSN',
  'ESCMEC',
  'QHP_LAWFUL_PRESENCE',
  'LOSS_OF_MEC_SEP',
] as const;
type DmiGroup = (typeof DMI_GROUPS)[number] | 'Other';

function tokenizeIssueType(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split('|')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

function groupForToken(t: string): DmiGroup {
  const upper = t.toUpperCase();
  for (const g of DMI_GROUPS) {
    if (upper.includes(g)) return g;
  }
  return 'Other';
}

function groupsForRow(row: RouteRowInput): DmiGroup[] {
  const tokens = tokenizeIssueType((row.facts as any)?.dmi?.issueType ?? null);
  if (tokens.length === 0) return [];
  const seen = new Set<DmiGroup>();
  for (const t of tokens) seen.add(groupForToken(t));
  return Array.from(seen);
}

interface Buckets {
  chase: Set<string>;
  premium: Set<string>;
  amount: Set<string>;
  prior_balance: Set<string>;
  dmi: Set<string>;
  manual_review: Set<string>;
  satisfied: Set<string>;
  all_actionable: Set<string>;
}

function computeBuckets(proj: DiagnoseRoutesProjection): Buckets {
  const fyi = proj.fyi;
  const mrDmi: string[] = [];
  const mrOther: string[] = [];
  for (const k of proj.queues.manual_review ?? []) {
    const tags = fyi.get(k) ?? [];
    if (tags.includes('dmi_expired')) mrDmi.push(k);
    else mrOther.push(k);
  }
  const dmi = new Set<string>([...(proj.queues.dmi ?? []), ...mrDmi]);
  const manual_review = new Set<string>(mrOther);
  const chase = new Set<string>(proj.chaseEligible ?? []);
  const premium = new Set<string>(proj.queues.premium ?? []);
  const amount = new Set<string>(proj.queues.amount_discrepancy ?? []);
  const prior_balance = new Set<string>(proj.queues.prior_balance ?? []);
  const satisfied = new Set<string>(proj.satisfied ?? []);
  const all_actionable = new Set<string>([
    ...chase, ...premium, ...amount, ...prior_balance, ...dmi, ...manual_review,
  ]);
  return { chase, premium, amount, prior_balance, dmi, manual_review, satisfied, all_actionable };
}

const CHIP_DEFS: Array<{ key: FilterKey; label: string; testid: string }> = [
  { key: 'all_actionable', label: 'All actionable', testid: 'filter-all_actionable' },
  { key: 'chase', label: 'Chase', testid: 'filter-chase' },
  { key: 'premium', label: 'Premium', testid: 'filter-premium' },
  { key: 'amount', label: 'Amount', testid: 'filter-amount' },
  { key: 'prior_balance', label: 'Prior balance', testid: 'filter-prior_balance' },
  { key: 'dmi', label: 'DMI', testid: 'filter-dmi' },
  { key: 'manual_review', label: 'Manual review', testid: 'filter-manual_review' },
  // NOTE: the satisfied chip retains the legacy testid for back-compat.
  { key: 'satisfied', label: 'Satisfied / FYI', testid: 'filter-satisfied' },
];

const CHIP_TOOLTIPS: Record<FilterKey, string> = {
  all_actionable:
    'Every member-month that still needs a decision — all buckets except Satisfied.',
  chase:
    "Unpaid commission that's owed and ready to chase — premium is satisfied (or it's a $0 net-premium / fully-subsidized plan) and nothing is blocking it. Zero-net-premium plans appear here as dispute candidates.",
  premium:
    "Held because the member owes a positive premium that hasn't been paid yet (net premium > 0 and back-office paid-through is before the service month). Not chaseable until premium is paid. This is NOT zero-net-premium — those are chaseable and appear under Chase.",
  amount:
    'A payment exists but the amount is wrong — actual does not equal expected (amount discrepancy).',
  prior_balance:
    'Manually held because the member owes a prior balance.',
  dmi:
    'An open data-matching / verification issue (DMI) on the enrollment for an unpaid month. Expired DMIs appear here as a sub-state.',
  manual_review:
    'Signals are inconclusive and need a human — e.g., expired DMIs or member-count conflicts.',
  satisfied:
    'Already resolved — paid correctly or satisfied cross-entity. No action needed; FYI flags are shown for awareness.',
};

interface OperatorReviewPageProps {
  /** Test seam — defaults to the real explainCell. */
  explainCellFn?: typeof defaultExplainCell;
}

export default function OperatorReviewPage(props: OperatorReviewPageProps = {}) {
  const explainCellFn = props.explainCellFn ?? defaultExplainCell;

  const { batches, resolverIndex } = useBatch();
  const allBatchesDataVersion = useAllBatchesDataVersion();
  const { overlay: clearingOverlay } = useCrossBatchOverlay();

  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<Error | null>(null);
  const [rows, setRows] = useState<RouteRowInput[]>([]);
  const [projection, setProjection] = useState<DiagnoseRoutesProjection | null>(null);
  // C2c — retain widened assembler evidence in page state.
  const [evidence, setEvidence] = useState<Pick<
    AssembleDiagnoseRouteRowsResult,
    'evidenceBindingsByRowKey' | 'pickerMapsByMemberKey' | 'traceContextByScope'
  > | null>(null);
  const [nameByStableKey, setNameByStableKey] = useState<Map<string, string>>(new Map());
  const [selectedFilter, setSelectedFilter] = useState<FilterKey>('all_actionable');
  const [refreshTick, setRefreshTick] = useState(0);
  const [prompt, setPrompt] = useState<HoldPromptState | null>(null);
  const [pendingRowKey, setPendingRowKey] = useState<string | null>(null);
  const [cycleRunning, setCycleRunning] = useState(false);
  const [lastCycleSummary, setLastCycleSummary] = useState<
    null | { applied: string[]; noopCount: number }
  >(null);
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  // DMI work-surface controls.
  const [dmiStatus, setDmiStatus] = useState<'all' | 'open' | 'expired' | 'in_progress'>('all');
  const [dmiGroupFilter, setDmiGroupFilter] = useState<Set<DmiGroup>>(new Set());
  const [dmiSortDeadline, setDmiSortDeadline] = useState(false);

  // C2c slice 1 — member search + per-member expand.
  const [search, setSearch] = useState('');
  const [expandedMembers, setExpandedMembers] = useState<Set<string>>(new Set());

  const genRef = useRef(0);
  // C3b-2 — REF-retained inputs for the commission-submission download.
  // Populated by the load effect AFTER projRecords + rateRows + today are
  // computed; the download path NEVER re-fetches the all-batch projection.
  const submissionInputsRef = useRef<{
    allBatchRecords: NormalizedRecord[];
    rateRows: CarrierCompRateRow[];
    today: string;
  } | null>(null);
  const [submissionInputsReady, setSubmissionInputsReady] = useState(false);
  const [downloadingSubmission, setDownloadingSubmission] = useState(false);

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
        setEvidence({
          evidenceBindingsByRowKey: assembled.evidenceBindingsByRowKey ?? new Map(),
          pickerMapsByMemberKey: assembled.pickerMapsByMemberKey ?? new Map(),
          traceContextByScope: assembled.traceContextByScope ?? new Map(),
        });
        setNameByStableKey(nameMap);
        // C3b-2 — retain the load effect's inputs in a REF (not render state)
        // so the download path can call assembleCommissionSubmission WITHOUT
        // re-running getAllNormalizedRecordsForMemberTimeline.
        submissionInputsRef.current = {
          allBatchRecords: projRecords as NormalizedRecord[],
          rateRows,
          today,
        };
        setSubmissionInputsReady(true);
        setStatus('ready');
      } catch (err) {
        if (!isLatest()) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setStatus('error');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batches, allBatchesDataVersion, resolverIndex, refreshTick]);

  const buckets = useMemo<Buckets | null>(
    () => (projection ? computeBuckets(projection) : null),
    [projection],
  );

  const rowsByKey = useMemo(() => {
    const m = new Map<string, RouteRowInput>();
    for (const r of rows) m.set(r.rowKey, r);
    return m;
  }, [rows]);

  const visibleRows = useMemo(() => {
    if (!projection || !buckets) return [] as RouteRowInput[];
    const set = buckets[selectedFilter];
    let result = rows.filter((r) => set.has(r.rowKey));

    if (selectedFilter === 'dmi') {
      // Issue-type group filter (empty → no filter).
      if (dmiGroupFilter.size > 0) {
        result = result.filter((r) => {
          const gs = groupsForRow(r);
          for (const g of gs) if (dmiGroupFilter.has(g)) return true;
          return false;
        });
      }
      // Status subfilter.
      if (dmiStatus !== 'all') {
        const fyi = projection.fyi;
        result = result.filter((r) => {
          const d = (r.facts as any)?.dmi;
          if (dmiStatus === 'open') return Boolean(d?.active && d?.surfaceEligible && !d?.expired);
          if (dmiStatus === 'in_progress') return d?.inProgress === true;
          if (dmiStatus === 'expired') {
            const tags = fyi.get(r.rowKey) ?? [];
            return tags.includes('dmi_expired');
          }
          return true;
        });
      }
      // Deadline sort: ascending by verificationEndDate; expired first;
      // missing date last.
      if (dmiSortDeadline) {
        const fyi = projection.fyi;
        const isExpired = (r: RouteRowInput) =>
          (fyi.get(r.rowKey) ?? []).includes('dmi_expired')
          || Boolean((r.facts as any)?.dmi?.expired);
        result = [...result].sort((a, b) => {
          const ae = isExpired(a) ? 0 : 1;
          const be = isExpired(b) ? 0 : 1;
          if (ae !== be) return ae - be;
          const ad = (a.facts as any)?.dmi?.verificationEndDate as string | null | undefined;
          const bd = (b.facts as any)?.dmi?.verificationEndDate as string | null | undefined;
          if (!ad && !bd) return 0;
          if (!ad) return 1;
          if (!bd) return -1;
          return ad < bd ? -1 : ad > bd ? 1 : 0;
        });
      }
    }
    return result;
  }, [rows, projection, buckets, selectedFilter, dmiStatus, dmiGroupFilter, dmiSortDeadline]);

  // Present DMI groups across the current DMI bucket (for chip listing).
  const presentDmiGroups = useMemo<DmiGroup[]>(() => {
    if (!buckets) return [];
    const seen = new Set<DmiGroup>();
    for (const k of buckets.dmi) {
      const r = rowsByKey.get(k);
      if (!r) continue;
      for (const g of groupsForRow(r)) seen.add(g);
    }
    return ([...DMI_GROUPS, 'Other'] as DmiGroup[]).filter((g) => seen.has(g));
  }, [buckets, rowsByKey]);

  // C2c slice 1 — apply member search AFTER bucket+DMI filtering, BEFORE grouping.
  const searchActive = search.trim().length > 0;
  const searchedRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return visibleRows;
    return visibleRows.filter((r) => {
      const name = nameByStableKey.get(r.stableMemberKey);
      const id: any = r.identity ?? {};
      const fields: Array<string | null | undefined> = [
        name,
        id.issuer_subscriber_id,
        id.exchange_subscriber_id,
        id.policy_number,
        r.stableMemberKey,
      ];
      for (const f of fields) {
        if (f != null && String(f).toLowerCase().includes(q)) return true;
      }
      return false;
    });
  }, [visibleRows, search, nameByStableKey]);

  // Group searchedRows by stableMemberKey, preserving FIRST-APPEARANCE order.
  // Within a member: sort by serviceMonth asc, then targetScope.
  const memberGroups = useMemo(() => {
    const order: string[] = [];
    const map = new Map<string, RouteRowInput[]>();
    for (const r of searchedRows) {
      const k = r.stableMemberKey;
      if (!map.has(k)) {
        map.set(k, []);
        order.push(k);
      }
      map.get(k)!.push(r);
    }
    for (const k of order) {
      map.get(k)!.sort((a, b) => {
        if (a.serviceMonth !== b.serviceMonth) {
          return a.serviceMonth < b.serviceMonth ? -1 : 1;
        }
        return a.targetScope < b.targetScope ? -1 : a.targetScope > b.targetScope ? 1 : 0;
      });
    }
    return order.map((k) => ({ stableMemberKey: k, rows: map.get(k)! }));
  }, [searchedRows]);

  const isMemberExpanded = useCallback(
    (k: string) => searchActive || expandedMembers.has(k),
    [searchActive, expandedMembers],
  );
  const toggleMember = useCallback((k: string) => {
    setExpandedMembers((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }, []);
  const expandAllDisplayed = useCallback(() => {
    setExpandedMembers((prev) => {
      const next = new Set(prev);
      for (const g of memberGroups) {
        if (g.rows.length > 1) next.add(g.stableMemberKey);
      }
      return next;
    });
  }, [memberGroups]);
  const collapseAllDisplayed = useCallback(() => {
    setExpandedMembers((prev) => {
      const next = new Set(prev);
      for (const g of memberGroups) next.delete(g.stableMemberKey);
      return next;
    });
  }, [memberGroups]);


  /** Re-project against the CURRENT decision index (no write). */
  const reproject = useCallback(async () => {
    const snap = rows;
    if (snap.length === 0) return;
    const proj = await projectDiagnoseRoutes({ rows: snap, forceDecisionIndex: true });
    setProjection(proj);
  }, [rows]);

  const openHoldPrompt = useCallback((row: RouteRowInput, spec: HoldActionSpec) => {
    setPrompt({ row, spec, reasonCode: spec.defaultReason, internalNote: '', submitting: false });
  }, []);

  const submitHold = useCallback(async () => {
    if (!prompt) return;
    if (pendingRowKey || cycleRunning) return;
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
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Hold failed: ${msg}`);
      setPrompt((p) => (p ? { ...p, submitting: false } : null));
    } finally {
      setPendingRowKey(null);
    }
  }, [prompt, pendingRowKey, cycleRunning, reproject]);

  const runCycle = useCallback(async () => {
    if (cycleRunning || pendingRowKey) return;
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

  // C3b-2 — Commission-submission CSV download.
  // Uses the REF-retained load inputs ONLY — never triggers a fresh
  // getAllNormalizedRecordsForMemberTimeline call. Writes nothing.
  const downloadCommissionSubmission = useCallback(async () => {
    const inputs = submissionInputsRef.current;
    if (!inputs) return;
    if (downloadingSubmission || cycleRunning || pendingRowKey) return;
    setDownloadingSubmission(true);
    try {
      const preview = await assembleCommissionSubmission({
        allBatchRecords: inputs.allBatchRecords,
        monthList,
        serviceMonths: batchMonths,
        targetScopes: ['Coverall', 'Vix'],
        batchMonthByBatchId: batchMonthByBatchIdObj,
        today: inputs.today,
        rateRows: inputs.rateRows,
        clearingOverlay,
      });
      const csv = buildCommissionSubmissionCsv(
        preview.rows.map(toCommissionSubmissionCsvRow),
      );
      const first = batchMonths[0] ?? '';
      const last = batchMonths[batchMonths.length - 1] ?? first;
      const stamp = (() => {
        const d = new Date();
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}${m}${day}`;
      })();
      const filename = `commission-submission-ambetter-${first}_${last}-${stamp}.csv`;
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success(`Downloaded ${preview.rows.length} submission row(s)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Download failed: ${msg}`);
    } finally {
      setDownloadingSubmission(false);
    }
  }, [
    downloadingSubmission, cycleRunning, pendingRowKey,
    monthList, batchMonths, batchMonthByBatchIdObj, clearingOverlay,
  ]);

  const openEvidence = useCallback(
    async (row: RouteRowInput) => {
      if (!evidence) {
        toast.error('Evidence binding not yet loaded.');
        return;
      }
      const binding = evidence.evidenceBindingsByRowKey.get(row.rowKey);
      const scopeCtx = evidence.traceContextByScope.get(row.targetScope);
      if (!binding || !scopeCtx) {
        toast.error('No evidence binding for this row.');
        return;
      }
      const preloadedRecords =
        scopeCtx.scopedRecordsByMemberKey.get(binding.memberKey) ?? [];
      const pickerForMember = evidence.pickerMapsByMemberKey.get(binding.memberKey);
      const preloadedContext = {
        ...(scopeCtx.baseClassifierContext as any),
        pickerEdeByMonth: pickerForMember,
      };
      setDrawer({ row, loading: true, trace: null, error: null });
      try {
        const trace = await explainCellFn({
          memberKey: binding.memberKey,
          monthKey: row.serviceMonth,
          scope: row.targetScope as 'Coverall' | 'Vix',
          preloadedRecords,
          preloadedContext,
        });
        setDrawer({ row, loading: false, trace, error: null });
      } catch (err) {
        setDrawer({
          row,
          loading: false,
          trace: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [evidence, explainCellFn],
  );

  const toggleDmiGroup = (g: DmiGroup) => {
    setDmiGroupFilter((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });
  };

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
              variant="outline"
              onClick={() => setRefreshTick((t) => t + 1)}
              data-testid="refresh"
              disabled={cycleRunning || pendingRowKey !== null}
            >
              <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Refresh
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={downloadCommissionSubmission}
              data-testid="download-commission-submission"
              disabled={
                !submissionInputsReady
                || downloadingSubmission
                || cycleRunning
                || pendingRowKey !== null
              }
              title={
                !submissionInputsReady
                  ? 'Submission inputs still loading…'
                  : 'Download Ambetter commission submission CSV (all batch months)'
              }
            >
              {downloadingSubmission
                ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                : <Download className="h-3.5 w-3.5 mr-1.5" />}
              Download commission submission (CSV)
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

        {buckets && (
          <div className="flex flex-wrap gap-2" data-testid="filter-chips">
            {CHIP_DEFS.map((c) => {
              const count = buckets[c.key].size;
              const active = selectedFilter === c.key;
              return (
                <div key={c.key} className="inline-flex items-center">
                  <Button
                    size="sm"
                    variant={active ? 'default' : 'outline'}
                    onClick={() => setSelectedFilter(c.key)}
                    data-testid={c.testid}
                    data-count={count}
                    data-active={active ? 'true' : 'false'}
                    className="rounded-r-none"
                  >
                    {c.label}
                    <span className="ml-1.5 inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-muted px-1.5 text-[10px] font-semibold text-foreground">
                      {count}
                    </span>
                  </Button>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label={`About ${c.label}`}
                        data-testid={`chip-info-${c.key}`}
                        className="inline-flex h-8 w-7 items-center justify-center rounded-r-md border border-l-0 border-input bg-background text-muted-foreground hover:text-foreground"
                      >
                        <Info className="h-3.5 w-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs text-xs leading-snug">
                      {CHIP_TOOLTIPS[c.key]}
                    </TooltipContent>
                  </Tooltip>
                </div>
              );
            })}
          </div>
        )}

        {/* C2c slice 1 — member search + expand/collapse all */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Input
              data-testid="member-search"
              type="text"
              placeholder="Search by name, subscriber id, policy…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 w-72 text-xs pr-7"
            />
            {search.length > 0 && (
              <button
                type="button"
                aria-label="Clear search"
                data-testid="member-search-clear"
                onClick={() => setSearch('')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={expandAllDisplayed}
            data-testid="expand-all"
            disabled={searchActive}
            title={searchActive ? 'Search auto-expands matching groups' : undefined}
          >
            Expand all
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={collapseAllDisplayed}
            data-testid="collapse-all"
            disabled={searchActive}
          >
            Collapse all
          </Button>
        </div>


        {selectedFilter === 'dmi' && (
          <div
            className="rounded-md border bg-card p-3 space-y-3"
            data-testid="dmi-controls"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold text-muted-foreground mr-1">Status:</span>
              {(['all', 'open', 'expired', 'in_progress'] as const).map((s) => (
                <Button
                  key={s}
                  size="sm"
                  variant={dmiStatus === s ? 'default' : 'outline'}
                  onClick={() => setDmiStatus(s)}
                  data-testid={`dmi-status-${s}`}
                >
                  {s.replace('_', ' ')}
                </Button>
              ))}
              <span className="mx-2 h-4 w-px bg-border" />
              <Button
                size="sm"
                variant={dmiSortDeadline ? 'default' : 'outline'}
                onClick={() => setDmiSortDeadline((v) => !v)}
                data-testid="dmi-sort-deadline"
              >
                Sort by deadline {dmiSortDeadline ? '↑' : ''}
              </Button>
            </div>
            {presentDmiGroups.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold text-muted-foreground mr-1">Issue type:</span>
                {presentDmiGroups.map((g) => (
                  <Button
                    key={g}
                    size="sm"
                    variant={dmiGroupFilter.has(g) ? 'default' : 'outline'}
                    onClick={() => toggleDmiGroup(g)}
                    data-testid={`dmi-group-${g}`}
                  >
                    {g}
                  </Button>
                ))}
                {dmiGroupFilter.size > 0 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setDmiGroupFilter(new Set())}
                    data-testid="dmi-group-clear"
                  >
                    Clear
                  </Button>
                )}
              </div>
            )}
          </div>
        )}

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
        ) : searchedRows.length === 0 ? (
          <div
            className="flex items-center gap-2 p-6 rounded-lg border bg-card text-muted-foreground"
            data-testid="search-no-results"
          >
            <Inbox className="h-4 w-4" />
            <span className="text-sm">
              No rows match “{search}” within the current filter.
            </span>
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
                  <TableHead className="bg-card">Evidence</TableHead>
                  <TableHead className="bg-card">FYI</TableHead>
                  <TableHead className="bg-card">Amount evidence</TableHead>
                  <TableHead className="bg-card">DMI</TableHead>
                  <TableHead className="bg-card">Premium / Count</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {memberGroups.map((group) => {
                  const expanded = isMemberExpanded(group.stableMemberKey);
                  const hiddenCount = group.rows.length - 1;
                  const renderRow = (r: RouteRowInput, opts: { isFirst: boolean }) => {
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
                        data-group-first={opts.isFirst ? 'true' : 'false'}
                      >
                        <TableCell className="text-xs">
                          <div className="flex items-start gap-1.5">
                            {opts.isFirst && group.rows.length > 1 ? (
                              <button
                                type="button"
                                data-testid="member-toggle"
                                data-member-key={group.stableMemberKey}
                                aria-expanded={expanded}
                                aria-label={expanded ? 'Collapse member' : 'Expand member'}
                                onClick={() => toggleMember(group.stableMemberKey)}
                                disabled={searchActive}
                                title={searchActive ? 'Auto-expanded while searching' : undefined}
                                className="mt-0.5 inline-flex h-5 items-center gap-1 rounded border border-input bg-background px-1.5 text-[10px] font-semibold text-foreground hover:bg-accent disabled:opacity-60"
                              >
                                {expanded ? (
                                  <ChevronDown className="h-3 w-3" />
                                ) : (
                                  <ChevronRight className="h-3 w-3" />
                                )}
                                +{hiddenCount}
                              </button>
                            ) : !opts.isFirst ? (
                              <span className="mt-0.5 inline-block w-4 border-l border-border" aria-hidden="true" />
                            ) : null}
                            <div>
                              <div className="font-medium">{name}</div>
                              <div className="text-muted-foreground">{r.carrier}</div>
                            </div>
                          </div>
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
                        <TableCell className="text-xs">
                          <Button
                            size="sm"
                            variant="ghost"
                            data-testid="open-evidence"
                            onClick={() => openEvidence(r)}
                          >
                            <FileSearch className="h-3.5 w-3.5 mr-1" />
                            Evidence
                          </Button>
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
                  };
                  const [first, ...rest] = group.rows;
                  return (
                    <React.Fragment key={group.stableMemberKey}>
                      {renderRow(first, { isFirst: true })}
                      {expanded && rest.map((r) => renderRow(r, { isFirst: false }))}
                    </React.Fragment>
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

        <Sheet open={drawer !== null} onOpenChange={(open) => { if (!open) setDrawer(null); }}>
          <SheetContent
            side="right"
            className="w-[640px] sm:max-w-[640px] overflow-y-auto"
            data-testid="evidence-drawer"
          >
            {drawer && (
              <>
                <SheetHeader>
                  <SheetTitle>Row evidence</SheetTitle>
                  <SheetDescription>
                    {drawer.row.targetScope} · {drawer.row.serviceMonth} · {drawer.row.stableMemberKey}
                  </SheetDescription>
                </SheetHeader>
                <div className="mt-4 space-y-4 text-xs">
                  <section>
                    <div className="font-semibold mb-1">Route</div>
                    <div data-testid="drawer-route">
                      <Badge variant={ROUTE_VARIANT[projection!.routes.get(drawer.row.rowKey)?.route ?? 'manual_review']}>
                        {projection!.routes.get(drawer.row.rowKey)?.route}
                      </Badge>
                      <span className="ml-2 text-muted-foreground">
                        {projection!.routes.get(drawer.row.rowKey)?.rationale}
                      </span>
                    </div>
                    {(projection!.fyi.get(drawer.row.rowKey) ?? []).length > 0 && (
                      <div className="mt-2 space-x-1" data-testid="drawer-fyi">
                        {(projection!.fyi.get(drawer.row.rowKey) ?? []).map((f) => (
                          <Badge key={f} variant="outline">{f}</Badge>
                        ))}
                      </div>
                    )}
                  </section>
                  <section data-testid="drawer-facts">
                    <div className="font-semibold mb-1">Route facts</div>
                    <pre className="text-[11px] bg-muted/40 rounded p-2 overflow-x-auto whitespace-pre-wrap">
{JSON.stringify({
  dmi: (drawer.row.facts as any)?.dmi,
  premium: (drawer.row.facts as any)?.premium,
  amount: (drawer.row.facts as any)?.amount,
  crossEntitySatisfied: (drawer.row.facts as any)?.crossEntitySatisfied,
  memberCount: (drawer.row.facts as any)?.memberCount,
}, null, 2)}
                    </pre>
                  </section>
                  <section data-testid="drawer-trace">
                    <div className="font-semibold mb-1">MT trace (explainCell)</div>
                    {drawer.loading && (
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" /> Loading trace…
                      </div>
                    )}
                    {drawer.error && (
                      <div className="text-destructive">Failed: {drawer.error}</div>
                    )}
                    {drawer.trace && (
                      <div className="space-y-2">
                        <div>
                          <span className="font-medium">State:</span> {drawer.trace.final.state}
                          {drawer.trace.final.reason ? ` (${drawer.trace.final.reason})` : ''}
                        </div>
                        {drawer.trace.firingRule && (
                          <div data-testid="drawer-firing-rule">
                            <span className="font-medium">Firing rule:</span>{' '}
                            {drawer.trace.firingRule.name} — {drawer.trace.firingRule.reason}
                          </div>
                        )}
                        <div>
                          <span className="font-medium">Sources:</span>{' '}
                          E={String(drawer.trace.final.chips.in_ede)}{' '}
                          B={String(drawer.trace.final.chips.in_back_office)}{' '}
                          C={String(drawer.trace.final.chips.in_commission)}{' '}
                          paid=${drawer.trace.final.chips.paid_amount}
                        </div>
                        {drawer.trace.final.badges?.reversal_evidence && (
                          <div>
                            <span className="font-medium">Reversal evidence:</span>{' '}
                            <code>{JSON.stringify(drawer.trace.final.badges.reversal_evidence)}</code>
                          </div>
                        )}
                        {drawer.trace.helpers.length > 0 && (
                          <details>
                            <summary className="cursor-pointer">Helpers ({drawer.trace.helpers.length})</summary>
                            <pre className="text-[11px] bg-muted/40 rounded p-2 mt-1 overflow-x-auto">
{JSON.stringify(drawer.trace.helpers, null, 2)}
                            </pre>
                          </details>
                        )}
                        {drawer.trace.scopedRows.length > 0 && (
                          <details>
                            <summary className="cursor-pointer">Scoped rows ({drawer.trace.scopedRows.length})</summary>
                            <pre className="text-[11px] bg-muted/40 rounded p-2 mt-1 overflow-x-auto">
{JSON.stringify(drawer.trace.scopedRows.map((r) => ({
  source_type: (r as any).source_type,
  batch_id: (r as any).batch_id,
  effective_date: (r as any).effective_date,
  policy_term_date: (r as any).policy_term_date,
})), null, 2)}
                            </pre>
                          </details>
                        )}
                      </div>
                    )}
                  </section>
                </div>
              </>
            )}
          </SheetContent>
        </Sheet>
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
  // C2c — show tokenized groups as chips; preserve raw issueType in title.
  const tokens = tokenizeIssueType(d.issueType ?? null);
  const groups = Array.from(new Set(tokens.map(groupForToken)));
  return (
    <span title={d.issueType ?? ''} className="space-x-1">
      {groups.length > 0
        ? groups.map((g) => (
            <Badge key={g} variant="outline" data-testid="dmi-issue-chip">{g}</Badge>
          ))
        : <span>{d.issueType ?? 'DMI'}</span>}
      {d.expired ? <span className="text-destructive">(expired)</span> : null}
      {d.verificationEndDate ? <span className="text-muted-foreground"> · {d.verificationEndDate}</span> : null}
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
