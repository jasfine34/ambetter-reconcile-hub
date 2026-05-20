/**
 * #104 — Best Known Member Profile + Messer Missing Commission Export.
 *
 * Read-only enrichment + export workflow:
 *   1. Pulls reconciled members for the active batch (or any selected month).
 *   2. Identifies the canonical Expected But Unpaid cohort: the
 *      Matched + BO Only + EDE Only unpaid rows returned by
 *      `getExpectedPaymentBreakdown(...).unpaidRows`. This matches the
 *      Dashboard "Expected But Unpaid" card exactly.
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
} from '@/lib/persistence';
import { useToast } from '@/hooks/use-toast';
import {
  buildMemberProfile,
  splitNameLastSpace,
  assembleAddressLine,
  type MemberProfile,
  type EnrichedField,
} from '@/lib/canonical/memberProfileView';
import {
  type CanonicalScope,
  filterReconciledByScope,
} from '@/lib/canonical/scope';
import { extractNpnFromAorString } from '@/lib/agents';
import { NPN_MAP, EBU_BATCH_SCOPE_DISCLAIMER } from '@/lib/constants';
import { computeFilteredEde, type FilteredEdeResult } from '@/lib/expectedEde';
import { getStatementMonthBounds } from '@/lib/canonical/statementMonthBounds';
import { applyRuntimeBOActive } from '@/lib/canonical/applyRuntimeBOActive';
import { getExpectedPaymentBreakdown, isZeroNetPremium } from '@/lib/canonical/metrics';
import { classifySourceTypeForRow } from '@/lib/canonical/sourceTypeForRow';
import { getCoveredMonths } from '@/lib/dateRange';
import {
  paidForServiceMonth,
  classifyMemberForMonth,
  buildIsDueEligibleRecord,
  computeFirstEligibleMonth,
} from '@/lib/classifier';
import { isActiveBackOfficeRecord } from '@/lib/canonical/isActiveBackOfficeRecord';
import {
  findWeakMatches,
  loadWeakMatchOverrides,
  applyOverrides,
  pickStableKey,
  type WeakMatchOverride,
} from '@/lib/weakMatch';
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


type PremiumBucket = 'all' | 'zero_premium' | 'has_premium';

interface ExportRow {
  // Messer columns (downloaded)
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
  /** Bundle 13e — resolved est-missing dollars; blank in CSV when not RESOLVED/REMAINDER. */
  estimatedMissingCommission: number | null;
  /** Bundle 13e — adjacent status column. */
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
  { key: 'estimatedMissingCommission', label: 'Estimated Missing Commission' },
  { key: 'estMissingStatus', label: 'Est_Missing_Status' },
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
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Resolve "writing agent name" for the Messer form using the AOR-primary
 * fallback ladder spec'd in #104:
 *   current_policy_aor (display name) → BO Broker Name → Commission
 *   Writing Agent Name → blank.
 *
 * AOR is primary because the inquiry form is about who wrote/owns the policy,
 * not who is currently being paid.
 */
export function resolveWritingAgentName(opts: {
  currentPolicyAor: string | null | undefined;
  boBrokerName: string | null | undefined;
  commissionWritingAgentName: string | null | undefined;
}): string {
  const aor = String(opts.currentPolicyAor ?? '').trim();
  if (aor) {
    // Strip embedded "(NPN)" suffix for display: "Jason Fine (21055210)" → "Jason Fine".
    const cleaned = aor.replace(/\s*\(\d+\)\s*$/, '').trim();
    if (cleaned) return cleaned;
  }
  const boName = String(opts.boBrokerName ?? '').trim();
  if (boName) return boName;
  const commName = String(opts.commissionWritingAgentName ?? '').trim();
  if (commName) return commName;
  return '';
}

/** Member ID fallback ladder: issuer_subscriber_id → policy_number → exchange_subscriber_id. */
export function resolveMemberId(opts: {
  issuerSubscriberId: string | null | undefined;
  policyNumber: string | null | undefined;
  exchangeSubscriberId: string | null | undefined;
}): string {
  const i = String(opts.issuerSubscriberId ?? '').trim();
  if (i) return i;
  const p = String(opts.policyNumber ?? '').trim();
  if (p) return p;
  const e = String(opts.exchangeSubscriberId ?? '').trim();
  if (e) return e;
  return '';
}

