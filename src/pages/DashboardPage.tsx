import { useMemo, useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBatch } from '@/contexts/BatchContext';
import { MetricCard } from '@/components/MetricCard';
import { DataTable } from '@/components/DataTable';
import { BatchSelector } from '@/components/BatchSelector';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Users, Building2, DollarSign, AlertTriangle, CheckCircle2, XCircle, FileText, TrendingDown, Database, Info, ShieldAlert, RefreshCw, Hammer, Link2 } from 'lucide-react';
import { getNormalizedRecords, saveReconciledMembers } from '@/lib/persistence';
import { reconcile } from '@/lib/reconcile';
import { useToast } from '@/hooks/use-toast';
import { RebuildBatchButton } from '@/components/RebuildBatchButton';
import { RebuildAllBatchesButton } from '@/components/RebuildAllBatchesButton';
import { RECONCILE_LOGIC_VERSION } from '@/lib/rebuild';
import { CollapsibleDebugCard } from '@/components/CollapsibleDebugCard';
import { SourceFunnelCard } from '@/components/SourceFunnelCard';
import { isCoverallAORByName, isCoverallAORByNPN, COVERALL_NPN_SET } from '@/lib/agents';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { getCoveredMonths, monthKeyToFirstOfMonth, fallbackReconcileMonth } from '@/lib/dateRange';
import { computeFilteredEde } from '@/lib/expectedEde';
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
  getNotInBackOffice,
} from '@/lib/canonical';

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

