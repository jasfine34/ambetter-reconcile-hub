import { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBatch } from '@/contexts/BatchContext';
import { MetricCard } from '@/components/MetricCard';
import { DataTable } from '@/components/DataTable';
import { BatchSelector } from '@/components/BatchSelector';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Users, Building2, DollarSign, AlertTriangle, CheckCircle2, XCircle, FileText, TrendingDown, Database, Info, ShieldAlert, RefreshCw, Hammer, Link2 } from 'lucide-react';
import { getNormalizedRecords, saveReconciledMembers, saveAndVerifyReconciled } from '@/lib/persistence';
import { reconcile } from '@/lib/reconcile';
import { useToast } from '@/hooks/use-toast';
import { RebuildBatchButton } from '@/components/RebuildBatchButton';
import { RebuildAllBatchesButton } from '@/components/RebuildAllBatchesButton';
import { RebuildCrossBatchClearingsButton } from '@/components/RebuildCrossBatchClearingsButton';
import { RECONCILE_LOGIC_VERSION } from '@/lib/rebuild';
import { CollapsibleDebugCard } from '@/components/CollapsibleDebugCard';
import { SourceFunnelCard } from '@/components/SourceFunnelCard';
import { isCoverallAORByName, isCoverallAORByNPN, COVERALL_NPN_SET } from '@/lib/agents';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { getCoveredMonths, monthKeyToFirstOfMonth, fallbackReconcileMonth } from '@/lib/dateRange';
import { computeFilteredEde } from '@/lib/expectedEde';
import { usePayEntityScope, PAY_ENTITY_STORAGE_KEY as SHARED_PAY_ENTITY_STORAGE_KEY } from '@/hooks/usePayEntityScope';
import { findWeakMatches, loadWeakMatchOverrides, applyOverrides, pickStableKey, type WeakMatchOverride } from '@/lib/weakMatch';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { runIdentityResolution, invalidateResolverCache } from '@/lib/resolvedIdentities';
import { ResolvedBadge } from '@/components/ResolvedBadge';
import {
  runInvariants,
  type InvariantResult,
  getFoundInBackOffice,
  getEligibleCohort,
  getNotInBackOfficeRows,
  getNetPaidCommission,
  getDirectVsDownlineSplit,
  getTotalCoveredLives,
  getMonthlyBreakdown,
  isActiveBackOfficeRecord,
  getExpectedPaymentBreakdown,
  getExpectedMissingCommissionSum,
  getSourceCoverageBuckets,
  getTotalPoliciesPaidAttribution,
  classifySourceTypeForRow,
  filterCommissionRowsByScope,
  isZeroNetPremium,
} from '@/lib/canonical';
import { getIssueTypeLabel, EBU_BATCH_SCOPE_DISCLAIMER } from '@/lib/constants';
import { Badge } from '@/components/ui/badge';
import { formatMoney } from '@/lib/utils';
import { useCrossBatchOverlay } from '@/hooks/useCrossBatchOverlay';
import {
  EMPTY_CLEARING_OVERLAY_MAP,
  partitionUnpaidRowsByOverlay,
  sumEffectiveEstMissing,
  type AdjustedRow,
} from '@/lib/canonical/crossBatchOverlay';
import { classifyPolicyOwnerFromCurrentAor } from '@/lib/canonical/policyOwner';
import { CrossBatchRolloutBanner } from '@/components/CrossBatchRolloutBanner';
import { CrossBatchStaleSweepBanner } from '@/components/CrossBatchStaleSweepBanner';
import { CrossBatchOverlayLoadErrorBanner } from '@/components/CrossBatchOverlayLoadErrorBanner';

/** Format '2026-01' as '1/1/2026' for display. */
function formatMonthStart(monthKey: string): string {
  if (!monthKey) return '';
  const [y, m] = monthKey.split('-');
  if (!y || !m) return monthKey;
  return `${parseInt(m, 10)}/1/${y}`;
}

/**
 * Format a per-month newly-effective breakdown so all distinct effective
 * months in the qualifying universe appear, sorted ascending. Used by the
 * Expected Enrollments card, Total Covered Lives card, and the EDE Expected
 * Enrollment Debug card to guarantee per-month numbers SUM to the card total.
 *
 * Falls back to '' when there are no entries with positive counts.
 */
