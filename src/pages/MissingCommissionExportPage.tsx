/**
 * #104 — Best Known Member Profile + Messer Missing Commission Export.
 *
 * Read-only enrichment + export workflow:
 *   1. Pulls reconciled members for the active batch (or any selected month).
 *   2. Identifies the canonical Expected But Unpaid cohort via the
 *      MT-approved selector (`buildMtApprovedMceCandidates`) over the
 *      all-batch projection cache. This is the same inclusion the Member
 *      Timeline screen shows as "unpaid" cells under official-AOR scope.
 *   3. For each unpaid member, builds a {@link MemberProfile} live from
 *      ALL normalized records across ALL batches — so a Jan record's blank
 *      Address 1 picks up the value from a Mar BO row.
 *   4. Lets the user filter by pay-entity scope and net-premium bucket, and
 *      download a Messer-form-shaped CSV (column order locked).
 *
 * NO persisted-data changes. NO RECONCILE_LOGIC_VERSION bump (UI/export-only,
 * same precedent as #90).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useBatch } from '@/contexts/BatchContext';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Download, Info, AlertTriangle, Play, Loader2, RefreshCw, AlertCircle, Inbox } from 'lucide-react';
import Papa from 'papaparse';
import {
  getNormalizedRecords,
  getNormalizedRecordsByMemberKeys,
  getCommissionRecordsByTriples,
  getAllNormalizedRecordsForMemberTimeline,
} from '@/lib/persistence';
import { useAllBatchesDataVersion } from '@/hooks/useBatchDataVersion';
import { buildMtApprovedMceCandidates } from '@/lib/canonical/mtApprovedMceSelector';
import { getMtAllBatchProjection } from '@/lib/canonical/mtApprovedMceCache';
import { buildMonthList } from '@/lib/memberTimeline';
import { useToast } from '@/hooks/use-toast';
import {
  buildMemberProfile,
  type MemberProfile,
  type EnrichedField,
} from '@/lib/canonical/memberProfileView';
import {
  type CanonicalScope,
  filterReconciledByScope,
} from '@/lib/canonical/scope';
import { extractNpnFromAorString } from '@/lib/agents';
import { NPN_MAP, EBU_BATCH_SCOPE_DISCLAIMER } from '@/lib/constants';
// Phase B Item 4b — the old MCE inclusion stack has been deleted from this
// page. MCE production inclusion = MT-approved selector
// (`buildMtApprovedMceCandidates`) over the all-batch projection cache. The
// expected-payment helper in metrics.ts is retained for Dashboard / Agent
// Summary / Unpaid Recovery, which are unchanged.
import { getCoveredMonths } from '@/lib/dateRange';
import { useCrossBatchOverlay } from '@/hooks/useCrossBatchOverlay';
import {
  EMPTY_CLEARING_OVERLAY_MAP,
  partitionUnpaidRowsByOverlay,
  type AdjustedRow,
  type ClearingOverlayMap,
  type ClearingState,
} from '@/lib/canonical/crossBatchOverlay';
import {
  CrossBatchOverlayLoadErrorBanner,
  OVERLAY_LOAD_ERROR_MESSAGE,
} from '@/components/CrossBatchOverlayLoadErrorBanner';
import { ClearingStatusChip } from '@/components/ClearingStatusChip';
import { buildEdeFfmFallbackIndex } from '@/lib/aorPicker';
import { loadCarrierCompRates } from '@/lib/canonical/compGridLoader';
import {
  createEstMissingResolver,
  type EstMissingStatus,
} from '@/lib/canonical/estMissingResolver';
import { buildSourceEvidenceMap } from '@/lib/canonical/estMissingEvidenceAdapter';
import {
  buildPolicyStateRecords,
  buildPolicyMemberCountRecords,
} from '@/lib/sweep/resolverRecordAdapters';
import { resolvePolicyStateForCompGrid } from '@/lib/canonical/policyState';
import { resolvePolicyMemberCountForCompGrid } from '@/lib/canonical/policyMemberCount';
import { isZeroNetPremium } from '@/lib/canonical/metrics';


type PremiumBucket = 'all' | 'zero_premium' | 'has_premium';

interface ExportRow {
  // Vendor Messer CSV columns (12 locked — R-MCE-002). These are the ONLY
  // fields written by buildMesserCsv to the downloaded carrier-facing CSV.
  carrierName: string;
  npn: string;
  writingAgentCarrierId: string;
  writingAgentName: string;
  policyEffectiveDate: string;
  policyNumber: string;
  memberFirstName: string;
  memberLastName: string;
  dob: string;
  ssn: string; // blank v1
  memberId: string;
  address: string;
  // Preview / backing fields — NOT in the vendor CSV (R-MCE-001 / R-MCE-002).
  /** Bundle 13e — resolved est-missing dollars; preview-only. */
  estimatedMissingCommission: number | null;
  /** Bundle 13e — backing status that drives the preview dollar cell's
   *  Needs review / TBD text. Not a standalone preview column. */
  estMissingStatus: EstMissingStatus | null;
  // Internal preview-only columns
  _memberKey: string;
  _ffmId: EnrichedField<string>;
  _exchangeSubscriberId: string;
  _issuerSubscriberId: string;
  _aor: string;
  _netPremiumBucket: PremiumBucket;
  _missingReason: string;
  _estimatedMissingCommission: number | null;
  /** Bundle 13e — resolver status accompanying the resolved amount. */
  _estMissingStatus: EstMissingStatus | null;
  _profile: MemberProfile;
  _hasConflict: boolean;
  _phone: EnrichedField<string>;
  _email: EnrichedField<string>;
  /** Phase 1.5 — Source/Evidence Type for the unpaid expected-payment row. */
  _sourceType: 'Matched' | 'BO Only' | 'EDE Only';
  /** Bundle 13c — preview-only cross-batch clearing state (NOT in CSV). */
  _clearingStatus: ClearingState | null;
  /** Bundle 13c — preview-only render flag for the "Needs review" badge. */
  _clearingNeedsReview: boolean;
}