const RECON_COLUMNS = [
  { key: 'applicant_name', label: 'Name' },
  { key: 'policy_number', label: 'Policy #' },
  { key: 'issuer_subscriber_id', label: 'Issuer Sub ID' },
  { key: 'agent_name', label: 'Agent' },
  { key: 'aor_bucket', label: 'AOR' },
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
  { key: 'aor_bucket', label: 'AOR' },
  { key: 'policy_number', label: 'Policy #' },
  { key: 'issuer_subscriber_id', label: 'Issuer Sub ID' },
  { key: 'in_ede', label: 'EDE' },
  { key: 'in_back_office', label: 'Back Office' },
  { key: 'in_commission', label: 'Commission' },
  { key: 'eligible_for_commission', label: 'Eligible' },
  { key: 'actual_commission', label: 'Commission $' },
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

const PAY_ENTITY_STORAGE_KEY = 'dashboard_pay_entity_filter';

const ERICA_NPN = '21277051';

type PayEntityFilter = 'Coverall' | 'Vix' | 'All';

function getStoredPayEntity(): PayEntityFilter {
  try {
    const stored = localStorage.getItem(PAY_ENTITY_STORAGE_KEY);
    if (stored === 'Coverall' || stored === 'Vix' || stored === 'All') return stored;
  } catch {}
  return 'Coverall';
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
  const [payEntityFilter, setPayEntityFilter] = useState<PayEntityFilter>(getStoredPayEntity);
  const [edeRawDrilldown, setEdeRawDrilldown] = useState<string | null>(null);
  const [edeRawRows, setEdeRawRows] = useState<Record<string, unknown>[]>([]);
  const [edeRawLoading, setEdeRawLoading] = useState(false);
  const [notInBoOpen, setNotInBoOpen] = useState(false);
  const [clawbacksOpen, setClawbacksOpen] = useState(false);
  const [invariantsOpen, setInvariantsOpen] = useState(false);
  const [invariantResults, setInvariantResults] = useState<InvariantResult[] | null>(null);
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

  useEffect(() => {
    localStorage.setItem(PAY_ENTITY_STORAGE_KEY, payEntityFilter);
  }, [payEntityFilter]);

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
      await saveReconciledMembers(currentBatchId, members);
      await refreshAll();
      toast({ title: 'Reconciliation Complete', description: `${members.length} members reconciled` });
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
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
    const candidates = findWeakMatches(filteredEde.uniqueMembers, normalizedRecords);
    const { confirmedKeys, rejectedKeys, pending } = applyOverrides(candidates, weakOverrides);
    return { candidates, confirmedKeys, rejectedKeys, pending };
  }, [filteredEde, normalizedRecords, weakOverrides]);

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
   * Run the canonical invariant suite against the currently-loaded data and
   * stash results into modal state. Extracted as a callback so the modal's
   * "Re-run" button can re-invoke it without duplicating the input wiring.
   */
  const executeInvariants = useCallback(() => {
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
    });
    setInvariantResults(results);
  }, [reconciled, normalizedRecords, filteredEde, confirmedUpgradeMemberKeys, weakMatchResult, payEntityFilter]);

  const dashboardTitle = useMemo(() => {
    switch (payEntityFilter) {
      case 'Coverall': return 'Coverall Commission Reconciliation';
      case 'Vix': return 'Vix Health Commission Reconciliation';
      case 'All': return 'Combined Commission Reconciliation';
    }
  }, [payEntityFilter]);

  const metrics = useMemo(() => {
    const expected = filtered.filter(r => r.is_in_expected_ede_universe).length;
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
    const eligibleCohort = getEligibleCohort(reconciled, scopeForCanonical, confirmedUpgradeMemberKeys);
    const eligible = eligibleCohort.length;
    const shouldPay = eligible;
    // Count distinct policies with positive payments
    const paidCommRecords = filtered.filter(r => r.in_commission).length;
    const paidEligible = eligibleCohort.filter(r => r.in_commission).length;
    const unpaid = shouldPay - paidEligible;
    // Gross / Clawbacks / Net Paid — computed from RAW commission records and
    // scoped by the dashboard's pay_entity filter, so they match exactly what
    // the carrier statement(s) for the selected scope contain. Aggregating from
    // the per-member `filtered` set bleeds in cross-entity dollars whenever a
    // member's expected_pay_entity differs from where they were actually paid
    // (e.g. expected Coverall but Vix paid the row, or vice-versa).
    let totalComm = 0;
    let totalClawbacks = 0;
    for (const rec of normalizedRecords) {
      if (rec.source_type !== 'COMMISSION') continue;
      if (payEntityFilter === 'Coverall' && rec.pay_entity !== 'Coverall') continue;
      if (payEntityFilter === 'Vix' && rec.pay_entity !== 'Vix') continue;
      const amt = Number(rec.commission_amount) || 0;
      if (amt > 0) totalComm += amt;
      else if (amt < 0) totalClawbacks += amt;
    }
    // Coverall vs Downline split — computed from RAW commission records (not the
    // per-member aggregates) because positives and clawbacks within a single
    // reconciled member can come from rows with different writing-agent NPNs.
    //
    // Bucketing per row (commission rows only):
    //   - Coverall (direct): writing-agent NPN ∈ COVERALL_NPN_SET (any pay_entity).
    //   - Downline (overrides): pay_entity = "Coverall" AND writing-agent NPN ∉ COVERALL_NPN_SET
    //     (this also catches blank/unknown NPNs on Coverall statements per the
    //     "income belongs to Coverall regardless of who wrote it" rule).
    //   - Otherwise: not in either bucket (e.g. Vix-statement rows for non-Coverall NPNs).
    //
    // Each bucket is NET (positives minus clawbacks within the bucket), so
    // direct + downline ties to Net Paid Commission exactly when scope is
    // Coverall or All.
    let coverallDirectNet = 0;
    let downlineNet = 0;
    let coverallDirectRows = 0;
    let downlineRows = 0;
    let unclassifiedRows = 0;
    let unclassifiedNet = 0;
    for (const rec of normalizedRecords) {
      if (rec.source_type !== 'COMMISSION') continue;
      const amt = Number(rec.commission_amount) || 0;
      if (amt === 0) continue;
      // Apply same pay-entity scope as the rest of the dashboard.
      if (payEntityFilter === 'Coverall' && rec.pay_entity !== 'Coverall') continue;
      if (payEntityFilter === 'Vix' && rec.pay_entity !== 'Vix') continue;
      const isCoverallNpn = isCoverallAORByNPN(rec.agent_npn);
      if (isCoverallNpn) {
        coverallDirectNet += amt;
        coverallDirectRows += 1;
      } else if (rec.pay_entity === 'Coverall') {
        downlineNet += amt;
        downlineRows += 1;
      } else {
        unclassifiedRows += 1;
        unclassifiedNet += amt;
      }
    }
    const netPaidTotal = totalComm + totalClawbacks;
    const splitDelta = netPaidTotal - (coverallDirectNet + downlineNet);
    const estMissing = filtered.reduce((s, r) => s + (r.estimated_missing_commission || 0), 0);
    const difference = shouldPay - paidEligible;
    const unpaidVariance = unpaid - difference;
    const totalEdeRaw = filtered.filter(r => r.in_ede).length;
    const hasAnyEde = filtered.filter(r => r.in_ede).length;
    const hasExpectedEde = filtered.filter(r => r.is_in_expected_ede_universe).length;
    const expectedWithBO = filtered.filter(r => r.is_in_expected_ede_universe && effInBO(r)).length;
    const fullyMatched = filtered.filter(r => r.in_ede && effInBO(r) && r.in_commission).length;
    const paidOutsideEde = filtered.filter(r => !r.in_ede && effInBO(r) && r.in_commission).length;
    const commissionOnly = filtered.filter(r => !r.in_ede && !effInBO(r) && r.in_commission).length;
    const backOfficeOnly = filtered.filter(r => !r.in_ede && effInBO(r) && !r.in_commission).length;
    const unpaidExpected = filtered.filter(r => r.in_ede && effInBO(r) && r.eligible_for_commission === 'Yes' && !r.in_commission).length;
    const totalPaidAll = filtered.filter(r => r.in_commission).length;
    const paidOutsideExpected = filtered.filter(r => !r.in_ede && r.in_commission).length;
    return { expected, expectedPriorMonth, expectedStatementMonth, foundBO, eligible, shouldPay, paidCommRecords, paidEligible, unpaid, totalComm, totalClawbacks, estMissing, difference, unpaidVariance, totalEdeRaw, hasAnyEde, hasExpectedEde, expectedWithBO, fullyMatched, paidOutsideEde, commissionOnly, backOfficeOnly, unpaidExpected, totalPaidAll, paidOutsideExpected, coverallDirectNet, downlineNet, netPaidTotal, splitDelta, coverallDirectRows, downlineRows, unclassifiedRows, unclassifiedNet };
  }, [filtered, normalizedRecords, payEntityFilter, filteredEde, priorMonth, statementMonth, effInBO]);

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
    for (const rec of normalizedRecords) {
      if (rec.source_type !== 'COMMISSION') continue;
      const amt = Number(rec.commission_amount) || 0;
      if (amt >= 0) continue;
      if (payEntityFilter === 'Coverall' && rec.pay_entity !== 'Coverall') continue;
      if (payEntityFilter === 'Vix' && rec.pay_entity !== 'Vix') continue;
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

      // Inferred reason — priority order per spec.
      let inferredReason = '';
      if (boRecord && (!recon || recon.member_key !== boRecord.member_key)) {
        inferredReason = 'matching failure (BO row exists but join failed)';
      } else if (boRecord && boBrokerNpn && !COVERALL_NPN_SET.has(boBrokerNpn)) {
        inferredReason = 'AOR drift (BO broker is non-Coverall)';
      } else if (boRecord && !boEligible) {
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

  const unpaidSample = useMemo(() => {
    return filtered
      .filter(r => r.is_in_expected_ede_universe && effInBO(r) && r.eligible_for_commission === 'Yes' && !r.in_commission)
      .slice(0, 50);
  }, [filtered, effInBO]);

  const drilldownData = useMemo(() => {
    if (!drilldown) return null;
    switch (drilldown) {
      case 'expected': return filtered.filter(r => r.is_in_expected_ede_universe);
      case 'foundBO': return filtered.filter(r => r.is_in_expected_ede_universe && effInBO(r));
      case 'eligible': return filtered.filter(r => r.is_in_expected_ede_universe && effInBO(r) && r.eligible_for_commission === 'Yes');
      case 'paidComm': return filtered.filter(r => r.in_commission);
      case 'paidEligible': return filtered.filter(r => r.is_in_expected_ede_universe && effInBO(r) && r.eligible_for_commission === 'Yes' && r.in_commission);
      case 'unpaid': return filtered.filter(r => r.is_in_expected_ede_universe && effInBO(r) && r.eligible_for_commission === 'Yes' && !r.in_commission);
      case 'fullyMatched': return filtered.filter(r => r.in_ede && effInBO(r) && r.in_commission);
      case 'paidOutsideEde': return filtered.filter(r => !r.in_ede && effInBO(r) && r.in_commission);
      case 'commissionOnly': return filtered.filter(r => !r.in_ede && !effInBO(r) && r.in_commission);
      case 'backOfficeOnly': return filtered.filter(r => !r.in_ede && effInBO(r) && !r.in_commission);
      case 'unpaidExpected': return filtered.filter(r => r.in_ede && effInBO(r) && r.eligible_for_commission === 'Yes' && !r.in_commission);
      case 'totalPaidAll': return filtered.filter(r => r.in_commission);
      case 'paidOutsideExpected': return filtered.filter(r => !r.in_ede && r.in_commission);
      default: return filtered;
    }
  }, [drilldown, filtered, effInBO]);

  const isCoverageDrilldown = ['fullyMatched', 'paidOutsideEde', 'commissionOnly', 'backOfficeOnly', 'unpaidExpected', 'totalPaidAll', 'paidOutsideExpected'].includes(drilldown || '');

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-foreground">Reconciliation Dashboard</h2>
          <p className="text-sm text-muted-foreground">{dashboardTitle}</p>
        </div>
        <div className="flex items-center gap-2">
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
              executeInvariants();
              setInvariantsOpen(true);
            }}
            disabled={!currentBatchId || reconciled.length === 0}
          >
            <ShieldAlert className="h-4 w-4 mr-1" />
            Run Invariants
          </Button>
          <Button variant="outline" size="sm" onClick={() => setResolveConfirmOpen(true)} disabled={resolving}>
            <Link2 className={`h-4 w-4 mr-1 ${resolving ? 'animate-pulse' : ''}`} />
            {resolving ? 'Resolving...' : 'Resolve Identities Across Batches'}
          </Button>
          <RebuildBatchButton />
          <RebuildAllBatchesButton />
          <BatchSelector />
        </div>
      </div>

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
      {currentBatchId && lastRebuildAt && !logicChanged && (
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
          title="EE Universe Audit"
          icon={<ShieldAlert className="h-4 w-4" />}
          summary={`${eeAuditRows.length} EE members fall outside Found and Not-in-BO buckets`}
        >
          <div className="text-xs text-muted-foreground">
            Members in the Expected Enrollments universe (scope:{' '}
            <strong>{payEntityFilter}</strong>) who are NOT in the Found-in-BO
            bucket and NOT in the actionable Not-in-BO bucket. The
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
              const tooltipText = `Total Ambetter policies with a Coverall AOR (scope: ${payEntityFilter}) in a qualifying status (Effectuated / PendingEffectuation / PendingTermination), active in this batch's covered months. Per-month breakdown shows NEWLY-EFFECTIVE members per actual effective month, so per-month numbers SUM to the total. Sourced from raw EDE rows so this matches the EDE debug panel exactly. Tie-out check: In BO ${filteredEde.inBOCount} + Not in BO ${filteredEde.notInBOCount} = ${tieOut} ${tiesOut ? '✓' : '⚠️ MISMATCH vs ' + expectedTotal}.`;
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
              const filteredMissing = filteredEde.missingFromBO.filter(
                (r) => !confirmed.has(keyFor(r)),
              );
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
            <MetricCard title="Total Covered Lives" value={debugStats?.totalCoveredLives ?? 0} icon={<Users className="h-4 w-4" />} variant="info" subtitle={debugStats ? (formatMonthBreakdown(debugStats.totalCoveredLivesByMonth, { yearless: true }) || undefined) : undefined} tooltip={{ text: "Sum of coveredMemberCount across all qualified EDE records — counts the subscriber plus every dependent on each policy. Per-month breakdown is by actual effective month (newly effective lives) so per-month numbers SUM to the total.", why: "Reflects the actual number of insured lives, not just policy holders. Use this when reporting total members served or comparing to per-life carrier metrics." }} />
            <MetricCard title="Found in Back Office" value={metrics.foundBO} icon={<Building2 className="h-4 w-4" />} variant="info" onClick={() => setDrilldown('foundBO')} tooltip={{ text: "Out of the expected members, these are the ones Ambetter recognizes in their system.", why: "If members are missing here, Ambetter may not have the policy correctly recorded, which can prevent payment." }} />
            <MetricCard title="Eligible for Commission" value={metrics.eligible} icon={<CheckCircle2 className="h-4 w-4" />} variant="success" onClick={() => setDrilldown('eligible')} tooltip={{ text: "These are members that exist in Ambetter's system and are marked as eligible for commission.", why: "Only members in this group can generate commission. If eligibility is wrong, payments will not occur." }} />
            <MetricCard title="Should Be Paid" value={metrics.shouldPay} icon={<DollarSign className="h-4 w-4" />} tooltip={{ text: "This is the total number of members we expect to receive commission for based on enrollment, carrier records, and eligibility.", why: "This represents your true payable book of business and is the key number for identifying missing revenue." }} />
            <MetricCard title="Paid Commission Records" value={metrics.paidCommRecords} icon={<CheckCircle2 className="h-4 w-4" />} variant="info" onClick={() => setDrilldown('paidComm')} tooltip={{ text: "These are all members that appear on the commission statements as having been paid, regardless of whether they match our expected book.", why: "This shows what the carrier actually paid, including payments that may not belong to your tracked enrollments." }} />
            <MetricCard title="Paid Within Eligible Cohort" value={metrics.paidEligible} icon={<CheckCircle2 className="h-4 w-4" />} variant="success" onClick={() => setDrilldown('paidEligible')} tooltip={{ text: "These are members we expected to be paid on AND actually received commission for.", why: "This is your true success rate — how much of your expected revenue you actually collected." }} />
            <MetricCard title="Unpaid Policies" value={metrics.unpaid} icon={<XCircle className="h-4 w-4" />} variant="destructive" onClick={() => setDrilldown('unpaid')} tooltip={{ text: "These are members we expected to be paid on but did not receive commission for.", why: "This is your potential revenue loss and the most important number for recovery and escalation." }} />
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
            <MetricCard title="Est. Missing Commission" value={`$${metrics.estMissing.toLocaleString(undefined, { minimumFractionDigits: 2 })}`} icon={<TrendingDown className="h-4 w-4" />} variant="warning" tooltip={{ text: "This is an estimate of how much commission may be missing based on unpaid policies.", why: "This represents potential recoverable revenue and helps prioritize follow-up with carriers." }} />
          </div>

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
                  <span className="text-muted-foreground block">Paid Within Eligible</span>
                  <strong className="text-foreground text-lg">{metrics.paidEligible}</strong>
                </div>
                <div>
                  <span className="text-muted-foreground block">Unpaid Policies</span>
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
                  <span className="text-muted-foreground">is_in_expected_ede_universe: <strong className="text-foreground">{metrics.hasExpectedEde}</strong></span>
                  <span className="text-muted-foreground">expected + in_back_office: <strong className="text-foreground">{metrics.expectedWithBO}</strong></span>
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
              <DataTable data={drilldownData} columns={isCoverageDrilldown ? COVERAGE_DRILLDOWN_COLUMNS : RECON_COLUMNS} exportFileName={`${drilldown}_details.csv`} />
            </div>
          )}

          {!drilldownData && (
            <div>
              <h3 className="text-lg font-semibold mb-3">Source Coverage Analysis</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                <MetricCard title="Fully Matched & Paid" value={metrics.fullyMatched} icon={<CheckCircle2 className="h-4 w-4" />} variant="success" onClick={() => setDrilldown('fullyMatched')} tooltip={{ text: "These members exist in all systems and were paid correctly.", why: "This represents clean, correctly tracked and paid business." }} />
                <MetricCard title="Paid but Missing from EDE" value={metrics.paidOutsideEde} icon={<AlertTriangle className="h-4 w-4" />} variant="warning" onClick={() => setDrilldown('paidOutsideEde')} tooltip={{ text: "These members exist in Ambetter's system and were paid, but are not in your EDE data.", why: "This may represent state-based exchange enrollments or other production not captured in your system, meaning your true book may be larger than expected." }} />
                <MetricCard title="Commission Statement Only" value={metrics.commissionOnly} icon={<FileText className="h-4 w-4" />} variant="warning" onClick={() => setDrilldown('commissionOnly')} tooltip={{ text: "These members appear only on commission statements and are not found in EDE or back office data.", why: "This may indicate mismatches, legacy payments, or data issues that need investigation." }} />
                <MetricCard title="Back Office Only (Not Paid)" value={metrics.backOfficeOnly} icon={<Building2 className="h-4 w-4" />} variant="info" onClick={() => setDrilldown('backOfficeOnly')} tooltip={{ text: "These members exist in the carrier system but are not in EDE and have not generated commission.", why: "This may represent missed enrollments, incomplete data feeds, or potential future revenue not yet realized." }} />
                <MetricCard title="Unpaid Expected Policies" value={metrics.unpaidExpected} icon={<XCircle className="h-4 w-4" />} variant="destructive" onClick={() => setDrilldown('unpaidExpected')} tooltip={{ text: "These are members in EDE and back office, eligible for commission, but not paid.", why: "This is your primary recovery target — expected revenue that was not received." }} />
                <MetricCard title="Total Paid (All Sources)" value={metrics.totalPaidAll} icon={<DollarSign className="h-4 w-4" />} variant="success" onClick={() => setDrilldown('totalPaidAll')} tooltip={{ text: "Count of all unique members where commission was paid, regardless of source.", why: "This shows the full scope of what the carrier actually paid across all systems." }} />
                <MetricCard title="Paid Outside Expected Universe" value={metrics.paidOutsideExpected} icon={<ShieldAlert className="h-4 w-4" />} variant="warning" onClick={() => setDrilldown('paidOutsideExpected')} tooltip={{ text: "These are paid policies that are not part of your expected EDE-based book.", why: "This highlights production that exists outside your current tracking system and may indicate missing data sources such as state-based exchanges." }} />
              </div>
            </div>
          )}

          {!drilldownData && (
            <div>
              <h3 className="text-lg font-semibold mb-3">Exception Summary</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {([
                  { issue: 'Missing from Back Office', tip: { text: "These members appear in our system but are not found in Ambetter's system.", why: "If the carrier doesn't recognize the policy, they cannot pay commission on it." } },
                  { issue: 'Missing from Commission', tip: { text: "These members should have generated commission but do not appear on the commission statements.", why: "These are likely unpaid policies and should be reviewed for missing payments." } },
                  { issue: 'Wrong Pay Entity', tip: { text: "These members were paid, but under the wrong entity (for example, Vix instead of Coverall).", why: "Revenue may be going to the wrong account and may need to be corrected." } },
                  { issue: 'Not Eligible for Commission', tip: { text: "These members exist but are not marked as eligible for commission by the carrier.", why: "These policies will not generate revenue unless eligibility is corrected." } },
                  { issue: 'Paid but Missing from EDE', tip: { text: "These members were paid on commission statements but do not appear in our enrollment system.", why: "This may indicate external enrollments, data mismatches, or policies written outside your tracked workflow." } },
                ] as const).map(({ issue, tip }) => {
                  const count = filtered.filter(r => r.issue_type === issue).length;
                  return count > 0 ? (
                    <MetricCard key={issue} title={issue} value={count} variant={issue.includes('Wrong') ? 'destructive' : 'warning'} tooltip={tip} />
                  ) : null;
                })}
              </div>
            </div>
          )}
        </>
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
              EDE Enrollments Not in Back Office ({filteredEde.notInBOCount})
            </DialogTitle>
            <DialogDescription>
              Members who pass the Expected Enrollments filter (scope: {payEntityFilter}) but have no
              matching Back Office record. Split into two action-distinct buckets below.
            </DialogDescription>
          </DialogHeader>
          {(() => {
            const hasIssuerRows = filteredEde.missingFromBO.filter(r => String(r.issuer_subscriber_id ?? '').trim() !== '');
            const missingIssuerRows = filteredEde.missingFromBO.filter(r => String(r.issuer_subscriber_id ?? '').trim() === '');
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
          <div className="space-y-2">
            {(invariantResults ?? []).map((r) => {
              const hasNumbers =
                r.status === 'fail' &&
                (typeof r.expected === 'number' || typeof r.actual === 'number');
              return (
                <div
                  key={r.id}
                  className={`rounded-md border px-3 py-2 text-sm ${
                    r.status === 'pass'
                      ? 'bg-success/10 border-success/30'
                      : 'bg-destructive/10 border-destructive/30'
                  }`}
                >
                  <div className="flex items-start gap-2">
                    {r.status === 'pass' ? (
                      <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0 text-success" />
                    ) : (
                      <XCircle className="h-4 w-4 mt-0.5 shrink-0 text-destructive" />
                    )}
                    <div className="flex-1">
                      <div className="font-medium text-foreground">{r.label}</div>
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
            {invariantResults && invariantResults.length > 0 && (
              <div className="text-xs text-muted-foreground pt-2 border-t">
                {invariantResults.filter((r) => r.status === 'pass').length} passed ·{' '}
                {invariantResults.filter((r) => r.status === 'fail').length} failed
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={executeInvariants}>
              <RefreshCw className="h-4 w-4 mr-1" />
              Re-run
            </Button>
            <Button variant="outline" onClick={() => setInvariantsOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