function formatMonthBreakdown(byMonth: Record<string, number>, opts?: { yearless?: boolean }): string {
  const entries = Object.entries(byMonth)
    .filter(([m, c]) => m && (c ?? 0) > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return '';
  const fmt = (m: string) => opts?.yearless ? formatMonthStart(m).replace(/\/\d{4}$/, '') : formatMonthStart(m);
  return entries.map(([m, c]) => `${fmt(m)}: ${c.toLocaleString()}`).join(' · ');
}

const EDE_RAW_DRILLDOWN_COLUMNS = [
  { key: 'currentPolicyAOR', label: 'Current Policy AOR' },
  { key: 'policyStatus', label: 'Policy Status' },
  { key: 'issuer', label: 'Issuer' },
  { key: 'effectiveDate', label: 'Effective Date' },
  { key: 'exchangePolicyId', label: 'Exchange Policy ID' },
  { key: 'exchangeSubscriberId', label: 'Exchange Sub ID' },
  { key: 'issuerSubscriberId', label: 'Issuer Sub ID' },
  { key: 'applicant_name', label: 'Applicant' },
  { key: 'source_file_label', label: 'Source File' },
];

// Expected Enrollments drilldown columns — matches the FilteredEdeRow shape
// returned by computeFilteredEde.uniqueMembers (the canonical EE universe).
// This carveout exists ONLY for the Expected drilldown so the row count and
// the card value (filteredEde.uniqueKeys) are sourced from the same data.
// Reconciled-member-only fields (issue_type, actual_commission, in_commission)
// are intentionally omitted; FilteredEdeRow does not carry them.
const EXPECTED_DRILLDOWN_COLUMNS = [
  { key: 'applicant_name', label: 'Name' },
  { key: 'policy_number', label: 'Policy #' },
  { key: 'issuer_subscriber_id', label: 'Issuer Sub ID' },
  { key: 'exchange_subscriber_id', label: 'Exchange Sub ID' },
  { key: 'current_policy_aor', label: 'Current Policy AOR' },
  { key: 'policy_status', label: 'Policy Status' },
  { key: 'effective_date', label: 'Effective Date' },
  { key: 'effective_month', label: 'Effective Month' },
  { key: 'in_back_office', label: 'Back Office' },
];

const RECON_COLUMNS = [
  { key: 'applicant_name', label: 'Name' },
  { key: 'policy_number', label: 'Policy #' },
  { key: 'issuer_subscriber_id', label: 'Issuer Sub ID' },
  { key: 'agent_name', label: 'Agent' },
  { key: 'current_policy_aor', label: 'Current Policy AOR' }, { key: 'aor_bucket', label: 'Writing Agent' },
  { key: 'in_ede', label: 'EDE' },
  { key: 'in_back_office', label: 'Back Office' },
  { key: 'in_commission', label: 'Commission' },
  { key: 'eligible_for_commission', label: 'Eligible' },
  { key: 'expected_pay_entity', label: 'Expected Entity' },
  { key: 'actual_pay_entity', label: 'Actual Entity' },
  { key: 'actual_commission', label: 'Commission $' },
  { key: 'issue_type', label: 'Issue' },
];

const UNPAID_SAMPLE_COLUMNS = [
  { key: 'member_key', label: 'Member Key' },
  { key: 'applicant_name', label: 'Name' },
  { key: 'agent_npn', label: 'Agent NPN' },
  { key: 'in_ede', label: 'EDE' },
  { key: 'in_back_office', label: 'Back Office' },
  { key: 'eligible_for_commission', label: 'Eligible' },
  { key: 'in_commission', label: 'Commission' },
  { key: 'actual_commission', label: 'Commission $' },
  { key: 'commission_record_count', label: 'Comm Records' },
  { key: 'has_mixed_sources', label: 'Mixed Sources' },
  { key: 'source_count', label: 'Source Count' },
];

const COVERAGE_DRILLDOWN_COLUMNS = [
  { key: 'applicant_name', label: 'Name' },
  { key: 'agent_npn', label: 'Agent NPN' },
  { key: 'current_policy_aor', label: 'Current Policy AOR' }, { key: 'aor_bucket', label: 'Writing Agent' },
  { key: 'policy_number', label: 'Policy #' },
  { key: 'issuer_subscriber_id', label: 'Issuer Sub ID' },
  { key: 'in_ede', label: 'EDE' },
  { key: 'in_back_office', label: 'Back Office' },
  { key: 'in_commission', label: 'Commission' },
  { key: 'eligible_for_commission', label: 'Eligible' },
  { key: 'actual_commission', label: 'Commission $' },
];

// Unpaid Details drilldown columns — Coverage columns + the canonical
// Phase 1.5 Source Type (`Matched` / `BO Only` / `EDE Only`) so operators
// can see at a glance which evidence side is unpaid. Field is annotated
// onto each drilldown row in `drilldownData` from the same
// `getExpectedPaymentBreakdown` universe buckets that drive the card splits.
const UNPAID_DETAILS_DRILLDOWN_COLUMNS = [
  ...COVERAGE_DRILLDOWN_COLUMNS,
  { key: '_sourceType', label: 'Source Type' },
];

// Paid: EDE Only-specific drilldown columns. Identical to COVERAGE_DRILLDOWN_COLUMNS
// but appends a `bo_reason` column so the BO inactive/terminated vs BO absent
// classification surfaced by getSourceCoverageBuckets is visible. Other
// Source Coverage drilldowns intentionally do NOT carry this column to avoid
// noise where it doesn't apply.
const PAID_EDE_ONLY_DRILLDOWN_COLUMNS = [
  ...COVERAGE_DRILLDOWN_COLUMNS,
  { key: 'bo_reason', label: 'BO Reason' },
];

// Diagnostic drilldown for "BO Active: Non-current EDE" (Interpretation C).
// Adds a `diagnostic_reason` column showing future-effective /
// non-qualified-status / aor-or-key-mismatch / unknown.
const BO_ACTIVE_NON_CURRENT_EDE_COLUMNS = [
  ...COVERAGE_DRILLDOWN_COLUMNS,
  { key: 'diagnostic_reason', label: 'Reason' },
];

// Bundle 6 — Exception Summary drilldown columns. Reused for both
// "Wrong Pay Entity" and "Not Eligible for Commission" cards.
const EXCEPTION_DRILLDOWN_COLUMNS = [
  { key: 'applicant_name', label: 'Name' },
  { key: 'policy_number', label: 'Policy #' },
  { key: 'agent_npn', label: 'Agent NPN' },
  { key: 'agent_name', label: 'Agent' },
  { key: 'current_policy_aor', label: 'Current Policy AOR' }, { key: 'aor_bucket', label: 'Writing Agent' },
  { key: 'expected_pay_entity', label: 'Expected Entity' },
  { key: 'actual_pay_entity', label: 'Actual Entity' },
  { key: 'eligible_for_commission', label: 'Eligible' },
  { key: 'actual_commission', label: 'Commission $' },
  { key: 'issue_type', label: 'Issue' },
  { key: 'issue_notes', label: 'Notes' },
];

const NOT_IN_BO_COLUMNS = [
  { key: 'applicant_name', label: 'Full Name' },
  { key: 'policy_number', label: 'Policy # (EDE)' },
  { key: 'exchange_subscriber_id', label: 'Exchange Sub ID' },
  { key: 'issuer_subscriber_id', label: 'Issuer Sub ID' },
  { key: 'current_policy_aor', label: 'Current Policy AOR' },
  { key: 'effective_date', label: 'Effective Date' },
  { key: 'policy_status', label: 'Policy Status' },
  { key: 'covered_member_count', label: 'Covered Members' },
];

// NOTE: Pay-entity scope state moved to the shared `usePayEntityScope` hook
// (src/hooks/usePayEntityScope.ts) so other pages (Agent Summary, etc.) react
// to the same dropdown selection. The localStorage key is re-exported from
// the hook for backwards-compat with anything reading it directly.
const PAY_ENTITY_STORAGE_KEY = SHARED_PAY_ENTITY_STORAGE_KEY;

const ERICA_NPN = '21277051';

type PayEntityFilter = 'Coverall' | 'Vix' | 'All';

// Bundle 13c — page-scoped helpers for cross-batch overlay wiring.

function relativeTime(iso: string): string {
  try {
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return iso;
    const diff = Date.now() - then;
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
    const d = Math.floor(h / 24);
    return `${d} day${d === 1 ? '' : 's'} ago`;
  } catch {
    return iso;
  }
}

function isReviewWorthyAdjustment(it: AdjustedRow): boolean {
  return (
    it.adjustment.kind === 'mark_needs_review' ||
    it.adjustment.kind === 'partial_amount_unavailable'
  );
}

function recomputeUnpaidSplit(
  rows: readonly any[],
  universe: { boOnly: readonly any[]; edeOnly: readonly any[] },
): { matched: number; boOnly: number; edeOnly: number } {
  const out = { matched: 0, boOnly: 0, edeOnly: 0 };
  for (const row of rows) {
    const bucket = classifySourceTypeForRow(row, universe);
    if (bucket === 'BO Only') out.boOnly += 1;
    else if (bucket === 'EDE Only') out.edeOnly += 1;
    else out.matched += 1;
  }
  return out;
}

function recomputeUnpaidPremiumSplit(
  rows: readonly any[],
): { zeroNetPremium: number; hasPremium: number } {
  const out = { zeroNetPremium: 0, hasPremium: 0 };
  for (const row of rows) {
    if (isZeroNetPremium(row)) out.zeroNetPremium += 1;
    else out.hasPremium += 1;
  }
  return out;
}

function recomputeUnpaidOwnerSplit(
  rows: readonly any[],
): { JF: number; EF: number; BS: number; Other: number } {
  const out = { JF: 0, EF: 0, BS: 0, Other: 0 };
  for (const row of rows) {
    out[classifyPolicyOwnerFromCurrentAor(row?.current_policy_aor)] += 1;
  }
  return out;
}

function sumReversedAmount(items: readonly AdjustedRow[]): number {
  return items.reduce((sum, it) => {
    if (it.adjustment.kind !== 'move_to_reversed_bucket') return sum;
    const value = Number(it.adjustment.overlay.actual_reversal_amount);
    return sum + (Number.isFinite(value) ? Math.abs(value) : 0);
  }, 0);
}

export default function DashboardPage() {
  const { reconciled, loading, counts, debugStats, currentBatchId, refreshAll, batches, resolverIndex, refreshResolverIndex } = useBatch();
  const currentBatch = useMemo(() => batches.find((b: any) => b.id === currentBatchId), [batches, currentBatchId]);
  const lastRebuildAt = currentBatch?.last_full_rebuild_at as string | null | undefined;
  const lastRebuildVersion = currentBatch?.last_rebuild_logic_version as string | null | undefined;
  const logicChanged = !!lastRebuildVersion && lastRebuildVersion !== RECONCILE_LOGIC_VERSION;
  const neverRebuilt = !lastRebuildAt;
  // Cross-batch staleness: count how many batches have a stored logic version
  // that doesn't match the current LOGIC_VERSION constant. Batches that have
  // never been rebuilt are also considered stale.
  const staleBatchesCount = useMemo(
    () =>
      (batches || []).filter((b: any) => {
        const v = b?.last_rebuild_logic_version as string | null | undefined;
        return !v || v !== RECONCILE_LOGIC_VERSION;
      }).length,
    [batches]
  );
  const [drilldown, setDrilldown] = useState<string | null>(null);
  const [rerunning, setRerunning] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [resolveConfirmOpen, setResolveConfirmOpen] = useState(false);
  const [payEntityFilter, setPayEntityFilter] = usePayEntityScope();
  const [edeRawDrilldown, setEdeRawDrilldown] = useState<string | null>(null);
  const [edeRawRows, setEdeRawRows] = useState<Record<string, unknown>[]>([]);
  const [edeRawLoading, setEdeRawLoading] = useState(false);
  const [notInBoOpen, setNotInBoOpen] = useState(false);
  const [clawbacksOpen, setClawbacksOpen] = useState(false);
  const [invariantsOpen, setInvariantsOpen] = useState(false);
  const [invariantResults, setInvariantResults] = useState<InvariantResult[] | null>(null);
  // #125 — Run Invariants UI feedback. Track last-run timestamp + running
  // state so operators can confirm a click actually executed (especially
  // when chips were already green). Single-flight: overlapping runs would
  // race on setInvariantResults and confuse the timestamp.
  const [invariantsRunning, setInvariantsRunning] = useState(false);
  const [invariantsLastRunAt, setInvariantsLastRunAt] = useState<Date | null>(null);
  // Sort state for the Clawbacks Detail / Clawbacks dialog Statement Date
  // column. null = default sort (most-negative amount first).
  const [clawbackStatementSort, setClawbackStatementSort] = useState<'asc' | 'desc' | null>(null);
  // Cached normalized records for this batch, used by the Source Funnel and
  // any other classifier-driven widget. Refreshes on batch change and after
  // a re-run.
  const [normalizedRecords, setNormalizedRecords] = useState<any[]>([]);
  // Persistent weak-match overrides (table: weak_match_overrides). Loaded once
  // per batch refresh. Used to upgrade/demote weak-match members.
  const [weakOverrides, setWeakOverrides] = useState<Map<string, WeakMatchOverride>>(new Map());
  const { toast } = useToast();
  const navigate = useNavigate();

  // Bundle 13c — cross-batch clearing overlay. C7: when load fails, fall back
  // to legacy/batch-only by substituting an empty overlay for downstream wiring,
  // so a previously-successful (but now stale) overlay doesn't leak through.
  const {
    overlay: clearingOverlay,
    loading: overlayLoading,
    error: overlayError,
  } = useCrossBatchOverlay();
  const dashboardClearingOverlay = overlayError
    ? EMPTY_CLEARING_OVERLAY_MAP
    : clearingOverlay;

  // Covered months for this batch (prior month + statement month). Drives the
  // drilldown buttons, subtitle month breakdown, and the expected-EDE filter.
  // Empty array if no batch is selected.
  const coveredMonths = useMemo(
    () => getCoveredMonths(currentBatch?.statement_month),
    [currentBatch?.statement_month]
  );
  const priorMonth = coveredMonths[0] ?? '';
  const statementMonth = coveredMonths[1] ?? '';

  // Fetch normalized records for the funnel + future classifier-driven widgets.
  // Re-fetch when the batch changes OR when reconciled data updates (rebuild,
  // re-run, upload completion — all refresh reconciled via refreshAll()).
  useEffect(() => {
    if (!currentBatchId) { setNormalizedRecords([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const recs = await getNormalizedRecords(currentBatchId);
        if (!cancelled) setNormalizedRecords(recs as any[]);
      } catch {
        if (!cancelled) setNormalizedRecords([]);
      }
    })();
    return () => { cancelled = true; };
  }, [currentBatchId, reconciled.length]);

  // Load persistent weak-match overrides. Re-load on batch change so a user
  // who confirms a match elsewhere sees the upgrade after returning.
  useEffect(() => {
    let cancelled = false;
    loadWeakMatchOverrides()
      .then((map) => { if (!cancelled) setWeakOverrides(map); })
      .catch(() => { if (!cancelled) setWeakOverrides(new Map()); });
    return () => { cancelled = true; };
  }, [currentBatchId]);

  // (Persisting the scope to localStorage is now handled by usePayEntityScope.)

  const loadEdeRawDrilldown = useCallback(async (month: string) => {
    if (!currentBatchId) return;
    setEdeRawDrilldown(month);
    setEdeRawLoading(true);
    try {
      const all = await getNormalizedRecords(currentBatchId);
      const targetDate = monthKeyToFirstOfMonth(month);
      const QUALIFIED = new Set(['effectuated', 'pendingeffectuation', 'pendingtermination']);
      const rows = (all as any[])
        .filter(r => r.source_type === 'EDE')
        .filter(r => {
          const raw = r.raw_json || {};
          const eff = String(raw.effectiveDate ?? r.effective_date ?? '').trim();
          // Normalize effective date
          let iso = '';
          const isoMatch = eff.match(/^(\d{4})-(\d{2})-(\d{2})/);
          if (isoMatch) iso = `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
          else {
            const slash = eff.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
            if (slash) {
              let [, m, d, y] = slash;
              let yr = parseInt(y); if (yr < 100) yr += 2000;
              iso = `${yr}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
            }
          }
          if (iso !== targetDate) return false;
          const status = String(raw.policyStatus ?? r.status ?? '').toLowerCase().replace(/\s+/g, '');
          if (!QUALIFIED.has(status)) return false;
          const issuer = String(raw.issuer ?? r.carrier ?? '').toLowerCase();
          if (!issuer.includes('ambetter')) return false;
          return isCoverallAORByName(String(raw.currentPolicyAOR ?? ''));
        })
        .map(r => {
          const raw = r.raw_json || {};
          return {
            currentPolicyAOR: raw.currentPolicyAOR ?? '',
            policyStatus: raw.policyStatus ?? r.status ?? '',
            issuer: raw.issuer ?? r.carrier ?? '',
            effectiveDate: raw.effectiveDate ?? r.effective_date ?? '',
            exchangePolicyId: raw.exchangePolicyId ?? r.exchange_policy_id ?? '',
            exchangeSubscriberId: raw.exchangeSubscriberId ?? r.exchange_subscriber_id ?? '',
            issuerSubscriberId: raw.issuerSubscriberId ?? r.issuer_subscriber_id ?? '',
            applicant_name: r.applicant_name ?? '',
            source_file_label: r.source_file_label ?? '',
          };
        });
      setEdeRawRows(rows);
    } catch (err: any) {
      toast({ title: 'Error loading EDE rows', description: err.message, variant: 'destructive' });
    } finally {
      setEdeRawLoading(false);
    }
  }, [currentBatchId, toast]);

  const handleRerun = useCallback(async () => {
    if (!currentBatchId) return;
    setRerunning(true);
    try {
      const allRecords = await getNormalizedRecords(currentBatchId);
      const reconcileMonth = currentBatch?.statement_month
        ? String(currentBatch.statement_month).substring(0, 7)
        : fallbackReconcileMonth();
      const { members } = reconcile(allRecords as any[], reconcileMonth, resolverIndex);
      // Canonical save: verifies row count post-save AND stamps the rebuild
      // logic version so a manual re-run contributes to staleness tracking
      // the same way a full rebuild does (Codex Finding 2).
      const { rowCount } = await saveAndVerifyReconciled(currentBatchId, members, {
        stampLogicVersion: true,
        logicVersion: RECONCILE_LOGIC_VERSION,
      });
      await refreshAll();
      const monthLabel = currentBatch?.statement_month
        ? new Date(`${currentBatch.statement_month}T00:00:00`).toLocaleDateString('en-US', { year: 'numeric', month: 'long' })
        : 'Batch';
      toast({
        title: `Rerun Complete: ${monthLabel} — ${rowCount.toLocaleString('en-US')} members`,
        description: `${members.length.toLocaleString('en-US')} reconcile() outputs verified in DB.`,
      });
    } catch (err: any) {
      toast({ title: 'Rerun Failed', description: err.message, variant: 'destructive' });
    } finally {
      setRerunning(false);
    }
  }, [currentBatchId, currentBatch, refreshAll, toast, resolverIndex]);

  const handleResolveIdentities = useCallback(async () => {
    setResolving(true);
    try {
      const summary = await runIdentityResolution();
      invalidateResolverCache();
      await refreshResolverIndex();
      // Auto-trigger reconciliation re-run so downstream counts update with
      // the freshly-resolved IDs layered in.
      if (currentBatchId) {
        const allRecords = await getNormalizedRecords(currentBatchId);
        const reconcileMonth = currentBatch?.statement_month
          ? String(currentBatch.statement_month).substring(0, 7)
          : fallbackReconcileMonth();
        // Re-load index post-invalidate for the rerun.
        const { loadResolverIndex } = await import('@/lib/resolvedIdentities');
        const freshIdx = await loadResolverIndex(true);
        const { members } = reconcile(allRecords as any[], reconcileMonth, freshIdx);
        await saveReconciledMembers(currentBatchId, members);
        await refreshAll();
      }
      toast({
        title: 'Identity Resolution Complete',
        description: `Resolved ${summary.resolvedIssuerIds} issuer IDs, ${summary.resolvedIssuerPolicyIds} policy IDs, ${summary.resolvedExchangePolicyIds} exchange policy IDs from ${summary.sourceRecordsScanned.toLocaleString()} records across ${summary.batchesScanned} batches. ${summary.conflictCount} conflicts.`,
      });
    } catch (err: any) {
      toast({ title: 'Resolution Error', description: err.message, variant: 'destructive' });
    } finally {
      setResolving(false);
      setResolveConfirmOpen(false);
    }
  }, [currentBatchId, currentBatch, refreshAll, refreshResolverIndex, toast]);


  // Filter reconciled data by pay entity.
  // Include members whose EXPECTED entity is the selected one (so we can see unpaid expectations)
  // AND members whose ACTUAL paid entity is the selected one (so totals match the carrier statement).
  const filtered = useMemo(() => {
    if (payEntityFilter === 'All') return reconciled;
    if (payEntityFilter === 'Coverall') {
      return reconciled.filter(r =>
        r.expected_pay_entity === 'Coverall' ||
        r.expected_pay_entity === 'Coverall_or_Vix' ||
        r.actual_pay_entity === 'Coverall'
      );
    }
    // Vix
    return reconciled.filter(r =>
      r.expected_pay_entity === 'Vix' ||
      r.expected_pay_entity === 'Coverall_or_Vix' ||
      r.actual_pay_entity === 'Vix'
    );
  }, [reconciled, payEntityFilter]);

  // Filtered EDE metrics — counted from RAW normalized records, not from the
  // post-reconcile member set. This is the count the user validated against
  // their manual workbook (Jan 2026 Coverall = 1,627). Sourcing from raw rows
  // keeps the Expected Enrollments card aligned with the EDE Expected
  // Enrollment Debug panel (which uses the same filter).
  const filteredEde = useMemo(
    () => computeFilteredEde(normalizedRecords, reconciled, payEntityFilter, coveredMonths, resolverIndex),
    [normalizedRecords, reconciled, payEntityFilter, coveredMonths, resolverIndex]
  );

  /**
   * Canonical EE-universe member_key set (#118 migration, 2026-05-06).
   * Sourced from `filteredEde.uniqueMembers` (current-batch span, AOR-based)
   * — this is the SAME predicate the canonical helpers use. Replaces the
   * persistent `reconciled_members.is_in_expected_ede_universe` flag for
   * every UI metric, drilldown, and unpaid sample. The persistent column
   * is retained as a diagnostic readout in the debug strip below.
   */
  const eeUniverseKeys = useMemo(
    () => new Set(filteredEde.uniqueMembers.map((m) => m.member_key)),
    [filteredEde]
  );

  // Weak-match resolution (2026-04-27). For each EE-universe member that
  // failed strict join to BO, check if a BO sibling exists by ≥2 fuzzy
  // signals. Apply persistent overrides from `weak_match_overrides`:
  //   confirmed → upgrade to Found-in-BO (added to confirmed set)
  //   rejected  → demote to actionable Not-in-BO (kept in missingFromBO)
  //   pending/deferred → surface in Manual Match queue (third sub-bucket)
  //
  // The math reconciles:
  //   Found-in-BO + disputable + waiting + weak-match-pending = Expected
  // Confirmed-match members move from missingFromBO into Found-in-BO.
  // Rejected-match members stay in missingFromBO (disputable/waiting split).
  const weakMatchResult = useMemo(() => {
    if (!filteredEde.uniqueMembers.length || !normalizedRecords.length) {
      return {
        candidates: [],
        confirmedKeys: new Set<string>(),
        rejectedKeys: new Set<string>(),
        pending: [] as ReturnType<typeof findWeakMatches>,
      };
    }
    // #129 follow-up: pass batch's statement_month as periodStart so this
    // Dashboard count agrees with ManualMatchPage (canonical-predicate parity).
    const periodStart = currentBatch?.statement_month ?? null;
    const candidates = findWeakMatches(filteredEde.uniqueMembers, normalizedRecords, { periodStart });
    const { confirmedKeys, rejectedKeys, pending } = applyOverrides(candidates, weakOverrides);
    return { candidates, confirmedKeys, rejectedKeys, pending };
  }, [filteredEde, normalizedRecords, weakOverrides, currentBatch?.statement_month]);

  // Confirmed weak-match upgrades: build a Set of reconciled-member member_keys
  // whose stable identity key has a 'confirmed' override. These members'
  // strict join to BO failed but the user has manually confirmed the BO
  // sibling — we treat them as in_back_office for ALL downstream metrics
  // (foundBO, eligible, shouldPay, drilldowns) so the card NUMBERS reflect
  // confirmed matches, not just the Not-in-BO subtitle math.
  //
  // Stable key built via pickStableKey() (issuer_sub_id → exchange_sub_id →
  // policy#) — same priority order as the weak-match override write path,
  // so the lookup matches across rebuilds.
  const confirmedUpgradeMemberKeys = useMemo(() => {
    const out = new Set<string>();
    if (!weakMatchResult.confirmedKeys.size) return out;
    for (const r of filtered) {
      if (r.in_back_office) continue; // already counted; nothing to upgrade
      const key = pickStableKey({
        issuer_subscriber_id: r.issuer_subscriber_id,
        exchange_subscriber_id: r.exchange_subscriber_id,
        policy_number: r.policy_number,
      });
      if (key && weakMatchResult.confirmedKeys.has(key)) out.add(r.member_key);
    }
    return out;
  }, [filtered, weakMatchResult.confirmedKeys]);

  /** Effective in_back_office: strict join OR confirmed weak-match upgrade. */
  const effInBO = useCallback(
    (r: { member_key: string; in_back_office: boolean }) =>
      r.in_back_office || confirmedUpgradeMemberKeys.has(r.member_key),
    [confirmedUpgradeMemberKeys],
  );

  /**
   * Single source of truth for the "Not in Back Office" card subtitle math
   * AND the drilldown modal's row tabs. Built via the canonical
   * {@link getNotInBackOfficeRows} helper so the card count and modal row
   * count are mechanically identical (B1 follow-up to #129 — previously the
   * card subtracted confirmed weak-match overrides while the modal pulled
   * raw `filteredEde.missingFromBO`, leaking confirmed members into the
   * drilldown view).
   */
  const filteredMissingFromBO = useMemo(
    () => getNotInBackOfficeRows(filteredEde, weakMatchResult.confirmedKeys, pickStableKey),
    [filteredEde, weakMatchResult.confirmedKeys],
  );

  /**
   * Run the canonical invariant suite against the currently-loaded data and
   * stash results into modal state. Extracted as a callback so the modal's
   * "Re-run" button can re-invoke it without duplicating the input wiring.
   *
   * #125: single-flight (no overlapping runs), with running state and a
   * timestamp captured at completion so operators can confirm the click
   * actually executed even when results are unchanged.
   */
  // Phase 1.7: keep a ref to the latest `metrics` so executeInvariants can
  // pass the already-computed expectedPaymentBreakdown / sourceCoverage
  // without forming a forward reference at declaration time.
  const metricsRef = useRef<any>(null);
  const executeInvariants = useCallback(() => {
    if (invariantsRunning) return;
    setInvariantsRunning(true);
    // Defer to next tick so the "Running..." UI paints before the (sync)
    // computation blocks the main thread on large batches.
    setTimeout(() => {
      try {
        const m = metricsRef.current;
        const results = runInvariants({
          reconciled,
          normalizedRecords,
          filteredEde,
          confirmedUpgradeMemberKeys,
          confirmedWeakMatchOverrideKeys: weakMatchResult.confirmedKeys,
          weakMatchPendingOverrideKeys: new Set(weakMatchResult.pending.map((c) => c.override_key)),
          scope: payEntityFilter === 'All' ? 'All' : payEntityFilter,
          pickStableKey,
          isCoverallNpn: isCoverallAORByNPN,
          // Phase 1.7: pass already-computed Dashboard objects so cross-page
          // contract invariants check the SAME data the cards rendered.
          expectedPaymentBreakdown: m?.expectedPaymentBreakdown,
          expectedPaymentUniverse: m?.expectedPaymentBreakdown?.universe,
          sourceCoverage: m?.sourceCoverage,
        });
        setInvariantResults(results);
        setInvariantsLastRunAt(new Date());
      } catch (err) {
        // runInvariants now wraps each check; a throw here is a runner-level
        // bug. Surface a single error row so the panel is never blank.
        const msg = err instanceof Error ? err.message : String(err);
        setInvariantResults([
          {
            id: 'runner-error',
            label: 'Invariant runner failed',
            scope: payEntityFilter === 'All' ? 'All' : payEntityFilter,
            status: 'error',
            detail: `Runner threw before any invariant executed: ${msg}`,
          },
        ]);
        setInvariantsLastRunAt(new Date());
      } finally {
        setInvariantsRunning(false);
      }
    }, 0);
  }, [invariantsRunning, reconciled, normalizedRecords, filteredEde, confirmedUpgradeMemberKeys, weakMatchResult, payEntityFilter]);

  const dashboardTitle = useMemo(() => {
    switch (payEntityFilter) {
      case 'Coverall': return 'Coverall Commission Reconciliation';
      case 'Vix': return 'Vix Health Commission Reconciliation';
      case 'All': return 'Combined Commission Reconciliation';
    }
  }, [payEntityFilter]);

  const metrics = useMemo(() => {
    const expected = filtered.filter(r => eeUniverseKeys.has(r.member_key)).length;
    // PER-MONTH BREAKDOWN (2026-04-26): per-month Expected Enrollments now
    // counts NEWLY-EFFECTIVE members per month (each unique member attributed
    // to their first active covered month), so the per-month numbers SUM to
    // the card total. Carryover members remain in the total via uniqueKeys
    // but are not double-counted across months.
    const expectedPriorMonth = priorMonth ? (filteredEde.byMonth[priorMonth] ?? 0) : 0;
    const expectedStatementMonth = statementMonth ? (filteredEde.byMonth[statementMonth] ?? 0) : 0;
    // CANONICAL CARD WIRING (2026-04-28 pass-2): Found / Eligible / Should Pay
    // / Paid Within Eligible / Unpaid all flow through the canonical helpers
    // so the cards EXACTLY match Run Invariants for the same scope. Prior
    // wiring used `r.is_in_expected_ede_universe && effInBO(r)` (the
    // persistent column), which drifted from the canonical filteredEde-based
    // EE universe (Mar Coverall: 1,297 vs 1,309 invariant).
    const scopeForCanonical = payEntityFilter === 'All' ? 'All' : payEntityFilter;
    const foundBO = getFoundInBackOffice(reconciled, scopeForCanonical, filteredEde, confirmedUpgradeMemberKeys);
    // Legacy NARROW eligible-cohort (kept for invariant parity, validation
    // sample, AgentSummary parity tests). Phase 1 expanded the top
    // expected-payment cards to the broader workflow universe — see
    // expectedPaymentBreakdown below.
    const eligibleCohort = getEligibleCohort(reconciled, scopeForCanonical, confirmedUpgradeMemberKeys, filteredEde);
    const eligible = eligibleCohort.length;

    // Phase 1 expected-payment universe: Should Be Paid = Matched + BO Only + EDE Only.
    const expectedPaymentBreakdown = getExpectedPaymentBreakdown(
      reconciled,
      scopeForCanonical,
      filteredEde,
      confirmedUpgradeMemberKeys,
    );
    const shouldPay = expectedPaymentBreakdown.universe.total;
    const paidEligible = expectedPaymentBreakdown.paidCount;
    const unpaid = expectedPaymentBreakdown.unpaidCount;

    const netPaid = getNetPaidCommission(normalizedRecords, scopeForCanonical);
    const totalComm = netPaid.gross;
    const totalClawbacks = netPaid.clawbacks;
    const split = getDirectVsDownlineSplit(normalizedRecords, scopeForCanonical, isCoverallAORByNPN);
    const coverallDirectNet = split.coverallDirectNet;
    const downlineNet = split.downlineNet;
    const coverallDirectRows = split.coverallDirectRows;
    const downlineRows = split.downlineRows;
    const unclassifiedRows = split.unclassifiedRows;
    const unclassifiedNet = split.unclassifiedNet;
    const netPaidTotal = netPaid.net;
    const splitDelta = netPaidTotal - (coverallDirectNet + downlineNet);
    const estMissing = getExpectedMissingCommissionSum(reconciled, scopeForCanonical, filteredEde, confirmedUpgradeMemberKeys);
    const difference = shouldPay - paidEligible;
    const unpaidVariance = unpaid - difference;
    const totalEdeRaw = filtered.filter(r => r.in_ede).length;
    const hasAnyEde = filtered.filter(r => r.in_ede).length;
    const hasExpectedEde = filtered.filter(r => r.is_in_expected_ede_universe).length;
    const expectedWithBO = filtered.filter(r => r.is_in_expected_ede_universe && effInBO(r)).length;

    // Phase 1 Source Coverage — single helper for all paid/unpaid coverage tiles.
    // "Paid Outside Current EDE" tile removed (overlapped Expected Payments
    // Received; Jason Option B). New tile: "Paid: EDE Only" (12 rows on
    // Feb 2026 Ambetter All scope) with bo_reason drilldown classification.
    const sourceCoverage = getSourceCoverageBuckets(
      reconciled,
      scopeForCanonical,
      filteredEde,
      normalizedRecords,
      coveredMonths,
      confirmedUpgradeMemberKeys,
    );
    const fullyMatched = sourceCoverage.fullyMatchedPaid.count;
    const paidBackOfficeOnly = sourceCoverage.paidBackOfficeOnly.count;
    const paidEdeOnly = sourceCoverage.paidEdeOnly.count;
    const commissionOnly = sourceCoverage.paidCommissionStatementOnly.count;
    const backOfficeOnly = sourceCoverage.unpaidBackOfficeOnly.count;
    const unpaidExpected = sourceCoverage.expectedButUnpaid.count;
    const totalPaidAll = sourceCoverage.totalPoliciesPaid.count;
    // Bundle 7 + Bundle 10: paid-attribution ownership split computed via the
    // canonical helper using EDE current_policy_aor — DashboardPage MUST NOT
    // inline-classify. Vix is a pay entity (not ownership) and Downlines is
    // payment evidence (not ownership), so neither appears in this split.
    // Bundle 10 — display-time fallback: rows in the canonical Source Coverage
    // `paidCommissionStatementOnly` bucket (no EDE record at all) may fall
    // back to commission-statement evidence to land in JF/EF/BS, otherwise
    // they classify as 'Commission-Only'. The predicate lives in Source
    // Coverage; we just pass the resulting member-key Set through.
    const commissionStatementOnlyKeys = new Set<string>(
      sourceCoverage.paidCommissionStatementOnly.rows.map((r: any) => r.member_key),
    );
    const paidAttribution = getTotalPoliciesPaidAttribution(
      sourceCoverage.totalPoliciesPaid.rows,
      commissionStatementOnlyKeys,
    );
    // Bundle 3: paidCommRecords sourced from the same canonical totalPoliciesPaid set.
    const paidCommRecords = sourceCoverage.totalPoliciesPaid.count;
    const boActiveNonCurrentEde = sourceCoverage.boActiveNonCurrentEde.count;

    // Bundle 13c — adjusted-cohort partition for Dashboard EBU + Source Coverage EBU.
    const dashPartition = partitionUnpaidRowsByOverlay(expectedPaymentBreakdown.unpaidRows, dashboardClearingOverlay);
    const dashRegular = dashPartition.regular;
    const dashReversed = dashPartition.reversed;
    const dashReviewRows = dashRegular.filter(isReviewWorthyAdjustment);

    const scPartition = partitionUnpaidRowsByOverlay(sourceCoverage.expectedButUnpaid.rows, dashboardClearingOverlay);
    const scRegular = scPartition.regular;
    const scReviewRows = scRegular.filter(isReviewWorthyAdjustment);

    const dashRegularRows = dashRegular.map((it) => it.row);
    const scRegularRows = scRegular.map((it) => it.row);

    const adjustedUnpaidSplit = recomputeUnpaidSplit(dashRegularRows, expectedPaymentBreakdown.universe);
    const adjustedUnpaidPremiumSplit = recomputeUnpaidPremiumSplit(dashRegularRows);
    const adjustedUnpaidOwnerSplit = recomputeUnpaidOwnerSplit(scRegularRows);

    const adjustedSourceCoverage = {
      expectedButUnpaid: {
        count: scRegular.length,
        rows: scRegularRows,
      },
    };

    return {
      expected, expectedPriorMonth, expectedStatementMonth, foundBO, eligible, shouldPay,
      eligibleCohort, expectedPaymentBreakdown, sourceCoverage, paidAttribution, paidCommRecords,
      paidEligible, unpaid, totalComm, totalClawbacks, estMissing, difference, unpaidVariance,
      totalEdeRaw, hasAnyEde, hasExpectedEde, expectedWithBO, fullyMatched, paidBackOfficeOnly,
      paidEdeOnly, commissionOnly, backOfficeOnly, unpaidExpected, totalPaidAll,
      boActiveNonCurrentEde, coverallDirectNet, downlineNet, netPaidTotal, splitDelta,
      coverallDirectRows, downlineRows, unclassifiedRows, unclassifiedNet,
      // Bundle 13c — adjusted cohort fields (raw fields above are PRESERVED).
      adjustedUnpaid: dashRegular.length,
      adjustedEstMissing: sumEffectiveEstMissing(dashRegular),
      adjustedUnpaidExpected: scRegular.length,
      adjustedUnpaidSplit,
      adjustedUnpaidPremiumSplit,
      adjustedUnpaidOwnerSplit,
      adjustedUnpaidRows: dashRegularRows,
      adjustedSourceCoverage,
      dashboardReviewRows: dashReviewRows,
      sourceCoverageReviewRows: scReviewRows,
      reversedAdjustedRows: dashReversed,
      reversedUnpaidAmount: sumReversedAmount(dashReversed),
    };
  }, [filtered, reconciled, normalizedRecords, payEntityFilter, filteredEde, eeUniverseKeys, priorMonth, statementMonth, effInBO, confirmedUpgradeMemberKeys, coveredMonths, dashboardClearingOverlay]);

  // Phase 1.7: keep metricsRef in sync so executeInvariants reads the latest.
  useEffect(() => { metricsRef.current = metrics; }, [metrics]);

  // Clawback rows — every commission row with amount < 0 within the current
  // pay-entity scope. Derived from RAW normalized commission records (same
  // source as the totalClawbacks aggregate on the Net Paid card) so the rows
  // sum exactly to the displayed total. Each row carries source_file_label
  // and statement-date hints so the user can answer "why is a Mar 21 row in
  // the Mar 2026 batch?" without leaving the dashboard.
  const clawbackRows = useMemo(() => {
    const out: Array<{
      applicant_name: string;
      policy_number: string;
      pay_code: string;
      amount: number;
      pay_entity: string;
      source_file_label: string;
      statement_date: string;
      /** Epoch ms parsed from statement_date for sorting; NaN if unparseable. */
      _statement_sort: number;
      member_key: string;
    }> = [];
    // Bundle 2 — consume the canonical scope helper for COMMISSION +
    // pay_entity filtering instead of re-implementing it inline. Then apply
    // the clawback-specific predicate (amount < 0). No math change.
    const scopeForCanonical = payEntityFilter === 'All' ? 'All' : payEntityFilter;
    const scopedComm = filterCommissionRowsByScope(normalizedRecords, scopeForCanonical);
    for (const rec of scopedComm) {
      const amt = Number(rec.commission_amount) || 0;
      if (amt >= 0) continue;
      const raw = rec.raw_json || {};
      const stmtRaw = String(
        rec.raw_json?.['Accounting Cycle'] ??
          rec.raw_json?.['Accounting_Cycle'] ??
          rec.raw_json?.['accounting_cycle'] ??
          rec.raw_json?.['accounting cycle'] ??
          rec.raw_json?.['Statement Date'] ??
          rec.raw_json?.['Statement Period'] ??
          rec.raw_json?.['Period End Date'] ??
          rec.raw_json?.['Pay Period'] ??
          '',
      ).trim();
      const parsed = stmtRaw ? new Date(stmtRaw) : null;
      const formatted = parsed && !isNaN(parsed.getTime())
        ? parsed.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' })
        : stmtRaw;
      out.push({
        applicant_name: rec.applicant_name || '',
        policy_number: rec.policy_number || '',
        pay_code:
          String(raw['Pay Code'] ?? raw['PayCode'] ?? raw['Pay Type'] ?? '').trim() || '—',
        amount: amt,
        pay_entity: rec.pay_entity || '',
        source_file_label: rec.source_file_label || '',
        statement_date: formatted,
        _statement_sort: parsed ? parsed.getTime() : NaN,
        member_key: rec.member_key || '',
      });
    }
    out.sort((a, b) => a.amount - b.amount); // most negative first
    return out;
  }, [normalizedRecords, payEntityFilter]);

  /**
   * Clawback rows ordered per the Statement Date sort selection. When no
   * explicit sort is active, returns the default amount-sorted list. NaN sort
   * keys (unparseable dates) are pushed to the end in both directions.
   */
  const sortedClawbackRows = useMemo(() => {
    if (!clawbackStatementSort) return clawbackRows;
    const dir = clawbackStatementSort === 'asc' ? 1 : -1;
    return [...clawbackRows].sort((a, b) => {
      const aBad = isNaN(a._statement_sort);
      const bBad = isNaN(b._statement_sort);
      if (aBad && bBad) return 0;
      if (aBad) return 1;
      if (bBad) return -1;
      return dir * (a._statement_sort - b._statement_sort);
    });
  }, [clawbackRows, clawbackStatementSort]);

  const toggleClawbackStatementSort = useCallback(() => {
    setClawbackStatementSort((cur) => (cur === 'asc' ? 'desc' : cur === 'desc' ? null : 'asc'));
  }, []);

  const clawbackStatementSortIndicator =
    clawbackStatementSort === 'asc' ? ' ↑' : clawbackStatementSort === 'desc' ? ' ↓' : '';

  /**
   * EE Universe Audit (2026-04-26) — surfaces members in the Expected
   * Enrollments universe who fall in NEITHER the Found-in-BO bucket
   * (`is_in_expected_ede_universe && in_back_office`) NOR the actionable
   * Not-in-BO bucket (`filteredEde.missingFromBO`). These are the "gap"
   * members where ID-candidate matching found a BO sibling but the reconciled
   * member's flags don't classify them as Found-in-BO. We classify each row
   * with a best-effort INFERRED reason so we can decide the right downstream
   * fix without designing a "not actionable" bucket that hides bugs.
   *
   * Read-only — does not affect any totals, no DB writes.
   */
  const eeAuditRows = useMemo(() => {
    if (!filteredEde.uniqueMembers.length) return [] as Array<Record<string, unknown>>;

    const reconByMemberKey = new Map<string, any>();
    for (const m of reconciled) reconByMemberKey.set(m.member_key, m);

    // Index BO normalized records by every ID candidate so we can detect
    // "BO row exists but join failed" cases.
    const boByExchangeSub = new Map<string, any>();
    const boByIssuerSub = new Map<string, any>();
    const boByPolicy = new Map<string, any>();
    for (const r of normalizedRecords) {
      if (r.source_type !== 'BACK_OFFICE') continue;
      if (r.exchange_subscriber_id && !boByExchangeSub.has(r.exchange_subscriber_id)) {
        boByExchangeSub.set(r.exchange_subscriber_id, r);
      }
      if (r.issuer_subscriber_id && !boByIssuerSub.has(r.issuer_subscriber_id)) {
        boByIssuerSub.set(r.issuer_subscriber_id, r);
      }
      if (r.policy_number && !boByPolicy.has(r.policy_number)) {
        boByPolicy.set(r.policy_number, r);
      }
    }

    const sortedCovered = (coveredMonths || []).filter(Boolean).slice().sort();
    const earliestCovered = sortedCovered[0] ?? '';
    const latestCovered = sortedCovered[sortedCovered.length - 1] ?? '';

    const rows: Array<Record<string, unknown>> = [];
    for (const fe of filteredEde.uniqueMembers) {
      // Skip rows already in the actionable Not-in-BO bucket.
      if (!fe.in_back_office) continue;
      const recon = reconByMemberKey.get(fe.member_key);
      // Found-in-BO bucket = reconciled & EE universe & in BO.
      const isFoundInBo = !!(recon && recon.is_in_expected_ede_universe && recon.in_back_office);
      if (isFoundInBo) continue;

      const boByExch = fe.exchange_subscriber_id ? boByExchangeSub.get(fe.exchange_subscriber_id) : null;
      const boByIssuer = fe.issuer_subscriber_id ? boByIssuerSub.get(fe.issuer_subscriber_id) : null;
      const boByPol = fe.policy_number ? boByPolicy.get(fe.policy_number) : null;
      const boRecord: any = boByExch || boByIssuer || boByPol || null;

      const boBrokerNpn: string = boRecord?.agent_npn || '';
      const boEligibleRaw: string = boRecord?.eligible_for_commission || '';
      const boEligible = boEligibleRaw === 'Yes';
      const boTermDate: string = boRecord?.policy_term_date || boRecord?.broker_term_date || '';
      const boState = String(((boRecord?.raw_json || {}) as Record<string, any>)['State'] ?? '').trim().toUpperCase();

      // Canonical BO active predicate (#29 Phase 1) — single source of truth
      // for whether the matched BO record disqualifies on policy term, broker
      // term (with 9999-* sentinel), or eligible_for_commission.
      const periodStart = (sortedCovered[0] || (fe.effective_date || '').substring(0, 7)) + '-01';
      const boIsActive = boRecord
        ? isActiveBackOfficeRecord(
            { source_type: 'BACK_OFFICE', ...boRecord },
            periodStart,
          )
        : true;

      // Inferred reason — priority order per spec.
      let inferredReason = '';
      if (boRecord && (!recon || recon.member_key !== boRecord.member_key)) {
        inferredReason = 'matching failure (BO row exists but join failed)';
      } else if (boRecord && boBrokerNpn && !COVERALL_NPN_SET.has(boBrokerNpn)) {
        inferredReason = 'AOR drift (BO broker is non-Coverall)';
      } else if (boRecord && !boIsActive) {
        inferredReason = 'ineligible BO record';
      } else if (sortedCovered.length > 0) {
        const effMonth = (fe.effective_date || '').substring(0, 7);
        const termMonth = boRecord?.policy_term_date ? String(boRecord.policy_term_date).substring(0, 7) : '';
        const fullyCovers = effMonth && effMonth <= earliestCovered && (!termMonth || termMonth > latestCovered);
        if (!fullyCovers) inferredReason = 'span edge case';
      }
      if (!inferredReason) inferredReason = 'unknown — no BO record found anywhere';

      const edeStatus = fe.policy_status || '';
      const aorMatch = (fe.current_policy_aor || '').match(/\((\d{5,15})\)/);
      const writingAgentNpn = aorMatch ? aorMatch[1] : '';

      rows.push({
        applicant_name: fe.applicant_name || '',
        policy_number: fe.policy_number || '',
        issuer_subscriber_id: fe.issuer_subscriber_id || '',
        exchange_subscriber_id: fe.exchange_subscriber_id || '',
        ede_status: edeStatus,
        current_policy_aor: fe.current_policy_aor || '',
        writing_agent_npn: writingAgentNpn,
        bo_record_exists: boRecord ? 'yes' : 'no',
        bo_broker_npn: boBrokerNpn,
        bo_eligible: boRecord ? (boEligible ? 'yes' : 'no') : '',
        bo_term_date: boTermDate || '',
        bo_state: boState,
        inferred_reason: inferredReason,
      });
    }
    return rows;
  }, [filteredEde, reconciled, normalizedRecords, coveredMonths]);

  // D1 (PR2 follow-up): route through canonical eligibleCohort so the
  // validation sample cannot drift from the Unpaid Policies card/drilldown.
  const unpaidSample = useMemo(() => {
    return metrics.eligibleCohort.filter(r => !r.in_commission).slice(0, 50);
  }, [metrics.eligibleCohort]);

  // Bundle 6 — single-source rows for Exception Summary cards. The same
  // array drives both the card count and the drilldown payload, so they
  // can never drift. Keyed by the exact persisted issue_type string.
  const exceptionRowsByIssue = useMemo(() => ({
    'Wrong Pay Entity': filtered.filter((r) => r.issue_type === 'Wrong Pay Entity'),
    'Not Eligible for Commission': filtered.filter((r) => r.issue_type === 'Not Eligible for Commission'),
  }), [filtered]);

  const drilldownData = useMemo(() => {
    if (!drilldown) return null;
    const sc = metrics.sourceCoverage;
    const epb = metrics.expectedPaymentBreakdown;
    // Phase 1.5 — annotate unpaid drilldown rows with the canonical
    // `_sourceType` (Matched / BO Only / EDE Only) sourced from the same
    // breakdown universe buckets used elsewhere. Same classification the
    // Missing Commission Export page emits — no new predicate.
    const sourceTypeForUnpaid = (r: any) => classifySourceTypeForRow(r, epb.universe);
    switch (drilldown) {
      // Bundle 2 — source rows directly from filteredEde.uniqueMembers so
      // the drilldown row count matches the Expected Enrollments card value
      // (filteredEde.uniqueKeys) exactly. Previously this filtered the
      // legacy `filtered` reconciled array through eeUniverseKeys, which
      // could drift if the reconciled set was stale or out of sync.
      case 'expected': return filteredEde.uniqueMembers;
      // Phase 1 (#X): top expected-payment cards now slice from the broader
      // expected-payment universe. shouldPay / paidEligible / unpaid all
      // come from the same getExpectedPaymentBreakdown so card values and
      // drilldown row counts cannot drift.
      case 'shouldPay': return epb.universe.rows;
      case 'paidComm': return sc.totalPoliciesPaid.rows;
      case 'paidEligible': return epb.paidRows;
      case 'unpaid': return metrics.adjustedUnpaidRows.map((r: any) => ({ ...r, _sourceType: sourceTypeForUnpaid(r) }));
      case 'fullyMatched': return sc.fullyMatchedPaid.rows;
      // New Phase 1 tile: Paid: Back Office Only (was wrapped under
      // "Paid but Missing from EDE" / paidOutsideEde — now 4-bucket math).
      case 'paidBackOfficeOnly': return sc.paidBackOfficeOnly.rows;
      // New Phase 1 tile: Paid: EDE Only (the 12-row residual). Each row is
      // shaped { row, bo_reason } so the drilldown column can render the BO
      // reason ("BO inactive/terminated" vs "BO absent") next to the data.
      case 'paidEdeOnly': return sc.paidEdeOnly.rows.map((x) => ({ ...x.row, bo_reason: x.bo_reason }));
      case 'commissionOnly': return sc.paidCommissionStatementOnly.rows;
      case 'backOfficeOnly': return sc.unpaidBackOfficeOnly.rows;
      case 'unpaidExpected': return metrics.adjustedSourceCoverage.expectedButUnpaid.rows;
      case 'totalPaidAll': return sc.totalPoliciesPaid.rows;
      // Diagnostic-only: BO Active w/ Non-current EDE (Interpretation C).
      // Excluded from Should Be Paid; visible separately for review.
      case 'boActiveNonCurrentEde': return sc.boActiveNonCurrentEde.rows.map((x) => ({ ...x.row, diagnostic_reason: x.reason }));
      // Bundle 6 — Exception Summary drilldowns. Same rows array used for
      // the card count, guaranteeing parity.
      case 'exceptionWrongPayEntity': return exceptionRowsByIssue['Wrong Pay Entity'];
      case 'exceptionNotEligible': return exceptionRowsByIssue['Not Eligible for Commission'];
      default: return filtered;
    }
  }, [drilldown, filtered, eeUniverseKeys, metrics.sourceCoverage, metrics.expectedPaymentBreakdown, metrics.adjustedUnpaidRows, metrics.adjustedSourceCoverage, exceptionRowsByIssue]);

  const isCoverageDrilldown = ['fullyMatched', 'paidBackOfficeOnly', 'paidEdeOnly', 'commissionOnly', 'backOfficeOnly', 'unpaidExpected', 'totalPaidAll', 'boActiveNonCurrentEde'].includes(drilldown || '');
  const isExceptionDrilldown = drilldown === 'exceptionWrongPayEntity' || drilldown === 'exceptionNotEligible';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-y-2">
        <div>
          <h2 className="text-2xl font-bold text-foreground">Reconciliation Dashboard</h2>
          <p className="text-sm text-muted-foreground">{dashboardTitle}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 gap-y-2">
          <Select value={payEntityFilter} onValueChange={(v) => setPayEntityFilter(v as PayEntityFilter)}>
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="View" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="Coverall">Coverall</SelectItem>
              <SelectItem value="Vix">Vix Health</SelectItem>
              <SelectItem value="All">All (Combined)</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={handleRerun} disabled={rerunning || !currentBatchId}>
            <RefreshCw className={`h-4 w-4 mr-1 ${rerunning ? 'animate-spin' : ''}`} />
            {rerunning ? 'Running...' : 'Re-run Reconciliation'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setInvariantsOpen(true);
              executeInvariants();
            }}
            disabled={!currentBatchId || reconciled.length === 0 || invariantsRunning}
          >
            <ShieldAlert className={`h-4 w-4 mr-1 ${invariantsRunning ? 'animate-pulse' : ''}`} />
            {invariantsRunning ? 'Running…' : 'Run Invariants'}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setResolveConfirmOpen(true)} disabled={resolving}>
            <Link2 className={`h-4 w-4 mr-1 ${resolving ? 'animate-pulse' : ''}`} />
            {resolving ? 'Resolving...' : 'Resolve Identities Across Batches'}
          </Button>
          <RebuildBatchButton />
          <RebuildAllBatchesButton />
          <RebuildCrossBatchClearingsButton />
          <span
            className="text-xs text-muted-foreground"
            data-testid="dashboard-cross-batch-last-updated"
            title={dashboardClearingOverlay.lastEvaluatedAt ?? ''}
          >
            Last updated: {dashboardClearingOverlay.lastEvaluatedAt
              ? relativeTime(dashboardClearingOverlay.lastEvaluatedAt)
              : 'Never run'}
          </span>
          <BatchSelector />
        </div>
      </div>

      {/* Bundle 13c — rollout banner (C12 mount order: top of stack). */}
      <CrossBatchRolloutBanner />

      {/* Cross-batch staleness banner */}
      {staleBatchesCount > 0 && (
        <Card className="border-yellow-500/40 bg-yellow-500/10">
          <CardContent className="px-4 py-3">
            <div className="flex items-start gap-3 text-sm">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-yellow-600" />
              <div className="flex-1">
                <div className="font-medium text-foreground">
                  {staleBatchesCount} {staleBatchesCount === 1 ? 'batch was' : 'batches were'} reconciled under older logic. Rebuild all to refresh.
                </div>
                <div className="text-muted-foreground text-xs mt-1">
                  Current logic version: <code className="font-mono">{RECONCILE_LOGIC_VERSION}</code>
                </div>
              </div>
              <RebuildAllBatchesButton variant="default" label="Rebuild all" />
            </div>
          </CardContent>
        </Card>
      )}

      {/* Fail-safe: per-batch silent-rebuild detection. If the selected batch
          has normalized records but ZERO reconciled members, the rebuild
          orchestrator's assertion missed (or the batch hasn't been rebuilt
          since the assertion shipped). Surface a red banner so we can recover
          with a single click. */}
      {currentBatchId &&
        counts.normalizedRecords > 0 &&
        counts.reconciledMembers === 0 && (
          <Card className="border-destructive bg-destructive/10">
            <CardContent className="px-4 py-3">
              <div className="flex items-start gap-3 text-sm">
                <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0 text-destructive" />
                <div className="flex-1">
                  <div className="font-semibold text-destructive">
                    This batch has {counts.normalizedRecords.toLocaleString()} normalized records
                    but 0 reconciled members.
                  </div>
                  <div className="text-muted-foreground text-xs mt-1">
                    A previous rebuild appears to have silently dropped the reconciled set.
                    Click <strong>Rebuild Entire Batch</strong> to fix.
                  </div>
                </div>
                <RebuildBatchButton />
              </div>
            </CardContent>
          </Card>
        )}

      {/* Rebuild status / stale logic warning */}
      {currentBatchId && (logicChanged || neverRebuilt) && (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="px-4 py-3">
            <div className="flex items-start gap-2 text-sm">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-destructive" />
              <div className="flex-1">
                <div className="font-medium text-foreground">
                  {neverRebuilt
                    ? 'This batch has never been fully rebuilt from source files.'
                    : 'Reconciliation logic has changed since the last rebuild.'}
                </div>
                <div className="text-muted-foreground text-xs mt-1">
                  {neverRebuilt
                    ? 'Normalized data reflects whatever logic was active at upload time. Click "Rebuild Entire Batch" to re-process all source files with current logic.'
                    : <>Last rebuild used <code className="font-mono">{lastRebuildVersion}</code>; current code is <code className="font-mono">{RECONCILE_LOGIC_VERSION}</code>. Rebuild to refresh stale records.</>}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Bundle 13c — stale sweep + overlay load error banners (C12: 5th + 6th). */}
      <CrossBatchStaleSweepBanner />
      {overlayError && <CrossBatchOverlayLoadErrorBanner />}
        <div className="text-xs text-muted-foreground flex items-center gap-2">
          <Hammer className="h-3 w-3" />
          Last full rebuild: {new Date(lastRebuildAt).toLocaleString()} · logic <code className="font-mono">{lastRebuildVersion}</code>
        </div>
      )}

      {/* Matching explanation */}
      <Card className="border-dashed border-primary/30 bg-primary/5">
        <CardContent className="px-4 py-3">
          <p className="text-xs text-muted-foreground flex items-start gap-2">
            <Info className="h-4 w-4 mt-0.5 shrink-0 text-primary" />
            For Ambetter, the EDE field <strong>issuerSubscriberId</strong> often contains the actual member/policy identifier used in carrier systems and commission statements. This is used as the primary match key.
          </p>
        </CardContent>
      </Card>

      {/* Source Funnel — Phase 2b introduction of the classifier (§4.5 of
          ARCHITECTURE_PLAN). Observational for now; Phase 3 wires dispute /
          attribution workflows off the gap counts. */}
      {reconciled.length > 0 && normalizedRecords.length > 0 && (
        <SourceFunnelCard
          normalizedRecords={normalizedRecords}
          coveredMonths={coveredMonths}
        />
      )}

      {loading ? (
        <div className="text-center py-20 text-muted-foreground">Loading...</div>
      ) : reconciled.length === 0 ? (
        <div className="text-center py-20">
          <FileText className="h-12 w-12 text-muted-foreground mx-auto mb-3" />
          <p className="text-muted-foreground">No reconciliation data yet. Upload files to get started.</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            {(() => {
              // Expected Enrollments — sourced from the FILTERED EDE count
              // (raw rows, post issuer/AOR/status/effective-date filter), so it
              // matches the EDE Expected Enrollment Debug panel and the user's
              // manual workbook ground truth.
              const expectedTotal = filteredEde.uniqueKeys;
              const tieOut = filteredEde.inBOCount + filteredEde.notInBOCount;
              const tiesOut = tieOut === expectedTotal;
              const monthBreakdown = formatMonthBreakdown(filteredEde.byMonth, { yearless: true });
              // Tie-out is the RAW pre-override EDE bucketing (strict BO match vs raw EDE
              // missing-from-BO). It is intentionally distinct from the live "Not in Back Office"
              // Dashboard card, which applies override-aware post weak-match-confirmation logic.
              // Wording uses "Raw strict BO" / "Raw EDE Not-in-BO" to disambiguate.
              const tooltipText = `Total Ambetter policies with a Coverall AOR (scope: ${payEntityFilter}) in a qualifying status (Effectuated / PendingEffectuation / PendingTermination), active in this batch's covered months. Per-month breakdown shows NEWLY-EFFECTIVE members per actual effective month, so per-month numbers SUM to the total. Sourced from raw EDE rows so this matches the EDE debug panel exactly. This tie-out is the raw pre-override EDE bucketing and is distinct from the override-aware "Not in Back Office" card. Tie-out check: Raw strict BO ${filteredEde.inBOCount} + Raw EDE Not-in-BO ${filteredEde.notInBOCount} = ${tieOut} ${tiesOut ? '✓' : '⚠️ MISMATCH vs ' + expectedTotal}.`;
              return (
                <MetricCard
                  title="Expected Enrollments"
                  value={expectedTotal}
                  icon={<Users className="h-4 w-4" />}
                  onClick={() => setDrilldown('expected')}
                  subtitle={monthBreakdown || undefined}
                  tooltip={{ text: tooltipText, why: "This is what Coverall SHOULD be paid if every record is captured downstream. All other numbers are measured against this." }}
                />
              );
            })()}
            {(() => {
              // Weak-match split: among the EE rows missing strict BO,
              // pull out members where a fuzzy BO sibling exists. Confirmed
              // overrides upgrade to Found-in-BO (subtracted from this card);
              // rejected stay in disputable/waiting; pending stay here as
              // their own sub-bucket.
              const confirmed = weakMatchResult.confirmedKeys;
              const pendingKeys = new Set(weakMatchResult.pending.map((c) => c.override_key));
              // Stable identity key for an EE-side row — same priority as the
              // weak-match override write path (issuer sub ID → exchange sub ID
              // → policy #), so lookups against confirmed/pending sets match
              // across rebuilds.
              const keyFor = (r: typeof filteredEde.missingFromBO[number]) =>
                pickStableKey({
                  issuer_subscriber_id: r.issuer_subscriber_id,
                  exchange_subscriber_id: r.exchange_subscriber_id,
                  policy_number: r.policy_number,
                });
              // Card and modal share filteredMissingFromBO (canonical
              // getNotInBackOfficeRows). Confirmed weak-match overrides are
              // already excluded — see the page-level memo.
              const filteredMissing = filteredMissingFromBO;
              const weakPending = filteredMissing.filter((r) =>
                pendingKeys.has(keyFor(r)),
              ).length;
              const actionable = filteredMissing.length - weakPending;
              const hasIssuer = filteredMissing
                .filter((r) => !pendingKeys.has(keyFor(r)))
                .filter((r) => String(r.issuer_subscriber_id ?? '').trim() !== '').length;
              const missingIssuer = actionable - hasIssuer;
              const notInBo = filteredMissing.length;
              return (
                <MetricCard
                  title="Not in Back Office"
                  value={notInBo}
                  icon={<AlertTriangle className="h-4 w-4" />}
                  variant={notInBo > 0 ? 'destructive' : 'success'}
                  onClick={() => setNotInBoOpen(true)}
                  subtitle={
                    `${hasIssuer} disputable · ${missingIssuer} waiting` +
                    (weakPending > 0 ? ` · ${weakPending} weak BO match` : '')
                  }
                  tooltip={{
                    text:
                      `Members that pass the Expected Enrollments filter but lack a strict Back Office match. ` +
                      `Disputable = has issuer ID, BO should add them. Waiting = no issuer ID yet, usually self-resolves. ` +
                      `Weak BO match = a BO record likely matches but the join is ambiguous — review in Manual Match. ` +
                      `Confirmed overrides (${confirmed.size}) have already been upgraded to Found-in-BO.`,
                    why:
                      `Tie-out: Found-in-BO (${filteredEde.inBOCount + confirmed.size}) + Disputable (${hasIssuer}) + Waiting (${missingIssuer}) + Weak (${weakPending}) = ${filteredEde.inBOCount + confirmed.size + hasIssuer + missingIssuer + weakPending} (Expected ${filteredEde.uniqueKeys}).`,
                  }}
                />
              );
            })()}
            {weakMatchResult.pending.length > 0 && (
              <button
                type="button"
                onClick={() => navigate('/manual-match?filter=weak')}
                className="relative rounded-xl border p-5 text-left transition-all hover:shadow-md cursor-pointer hover:scale-[1.02] bg-muted/40 border-border"
                title="Open Manual Match queue filtered to weak matches"
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Weak BO Match Queue
                  </span>
                  <Link2 className="h-4 w-4 text-muted-foreground" />
                </div>
                <div className="text-3xl font-bold text-muted-foreground">
                  {weakMatchResult.pending.length.toLocaleString()}
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  Review in Manual Match · {weakMatchResult.confirmedKeys.size} confirmed,{' '}
                  {weakMatchResult.rejectedKeys.size} rejected so far
                </div>
              </button>
            )}
            {/* Total Covered Lives — sourced from canonical filteredEde so it
                follows the scope dropdown (Coverall / Vix / All) the same way
                Expected Enrollments does. The legacy debugStats.totalCoveredLives
                is whole-batch / scope-blind and is intentionally retained for one
                release as a parity oracle (verified near-equal at scope=All). */}
            {(() => {
              const tclTotal = getTotalCoveredLives(filteredEde);
              const tclByMonth = getMonthlyBreakdown('totalCoveredLives', filteredEde);
              return (
                <MetricCard
                  title="Total Covered Lives"
                  value={tclTotal}
                  icon={<Users className="h-4 w-4" />}
                  variant="info"
                  subtitle={formatMonthBreakdown(tclByMonth, { yearless: true }) || undefined}
                  tooltip={{
                    text: "Sum of coveredMemberCount across the scope's qualified EDE members — counts the subscriber plus every dependent on each policy. Per-month breakdown is by actual effective month (newly effective lives) so per-month numbers SUM to the total. Vix scope counts members whose AOR-of-record is Erica (the only Coverall_or_Vix AOR), matching Expected Enrollments — Coverall and Vix users will see different counts than the prior whole-batch number.",
                    why: "Reflects the actual number of insured lives in the selected scope, not just policy holders. Use this when reporting total members served or comparing to per-life carrier metrics.",
                  }}
                />
              );
            })()}
            {/* #121: Found in Back Office / Eligible for Commission / Should Be Paid were
                arithmetically identical for this cohort (EE universe ∩ Back Office ∩ eligible),
                so they have been consolidated into a single Should Be Paid hero card. The
                drilldown opens the same row set the prior three cards opened. */}
            <MetricCard
              title="Should Be Paid"
              value={metrics.shouldPay}
              icon={<DollarSign className="h-4 w-4" />}
              onClick={() => setDrilldown('shouldPay')}
              tooltip={{
                text: "Members in the broader expected-payment universe: Matched (EDE ∩ active BO ∩ eligible) + BO Only (active BO + eligible, not in EDE) + EDE Only (in EDE, BO inactive/absent). Phase 1 expanded this from the narrow Matched-only cohort.",
                why: "This is the full payable book of business including trailing/legacy and BO-only policies — the key number for identifying missing revenue.",
              }}
              splits={[
                { label: 'Matched', value: metrics.expectedPaymentBreakdown.universe.matchedCount },
                { label: 'BO Only', value: metrics.expectedPaymentBreakdown.universe.boOnlyCount },
                { label: 'EDE Only', value: metrics.expectedPaymentBreakdown.universe.edeOnlyCount },
              ]}
            />
            
            <MetricCard
              title="Expected Payments Received"
              value={metrics.paidEligible}
              icon={<CheckCircle2 className="h-4 w-4" />}
              variant="success"
              onClick={() => setDrilldown('paidEligible')}
              tooltip={{ text: "Members in the expected-payment universe (Matched + BO Only + EDE Only) that received commission.", why: "True success rate — how much of the broader expected book was actually paid." }}
              splits={[
                { label: 'Matched', value: metrics.expectedPaymentBreakdown.paidSplit.matched },
                { label: 'BO Only', value: metrics.expectedPaymentBreakdown.paidSplit.boOnly },
                { label: 'EDE Only', value: metrics.expectedPaymentBreakdown.paidSplit.edeOnly },
              ]}
            />
            <div className="relative">
              <MetricCard
                title="Expected But Unpaid"
                value={metrics.adjustedUnpaid}
                icon={<XCircle className="h-4 w-4" />}
                variant="destructive"
                onClick={() => setDrilldown('unpaid')}
                tooltip={{ text: "Members in the expected-payment universe (Matched + BO Only + EDE Only) that were not paid, after applying cross-batch payment clearings.", why: "Primary recovery target — expected revenue that was not received." }}
                splits={[
                  { label: 'Matched', value: metrics.adjustedUnpaidSplit.matched },
                  { label: 'BO Only', value: metrics.adjustedUnpaidSplit.boOnly },
                  { label: 'EDE Only', value: metrics.adjustedUnpaidSplit.edeOnly },
                ]}
                splits2={[
                  { label: 'Zero Net Premium', value: metrics.adjustedUnpaidPremiumSplit.zeroNetPremium },
                  { label: 'Has Premium', value: metrics.adjustedUnpaidPremiumSplit.hasPremium },
                ]}
              />
              {metrics.dashboardReviewRows.length > 0 && (
                <Badge
                  data-testid="dashboard-ebu-needs-review-chip"
                  className="absolute top-2 right-2 border-amber-300 bg-amber-50 text-amber-700"
                  variant="outline"
                >
                  Needs review: {metrics.dashboardReviewRows.length}
                </Badge>
              )}
            </div>
            {/* Bundle 13c — Cleared then reversed cohort tile (always renders). */}
            <div
              className="relative rounded-xl border p-5 text-left bg-amber-50/60 border-amber-300/60"
              data-testid="dashboard-cleared-then-reversed-tile"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Cleared then reversed
                </span>
                <AlertTriangle className="h-4 w-4 text-amber-600" />
              </div>
              <div className="text-3xl font-bold text-foreground" data-testid="dashboard-reversed-count">
                {metrics.reversedAdjustedRows.length}
              </div>
              <div className="text-xs text-muted-foreground mt-1" data-testid="dashboard-reversed-amount">
                {formatMoney(metrics.reversedUnpaidAmount)} reversed
              </div>
              {metrics.reversedAdjustedRows.length > 0 ? (
                <button
                  type="button"
                  onClick={() => navigate('/unpaid-recovery?filter=clearedThenReversed')}
                  className="mt-3 text-xs text-primary hover:underline"
                  data-testid="dashboard-reversed-link"
                >
                  View details
                </button>
              ) : (
                <span
                  className="mt-3 inline-block text-xs text-muted-foreground"
                  data-testid="dashboard-reversed-empty"
                >
                  No reversals
                </span>
              )}
            </div>
            <div className="relative rounded-xl border p-5 text-left bg-success/10 border-success/30">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Net Paid Commission</span>
                <div className="flex items-center gap-1.5">
                  <TooltipProvider delayDuration={200}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="text-muted-foreground/60 hover:text-muted-foreground transition-colors cursor-help">
                          <Info className="h-3.5 w-3.5" />
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="max-w-[320px] text-xs leading-relaxed">
                        <div className="space-y-1.5">
                          <p>Positive commission received minus clawbacks/adjustments.</p>
                          <p>
                            <strong>Clawbacks</strong> are commission reversals — they appear when a
                            previously-paid policy is unwound, refunded, or charged back.
                            They're identified as commission rows where{' '}
                            <code>amount &lt; 0</code> OR <code>pay_code</code> indicates a reversal
                            (e.g. <code>CB</code>, <code>RV</code>).
                          </p>
                          <p className="text-primary/80 font-medium">Why this matters: This is your true take-home revenue after all reversals are applied.</p>
                        </div>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  <DollarSign className="h-4 w-4 text-muted-foreground" />
                </div>
              </div>
              <div className="text-3xl font-bold text-success">
                ${metrics.netPaidTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                Gross ${metrics.totalComm.toLocaleString(undefined, { minimumFractionDigits: 2 })} −{' '}
                <button
                  type="button"
                  onClick={() => setClawbacksOpen(true)}
                  disabled={clawbackRows.length === 0}
                  className="underline decoration-dotted underline-offset-2 hover:text-destructive transition-colors disabled:no-underline disabled:cursor-default"
                  title={
                    clawbackRows.length === 0
                      ? 'No clawback rows in scope'
                      : `Click to see all ${clawbackRows.length} clawback rows`
                  }
                >
                  Clawbacks ${Math.abs(metrics.totalClawbacks).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </button>
                {clawbackRows.length > 0 && (
                  <span className="ml-1 text-muted-foreground/70">({clawbackRows.length} rows)</span>
                )}
              </div>
              {payEntityFilter === 'Vix' ? (
                <div className="mt-3 pt-3 border-t border-success/30 text-[11px] text-muted-foreground italic">
                  Split not applicable under Vix scope.
                </div>
              ) : (
                <div className="mt-3 pt-3 border-t border-success/30">
                  <div className="grid grid-cols-2 gap-2 divide-x divide-success/30">
                    <div className="pr-2">
                      <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                        <span>Coverall (direct)</span>
                        <TooltipProvider delayDuration={200}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Info className="h-3 w-3 text-muted-foreground/60 cursor-help" />
                            </TooltipTrigger>
                            <TooltipContent side="top" className="max-w-[260px] text-xs leading-relaxed">
                              Members whose writing-agent NPN is one of the three Coverall NPNs (Jason 21055210, Erica 21277051, Becky 16531877). Net Paid (positive − clawbacks) for these members in the current scope.
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </div>
                      <div className="text-base font-semibold text-foreground mt-0.5">
                        ${metrics.coverallDirectNet.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      </div>
                    </div>
                    <div className="pl-2">
                      <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                        <span>Downline (overrides)</span>
                        <TooltipProvider delayDuration={200}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Info className="h-3 w-3 text-muted-foreground/60 cursor-help" />
                            </TooltipTrigger>
                            <TooltipContent side="top" className="max-w-[260px] text-xs leading-relaxed">
                              Override commissions Coverall receives where the writing agent is NOT one of the three Coverall NPNs (e.g. Allen Ford, former-employee books). Same Net Paid formula.
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </div>
                      <div className="text-base font-semibold text-foreground mt-0.5">
                        ${metrics.downlineNet.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      </div>
                    </div>
                  </div>
                  {Math.abs(metrics.splitDelta) > 0.01 && (
                    <TooltipProvider delayDuration={200}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div className="mt-2 inline-flex items-center gap-1 rounded-md bg-destructive/15 border border-destructive/40 px-1.5 py-0.5 text-[10px] font-medium text-destructive cursor-help">
                            <AlertTriangle className="h-3 w-3" />
                            Split mismatch: ${metrics.splitDelta.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                          </div>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" className="max-w-[320px] text-xs leading-relaxed">
                          <div className="space-y-1">
                            <div>Coverall (direct) + Downline does not equal Net Paid Commission. Difference: ${metrics.splitDelta.toFixed(2)}.</div>
                            <div className="pt-1 border-t border-border/40">
                              <div>Coverall (direct) rows: <strong>{metrics.coverallDirectRows.toLocaleString()}</strong></div>
                              <div>Downline rows: <strong>{metrics.downlineRows.toLocaleString()}</strong></div>
                              <div>Unclassified rows (excluded): <strong>{metrics.unclassifiedRows.toLocaleString()}</strong> (${metrics.unclassifiedNet.toFixed(2)})</div>
                            </div>
                            <div className="pt-1 text-muted-foreground">Unclassified = commission rows whose pay_entity is neither Coverall nor matches scope; check if any Coverall-scope drift remains in the underlying records.</div>
                          </div>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                </div>
              )}
            </div>
            <MetricCard title="Clawbacks / Adjustments" value={`$${metrics.totalClawbacks.toLocaleString(undefined, { minimumFractionDigits: 2 })}`} icon={<TrendingDown className="h-4 w-4" />} variant="destructive" tooltip={{ text: "The total dollar amount of negative commission rows (clawbacks, reversals, adjustments).", why: "These reduce your net revenue. A high clawback amount may indicate policy cancellations or billing corrections." }} />
            <MetricCard title="Est. Missing Commission" value={`$${metrics.adjustedEstMissing.toLocaleString(undefined, { minimumFractionDigits: 2 })}`} icon={<TrendingDown className="h-4 w-4" />} variant="warning" tooltip={{ text: "Estimate of how much commission may be missing based on unpaid policies, after applying cross-batch payment clearings.", why: "This represents potential recoverable revenue and helps prioritize follow-up with carriers." }} />
          </div>
          <p
            data-testid="dashboard-ebu-disclaimer"
            className="text-xs text-muted-foreground italic -mt-2"
          >
            {EBU_BATCH_SCOPE_DISCLAIMER}
          </p>

          {/* Validation Panel */}
          <Card className={metrics.unpaidVariance > 5 ? 'border-destructive/50 bg-destructive/5' : 'border-success/50 bg-success/5'}>
            <CardHeader className="py-3 px-4">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <ShieldAlert className="h-4 w-4" /> Reconciliation Validation
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-3 pt-0 space-y-3">
              <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
                <div>
                  <span className="text-muted-foreground block">Should Be Paid</span>
                  <strong className="text-foreground text-lg">{metrics.shouldPay}</strong>
                </div>
                <div>
                  <span className="text-muted-foreground block">Expected Payments Received</span>
                  <strong className="text-foreground text-lg">{metrics.paidEligible}</strong>
                </div>
                <div>
                  <span className="text-muted-foreground block">Expected But Unpaid</span>
                  <strong className="text-foreground text-lg">{metrics.unpaid}</strong>
                </div>
                <div>
                  <span className="text-muted-foreground block">Difference (Should − Paid)</span>
                  <strong className="text-foreground text-lg">{metrics.difference}</strong>
                </div>
                <div>
                  <span className="text-muted-foreground block">Unpaid Variance</span>
                  <strong className={`text-lg ${metrics.unpaidVariance > 5 ? 'text-destructive' : 'text-success'}`}>
                    {metrics.unpaidVariance}
                  </strong>
                </div>
              </div>
              {debugStats && (
                <div className="flex flex-wrap gap-6 text-sm border-t pt-2">
                  <span className="text-muted-foreground">Raw Records: <strong className="text-foreground">{debugStats.totalRawRecords}</strong></span>
                  <span className="text-muted-foreground">Unique Member Keys: <strong className="text-foreground">{debugStats.uniqueMemberKeys}</strong></span>
                  <span className="text-muted-foreground">Avg Records/Key: <strong className="text-foreground">{debugStats.avgRecordsPerKey}</strong></span>
                  <span className="text-muted-foreground">has_any_ede: <strong className="text-foreground">{metrics.hasAnyEde}</strong></span>
                  <span className="text-muted-foreground">persistent is_in_expected_ede_universe (diagnostic): <strong className="text-foreground">{metrics.hasExpectedEde}</strong></span>
                  <span className="text-muted-foreground">persistent EE ∩ BO (diagnostic): <strong className="text-foreground">{metrics.expectedWithBO}</strong></span>
                </div>
              )}
              {metrics.unpaidVariance > 5 && (
                <div className="flex items-start gap-2 text-sm bg-destructive/10 rounded-md p-3 border border-destructive/20">
                  <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-destructive" />
                  <span className="text-destructive font-medium">
                    Possible duplicate consolidation or classification issue remains. Unpaid Variance ({metrics.unpaidVariance}) is materially above zero.
                  </span>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Unpaid Validation Sample */}
          {unpaidSample.length > 0 && !drilldownData && (
            <CollapsibleDebugCard
              title="Unpaid Validation Sample (top 50)"
              summary={`${unpaidSample.length} rows`}
            >
              <DataTable data={unpaidSample} columns={UNPAID_SAMPLE_COLUMNS} exportFileName="unpaid_validation_sample.csv" />
            </CollapsibleDebugCard>
          )}

          {drilldownData && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold capitalize">{drilldown} Details</h3>
                <button onClick={() => setDrilldown(null)} className="text-sm text-primary hover:underline">Close</button>
              </div>
              <DataTable data={drilldownData} columns={drilldown === 'expected' ? EXPECTED_DRILLDOWN_COLUMNS : drilldown === 'paidEdeOnly' ? PAID_EDE_ONLY_DRILLDOWN_COLUMNS : drilldown === 'boActiveNonCurrentEde' ? BO_ACTIVE_NON_CURRENT_EDE_COLUMNS : drilldown === 'unpaid' ? UNPAID_DETAILS_DRILLDOWN_COLUMNS : isExceptionDrilldown ? EXCEPTION_DRILLDOWN_COLUMNS : (isCoverageDrilldown ? COVERAGE_DRILLDOWN_COLUMNS : RECON_COLUMNS)} exportFileName={`${drilldown}_details.csv`} />
            </div>
          )}

          {!drilldownData && (
            <div>
              <h3 className="text-lg font-semibold mb-3">Source Coverage Analysis</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                <MetricCard title="Fully Matched & Paid" value={metrics.fullyMatched} icon={<CheckCircle2 className="h-4 w-4" />} variant="success" onClick={() => setDrilldown('fullyMatched')} tooltip={{ text: "These members exist in EDE and Back Office and were paid.", why: "This represents clean, correctly tracked and paid business." }} />
                <MetricCard title="Paid: Back Office Only" value={metrics.paidBackOfficeOnly} icon={<Building2 className="h-4 w-4" />} variant="warning" onClick={() => setDrilldown('paidBackOfficeOnly')} tooltip={{ text: "Members paid and active in Back Office but not in current EDE.", why: "Coverall-owned business that pays through but isn't in the current EDE snapshot." }} />
                <MetricCard title="Paid: EDE Only" value={metrics.paidEdeOnly} icon={<AlertTriangle className="h-4 w-4" />} variant="warning" onClick={() => setDrilldown('paidEdeOnly')} tooltip={{ text: "Members in EDE and paid, where the Back Office record is inactive/terminated or absent.", why: "Trailing or re-enrolled commissions on policies whose BO record was terminated or never imported." }} />
                <MetricCard title="Paid: Commission Statement Only" value={metrics.commissionOnly} icon={<FileText className="h-4 w-4" />} variant="warning" onClick={() => setDrilldown('commissionOnly')} tooltip={{ text: "Members appearing only on commission statements (no EDE, no active BO).", why: "Commission-only ghosts — typically trailing $1 retention payments on legacy books." }} />
                <MetricCard title="Unpaid: Back Office Only" value={metrics.backOfficeOnly} icon={<Building2 className="h-4 w-4" />} variant="info" onClick={() => setDrilldown('backOfficeOnly')} tooltip={{ text: "Members active in Back Office, not in EDE, not yet paid.", why: "May represent missed enrollments or future revenue not yet realized." }} />
                <div className="relative">
                  <MetricCard
                    title="Expected But Unpaid"
                    value={metrics.adjustedUnpaidExpected}
                    icon={<XCircle className="h-4 w-4" />}
                    variant="destructive"
                    onClick={() => setDrilldown('unpaidExpected')}
                    tooltip={{ text: "Members in the expected-payment universe (Matched / BO Only / EDE Only) that were not paid, after applying cross-batch payment clearings.", why: "Primary recovery target — expected revenue that was not received." }}
                    splits={(() => {
                      const o = metrics.adjustedUnpaidOwnerSplit;
                      return [
                        { label: 'JF', value: o.JF },
                        { label: 'EF', value: o.EF },
                        { label: 'BS', value: o.BS },
                        { label: 'Other', value: o.Other },
                      ].filter((s) => s.value > 0);
                    })()}
                  />
                  {metrics.sourceCoverageReviewRows.length > 0 && (
                    <Badge
                      data-testid="source-coverage-ebu-needs-review-chip"
                      className="absolute top-2 right-2 border-amber-300 bg-amber-50 text-amber-700"
                      variant="outline"
                    >
                      Needs review: {metrics.sourceCoverageReviewRows.length}
                    </Badge>
                  )}
                </div>
                <MetricCard
                  title="Total Policies Paid"
                  value={metrics.totalPaidAll}
                  icon={<DollarSign className="h-4 w-4" />}
                  variant="success"
                  onClick={() => setDrilldown('totalPaidAll')}
                  tooltip={{ text: "Count of all unique members where commission was paid, regardless of source.", why: "Total paid = Fully Matched & Paid + Paid: BO Only + Paid: EDE Only + Paid: Commission Statement Only + the paid subset of BO Active: Non-current EDE (Phase 1.7 diagnostic). All five paid buckets are summed here." }}
                  splits={(() => {
                    const a = metrics.paidAttribution;
                    return [
                      { label: 'JF', value: a.JF },
                      { label: 'EF', value: a.EF },
                      { label: 'BS', value: a.BS },
                      { label: 'Commission-Only', value: a['Commission-Only'] },
                      { label: 'Other', value: a.Other },
                    ].filter((s) => s.value > 0);
                  })()}
                />
                <MetricCard
                  title="BO Active: Non-current EDE"
                  value={metrics.boActiveNonCurrentEde}
                  icon={<Info className="h-4 w-4" />}
                  variant="info"
                  onClick={() => setDrilldown('boActiveNonCurrentEde')}
                  tooltip={{ text: "Active eligible Back Office records that also have EDE evidence, but not in the current Expected Enrollments universe.", why: "Diagnostic only — typically next-batch future-effective enrollments, AOR/key mismatches, or non-qualified EDE statuses. Excluded from Should Be Paid." }}
                  splits={(() => {
                    const b = metrics.sourceCoverage.boActiveNonCurrentEde;
                    const reasonCounts = b.reasonCounts;
                    return [
                      { label: 'Paid', value: b.paidCount },
                      { label: 'Unpaid', value: b.unpaidCount },
                      { label: 'Future-eff', value: reasonCounts['future-effective'] },
                      { label: 'Non-qualified', value: reasonCounts['non-qualified-status'] },
                      { label: 'AOR/key mismatch', value: reasonCounts['aor-or-key-mismatch'] },
                      { label: 'Unknown', value: reasonCounts['unknown'] },
                    ].filter((s) => s.value > 0);
                  })()}
                />

              </div>
              <p
                data-testid="dashboard-source-coverage-ebu-disclaimer"
                className="text-xs text-muted-foreground italic mt-2"
              >
                {EBU_BATCH_SCOPE_DISCLAIMER}
              </p>
            </div>
          )}

          {!drilldownData && (
            <div>
              <h3 className="text-lg font-semibold mb-3">Exception Summary</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {([
                  { issue: 'Wrong Pay Entity', drillKey: 'exceptionWrongPayEntity', tip: { text: "These members were paid, but under the wrong entity (for example, Vix instead of Coverall).", why: "Revenue may be going to the wrong account and may need to be corrected." } },
                  { issue: 'Not Eligible for Commission', drillKey: 'exceptionNotEligible', tip: { text: "These members exist but are not marked as eligible for commission by the carrier.", why: "These policies will not generate revenue unless eligibility is corrected." } },
                ] as const).map(({ issue, drillKey, tip }) => {
                  // Bundle 6 — single-source: same array drives count and drilldown.
                  const rows = exceptionRowsByIssue[issue];
                  const count = rows.length;
                  return count > 0 ? (
                    <MetricCard key={issue} title={getIssueTypeLabel(issue)} value={count} variant={issue.includes('Wrong') ? 'destructive' : 'warning'} tooltip={tip} onClick={() => setDrilldown(drillKey)} />
                  ) : null;
                })}
              </div>
            </div>
          )}
        </>
      )}

      {/* Debug Counts */}
      <CollapsibleDebugCard
        title="Debug Counts (Selected Batch)"
        icon={<Database className="h-4 w-4" />}
        summary={`${counts.uploadedFiles} files · ${counts.normalizedRecords} normalized · ${counts.reconciledMembers} members`}
      >
          <div className="flex flex-wrap gap-6 text-sm">
            <span className="text-muted-foreground">Uploaded Files: <strong className="text-foreground">{counts.uploadedFiles}</strong></span>
            <span className="text-muted-foreground">Normalized Records: <strong className="text-foreground">{counts.normalizedRecords}</strong></span>
            <span className="text-muted-foreground">Reconciled Members: <strong className="text-foreground">{counts.reconciledMembers}</strong></span>
            <span className="text-muted-foreground">Filtered Members: <strong className="text-foreground">{filtered.length}</strong></span>
          </div>
          {debugStats && (
            <div className="flex flex-wrap gap-6 text-sm border-t pt-2 mt-2">
              <span className="text-muted-foreground">Raw Records: <strong className="text-foreground">{debugStats.totalRawRecords}</strong></span>
              <span className="text-muted-foreground">EDE rows: <strong className="text-foreground">{debugStats.totalEDE}</strong></span>
              <span className="text-muted-foreground">Back Office rows: <strong className="text-foreground">{debugStats.totalBO}</strong></span>
              <span className="text-muted-foreground">Commission rows: <strong className="text-foreground">{debugStats.totalComm}</strong></span>
              <span className="text-muted-foreground">Unique Member Keys: <strong className="text-foreground">{debugStats.uniqueMemberKeys}</strong></span>
              <span className="text-muted-foreground">Avg Records/Key: <strong className="text-foreground">{debugStats.avgRecordsPerKey}</strong></span>
            </div>
          )}
          {debugStats && (
            <div className="flex flex-wrap gap-6 text-sm border-t pt-2 mt-2">
              <span className="text-muted-foreground">EDE w/ issuerSubId: <strong className="text-foreground">{debugStats.edeWithIssuerSubId}</strong></span>
              <span className="text-muted-foreground">EDE missing issuerSubId: <strong className="text-foreground">{debugStats.edeMissingIssuerSubId}</strong></span>
              <span className="text-muted-foreground">…of which have exchangeSubId: <strong className="text-foreground">{debugStats.edeMissingIssuerSubIdWithExchange}</strong></span>
              <span className="text-muted-foreground">Promoted from sibling: <strong className="text-foreground">{debugStats.edePromotedIssuerSubIdFromExchange}</strong></span>
              <span className="text-muted-foreground">BO starting "U": <strong className="text-foreground">{debugStats.boStartingWithU}</strong></span>
              <span className="text-muted-foreground">Comm starting "U": <strong className="text-foreground">{debugStats.commStartingWithU}</strong></span>
              <span className="text-muted-foreground">BO Active (in period): <strong className="text-foreground">{debugStats.boActiveCount}</strong></span>
              <span className="text-muted-foreground">BO Excluded (expired term): <strong className="text-foreground">{debugStats.boExcludedCount}</strong></span>
              <span className="text-muted-foreground">BO No Term Date (assumed active): <strong className="text-foreground">{debugStats.boMissingTermDate}</strong></span>
            </div>
          )}
          {debugStats && debugStats.edeMissingIssuerSubIdSamples.length > 0 && (
            <div className="border-t pt-2 mt-2 text-xs">
              <div className="text-muted-foreground font-medium mb-1">
                Sample EDE rows missing issuerSubId (with exchangeSubId):
              </div>
              <div className="space-y-1 font-mono">
                {debugStats.edeMissingIssuerSubIdSamples.map((s, i) => (
                  <div key={i} className="text-foreground">
                    {s.applicant_name} — exchSub: {s.exchange_subscriber_id} — exchPol: {s.exchange_policy_id || '—'} — file: {s.source_file_label}
                  </div>
                ))}
              </div>
            </div>
          )}
          {debugStats && (
            <div className="flex flex-wrap gap-6 text-sm border-t pt-2 mt-2">
              <span className="text-muted-foreground">Match by issuer_sub_id: <strong className="text-foreground">{debugStats.matchByIssuerSubId}</strong></span>
              <span className="text-muted-foreground">Match by exchange_sub_id: <strong className="text-foreground">{debugStats.matchByExchangeSubId}</strong></span>
              <span className="text-muted-foreground">Match by policy_number: <strong className="text-foreground">{debugStats.matchByPolicyNumber}</strong></span>
              <span className="text-muted-foreground">Match by name: <strong className="text-foreground">{debugStats.matchByName}</strong></span>
              <span className="text-muted-foreground">Match by fallback: <strong className="text-foreground">{debugStats.matchByFallback}</strong></span>
            </div>
          )}
      </CollapsibleDebugCard>

      {/* EDE Enrollment Debug */}
      {debugStats && (
        <CollapsibleDebugCard
          title="EDE Expected Enrollment Debug"
          icon={<Users className="h-4 w-4" />}
          summary={`${debugStats.edeAfterFilter} qualified · ${formatMonthBreakdown(filteredEde.byMonth) || 'no months'}`}
        >
            <div className="flex flex-wrap gap-6 text-sm">
              <span className="text-muted-foreground">Total Raw EDE rows: <strong className="text-foreground">{debugStats.edeRawTotal}</strong></span>
              <span className="text-muted-foreground">After filter (eff. date + status): <strong className="text-foreground">{debugStats.edeAfterFilter}</strong></span>
              <span className="text-muted-foreground">Unique member_keys after filter: <strong className="text-foreground">{debugStats.edeUniqueKeysAfterFilter}</strong></span>
              <span className="text-muted-foreground">Expected Enrollments (reconciled): <strong className="text-foreground">{metrics.expected}</strong></span>
              <span className="text-muted-foreground">All EDE unfiltered: <strong className="text-foreground">{metrics.totalEdeRaw}</strong></span>
              <span className="text-muted-foreground">Invalid date rows: <strong className="text-foreground">{debugStats.edeInvalidDateCount}</strong></span>
            </div>
            <div className="flex flex-wrap gap-6 text-sm border-t pt-2 items-center">
              <span className="text-muted-foreground font-medium">Expected by month (newly effective):</span>
              {Object.entries(filteredEde.byMonth)
                .filter(([m, c]) => m && (c ?? 0) > 0)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([m, c]) => (
                  <button
                    key={m}
                    onClick={() => loadEdeRawDrilldown(m)}
                    className="text-muted-foreground hover:text-primary underline-offset-4 hover:underline"
                  >
                    {formatMonthStart(m)}: <strong className="text-foreground">{c.toLocaleString()}</strong>
                  </button>
                ))}
              <span className="text-xs text-muted-foreground italic">(click a count to drilldown into raw EDE rows)</span>
            </div>
            <div className="flex flex-wrap gap-4 text-sm border-t pt-2">
              <span className="text-muted-foreground font-medium">Status breakdown:</span>
              {Object.entries(debugStats.edeStatusBreakdown).sort((a, b) => b[1] - a[1]).map(([status, count]) => (
                <span key={status} className="text-muted-foreground">
                  {status}: <strong className="text-foreground">{count as number}</strong>
                </span>
              ))}
            </div>
            {debugStats.edeEffDateSamples.length > 0 && (
              <div className="flex flex-wrap gap-4 text-sm border-t pt-2">
                <span className="text-muted-foreground font-medium">Effective date samples:</span>
                {debugStats.edeEffDateSamples.map((d, i) => (
                  <span key={i} className="text-muted-foreground font-mono">{d}</span>
                ))}
              </div>
            )}
            {edeRawDrilldown && (
              <div className="border-t pt-3 mt-2 space-y-2">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-semibold">
                    Raw EDE rows for {formatMonthStart(edeRawDrilldown ?? '')}
                    {!edeRawLoading && ` (${edeRawRows.length} rows)`}
                  </h4>
                  <button onClick={() => { setEdeRawDrilldown(null); setEdeRawRows([]); }} className="text-sm text-primary hover:underline">Close</button>
                </div>
                {edeRawLoading ? (
                  <div className="text-sm text-muted-foreground py-4">Loading raw EDE rows...</div>
                ) : (
                  <DataTable
                    data={edeRawRows}
                    columns={EDE_RAW_DRILLDOWN_COLUMNS}
                    exportFileName={`ede_raw_${edeRawDrilldown}.csv`}
                    pageSize={25}
                  />
                )}
              </div>
            )}
        </CollapsibleDebugCard>
      )}

      {/* Commission Aggregation Debug */}
      {debugStats && (
        <CollapsibleDebugCard
          title="Commission Aggregation Debug"
          icon={<DollarSign className="h-4 w-4" />}
          summary={`${debugStats.commRawRows} rows · +$${debugStats.commTotalPositive.toLocaleString(undefined, { minimumFractionDigits: 2 })} / −$${Math.abs(debugStats.commTotalNegative).toLocaleString(undefined, { minimumFractionDigits: 2 })}`}
        >
            <div className="flex flex-wrap gap-6 text-sm">
              <span className="text-muted-foreground">Raw Rows: <strong className="text-foreground">{debugStats.commRawRows}</strong></span>
              <span className="text-muted-foreground">Positive Rows: <strong className="text-foreground">{debugStats.commPositiveRows}</strong></span>
              <span className="text-muted-foreground">Negative Rows: <strong className="text-foreground">{debugStats.commNegativeRows}</strong></span>
              <span className="text-muted-foreground">Distinct Policy (raw): <strong className="text-foreground">{debugStats.commDistinctPolicyRaw}</strong></span>
              <span className="text-muted-foreground">Distinct Policy (normalized): <strong className="text-foreground">{debugStats.commDistinctPolicyNormalized}</strong></span>
            </div>
            <div className="flex flex-wrap gap-6 text-sm border-t pt-2">
              <span className="text-muted-foreground">Total Positive: <strong className="text-foreground">${debugStats.commTotalPositive.toLocaleString(undefined, { minimumFractionDigits: 2 })}</strong></span>
              <span className="text-muted-foreground">Total Negative: <strong className="text-foreground">${debugStats.commTotalNegative.toLocaleString(undefined, { minimumFractionDigits: 2 })}</strong></span>
            </div>
            {debugStats.commSampleRaw && debugStats.commSampleRaw.length > 0 && (
              <div className="border-t pt-2">
                <div className="text-sm text-muted-foreground font-medium mb-1">Sample (first 10 rows): raw → parsed</div>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-xs font-mono">
                  {debugStats.commSampleRaw.map((raw, i) => (
                    <div key={i} className="border rounded px-2 py-1 bg-muted/30">
                      <div className="text-muted-foreground truncate" title={raw}>{raw}</div>
                      <div className="text-foreground">→ {debugStats.commSampleParsed[i]?.toFixed(2)}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
        </CollapsibleDebugCard>
      )}

      {/* Clawbacks Detail — every negative-amount commission row in scope.
          Sourced from raw normalized commission records so it ties exactly to
          the Net Paid card's "Clawbacks $X" line. Each row carries its source
          file label + statement date so we can answer "why is a Mar 21 row in
          the Mar 2026 batch?" without leaving the dashboard. */}
      {clawbackRows.length > 0 && (
        <CollapsibleDebugCard
          title="Clawbacks Detail"
          icon={<TrendingDown className="h-4 w-4 text-destructive" />}
          summary={`${clawbackRows.length} rows · −$${Math.abs(metrics.totalClawbacks).toLocaleString(undefined, { minimumFractionDigits: 2 })}`}
        >
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              All commission rows where amount &lt; 0 within the current{' '}
              <strong>{payEntityFilter}</strong> scope, sorted most-negative first.
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => {
                const header = ['applicant_name','policy_number','pay_code','amount','pay_entity','source_file_label','statement_date','member_key'];
                const csv = [header.join(',')]
                  .concat(
                    clawbackRows.map((r) =>
                      header
                        .map((k) => {
                          const v = String((r as any)[k] ?? '');
                          return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
                        })
                        .join(','),
                    ),
                  )
                  .join('\n');
                const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `clawbacks-${payEntityFilter.toLowerCase()}-${currentBatchId ?? 'batch'}.csv`;
                a.click();
                URL.revokeObjectURL(url);
              }}
            >
              Export CSV
            </Button>
          </div>
          <div className="border rounded-md max-h-[420px] overflow-auto">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 sticky top-0">
                <tr className="text-left">
                  <th className="px-2 py-1.5 font-medium">Member</th>
                  <th className="px-2 py-1.5 font-medium">Policy #</th>
                  <th className="px-2 py-1.5 font-medium">Pay Code</th>
                  <th className="px-2 py-1.5 font-medium text-right">Amount</th>
                  <th className="px-2 py-1.5 font-medium">Pay Entity</th>
                  <th className="px-2 py-1.5 font-medium">Source File</th>
                  <th
                    className="px-2 py-1.5 font-medium cursor-pointer select-none hover:text-foreground"
                    onClick={toggleClawbackStatementSort}
                    title="Click to sort by Statement Date"
                  >
                    Statement Date{clawbackStatementSortIndicator}
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedClawbackRows.slice(0, 500).map((r, i) => (
                  <tr key={i} className="border-t">
                    <td className="px-2 py-1 truncate max-w-[160px]" title={r.applicant_name}>{r.applicant_name || '—'}</td>
                    <td className="px-2 py-1 font-mono">{r.policy_number || '—'}</td>
                    <td className="px-2 py-1 font-mono">{r.pay_code}</td>
                    <td className="px-2 py-1 text-right font-mono text-destructive">
                      ${r.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </td>
                    <td className="px-2 py-1">{r.pay_entity || '—'}</td>
                    <td className="px-2 py-1 truncate max-w-[200px]" title={r.source_file_label}>{r.source_file_label || '—'}</td>
                    <td className="px-2 py-1">{r.statement_date || '—'}</td>
                  </tr>
                ))}
                {sortedClawbackRows.length > 500 && (
                  <tr>
                    <td colSpan={7} className="px-2 py-2 text-center text-muted-foreground italic">
                      Showing first 500 of {sortedClawbackRows.length}. Export CSV for the full list.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CollapsibleDebugCard>
      )}

      {/* EE Universe Audit — surfaces the gap between EE total and
          (Found-in-BO + Not-in-BO). Read-only diagnostic panel; classifies
          each gap row with a best-effort inferred reason so we can decide
          the right downstream fix without designing a "not actionable"
          bucket that hides bugs. */}
      {reconciled.length > 0 && normalizedRecords.length > 0 && (
        <CollapsibleDebugCard
          title="Persistent vs Canonical EE-Universe Drift"
          icon={<ShieldAlert className="h-4 w-4" />}
          summary={`${eeAuditRows.length} EE members fall outside Found and Not-in-BO buckets`}
        >
          <div className="text-xs text-muted-foreground">
            Diagnostic (#118 follow-up): rows where the persistent
            <code className="font-mono mx-1">reconciled_members.is_in_expected_ede_universe</code>
            flag and live <em>canonical</em> EE-universe calculation disagree.
            Members in the Expected Enrollments universe (scope:{' '}
            <strong>{payEntityFilter}</strong>) who are NOT in the Found-in-BO
            bucket and NOT in the actionable Not-in-BO bucket. UI metrics no
            longer depend on the persistent flag — this panel exists to
            surface stale-rebuild / reconcile-time drift. The
            <em> Inferred Reason</em> column is a best-effort classification
            computed at render time, not stored.
          </div>
          <DataTable
            data={eeAuditRows}
            columns={[
              { key: 'applicant_name', label: 'Member Name' },
              { key: 'policy_number', label: 'Policy #' },
              { key: 'issuer_subscriber_id', label: 'Issuer Sub ID' },
              { key: 'exchange_subscriber_id', label: 'Exchange Sub ID' },
              { key: 'ede_status', label: 'EDE Status' },
              { key: 'current_policy_aor', label: 'currentPolicyAOR' },
              { key: 'writing_agent_npn', label: 'Writing Agent NPN' },
              { key: 'bo_record_exists', label: 'BO Record Exists?' },
              { key: 'bo_broker_npn', label: 'BO Broker NPN' },
              { key: 'bo_eligible', label: 'BO Eligible' },
              { key: 'bo_term_date', label: 'BO Term Date' },
              { key: 'bo_state', label: 'BO State' },
              { key: 'inferred_reason', label: 'Inferred Reason' },
            ]}
            exportFileName={`ee_universe_audit_${payEntityFilter.toLowerCase()}.csv`}
            pageSize={25}
          />
        </CollapsibleDebugCard>
      )}
      {/* Clawbacks drilldown — opened from the Net Paid Commission card. */}
      <Dialog open={clawbacksOpen} onOpenChange={setClawbacksOpen}>
        <DialogContent className="max-w-5xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <TrendingDown className="h-5 w-5 text-destructive" />
              Clawbacks ({clawbackRows.length} rows · −${Math.abs(metrics.totalClawbacks).toLocaleString(undefined, { minimumFractionDigits: 2 })})
            </DialogTitle>
            <DialogDescription>
              All commission rows where amount &lt; 0 within the current{' '}
              <strong>{payEntityFilter}</strong> scope. These are the exact rows that produce the
              Clawbacks total on the Net Paid Commission card. Source File and Statement Date columns
              show which statement each row originated from — useful for spotting prior-month statements
              that landed in this batch.
            </DialogDescription>
          </DialogHeader>
          <div className="border rounded-md overflow-auto max-h-[60vh]">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 sticky top-0">
                <tr className="text-left">
                  <th className="px-2 py-1.5 font-medium">Member</th>
                  <th className="px-2 py-1.5 font-medium">Policy #</th>
                  <th className="px-2 py-1.5 font-medium">Pay Code</th>
                  <th className="px-2 py-1.5 font-medium text-right">Amount</th>
                  <th className="px-2 py-1.5 font-medium">Pay Entity</th>
                  <th className="px-2 py-1.5 font-medium">Source File</th>
                  <th
                    className="px-2 py-1.5 font-medium cursor-pointer select-none hover:text-foreground"
                    onClick={toggleClawbackStatementSort}
                    title="Click to sort by Statement Date"
                  >
                    Statement Date{clawbackStatementSortIndicator}
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedClawbackRows.map((r, i) => (
                  <tr key={i} className="border-t">
                    <td className="px-2 py-1 truncate max-w-[180px]" title={r.applicant_name}>{r.applicant_name || '—'}</td>
                    <td className="px-2 py-1 font-mono">{r.policy_number || '—'}</td>
                    <td className="px-2 py-1 font-mono">{r.pay_code}</td>
                    <td className="px-2 py-1 text-right font-mono text-destructive">
                      ${r.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </td>
                    <td className="px-2 py-1">{r.pay_entity || '—'}</td>
                    <td className="px-2 py-1 truncate max-w-[220px]" title={r.source_file_label}>{r.source_file_label || '—'}</td>
                    <td className="px-2 py-1">{r.statement_date || '—'}</td>
                  </tr>
                ))}
                {sortedClawbackRows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-2 py-3 text-center text-muted-foreground italic">
                      No clawback rows in scope.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setClawbacksOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Not in Back Office drilldown */}
      <Dialog open={notInBoOpen} onOpenChange={setNotInBoOpen}>
        <DialogContent className="max-w-6xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              EDE Enrollments Not in Back Office ({filteredMissingFromBO.length})
            </DialogTitle>
            <DialogDescription>
              Members who pass the Expected Enrollments filter (scope: {payEntityFilter}) but have no
              matching Back Office record. Split into two action-distinct buckets below.
            </DialogDescription>
          </DialogHeader>
          {(() => {
            // Card and modal share the same canonical row set
            // (filteredMissingFromBO via getNotInBackOfficeRows) so confirmed
            // weak-match overrides never appear in either surface.
            const hasIssuerRows = filteredMissingFromBO.filter(r => String(r.issuer_subscriber_id ?? '').trim() !== '');
            const missingIssuerRows = filteredMissingFromBO.filter(r => String(r.issuer_subscriber_id ?? '').trim() === '');
            const monthSuffix = statementMonth || priorMonth || '';
            const fileSuffix = monthSuffix ? `_${monthSuffix}` : '';
            return (
              <Tabs defaultValue="has-issuer" className="w-full">
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger
                    value="has-issuer"
                    className="data-[state=active]:bg-destructive/10 data-[state=active]:text-destructive data-[state=active]:border-destructive/40 border border-transparent"
                  >
                    Has Issuer ID ({hasIssuerRows.length})
                  </TabsTrigger>
                  <TabsTrigger value="missing-issuer">
                    Missing Issuer ID ({missingIssuerRows.length})
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="has-issuer" className="space-y-3">
                  <p className="text-xs text-destructive/90 bg-destructive/5 border border-destructive/20 rounded-md px-3 py-2">
                    Issuer ID has been assigned but Back Office still has no record. Active dispute candidate — chase the BO team to add these policies.
                  </p>
                  <DataTable
                    data={hasIssuerRows as unknown as Record<string, unknown>[]}
                    columns={NOT_IN_BO_COLUMNS}
                    exportFileName={`not-in-bo-has-issuer-id${fileSuffix}.csv`}
                    pageSize={25}
                    renderCell={(key, row) => {
                      if (key !== 'issuer_subscriber_id') return undefined;
                      const meta = (row as any).issuer_subscriber_id_resolved as { source_kind?: string; batch_month?: string } | undefined;
                      const v = row[key];
                      const text = v == null || v === '' ? '—' : String(v);
                      if (!meta) return text;
                      return <span>{text}<ResolvedBadge sourceKind={meta.source_kind} batchMonth={meta.batch_month} /></span>;
                    }}
                  />
                </TabsContent>
                <TabsContent value="missing-issuer" className="space-y-3">
                  <p className="text-xs text-muted-foreground bg-muted/40 border border-border rounded-md px-3 py-2">
                    Waiting for Ambetter to assign a policy/issuer ID. Usually self-resolves within 1-2 months of effectuation. Chase only if aged.
                  </p>
                  <DataTable
                    data={missingIssuerRows as unknown as Record<string, unknown>[]}
                    columns={NOT_IN_BO_COLUMNS}
                    exportFileName={`not-in-bo-missing-issuer-id${fileSuffix}.csv`}
                    pageSize={25}
                  />
                </TabsContent>
              </Tabs>
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* Resolve Identities confirmation */}
      <Dialog open={resolveConfirmOpen} onOpenChange={setResolveConfirmOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Link2 className="h-5 w-5 text-primary" />
              Resolve Identities Across Batches
            </DialogTitle>
            <DialogDescription className="space-y-2 pt-2">
              <span className="block">
                Scans every batch for matching applicants (by FFM App ID, falling back to Exchange Subscriber ID) and learns issuer subscriber IDs, issuer policy IDs, and exchange policy IDs that were blank in earlier files but revealed in later ones.
              </span>
              <span className="block text-foreground font-medium">
                Originals are NOT modified. Resolved values are stored in a sidecar table and layered in only when the record's own field is blank.
              </span>
              <span className="block">
                After resolution completes, reconciliation will automatically re-run for the current batch so downstream counts update.
              </span>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResolveConfirmOpen(false)} disabled={resolving}>Cancel</Button>
            <Button onClick={handleResolveIdentities} disabled={resolving}>
              <Link2 className={`h-4 w-4 mr-1 ${resolving ? 'animate-pulse' : ''}`} />
              {resolving ? 'Resolving...' : 'Run Resolution'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Invariants results */}
      <Dialog open={invariantsOpen} onOpenChange={setInvariantsOpen}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-primary" />
              Invariants Check
            </DialogTitle>
            <DialogDescription>
              Batch <span className="font-mono text-foreground">{currentBatch?.label || currentBatchId || '—'}</span>
              {' · '}Scope <span className="font-mono text-foreground">{payEntityFilter}</span>.
              Cross-page checks that catch definitional drift. Failures mean a page is computing a metric
              outside the canonical helpers in <code className="font-mono">src/lib/canonical/</code>.
            </DialogDescription>
          </DialogHeader>
          {/* #125 — Run summary header: timestamp + aggregate counts so the
              operator can confirm the click executed even when results
              didn't change. Always rendered after at least one run. */}
          {(() => {
            if (invariantsRunning && !invariantResults) {
              return (
                <div className="flex items-center gap-2 text-sm text-muted-foreground border rounded-md px-3 py-2">
                  <RefreshCw className="h-4 w-4 animate-spin" />
                  Running invariant checks…
                </div>
              );
            }
            if (!invariantResults) return null;
            const passed = invariantResults.filter((r) => r.status === 'pass').length;
            const failed = invariantResults.filter((r) => r.status === 'fail').length;
            const errored = invariantResults.filter((r) => r.status === 'error').length;
            const total = invariantResults.length;
            const allGreen = passed === total && total > 0;
            const ts = invariantsLastRunAt;
            const summaryText = allGreen
              ? `All ${total} invariants passed`
              : `${passed} of ${total} passed${failed ? ` · ${failed} failed` : ''}${errored ? ` · ${errored} errored` : ''}`;
            return (
              <div
                className={`flex items-center justify-between gap-3 border rounded-md px-3 py-2 text-sm ${
                  allGreen ? 'bg-success/10 border-success/30' : 'bg-destructive/10 border-destructive/30'
                }`}
                data-testid="invariants-summary"
              >
                <div className="flex items-center gap-2 font-medium text-foreground">
                  {allGreen ? (
                    <CheckCircle2 className="h-4 w-4 text-success" />
                  ) : (
                    <XCircle className="h-4 w-4 text-destructive" />
                  )}
                  {summaryText}
                  {invariantsRunning && (
                    <RefreshCw className="h-3.5 w-3.5 animate-spin text-muted-foreground ml-1" />
                  )}
                </div>
                {ts && (
                  <div className="text-xs text-muted-foreground font-mono" title={ts.toISOString()}>
                    Last run: {ts.toLocaleTimeString()}
                  </div>
                )}
              </div>
            );
          })()}
          <div className="space-y-2">
            {(invariantResults ?? []).map((r) => {
              const hasNumbers =
                r.status === 'fail' &&
                (typeof r.expected === 'number' || typeof r.actual === 'number');
              const tone =
                r.status === 'pass'
                  ? 'bg-success/10 border-success/30'
                  : r.status === 'error'
                    ? 'bg-warning/10 border-warning/40'
                    : 'bg-destructive/10 border-destructive/30';
              return (
                <div key={r.id} className={`rounded-md border px-3 py-2 text-sm ${tone}`} data-testid={`invariant-${r.id}`}>
                  <div className="flex items-start gap-2">
                    {r.status === 'pass' ? (
                      <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0 text-success" />
                    ) : r.status === 'error' ? (
                      <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-warning" />
                    ) : (
                      <XCircle className="h-4 w-4 mt-0.5 shrink-0 text-destructive" />
                    )}
                    <div className="flex-1">
                      <div className="font-medium text-foreground flex items-center gap-2">
                        {r.label}
                        {r.status === 'error' && (
                          <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-warning/20 text-warning-foreground border border-warning/40">
                            error
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">{r.detail}</div>
                      {hasNumbers && (
                        <div className="text-xs font-mono mt-1 grid grid-cols-3 gap-2 text-foreground">
                          <span>expected: {r.expected?.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                          <span>actual: {r.actual?.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                          <span className="text-destructive">delta: {r.delta?.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={executeInvariants} disabled={invariantsRunning}>
              <RefreshCw className={`h-4 w-4 mr-1 ${invariantsRunning ? 'animate-spin' : ''}`} />
              {invariantsRunning ? 'Running…' : 'Re-run'}
            </Button>
            <Button variant="outline" onClick={() => setInvariantsOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