/**
 * Row-context Policy Effective Date (NOT enrichment-walk).
 * Pulls from EDE `effective_date` (typed) → EDE `raw_json.effectiveDate`
 * → BO `broker_effective_date` → BO `Policy Effective Date` raw → reconciled
 * `effective_date`. First non-blank wins. EDE is preferred because it carries
 * the authoritative policy effective date as filed on the marketplace; BO
 * dates can lag for retro-enrolled policies.
 */
export function resolvePolicyEffectiveDate(opts: {
  records: any[];
  reconciledEffectiveDate?: string | null;
}): string {
  const recs = opts.records || [];
  for (const r of recs) {
    if (r.source_type === 'EDE' && r.effective_date) return String(r.effective_date);
  }
  for (const r of recs) {
    if (r.source_type === 'EDE') {
      const v = r.raw_json?.effectiveDate;
      if (v) return String(v).trim();
    }
  }
  for (const r of recs) {
    if (r.source_type === 'BACK_OFFICE' && r.broker_effective_date) return String(r.broker_effective_date);
  }
  for (const r of recs) {
    if (r.source_type === 'BACK_OFFICE') {
      const v = r.raw_json?.['Policy Effective Date'];
      if (v) return String(v).trim();
    }
  }
  if (opts.reconciledEffectiveDate) return String(opts.reconciledEffectiveDate);
  return '';
}

// ---------------------------------------------------------------------------
// #109 — Writing Agent Carrier ID derived lookup.
//
// The carrier-specific writing-agent ID lives only on COMMISSION rows. For the
// missing-commission cohort, by definition there is no current commission row
// for that member, so direct lookup yields blank for ~85% of rows. We observed
// (and the diagnostic confirmed) that `writing_agent_carrier_id` is uniform
// per (carrier, pay_entity, agent_npn) across all loaded commission rows
// (e.g. every Coverall row → CHG9852, Vix → VIX9696). Building a derived map
// from observed COMMISSION rows lets us fall back to that ID when the member
// has no current commission row but the AOR has historical commission activity.
//
// Pure (no React hooks) — caller memoizes against batch data-version stamps.
// ---------------------------------------------------------------------------

export interface WritingAgentIdEntry {
  /** Most-recent winning ID (by batch month, then created_at). */
  id: string;
  /** Distinct losing values, if any, for conflict warnings. */
  conflicts: string[];
}

/** Stable key for (carrier, pay_entity, agent_npn). */
function carrierIdLookupKey(carrier: string, payEntity: string, npn: string): string {
  return `${(carrier || '').trim().toLowerCase()}|${(payEntity || '').trim().toLowerCase()}|${(npn || '').trim()}`;
}

/**
 * Build a lookup `(carrier, pay_entity, agent_npn) → writing_agent_carrier_id`
 * from observed COMMISSION rows. Most-recent batch month wins on conflict; all
 * losing values are surfaced in `conflicts` so callers can warn for review.
 *
 * Pure — pass already-loaded normalized records and a batch_id → 'YYYY-MM' map.
 */
export function buildWritingAgentCarrierIdLookup(opts: {
  records: any[];
  batchMonthByBatchId: Map<string, string>;
}): Map<string, WritingAgentIdEntry> {
  const groups = new Map<string, Array<{ id: string; month: string; createdAt: string }>>();
  for (const r of opts.records) {
    if (r.source_type !== 'COMMISSION') continue;
    const id = String(r.writing_agent_carrier_id ?? '').trim();
    if (!id) continue;
    const npn = String(r.agent_npn ?? '').trim();
    if (!npn) continue;
    const key = carrierIdLookupKey(r.carrier ?? '', r.pay_entity ?? '', npn);
    const month = opts.batchMonthByBatchId.get(r.batch_id) || '';
    const arr = groups.get(key);
    const entry = { id, month, createdAt: String(r.created_at ?? '') };
    if (arr) arr.push(entry); else groups.set(key, [entry]);
  }
  const out = new Map<string, WritingAgentIdEntry>();
  for (const [key, rows] of groups) {
    // Sort: most-recent month first, then most-recent created_at first.
    rows.sort((a, b) => {
      if (a.month !== b.month) return a.month < b.month ? 1 : -1;
      return a.createdAt < b.createdAt ? 1 : -1;
    });
    const winner = rows[0].id;
    const losers = Array.from(new Set(rows.slice(1).map((r) => r.id).filter((v) => v !== winner)));
    out.set(key, { id: winner, conflicts: losers });
  }
  return out;
}