// MCE export contract (docs/mce-export-contract.md) — vendor Messer CSV is
// locked at exactly 12 columns. Do NOT add the estimated-missing-commission
// dollar or status here; both remain preview/backing fields only.
const MESSER_COLUMNS: Array<{ key: keyof ExportRow; label: string }> = [
  { key: 'carrierName', label: 'Carrier Name' },
  { key: 'npn', label: 'NPN' },
  { key: 'writingAgentCarrierId', label: 'Writing Agent Carrier ID' },
  { key: 'writingAgentName', label: 'Writing Agent Name' },
  { key: 'policyEffectiveDate', label: 'Policy Effective Date' },
  { key: 'policyNumber', label: 'Policy #' },
  { key: 'memberFirstName', label: 'Member First Name' },
  { key: 'memberLastName', label: 'Member Last Name' },
  { key: 'dob', label: 'DOB' },
  { key: 'ssn', label: 'SSN' },
  { key: 'memberId', label: 'Member ID' },
  { key: 'address', label: 'Address (Street, City, State, Zip)' },
];

const INTERNAL_COLUMNS: Array<{ key: keyof ExportRow; label: string }> = [
  { key: '_memberKey', label: 'member_key' },
  { key: '_phone', label: 'Phone' },
  { key: '_email', label: 'Email' },
  { key: '_exchangeSubscriberId', label: 'exchange_subscriber_id' },
  { key: '_issuerSubscriberId', label: 'issuer_subscriber_id' },
  { key: '_aor', label: 'AOR' },
  { key: '_netPremiumBucket', label: 'Net premium bucket' },
  { key: '_missingReason', label: 'Missing reason' },
  { key: '_estimatedMissingCommission', label: 'Est. missing commission' },
  { key: '_sourceType', label: 'Source Type' },
  { key: '_clearingStatus', label: 'Clearing' },
];

// ---------------------------------------------------------------------------
// C3a Extraction A — pure vendor-field helpers + enrichVendorFields now live
// in `src/lib/mce/vendorEnrichment.ts`. classifyNetPremium still delegates to
// canonical isZeroNetPremium there. They are re-exported here so existing
// tests + agent-summary imports continue to resolve unchanged.
// ---------------------------------------------------------------------------

export {
  resolveWritingAgentName,
  resolveMemberId,
  resolvePolicyEffectiveDate,
  buildWritingAgentCarrierIdLookup,
  resolveTargetPayEntity,
  resolveWritingAgentCarrierId,
  enrichVendorFields,
  type WritingAgentIdEntry,
} from '@/lib/mce/vendorEnrichment';
import {
  resolveTargetPayEntity,
  enrichVendorFields,
  buildWritingAgentCarrierIdLookup,
} from '@/lib/mce/vendorEnrichment';

export function classifyNetPremium(row: any): PremiumBucket {
  return isZeroNetPremium(row) ? 'zero_premium' : 'has_premium';
}

export function buildMesserCsvFilename(opts: {
  scope: CanonicalScope;
  batchMonth: string; // 'YYYY-MM' or ''
  filter: PremiumBucket;
  downloadDate: Date;
}): string {
  const scopeTok =
    opts.scope === 'Coverall' ? 'coverall' : opts.scope === 'Vix' ? 'vix' : 'all';
  const batchTok = opts.batchMonth
    ? opts.batchMonth.replace('-', '_')
    : 'unknown_batch';
  const filterTok =
    opts.filter === 'all' ? 'all' : opts.filter === 'zero_premium' ? 'zero_premium' : 'has_premium';
  const dt = opts.downloadDate;
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `messer_missing_commission_ambetter_${scopeTok}_${batchTok}_${filterTok}_${yyyy}_${mm}_${dd}.csv`;
}

/**
 * #109 finishing touch — strip a single leading apostrophe (Excel text-format
 * marker) from a value at the CSV-render boundary only. Source data, the
 * derived lookup, and the in-memory preview remain untouched.
 */