/**
 * #110 — Normalize a stored `expected_pay_entity` (which may be
 * `'Coverall_or_Vix'` or blank) into the concrete pay-entity bucket that
 * should be used as the lookup / Tier-1 filter key.
 *
 * Rules (scope is authoritative for concrete scopes):
 *   - Coverall scope → 'Coverall' (always — overrides actual/expected).
 *   - Vix scope      → 'Vix'      (always — overrides actual/expected).
 *   - All scope:
 *       * If `actualPayEntity` is set ('Coverall' / 'Vix'), it wins.
 *       * Else if `expectedPayEntity` is concrete, use it.
 *       * Else (blank or 'Coverall_or_Vix') defer to NPN default:
 *           Jason Fine (21055210)  → 'Coverall'
 *           Becky Shuta (16531877) → 'Coverall'
 *           Erica Fine (21277051) → ambiguous → '' (caller leaves blank)
 *           any other NPN → ''
 *
 * Returns '' when the target pay-entity is genuinely ambiguous; callers
 * MUST treat '' as "leave Writing Agent Carrier ID blank".
 */
export function resolveTargetPayEntity(opts: {
  expectedPayEntity: string | null | undefined;
  actualPayEntity: string | null | undefined;
  scope: CanonicalScope;
  agentNpn: string | null | undefined;
}): string {
  // #110 final — active scope is authoritative for concrete scopes.
  // A Coverall-scope export must always emit a Coverall carrier ID, even when
  // the member has actual_pay_entity = 'Vix' historically. Without this,
  // members like Deanna Armstrong (Erica AOR, paid Vix) would emit VIX9696
  // inside a Coverall-scope CSV — wrong for a Coverall inquiry form.
  if (opts.scope === 'Coverall') return 'Coverall';
  if (opts.scope === 'Vix') return 'Vix';

  // All scope: existing rule — actual → concrete EPE → per-NPN default.
  const actual = String(opts.actualPayEntity ?? '').trim();
  if (actual === 'Coverall' || actual === 'Vix') return actual;

  const expected = String(opts.expectedPayEntity ?? '').trim();
  if (expected === 'Coverall' || expected === 'Vix') return expected;

  // Blank or 'Coverall_or_Vix' under All scope: defer to per-NPN default.
  const npn = String(opts.agentNpn ?? '').trim();
  if (npn === '21055210' || npn === '16531877') return 'Coverall';
  // Erica Fine and any other NPN: ambiguous → blank.
  return '';
}

/**
 * Resolution ladder for the export's Writing Agent Carrier ID column.
 *
 * #110 — both tiers are now scope-aware. Tier-1 (Direct) requires the
 * historical commission row to match the resolved target pay entity AND the
 * resolved current AOR NPN; otherwise an AOR-transferred member could pull a
 * stale prior-AOR / prior-pay-entity ID (e.g. a March Vix row leaking into a
 * January Coverall export).
 *
 *   1. Direct: member has a commission row with `writing_agent_carrier_id`
 *      AND that row's `pay_entity` === `payEntity`
 *      AND that row's `agent_npn` === `agentNpn`
 *   2. Historical: derived `(carrier, payEntity, agentNpn)` lookup hit.
 *   3. Blank.
 *
 * `payEntity === ''` (ambiguous in All scope) short-circuits to blank — we
 * deliberately refuse to guess.
 */
export function resolveWritingAgentCarrierId(opts: {
  records: any[];
  carrier: string;
  payEntity: string;
  agentNpn: string;
  lookup: Map<string, WritingAgentIdEntry>;
}): string {
  const targetPe = String(opts.payEntity || '').trim();
  const npn = String(opts.agentNpn || '').trim();
  // Refuse to guess when target is ambiguous or NPN unknown.
  if (!targetPe || !npn) return '';

  // Tier 1 — Direct, but scope+NPN aware.
  for (const r of opts.records) {
    if (r.source_type !== 'COMMISSION') continue;
    const id = String(r.writing_agent_carrier_id ?? '').trim();
    if (!id) continue;
    const rowPe = String(r.pay_entity ?? '').trim();
    const rowNpn = String(r.agent_npn ?? '').trim();
    if (rowPe !== targetPe) continue;
    if (rowNpn !== npn) continue;
    return id;
  }

  // Tier 2 — Historical lookup (already keyed by carrier+pe+npn).
  const hit = opts.lookup.get(carrierIdLookupKey(opts.carrier, targetPe, npn));
  return hit ? hit.id : '';
}

/**
 * Bundle 4.6: thin wrapper over the canonical zero-net-premium predicate.
 * Maps to MCE's programmatic bucket names (zero_premium / has_premium).
 * The rule itself lives in `isZeroNetPremium` in canonical/metrics.ts.
 */
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