export const stripExcelTextMarker = (value: unknown): string =>
  (value == null ? '' : String(value)).replace(/^'/, '');

/**
 * Serialize an unknown caught value into a human-readable message string so
 * error UIs never render the literal text "[object Object]". Prefers a
 * non-empty `.message`, falls back to JSON, then to String(err).
 */
export function serializeErrorMessage(err: unknown): string {
  if (err == null) return 'Unknown error';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message || err.name || 'Error';
  if (typeof err === 'object') {
    const maybeMsg = (err as { message?: unknown }).message;
    if (typeof maybeMsg === 'string' && maybeMsg.trim()) return maybeMsg;
    try {
      const s = JSON.stringify(err);
      if (s && s !== '{}') return s;
    } catch {
      /* circular — fall through */
    }
  }
  let s: string;
  try { s = String(err); } catch { return 'Unknown error'; }
  return s === '[object Object]' ? 'Unknown error' : s;
}

/** Convert ExportRow[] → CSV with EXACTLY the 12 locked Messer columns
 *  (R-MCE-002). Preview/backing fields like estimatedMissingCommission and
 *  estMissingStatus are intentionally excluded — see docs/mce-export-contract.md.
 */
export function buildMesserCsv(rows: ExportRow[]): string {
  const data = rows.map((r) => {
    const obj: Record<string, string> = {};
    for (const col of MESSER_COLUMNS) {
      const v = r[col.key];
      const raw = v == null ? '' : String(v);
      // #109: strip leading Excel text-format apostrophe ONLY for the
      // Writing Agent Carrier ID column, ONLY at the export boundary.
      obj[col.label] = col.key === 'writingAgentCarrierId' ? stripExcelTextMarker(raw) : raw;
    }
    return obj;
  });
  return Papa.unparse({
    fields: MESSER_COLUMNS.map((c) => c.label),
    data,
  });
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/**
 * v14 — Filter-match helper for Download-race close. Compares the fields
 * actually stored in ReportFilters: scope, premiumBucket, batchId. Carrier
 * is invariant in MCE today (UI control disabled, hard-coded to Ambetter)
 * and is therefore intentionally NOT compared here.
 */
export function filtersMatchRanFilters(
  current: { scope: CanonicalScope; premiumBucket: PremiumBucket; batchId: string | null },
  ran: { scope: CanonicalScope; premiumBucket: PremiumBucket; batchId: string | null } | null,
): boolean {
  if (!ran) return false;
  return (
    current.scope === ran.scope &&
    current.premiumBucket === ran.premiumBucket &&
    current.batchId === ran.batchId
  );
}

/**
 * Bundle 13c — co-located helper. Returns true when the adjustment kind
 * warrants a "Needs review" badge on the row (mirrors UR's predicate so
 * MCE chip parity is exact).
 */
export function isReviewWorthyAdjustment(it: AdjustedRow): boolean {
  return (
    it.adjustment.kind === 'mark_needs_review' ||
    it.adjustment.kind === 'partial_amount_unavailable'
  );
}

type OverlayRunState = {
  overlay: ClearingOverlayMap;
  loading: boolean;
  error: Error | null;
};

// Phase B Item 4b — inclusion = MT-approved selector (see
// `buildMtApprovedMceCandidates` / `getMtAllBatchProjection`). The old
// page-local candidate builder and its supporting demoted stack were deleted
// here; the agreement invariant in
// `src/test/mce-rewire-item4b-agreement-invariant.test.ts` is the drift lock.

export default function MissingCommissionExportPage() {
  const {
    batches, currentBatchId, setCurrentBatchId, reconciled, resolverIndex,
    reconciledLoadedForBatchId, loading: batchLoading,
  } = useBatch();
  const { toast } = useToast();
  const [scope, setScope] = useState<CanonicalScope>('Coverall');
  const [premiumBucket, setPremiumBucket] = useState<PremiumBucket>('all');

  // ---- Bundle 12.6 — local state machines ----------------------------------
  type SourceStatus = 'idle' | 'loading' | 'ready' | 'error';
  type ReportStatus = 'idle' | 'computing' | 'ready' | 'empty' | 'error';
  interface ReportFilters {
    scope: CanonicalScope;
    premiumBucket: PremiumBucket;
    batchId: string | null;
  }
  interface ReportResult {
    rows: ExportRow[];
    allBeforeBucket: ExportRow[];
    ranBatchMonth: string;
  }

  const [sourceStatus, setSourceStatus] = useState<SourceStatus>('idle');
  const [reportStatus, setReportStatus] = useState<ReportStatus>('idle');
  const [sourceError, setSourceError] = useState<Error | null>(null);
  const [reportError, setReportError] = useState<Error | null>(null);
  const [displayed, setDisplayed] = useState<ReportResult | null>(null);
  const [ranFilters, setRanFilters] = useState<ReportFilters | null>(null);
  const currentRunGen = useRef(0);

  // ---- Phase B Item 4a wiring slice (v2) — fleet-wide data-version token --
  // Drives the MT-approved selector cache key together with
  // `resolverIndex.fingerprint`. A rebuild on ANY batch shifts this token so
  // the cached all-batch projection invalidates without an F5.
  const allBatchesDataVersion = useAllBatchesDataVersion();


  // ---- Bundle 13c — cross-batch clearing overlay --------------------------
  const {
    overlay: clearingOverlay,
    loading: overlayLoading,
    error: overlayError,
  } = useCrossBatchOverlay();
  // C7: force legacy on overlay error, even after a previous successful load.
  const mceClearingOverlay = overlayError
    ? EMPTY_CLEARING_OVERLAY_MAP
    : clearingOverlay;

  // C13 await-overlay infrastructure (page-local — does NOT touch the hook).
  const overlayStateRef = useRef<OverlayRunState>({
    overlay: mceClearingOverlay,
    loading: overlayLoading,
    error: overlayError,
  });
  const overlayWaitersRef = useRef<Array<(state: OverlayRunState) => void>>([]);

  useEffect(() => {
    const next: OverlayRunState = {
      overlay: mceClearingOverlay,
      loading: overlayLoading,
      error: overlayError,
    };
    overlayStateRef.current = next;
    if (!overlayLoading) {
      const waiters = overlayWaitersRef.current.splice(0);
      for (const resolve of waiters) resolve(next);
    }
  }, [mceClearingOverlay, overlayLoading, overlayError]);

  function waitForOverlayIdle(timeoutMs = 5000): Promise<OverlayRunState> {
    const current = overlayStateRef.current;
    if (!current.loading) return Promise.resolve(current);
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        resolve(overlayStateRef.current);
      }, timeoutMs);
      overlayWaitersRef.current.push((state) => {
        window.clearTimeout(timer);
        resolve(state);
      });
    });
  }

  const filters: ReportFilters = useMemo(
    () => ({ scope, premiumBucket, batchId: currentBatchId ?? null }),
    [scope, premiumBucket, currentBatchId],
  );

  const resetToIdle = () => {
    currentRunGen.current += 1;
    setSourceStatus('idle');
    setReportStatus('idle');
    setSourceError(null);
    setReportError(null);
    setDisplayed(null);
    setRanFilters(null);
  };

  // Filter changes after a run reset to idle (Addition B — MCE supersedes
  // prior stale-result contract).
  const lastSeenFiltersRef = useRef<ReportFilters>(filters);
  useEffect(() => {
    const prev = lastSeenFiltersRef.current;
    const changed =
      prev.scope !== filters.scope ||
      prev.premiumBucket !== filters.premiumBucket ||
      prev.batchId !== filters.batchId;
    if (changed && (sourceStatus !== 'idle' || reportStatus !== 'idle')) {
      resetToIdle();
    }
    lastSeenFiltersRef.current = filters;
  }, [filters.scope, filters.premiumBucket, filters.batchId]);

  // Addition U — when batch reconciled-data readiness drops, full reset.
  useEffect(() => {
    if (
      currentBatchId &&
      reconciledLoadedForBatchId !== currentBatchId &&
      (sourceStatus !== 'idle' || reportStatus !== 'idle' || displayed !== null)
    ) {
      resetToIdle();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reconciledLoadedForBatchId, currentBatchId]);

  const isBatchReady =
    !!currentBatchId &&
    reconciledLoadedForBatchId === currentBatchId &&
    batchLoading === false;

  // v14 — single derived Download enable computation. Used at BOTH the
  // onClick handler guard and the disabled prop to prevent drift.
  const isDownloadable =
    reportStatus === 'ready' &&
    !!displayed &&
    displayed.rows.length > 0 &&
    filtersMatchRanFilters(filters, ranFilters) &&
    isBatchReady;

  // ---- Run pipeline --------------------------------------------------------
  async function runReport() {
    if (!isBatchReady) return;
    if (sourceStatus === 'loading') return;

    currentRunGen.current += 1;
    const myGen = currentRunGen.current;

    // CAPTURE phase — snapshot everything we need for this run.
    const f: ReportFilters = filters;
    const ranBatch = batches.find((b: any) => b.id === f.batchId) ?? null;
    const ranBatchMonth: string = ranBatch?.statement_month
      ? String(ranBatch.statement_month).substring(0, 7)
      : '';
    const ranCoveredMonths = getCoveredMonths(ranBatch?.statement_month);
    const reconciledSnapshot = reconciled;
    const resolverIndexSnapshot = resolverIndex;
    const allBatchesDataVersionSnap = allBatchesDataVersion;
    const batchMonthByBatchIdSnap = new Map<string, string>();
    const batchMonthByBatchIdObj: Record<string, string> = {};
    for (const b of batches) {
      const ym = b.statement_month ? String(b.statement_month).substring(0, 7) : '';
      batchMonthByBatchIdSnap.set(b.id, ym);
      batchMonthByBatchIdObj[b.id] = ym;
    }
    // Suppress unused-var warnings; retained snapshots are read in error
    // paths and by future debug instrumentation.
    void reconciledSnapshot;
    void ranCoveredMonths;

    // Build the inclusive month list spanning all known batches; ensure the
    // viewed service month is present so the classifier window covers it.
    const batchMonths = Array.from(batchMonthByBatchIdSnap.values()).filter(Boolean).sort();
    let monthListStart = batchMonths[0] || ranBatchMonth;
    let monthListEnd = batchMonths[batchMonths.length - 1] || ranBatchMonth;
    if (ranBatchMonth) {
      if (!monthListStart || ranBatchMonth < monthListStart) monthListStart = ranBatchMonth;
      if (!monthListEnd || ranBatchMonth > monthListEnd) monthListEnd = ranBatchMonth;
    }
    const monthListSnap = monthListStart && monthListEnd
      ? buildMonthList(monthListStart, monthListEnd)
      : [];

    const isLatest = () => myGen === currentRunGen.current;
    const commit = (fn: () => void) => { if (isLatest()) fn(); };

    setSourceStatus('loading');
    setSourceError(null);
    setReportStatus('idle');
    setReportError(null);

    let selectedBatchRecords: any[];
    let allBatchProjectionRecords: any[];
    try {
      // selectedBatchRecords still drives enrichment, FFM fallback index, and
      // the writing-agent-carrier-id lookup (item-1 preserved). The all-batch
      // projection (memoized by `useAllBatchesDataVersion` + resolver
      // fingerprint) drives the MT-approved selector for production inclusion.
      const dedupCtx = { batchMonthByBatchId: batchMonthByBatchIdObj };
      const [recs, projection] = await Promise.all([
        getNormalizedRecords(f.batchId!),
        getMtAllBatchProjection({
          allBatchesDataVersion: allBatchesDataVersionSnap,
          resolverIndex: resolverIndexSnapshot,
          loader: () => getAllNormalizedRecordsForMemberTimeline(dedupCtx),
        }),
      ]);
      selectedBatchRecords = recs || [];
      allBatchProjectionRecords = projection.records || [];
    } catch (err) {
      if (!isLatest()) return;
      commit(() => {
        setSourceError(err instanceof Error ? err : new Error(serializeErrorMessage(err)));
        setSourceStatus('error');
      });
      return;
    }
    if (!isLatest()) return;

    // ---- Phase B Item 4a/4b — MT-approved production inclusion ----
    // Production rows come from `buildMtApprovedMceCandidates` over the
    // all-batch projection. The old MCE-only inclusion stack was deleted in
    // 4b; Dashboard / Agent Summary / Unpaid Recovery still consume the
    // expected-payment helper from metrics.ts on their own paths.
    let missingMembers: any[];
    let adjustedByRow: Map<any, AdjustedRow> = new Map();
    try {
      // C13 await-overlay-at-Run-Report — preserved.
      let overlayState = overlayStateRef.current;
      if (overlayState.loading) {
        overlayState = await waitForOverlayIdle();
      }
      let overlayForRun: ClearingOverlayMap = overlayState.overlay;
      if (overlayState.loading || overlayState.error) {
        toast({
          title: 'Cross-batch payment clearings unavailable',
          description: OVERLAY_LOAD_ERROR_MESSAGE,
        });
        overlayForRun = EMPTY_CLEARING_OVERLAY_MAP;
      }

      const viewedServiceMonth = ranBatchMonth;
      void viewedServiceMonth;
      const combinedCandidates = ranBatchMonth
        ? buildMtApprovedMceCandidates({
            allBatchRecords: allBatchProjectionRecords,
            monthList: monthListSnap,
            serviceMonth: ranBatchMonth,
            scope: f.scope,
            batchMonthByBatchId: batchMonthByBatchIdObj,
          })
        : [];

      // §4.1 — Overlay month fallback (wiring layer). The selector emits
      // expected_ede_effective_month=null for BO-only candidates (no EDE
      // row), which would short-circuit deriveGrainKeyForReconciledRow and
      // silently skip overlay handling. Build a one-shot proxy row keyed by
      // `expected_ede_effective_month ?? service_month` for overlay grain
      // derivation ONLY; do NOT mutate the candidate (its EDE semantics
      // must remain intact for downstream enrichment).
      const proxyToCandidate = new Map<any, any>();
      const overlayInputCandidates = combinedCandidates.map((c: any) => {
        const proxy = {
          ...c,
          expected_ede_effective_month:
            c.expected_ede_effective_month ?? c.service_month ?? null,
        };
        proxyToCandidate.set(proxy, c);
        return proxy;
      });

      const partition = partitionUnpaidRowsByOverlay(overlayInputCandidates, overlayForRun);
      adjustedByRow = new Map<any, AdjustedRow>();
      for (const it of [
        ...partition.regular,
        ...partition.reversed,
        ...partition.removed,
        ...partition.needsReview,
      ]) {
        const candidate = proxyToCandidate.get(it.row) ?? it.row;
        adjustedByRow.set(candidate, { ...it, row: candidate });
      }

      // C6 + D2 second sub-signal — same shape as before; map proxy rows
      // back to the underlying selector candidates so downstream enrichment
      // reads the unmodified expected_ede_effective_month.
      missingMembers = partition.regular
        .filter((it) => it.adjustment.kind !== 'mark_needs_review')
        .map((it) => proxyToCandidate.get(it.row) ?? it.row);
    } catch (err) {
      if (!isLatest()) return;
      commit(() => {
        setReportError(err instanceof Error ? err : new Error(serializeErrorMessage(err)));
        setSourceStatus('ready');
        setReportStatus('error');
      });
      return;
    }

    // Slim cross-batch enrichment + commission-triple loaders.
    const memberKeys = Array.from(new Set(missingMembers.map((m) => m.member_key).filter(Boolean)));
    let enrichmentRecords: any[] = [];
    let commissionTripleRecords: any[] = [];
    let commissionTripleFallbackFailed = false;

    try {
      // Derive triples from missingMembers using the same target-pay-entity rule.
      const tripleSet = new Map<string, { carrier: string; payEntity: string; agentNpn: string }>();
      for (const m of missingMembers) {
        const aor = String(m.current_policy_aor ?? '').trim();
        const aorNpn = extractNpnFromAorString(aor);
        const npn = aorNpn || String(m.agent_npn ?? '').trim();
        if (!npn) continue;
        const targetPe = resolveTargetPayEntity({
          expectedPayEntity: m.expected_pay_entity,
          actualPayEntity: m.actual_pay_entity,
          scope: f.scope,
          agentNpn: npn,
        });
        if (!targetPe) continue;
        const key = `Ambetter|${targetPe.toLowerCase()}|${npn}`;
        if (!tripleSet.has(key)) {
          tripleSet.set(key, { carrier: 'Ambetter', payEntity: targetPe, agentNpn: npn });
        }
      }
      const triples = Array.from(tripleSet.values());

      const dedupCtx2 = { batchMonthByBatchId: batchMonthByBatchIdObj };
      enrichmentRecords = memberKeys.length === 0 ? [] : await getNormalizedRecordsByMemberKeys(memberKeys, dedupCtx2);

      try {
        commissionTripleRecords = triples.length === 0 ? [] : await getCommissionRecordsByTriples(triples, dedupCtx2);
      } catch (error) {
        commissionTripleFallbackFailed = true;
        commissionTripleRecords = [];
        console.warn('Missing Commission Export commission-triple fallback failed; continuing without fallback enrichment.', error);
      }
    } catch (err) {
      console.error('Failed to load Missing Commission Export source records', err);
      if (!isLatest()) return;
      commit(() => {
        setSourceError(err instanceof Error ? err : new Error(serializeErrorMessage(err)));
        setSourceStatus('error');
      });
      return;
    }
    if (!isLatest()) return;

    commit(() => setSourceStatus('ready'));
    setReportStatus('computing');

    try {
      // Build profile-records map: union of selected-batch + cross-batch enrichment.
      const profileById = new Map<string, any>();
      for (const r of selectedBatchRecords) if (r.id) profileById.set(r.id, r);
      for (const r of enrichmentRecords) if (r.id && !profileById.has(r.id)) profileById.set(r.id, r);
      const profileRecordsByMemberKey = new Map<string, any[]>();
      for (const r of profileById.values()) {
        const k = r.member_key;
        if (!k) continue;
        const arr = profileRecordsByMemberKey.get(k);
        if (arr) arr.push(r); else profileRecordsByMemberKey.set(k, [r]);
      }

      // Build writing-agent-carrier-id lookup from historical commission rows
      // (cross-batch) PLUS any commission rows in the selected batch.
      const lookupRecords: any[] = [];
      for (const r of selectedBatchRecords) {
        if (r.source_type === 'COMMISSION') lookupRecords.push(r);
      }
      const lookupSeen = new Set<string>(lookupRecords.map((r) => r.id).filter(Boolean));
      for (const r of commissionTripleRecords) {
        if (!r.id || !lookupSeen.has(r.id)) lookupRecords.push(r);
      }
      const writingAgentIdLookup = buildWritingAgentCarrierIdLookup({
        records: lookupRecords,
        batchMonthByBatchId: batchMonthByBatchIdSnap,
      });

      // Class-A FFM ID fallback index: built from selected-batch records so
      // missing members whose BO `issub:*` key isn't merged with the EDE
      // `sub:*` key can still surface a FFM ID via shared subscriber IDs.
      // Display/export only — does not feed reconcile.
      const ffmFallbackIndex = buildEdeFfmFallbackIndex(selectedBatchRecords);

      // ---- Bundle 13e — rate-chart resolver for estimated_missing_commission.
      // Derive effective year from ranBatchMonth (YYYY-MM); fall back to 2026
      // to match loadCarrierCompRates default when batch month is unknown.
      const yearFromBatchMonth = Number(ranBatchMonth?.substring(0, 4));
      const effectiveYear = Number.isFinite(yearFromBatchMonth) && yearFromBatchMonth > 0
        ? yearFromBatchMonth
        : 2026;
      let rateRows: Awaited<ReturnType<typeof loadCarrierCompRates>> = [];
      try {
        rateRows = await loadCarrierCompRates({ effectiveYear });
      } catch (e) {
        console.warn('MCE: loadCarrierCompRates failed; resolver will return UNSUPPORTED.', e);
        rateRows = [];
      }
      if (!isLatest()) return;
      // MCE export contract AC-2 — build resolver-ready evidence from
      // normalized BO/EDE records (NOT reconciled-row fields, which lack
      // state / member_count). Reuses the canonical resolver-record
      // adapters + state/member-count resolvers so we get the same proven
      // inputs the cross-batch sweep uses.
      const batchMonthByIdRecord: Record<string, string> = {};
      for (const [bid, bm] of batchMonthByBatchIdSnap) batchMonthByIdRecord[bid] = bm;
      const targetServiceMonths = ranBatchMonth ? [ranBatchMonth] : [];
      const syntheticEvidenceRows = missingMembers.map((m: any) => {
        const memberRecs = profileRecordsByMemberKey.get(m.member_key) ?? [];
        const stateRecords = buildPolicyStateRecords({
          normalizedRecords: memberRecs as any,
          batchMonthById: batchMonthByIdRecord,
        });
        const countRecords = buildPolicyMemberCountRecords({
          normalizedRecords: memberRecs as any,
          batchMonthById: batchMonthByIdRecord,
        });
        const stateRes = ranBatchMonth
          ? resolvePolicyStateForCompGrid({
              records: stateRecords,
              targetBatchMonth: ranBatchMonth,
              targetServiceMonths,
            })
          : { state: null };
        const countRes = ranBatchMonth
          ? resolvePolicyMemberCountForCompGrid({
              records: countRecords,
              targetBatchMonth: ranBatchMonth,
              targetServiceMonths,
            })
          : { memberCount: null };
        return {
          ...m,
          state: stateRes.state ?? (m as any).state ?? null,
          member_count: countRes.memberCount ?? (m as any).member_count ?? null,
        };
      });
      const evidenceMap = buildSourceEvidenceMap(syntheticEvidenceRows);
      const estMissingResolver = createEstMissingResolver({
        rateRows,
        batchMonth: ranBatchMonth,
        scope: f.scope,
        overlayMap: clearingOverlay,
        sourceEvidenceByMemberKey: evidenceMap,
      });

      const allBeforeBucket: ExportRow[] = [];
      for (const m of missingMembers) {
        const memberKey = m.member_key;
        const records = profileRecordsByMemberKey.get(memberKey) ?? [];
        const fallbackFfmCandidates = ffmFallbackIndex.lookup({
          batch_id: m.batch_id ?? f.batchId,
          carrier: m.carrier,
          exchange_subscriber_id: m.exchange_subscriber_id,
          issuer_subscriber_id: m.issuer_subscriber_id,
        });
        const profile = buildMemberProfile(memberKey, {
          records,
          referenceMonth: ranBatchMonth,
          batchMonthByBatchId: batchMonthByBatchIdSnap,
          fallbackFfmCandidates,
        });

        const aor = String(m.current_policy_aor ?? '').trim();

        // §4 — Net-premium bucket is cell-derived from the MT classifier
        // (m._mtNetBucket). '+Net' → has_premium; '0Net' / null → zero_premium.
        const bucket: PremiumBucket =
          (m as any)._mtNetBucket === '+Net' ? 'has_premium' : 'zero_premium';

        // ---- Bundle 13e — resolver-driven est-missing + status (replaces
        // legacy $18 fallback). PARTIAL_CLEARED_REMAINDER is handled inside
        // the resolver via the AdjustedRow input.
        const adj = adjustedByRow.get(m);
        const vendorFields = enrichVendorFields({
          candidate: m,
          records,
          profile,
          commissionTripleRecords,
          scope: f.scope,
          writingAgentIdLookup,
          adjustedRow: adj,
          resolveEstMissing: ({ row }) => estMissingResolver.resolve({
            row,
            adjustedRow: adj,
          }),
        });
        const estMissing = vendorFields.estimatedMissingCommission;
        const estMissingStatus = vendorFields.estMissingStatus;
        let clearingStatus: ClearingState | null = null;
        if (adj && adj.adjustment.kind !== 'no_overlay') {
          if (adj.adjustment.kind === 'no_adjustment') {
            clearingStatus = adj.adjustment.overlay?.clearing_state ?? null;
          } else {
            clearingStatus = adj.adjustment.overlay.clearing_state;
          }
        }
        const clearingNeedsReview = adj ? isReviewWorthyAdjustment(adj) : false;

        const hasConflict =
          profile.applicant_name.conflict ||
          profile.address1.conflict ||
          profile.city.conflict ||
          profile.state.conflict ||
          profile.zip.conflict ||
          profile.dob.conflict ||
          profile.phone.conflict ||
          profile.email.conflict;

        allBeforeBucket.push({
          ...vendorFields,
          _memberKey: memberKey,
          _ffmId: profile.ffm_id,
          _phone: profile.phone,
          _email: profile.email,
          _exchangeSubscriberId: String(m.exchange_subscriber_id ?? ''),
          _issuerSubscriberId: String(m.issuer_subscriber_id ?? ''),
          _aor: aor,
          _netPremiumBucket: bucket,
          _missingReason: m.issue_type || 'Missing from Commission',
          _estimatedMissingCommission: estMissing,
          _estMissingStatus: estMissingStatus,
          _profile: profile,
          _hasConflict: hasConflict,
          _sourceType: (m as any)._mtSourceType ?? 'Matched',
          _clearingStatus: clearingStatus,
          _clearingNeedsReview: clearingNeedsReview,
        });
      }

      const rows =
        f.premiumBucket === 'all'
          ? allBeforeBucket
          : allBeforeBucket.filter((r) => r._netPremiumBucket === f.premiumBucket);

      const result: ReportResult = { rows, allBeforeBucket, ranBatchMonth };

      if (!isLatest()) return;
      commit(() => {
        setDisplayed(result);
        setRanFilters(f);
        setReportStatus(rows.length === 0 ? 'empty' : 'ready');

        if (commissionTripleFallbackFailed) {
          toast({
            title: 'Report completed with limited commission history',
            description:
              'Some Writing Agent Carrier ID values may be blank because the historical commission lookup timed out. The report rows and CSV still completed.',
          });
        }
      });
    } catch (err) {
      if (!isLatest()) return;
      commit(() => {
        setReportError(err instanceof Error ? err : new Error(serializeErrorMessage(err)));
        setReportStatus('error');
      });
    }
  }

  function handleDownload() {
    if (!isDownloadable || !displayed || !ranFilters) return;
    const csv = buildMesserCsv(displayed.rows);
    const filename = buildMesserCsvFilename({
      scope: ranFilters.scope,
      batchMonth: displayed.ranBatchMonth,
      filter: ranFilters.premiumBucket,
      downloadDate: new Date(),
    });
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <TooltipProvider>
      <div className="space-y-6">
        {overlayError && <CrossBatchOverlayLoadErrorBanner />}
        <header className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">Missing Commission Export</h1>
          <p className="text-sm text-muted-foreground max-w-3xl">
            Generate the Messer Commission Inquiry Form (CSV) for members who are eligible
            for commission, found in the Back Office, but missing from the commission
            statement. Each row is enriched with the best-known descriptive and contact
            fields across <strong>all uploaded sources</strong> (BO-first, walking later
            BO → same-month EDE → later EDE → earlier fallback).
          </p>
          <p
            data-testid="mce-ebu-disclaimer"
            className="text-xs text-muted-foreground italic"
          >
            {EBU_BATCH_SCOPE_DISCLAIMER}
          </p>
        </header>

        {/* Filter bar */}
        <div className="rounded-lg border bg-card p-4 space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Month (Batch)</label>
              <Select value={currentBatchId ?? ''} onValueChange={(v) => setCurrentBatchId(v, 'mce-page-picker')}>
                <SelectTrigger className="mt-1.5"><SelectValue placeholder="Select batch" /></SelectTrigger>
                <SelectContent>
                  {batches.map((b: any) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.statement_month ? String(b.statement_month).substring(0, 7) : '(no month)'} — {b.carrier ?? 'Ambetter'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Carrier</label>
              <Select value="Ambetter" disabled>
                <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="Ambetter">Ambetter</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Scope</label>
              <Select value={scope} onValueChange={(v) => setScope(v as CanonicalScope)}>
                <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="Coverall">Coverall</SelectItem>
                  <SelectItem value="Vix">Vix</SelectItem>
                  <SelectItem value="All">All</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Premium bucket</label>
            <div className="mt-1.5 inline-flex rounded-md border bg-background p-1" role="group">
              {([
                { v: 'all', label: 'All' },
                { v: 'zero_premium', label: 'Zero Net Premium' },
                { v: 'has_premium', label: 'Has Net Premium' },
              ] as const).map((opt) => (
                <button
                  key={opt.v}
                  type="button"
                  data-bucket={opt.v}
                  onClick={() => setPremiumBucket(opt.v)}
                  className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                    premiumBucket === opt.v
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Bundle 12.6 — Run Report row. Lazy load on click; no
              cross-batch query on mount. Filter changes RESET to idle (no
              stale banner). Download uses snapshot, not live filters. */}
          <div className="flex items-center justify-between pt-2 border-t">
            <div className="text-sm text-muted-foreground" data-testid="report-count">
              {!isBatchReady
                ? 'Waiting for batch data…'
                : sourceStatus === 'loading'
                  ? 'Loading source records…'
                  : reportStatus === 'computing'
                    ? 'Running report…'
                    : sourceStatus === 'error'
                      ? 'Source load failed. See details below.'
                      : reportStatus === 'error'
                        ? 'Run failed. See details below.'
                        : reportStatus === 'idle'
                          ? 'Choose filters and click Run Report.'
                          : displayed
                            ? `${displayed.rows.length} member${displayed.rows.length === 1 ? '' : 's'}`
                            : ''}
              {displayed && displayed.rows.length !== displayed.allBeforeBucket.length && (
                <span className="ml-2 text-xs">({displayed.allBeforeBucket.length} before premium filter)</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button
                onClick={() => runReport()}
                disabled={
                  !isBatchReady ||
                  sourceStatus === 'loading' ||
                  reportStatus === 'computing' ||
                  sourceStatus === 'error'
                }
                variant={reportStatus === 'idle' ? 'default' : 'outline'}
                data-testid="run-report"
              >
                {sourceStatus === 'loading' || reportStatus === 'computing' ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Play className="h-4 w-4 mr-2" />
                )}
                {sourceStatus === 'loading' || reportStatus === 'computing' ? 'Running…' : 'Run Report'}
              </Button>
              <Button
                onClick={handleDownload}
                disabled={!isDownloadable}
                variant="outline"
                data-testid="messer-download"
              >
                <Download className="h-4 w-4 mr-2" />
                Download Messer Form (CSV)
              </Button>
            </div>
          </div>
        </div>

        {/* Content states. Errors NEVER render as a blank table; idle and
            empty are visually distinct from loading. */}
        {sourceStatus === 'error' ? (
          <div
            role="alert"
            data-testid="source-error-state"
            className="rounded-lg border border-destructive bg-destructive/5 p-8 text-center space-y-3"
          >
            <AlertCircle className="h-8 w-8 mx-auto text-destructive" />
            <div className="text-sm font-medium">Failed to load source records</div>
            <div className="text-xs text-muted-foreground max-w-md mx-auto break-words">
              {sourceError?.message ?? 'Unknown error'}
            </div>
            <Button onClick={() => runReport()} variant="outline" size="sm" data-testid="retry-source">
              <RefreshCw className="h-4 w-4 mr-2" />
              Retry
            </Button>
          </div>
        ) : sourceStatus === 'loading' ? (
          <div
            data-testid="source-loading-state"
            className="rounded-lg border bg-card p-12 text-center space-y-3"
          >
            <Loader2 className="h-8 w-8 mx-auto animate-spin text-muted-foreground" />
            <div className="text-sm text-muted-foreground">Loading source records…</div>
          </div>
        ) : reportStatus === 'computing' ? (
          <div
            data-testid="loading-state"
            className="rounded-lg border bg-card p-12 text-center space-y-3"
          >
            <Loader2 className="h-8 w-8 mx-auto animate-spin text-primary" />
            <div className="text-sm font-medium">Running report…</div>
            <div className="text-xs text-muted-foreground">Computing missing-commission cohort.</div>
          </div>
        ) : reportStatus === 'error' ? (
          <div
            role="alert"
            data-testid="error-state"
            className="rounded-lg border border-destructive bg-destructive/5 p-8 text-center space-y-3"
          >
            <AlertCircle className="h-8 w-8 mx-auto text-destructive" />
            <div className="text-sm font-medium">Run failed</div>
            <div className="text-xs text-muted-foreground max-w-md mx-auto break-words">
              {reportError?.message ?? 'Unknown error'}
            </div>
            <Button onClick={() => runReport()} variant="outline" size="sm" data-testid="retry-run">
              <RefreshCw className="h-4 w-4 mr-2" />
              Run again
            </Button>
          </div>
        ) : reportStatus === 'idle' ? (
          <div
            data-testid="initial-state"
            className="rounded-lg border bg-card p-12 text-center space-y-3"
          >
            <Play className="h-8 w-8 mx-auto text-muted-foreground" />
            <div className="text-sm font-medium">Choose filters and click Run Report.</div>
            <div className="text-xs text-muted-foreground max-w-md mx-auto">
              Pick a batch, scope, and premium bucket above. Results will appear here once you run the report.
            </div>
          </div>
        ) : reportStatus === 'empty' ? (
          <div
            data-testid="empty-state"
            className="rounded-lg border bg-card p-12 text-center space-y-3"
          >
            <Inbox className="h-8 w-8 mx-auto text-muted-foreground" />
            <div className="text-sm font-medium">No records found for the selected filters.</div>
            <div className="text-xs text-muted-foreground max-w-md mx-auto">
              Try a different scope, batch, or premium bucket and click Run Report.
            </div>
          </div>
        ) : (
          <div className="rounded-lg border overflow-auto" data-testid="results-table">
            <Table>

            <TableHeader>
              <TableRow>
                {/* Operator-aid column: FFM ID = the federal marketplace (Healthcare.gov)
                    application ID, sourced from EDE raw_json.ffmAppId via the canonical
                    member profile. Placed first so operators can read it at a glance for
                    Healthcare.gov cross-reference. Not part of the Messer CSV column set
                    (issuer_subscriber_id still flows into the Messer "Member ID" column
                    via resolveMemberId — that's the Ambetter portal lookup key, distinct
                    from the FFM application ID shown here). */}
                <TableHead
                  data-testid="ffm-id-header"
                  className="whitespace-nowrap text-xs uppercase tracking-wide bg-primary/5 text-foreground"
                  title="FFM application ID — Healthcare.gov / federal marketplace lookup key"
                >
                  FFM ID
                </TableHead>
                {MESSER_COLUMNS.map((c) => (
                  <TableHead key={String(c.key)} className="whitespace-nowrap text-xs uppercase tracking-wide">
                    {c.label}
                  </TableHead>
                ))}
                {INTERNAL_COLUMNS.map((c) => (
                  <TableHead
                    key={String(c.key)}
                    className="whitespace-nowrap text-xs uppercase tracking-wide bg-muted/40 text-muted-foreground"
                  >
                    <span className="flex items-center gap-1">
                      {c.label}
                      <Tooltip>
                        <TooltipTrigger><Info className="h-3 w-3 opacity-60" /></TooltipTrigger>
                        <TooltipContent>Internal — not in download</TooltipContent>
                      </Tooltip>
                    </span>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {displayed!.rows.slice(0, 250).map((row) => (
                <TableRow key={row._memberKey}>
                  {/* FFM ID cell — FFM application ID from EDE raw_json.ffmAppId via
                      profile.ffm_id. Empty for BO-only members (no EDE row); renders "—". */}
                  <TableCell
                    data-testid="ffm-id-cell"
                    className="text-sm whitespace-nowrap font-mono bg-primary/5"
                  >
                    {row._ffmId?.value
                      ? row._ffmId.value
                      : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  {MESSER_COLUMNS.map((c) => {
                    const v = row[c.key];
                    const fieldKey = c.key as string;
                    const profileField =
                      fieldKey === 'address'
                        ? row._profile.address1
                        : fieldKey === 'dob'
                          ? row._profile.dob
                          : fieldKey === 'memberFirstName' || fieldKey === 'memberLastName'
                            ? row._profile.applicant_name
                            : null;
                    return (
                      <TableCell key={fieldKey} className="text-sm whitespace-nowrap">
                        <span className="inline-flex items-center gap-1.5">
                          {v == null || v === '' ? <span className="text-muted-foreground">—</span> : String(v)}
                          {profileField && profileField.source_type && (
                            <Badge variant="outline" className="text-[9px] px-1 py-0 font-normal">
                              {profileField.source_type === 'back_office' ? 'BO' : profileField.source_type === 'ede' ? 'EDE' : 'COMM'}
                              {profileField.source_month ? ` · ${profileField.source_month}` : ''}
                            </Badge>
                          )}
                          {profileField && profileField.conflict && (
                            <Tooltip>
                              <TooltipTrigger>
                                <AlertTriangle className="h-3 w-3 text-amber-500" />
                              </TooltipTrigger>
                              <TooltipContent>
                                Conflict — also saw: {profileField.conflict_values.map(c => c.value).join(', ')}
                              </TooltipContent>
                            </Tooltip>
                          )}
                        </span>
                      </TableCell>
                    );
                  })}
                  {INTERNAL_COLUMNS.map((c) => {
                    if (c.key === '_clearingStatus') {
                      return (
                        <TableCell key={String(c.key)} className="text-sm whitespace-nowrap bg-muted/20 text-muted-foreground">
                          <span className="inline-flex items-center gap-1.5">
                            {row._clearingStatus
                              ? <ClearingStatusChip state={row._clearingStatus} />
                              : <span className="text-muted-foreground">—</span>}
                            {row._clearingNeedsReview && (
                              <Badge variant="secondary" data-testid="mce-needs-review-badge">Needs review</Badge>
                            )}
                          </span>
                        </TableCell>
                      );
                    }
                    const v = row[c.key];
                    let display: React.ReactNode;
                    if (c.key === '_phone' || c.key === '_email') {
                      const f = v as EnrichedField<string>;
                      display = f?.value ? f.value : <span className="text-muted-foreground">—</span>;
                    } else if (c.key === '_estimatedMissingCommission') {
                      const status = row._estMissingStatus;
                      if (typeof v === 'number' && Number.isFinite(v)) {
                        display = `$${v.toFixed(2)}`;
                      } else if (status === 'TBD_AMBIGUOUS_PAYEE') {
                        display = <span className="text-muted-foreground">TBD</span>;
                      } else if (status === 'UNSUPPORTED') {
                        display = <span className="text-muted-foreground">Needs review</span>;
                      } else {
                        display = <span className="text-muted-foreground">—</span>;
                      }
                    } else if (v == null || v === '') {
                      display = <span className="text-muted-foreground">—</span>;
                    } else {
                      display = String(v);
                    }
                    return (
                      <TableCell key={String(c.key)} className="text-sm whitespace-nowrap bg-muted/20 text-muted-foreground">
                        {display}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
            </Table>
            {displayed!.rows.length > 250 && (
              <div className="px-4 py-2 text-xs text-muted-foreground border-t bg-muted/20">
                Preview limited to first 250 rows. CSV download includes all {displayed!.rows.length}.
              </div>
            )}
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          NPN reference (Coverall): {Object.entries(NPN_MAP).map(([npn, info]) => `${info.name} (${npn})`).join(' · ')}
        </p>
      </div>
    </TooltipProvider>
  );
}