/** Convert ExportRow[] → CSV with EXACTLY the Messer column order (no internals). */
export function buildMesserCsv(rows: ExportRow[]): string {
  const data = rows.map((r) => {
    const obj: Record<string, string> = {};
    for (const col of MESSER_COLUMNS) {
      const v = r[col.key];
      let raw: string;
      if (col.key === 'estimatedMissingCommission') {
        // Bundle 13e — numeric-or-blank. No $18 fallback, no "TBD" string.
        raw = typeof v === 'number' && Number.isFinite(v) ? v.toFixed(2) : '';
      } else if (col.key === 'estMissingStatus') {
        raw = v == null ? '' : String(v);
      } else {
        raw = v == null ? '' : String(v);
      }
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
    const batchMonthByBatchIdSnap = new Map<string, string>();
    for (const b of batches) {
      batchMonthByBatchIdSnap.set(
        b.id,
        b.statement_month ? String(b.statement_month).substring(0, 7) : '',
      );
    }

    const isLatest = () => myGen === currentRunGen.current;
    const commit = (fn: () => void) => { if (isLatest()) fn(); };

    setSourceStatus('loading');
    setSourceError(null);
    setReportStatus('idle');
    setReportError(null);

    let selectedBatchRecords: any[];
    let weakOverrides: Map<string, WeakMatchOverride>;
    try {
      const [recs, overrides] = await Promise.all([
        getNormalizedRecords(f.batchId!),
        loadWeakMatchOverrides().catch(() => new Map<string, WeakMatchOverride>()),
      ]);
      selectedBatchRecords = recs || [];
      weakOverrides = overrides;
    } catch (err) {
      if (!isLatest()) return;
      commit(() => {
        setSourceError(err instanceof Error ? err : new Error(serializeErrorMessage(err)));
        setSourceStatus('error');
      });
      return;
    }
    if (!isLatest()) return;

    // Compute selected-batch-only EE universe.
    let breakdown: ReturnType<typeof getExpectedPaymentBreakdown>;
    let missingMembers: any[];
    let adjustedByRow: Map<any, AdjustedRow> = new Map();
    try {
      // ---- Ineligible-BO Phase 1 — runtime BO-active re-evaluation ----
      // Re-derive in_back_office from the canonical helper against raw BO
      // records (don't trust persisted reconciled.in_back_office). Also
      // compute an exclusion set to plug the EDE-Only no-eligibility-gate
      // leak: members whose only BO evidence fails the helper are removed
      // from the FilteredEdeResult AND from reconciled-for-breakdown.
      const boNormalizedRecords = selectedBatchRecords.filter(
        (n: any) => n.source_type === 'BACK_OFFICE',
      );
      const monthBounds = ranBatchMonth
        ? getStatementMonthBounds(ranBatchMonth)
        : { start: '', end: '' };
      const { adjustedReconciled, mceExclusionMemberKeys } = ranBatchMonth
        ? applyRuntimeBOActive(reconciledSnapshot, boNormalizedRecords, monthBounds)
        : { adjustedReconciled: reconciledSnapshot, mceExclusionMemberKeys: new Set<string>() };

      const ranFilteredEdeRaw = computeFilteredEde(
        selectedBatchRecords,
        adjustedReconciled,
        f.scope,
        ranCoveredMonths,
        resolverIndexSnapshot,
      );

      // Filter the returned FilteredEdeResult by the exclusion set and
      // recompute metadata. Never pre-filter computeFilteredEde's INPUT —
      // it needs the full reconciled list to resolve pre-Union-Find keys.
      const filteredUniqueMembers = (ranFilteredEdeRaw.uniqueMembers ?? []).filter(
        (m: any) => !mceExclusionMemberKeys.has(m.member_key),
      );
      const filteredMissingFromBO = (ranFilteredEdeRaw.missingFromBO ?? []).filter(
        (m: any) => !mceExclusionMemberKeys.has(m.member_key),
      );
      const byMonth: Record<string, number> = {};
      for (const m of filteredUniqueMembers) {
        const month = (m as any).effective_month;
        if (!month) continue;
        byMonth[month] = (byMonth[month] ?? 0) + 1;
      }
      const ranFilteredEde: FilteredEdeResult = {
        uniqueMembers: filteredUniqueMembers,
        uniqueKeys: filteredUniqueMembers.length,
        byMonth,
        inBOCount: filteredUniqueMembers.filter((m: any) => m.in_back_office).length,
        notInBOCount: filteredMissingFromBO.length,
        missingFromBO: filteredMissingFromBO,
      };
      const reconciledForBreakdown = adjustedReconciled.filter(
        (r: any) => !mceExclusionMemberKeys.has(r.member_key),
      );

      const periodStart = ranBatch?.statement_month ?? null;
      const candidates = findWeakMatches(ranFilteredEde.uniqueMembers, selectedBatchRecords, { periodStart });
      const { confirmedKeys } = applyOverrides(candidates, weakOverrides);
      const confirmedUpgradeMemberKeys = new Set<string>();
      if (confirmedKeys.size && reconciledForBreakdown.length) {
        const inScope = filterReconciledByScope(reconciledForBreakdown, f.scope);
        for (const r of inScope) {
          if (r.in_back_office) continue;
          if (mceExclusionMemberKeys.has(r.member_key)) continue;
          const key = pickStableKey({
            issuer_subscriber_id: r.issuer_subscriber_id,
            exchange_subscriber_id: r.exchange_subscriber_id,
            policy_number: r.policy_number,
          });
          if (key && confirmedKeys.has(key)) confirmedUpgradeMemberKeys.add(r.member_key);
        }
      }

      breakdown = getExpectedPaymentBreakdown(
        reconciledForBreakdown, f.scope, ranFilteredEde, confirmedUpgradeMemberKeys,
      );

      // ---- Bundle 13c — C13 await-overlay-at-Run-Report -------------------
      // Await any in-flight overlay load. On error (settled or new), surface
      // the C7 warning toast + fall back to legacy (EMPTY overlay map). NEVER
      // partition against a stale loading state without an explicit warning.
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

      // ============================================================
      // MCE Inclusion-Rule Fixes — service-month-correct candidate set.
      // Applied BEFORE partitionUnpaidRowsByOverlay so the overlay
      // partition sees the corrected candidate set.
      //
      //   Priority 2 (service-month drift): promote breakdown.paidRows
      //     where service-month evidence proves no payment for ranBatchMonth.
      //   Priority 1: drop members whose first-eligible-month > viewed.
      //   Priority 3: drop members already paid for viewed month (defense-
      //     in-depth after promotion gate).
      //   D2 first sub-signal: drop members the one-month classifier
      //     wrapper marks `manual_review` for viewed month.
      //   Narrow Priority 2 inclusion: boActiveNonCurrentEde rows passing
      //     ALL FOUR conditions (active BO, eligible=Yes, not future-
      //     first-eligible, no service-month payment).
      //
      // Helpers (paidForServiceMonth / classifyMemberForMonth /
      // computeFirstEligibleMonth / buildIsDueEligibleRecord) are imported
      // from src/lib/classifier. NO modification to getExpectedPaymentBreakdown
      // body or getExpectedPaymentUniverse body (Phase 2 carve-out).
      // ============================================================
      const viewedServiceMonth = ranBatchMonth;
      const recordsByMemberKey = new Map<string, any[]>();
      for (const r of selectedBatchRecords) {
        const k = r?.member_key;
        if (!k) continue;
        const arr = recordsByMemberKey.get(k);
        if (arr) arr.push(r); else recordsByMemberKey.set(k, [r]);
      }
      const memberRecordsForMember = (mk: string): any[] => recordsByMemberKey.get(mk) ?? [];
      const mceScopeForPay: 'Coverall' | 'Vix' | 'All' = f.scope;

      // Apply rules only when we have a viewed service month — otherwise
      // skip the candidate-builder layer and preserve prior behavior.
      let combinedCandidates: any[];
      if (viewedServiceMonth) {
        // Section 2: promote drift-misclassified paid rows.
        const promotedFromPaid = breakdown.paidRows.filter((r: any) => {
          const recs = memberRecordsForMember(r.member_key);
          const ev = paidForServiceMonth(recs, viewedServiceMonth, { targetPayEntity: mceScopeForPay });
          return !ev.paid;
        });

        // Section 3: apply three exclusion rules.
        const initialCandidates = [...breakdown.unpaidRows, ...promotedFromPaid];
        const filteredCandidates = initialCandidates.filter((r: any) => {
          const recs = memberRecordsForMember(r.member_key);
          // Rule 1: first-eligible-future-month exclusion.
          const firstEligible = computeFirstEligibleMonth(recs);
          if (firstEligible && firstEligible > viewedServiceMonth) return false;
          // Rule 3: service-month-specific paid exclusion (defense-in-depth).
          const ev = paidForServiceMonth(recs, viewedServiceMonth, { targetPayEntity: mceScopeForPay });
          if (ev.paid) return false;
          // Rule D2 first sub-signal: classifier manual_review.
          try {
            const state = classifyMemberForMonth(recs, viewedServiceMonth);
            if (state === 'manual_review') return false;
          } catch {
            // If the classifier wrapper throws for unexpected data shape,
            // do not silently exclude — fall through to keep the candidate.
          }
          return true;
        });

        // Narrow boActiveNonCurrentEde inclusion — all four conditions.
        const monthBoundsForMce = getStatementMonthBounds(viewedServiceMonth);
        const boActiveNonCurrentEdeCandidates =
          (breakdown.universe.boActiveNonCurrentEde ?? []).filter((r: any) => {
            const recs = memberRecordsForMember(r.member_key);
            // Condition 1: active BO via canonical helper (any matching BO row).
            const boRows = recs.filter((x) => x?.source_type === 'BACK_OFFICE');
            const boActive = boRows.some((br) =>
              isActiveBackOfficeRecord(br, monthBoundsForMce.start, monthBoundsForMce.end),
            );
            if (!boActive) return false;
            // Condition 2: eligible_for_commission === 'Yes' on the reconciled row.
            if (r.eligible_for_commission !== 'Yes') return false;
            // Condition 3: not first-eligible-future.
            const firstEligible = computeFirstEligibleMonth(recs);
            if (firstEligible && firstEligible > viewedServiceMonth) return false;
            // Condition 4: no service-month payment.
            const ev = paidForServiceMonth(recs, viewedServiceMonth, {
              targetPayEntity: mceScopeForPay,
            });
            if (ev.paid) return false;
            return true;
          });

        combinedCandidates = [...filteredCandidates, ...boActiveNonCurrentEdeCandidates];
      } else {
        combinedCandidates = breakdown.unpaidRows;
      }

      const partition = partitionUnpaidRowsByOverlay(combinedCandidates, overlayForRun);
      adjustedByRow = new Map<any, AdjustedRow>();
      for (const it of [
        ...partition.regular,
        ...partition.reversed,
        ...partition.removed,
        ...partition.needsReview,
      ]) {
        adjustedByRow.set(it.row, it);
      }

      // C6 — missingMembers excludes remove_from_unpaid + move_to_reversed_bucket.
      // D2 second sub-signal: also exclude overlay `mark_needs_review` items
      // from default MCE consumption (still surfaced via partition.needsReview
      // for any future review-mode UI).
      missingMembers = partition.regular
        .filter((it) => it.adjustment.kind !== 'mark_needs_review')
        .map((it) => it.row);
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

      enrichmentRecords = memberKeys.length === 0 ? [] : await getNormalizedRecordsByMemberKeys(memberKeys);

      try {
        commissionTripleRecords = triples.length === 0 ? [] : await getCommissionRecordsByTriples(triples);
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
      const evidenceMap = buildSourceEvidenceMap(missingMembers);
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

        const nameVal = profile.applicant_name.value || m.applicant_name || '';
        const { first, last } = splitNameLastSpace(nameVal);

        const aor = String(m.current_policy_aor ?? '').trim();
        const aorNpn = extractNpnFromAorString(aor);
        const npn = aorNpn || String(m.agent_npn ?? '').trim();

        const commRec = records.find((r) => r.source_type === 'COMMISSION' && r.writing_agent_carrier_id);
        const targetPayEntity = resolveTargetPayEntity({
          expectedPayEntity: m.expected_pay_entity,
          actualPayEntity: m.actual_pay_entity,
          scope: f.scope,
          agentNpn: npn,
        });
        // Pass commission-triple records too so Tier-1 direct lookup can hit
        // a historical row when the member's enrichment set has none.
        const writingAgentCarrierId = resolveWritingAgentCarrierId({
          records: [...records, ...commissionTripleRecords],
          carrier: 'Ambetter',
          payEntity: targetPayEntity,
          agentNpn: npn,
          lookup: writingAgentIdLookup,
        });

        const boRec = records.find((r) => r.source_type === 'BACK_OFFICE' && r.agent_name);
        const writingAgentName = resolveWritingAgentName({
          currentPolicyAor: aor,
          boBrokerName: boRec?.agent_name,
          commissionWritingAgentName: commRec?.agent_name,
        });

        const memberId = resolveMemberId({
          issuerSubscriberId: m.issuer_subscriber_id,
          policyNumber: m.policy_number,
          exchangeSubscriberId: m.exchange_subscriber_id,
        });

        const address = assembleAddressLine({
          address1: profile.address1.value,
          city: profile.city.value,
          state: profile.state.value,
          zip: profile.zip.value,
        });

        const bucket = classifyNetPremium(m);

        // ---- Bundle 13e — resolver-driven est-missing + status (replaces
        // legacy $18 fallback). PARTIAL_CLEARED_REMAINDER is handled inside
        // the resolver via the AdjustedRow input.
        const adj = adjustedByRow.get(m);
        const resolution = estMissingResolver.resolve({
          row: m,
          adjustedRow: adj,
        });
        const estMissing = resolution.amount;
        const estMissingStatus = resolution.status;
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
          carrierName: 'Ambetter',
          npn,
          writingAgentCarrierId,
          writingAgentName,
          policyEffectiveDate: resolvePolicyEffectiveDate({
            records,
            reconciledEffectiveDate: m.effective_date,
          }),
          policyNumber: String(m.policy_number ?? '') || '',
          memberFirstName: first,
          memberLastName: last,
          dob: profile.dob.value || (m.dob ? String(m.dob) : ''),
          ssn: '',
          memberId,
          address,
          estimatedMissingCommission: estMissing,
          estMissingStatus,
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
          _sourceType: classifySourceTypeForRow(m, breakdown.universe),
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
