/**
 * Bundle 11 — Unpaid Recovery (V1: display-only review/export workbench).
 *
 * Exposes the canonical Expected But Unpaid row set as a filterable,
 * exportable table. NO new business definitions, NO reconcile changes,
 * NO persisted-output writes. Everything flows through canonical helpers
 * (Bundle 7 ownership, Bundle 4.5 premium, Bundle 1.5/2 source type).
 *
 * Row source:
 *   getExpectedPaymentBreakdown(reconciled, scope, filteredEde,
 *     confirmedUpgradeMemberKeys).unpaidRows
 * — same source as Dashboard EBU, MCE, and Source Coverage EBU.
 *
 * IMPORTANT: visible rows and exported CSV both consume the SAME
 * `filteredRows` array (no table-vs-export drift).
 */
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Papa from 'papaparse';
import { useBatch } from '@/contexts/BatchContext';
import { BatchSelector } from '@/components/BatchSelector';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Search, Download, ChevronLeft, ChevronRight } from 'lucide-react';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { usePayEntityScope, type PayEntityScope } from '@/hooks/usePayEntityScope';
import { getNormalizedRecords } from '@/lib/persistence';
import { getCoveredMonths } from '@/lib/dateRange';
import { computeFilteredEde } from '@/lib/expectedEde';
import {
  getExpectedPaymentBreakdown,
  isZeroNetPremium,
  classifySourceTypeForRow,
} from '@/lib/canonical';
import {
  classifyPolicyOwnerFromCurrentAor,
  type PolicyOwnerBucket,
} from '@/lib/canonical/policyOwner';
import {
  findWeakMatches,
  loadWeakMatchOverrides,
  applyOverrides,
  pickStableKey,
  type WeakMatchOverride,
} from '@/lib/weakMatch';
import { filterReconciledByScope } from '@/lib/canonical/scope';
import { EBU_BATCH_SCOPE_DISCLAIMER } from '@/lib/constants';

// ---------------------------------------------------------------------------
// Filter model
// ---------------------------------------------------------------------------

export type OwnerFilter = 'all' | PolicyOwnerBucket;
export type SourceTypeFilter = 'all' | 'matched' | 'boOnly' | 'edeOnly';
export type PremiumBucketFilter = 'all' | 'zeroNetPremium' | 'hasPremium';

export interface UnpaidRecoveryFilters {
  owner: OwnerFilter;
  sourceType: SourceTypeFilter;
  premiumBucket: PremiumBucketFilter;
  search: string;
}

const DEFAULT_FILTERS: UnpaidRecoveryFilters = {
  owner: 'all',
  sourceType: 'all',
  premiumBucket: 'all',
  search: '',
};

const SOURCE_LABELS: Record<Exclude<SourceTypeFilter, 'all'>, 'Matched' | 'BO Only' | 'EDE Only'> = {
  matched: 'Matched',
  boOnly: 'BO Only',
  edeOnly: 'EDE Only',
};

/**
 * Pure filter — exported for tests. Visible table AND export both use this
 * same function so the on-screen rows always equal the downloaded rows.
 */
/**
 * Build a per-row FFM ID resolver from the loaded normalizedRecords.
 *
 * Bundle 12.5: FFM ID = the actual EDE `raw_json.ffmAppId`, not the carrier
 * policy identifier (which is what `issuer_subscriber_id` historically
 * carried). We match EDE normalized records back to the unpaid row by
 * `member_key` (the same identity key reconcile produces), collect distinct
 * `ffmAppId` values in normalizedRecords order, and join with ", ".
 *
 * NO fallback to issuer_subscriber_id / policy_number / exchange_subscriber_id.
 * Returns '' when no matched EDE record carries an ffmAppId.
 */
export function buildFfmIdResolver(normalizedRecords: any[]): (row: any) => string {
  const byKey = new Map<string, string[]>();
  for (const rec of normalizedRecords ?? []) {
    if (rec?.source_type !== 'EDE') continue;
    const key = String(rec.member_key ?? '');
    if (!key) continue;
    const ffm = String(rec.raw_json?.ffmAppId ?? '').trim();
    if (!ffm) continue;
    const arr = byKey.get(key) ?? [];
    if (!arr.includes(ffm)) arr.push(ffm);
    byKey.set(key, arr);
  }
  return (row: any) => {
    const key = String(row?.member_key ?? '');
    if (!key) return '';
    const arr = byKey.get(key);
    return arr && arr.length ? arr.join(', ') : '';
  };
}

export function filterUnpaidRecoveryRows(
  rows: any[],
  universe: { boOnly: readonly any[]; edeOnly: readonly any[] },
  filters: UnpaidRecoveryFilters,
  getFfmId: (row: any) => string = () => '',
): any[] {
  const search = filters.search.trim().toLowerCase();
  return rows.filter((r) => {
    if (filters.owner !== 'all') {
      if (classifyPolicyOwnerFromCurrentAor(r.current_policy_aor) !== filters.owner) return false;
    }
    if (filters.sourceType !== 'all') {
      const wanted = SOURCE_LABELS[filters.sourceType];
      if (classifySourceTypeForRow(r, universe) !== wanted) return false;
    }
    if (filters.premiumBucket !== 'all') {
      const isZero = isZeroNetPremium(r);
      if (filters.premiumBucket === 'zeroNetPremium' && !isZero) return false;
      if (filters.premiumBucket === 'hasPremium' && isZero) return false;
    }
    if (search) {
      const hay = [
        getFfmId(r),
        r.applicant_name,
        r.policy_number,
        r.issuer_subscriber_id,
        r.exchange_subscriber_id,
        r.agent_npn,
        r.current_policy_aor,
      ]
        .map((v) => String(v ?? '').toLowerCase())
        .join(' ');
      if (!hay.includes(search)) return false;
    }
    return true;
  });
}

/** Parse URL search params into the typed filter shape. */
export function parseFiltersFromSearchParams(sp: URLSearchParams): UnpaidRecoveryFilters {
  const owner = sp.get('owner') ?? 'all';
  const sourceType = sp.get('sourceType') ?? 'all';
  const premiumBucket = sp.get('premiumBucket') ?? 'all';
  const search = sp.get('search') ?? '';
  const validOwner: OwnerFilter =
    owner === 'JF' || owner === 'EF' || owner === 'BS' || owner === 'Other' ? owner : 'all';
  const validSource: SourceTypeFilter =
    sourceType === 'matched' || sourceType === 'boOnly' || sourceType === 'edeOnly' ? sourceType : 'all';
  const validPremium: PremiumBucketFilter =
    premiumBucket === 'zeroNetPremium' || premiumBucket === 'hasPremium' ? premiumBucket : 'all';
  return { owner: validOwner, sourceType: validSource, premiumBucket: validPremium, search };
}

/** Parse a scope URL param ("all"/"coverall"/"vix") to the shared PayEntityScope. */
export function parseScopeParam(raw: string | null): PayEntityScope | null {
  if (raw === 'coverall') return 'Coverall';
  if (raw === 'vix') return 'Vix';
  if (raw === 'all') return 'All';
  return null;
}

function scopeToParam(s: PayEntityScope): string {
  return s === 'Coverall' ? 'coverall' : s === 'Vix' ? 'vix' : 'all';
}

// ---------------------------------------------------------------------------
// Columns + export
// ---------------------------------------------------------------------------

export const UNPAID_RECOVERY_COLUMNS: Array<{ key: string; label: string }> = [
  { key: 'ffm_id', label: 'FFM ID' },
  { key: 'applicant_name', label: 'Member Name' },
  { key: 'policy_number', label: 'Policy #' },
  { key: 'exchange_subscriber_id', label: 'Exchange Sub ID' },
  { key: 'owner_bucket', label: 'Owner' },
  { key: 'source_type', label: 'Source Type' },
  { key: 'premium_bucket', label: 'Premium Bucket' },
  { key: 'net_premium', label: 'Net Premium' },
  { key: 'estimated_missing_commission', label: 'Est. Missing Commission' },
  { key: 'effective_date', label: 'Effective Date' },
  { key: 'status', label: 'Policy Status' },
  { key: 'issue_type', label: 'Issue / Missing Reason' },
];

const COLUMNS = UNPAID_RECOVERY_COLUMNS;

function deriveDisplayRow(
  r: any,
  universe: { boOnly: readonly any[]; edeOnly: readonly any[] },
  getFfmId: (row: any) => string = () => '',
) {
  return {
    ffm_id: getFfmId(r),
    applicant_name: r.applicant_name ?? '',
    policy_number: r.policy_number ?? '',
    exchange_subscriber_id: r.exchange_subscriber_id ?? '',
    owner_bucket: classifyPolicyOwnerFromCurrentAor(r.current_policy_aor),
    source_type: classifySourceTypeForRow(r, universe),
    premium_bucket: isZeroNetPremium(r) ? 'Zero Net Premium' : 'Has Premium',
    net_premium: r.net_premium ?? null,
    estimated_missing_commission: r.estimated_missing_commission ?? null,
    effective_date: r.effective_date ?? '',
    status: r.status ?? '',
    issue_type: r.issue_type ?? '',
  };
}

export function buildUnpaidRecoveryCsv(
  rows: any[],
  universe: { boOnly: readonly any[]; edeOnly: readonly any[] },
  getFfmId: (row: any) => string = () => '',
): string {
  const data = rows.map((r) => {
    const d = deriveDisplayRow(r, universe, getFfmId);
    const obj: Record<string, string> = {};
    for (const col of COLUMNS) {
      const v = (d as any)[col.key];
      obj[col.label] = v == null ? '' : String(v);
    }
    return obj;
  });
  return Papa.unparse({ fields: COLUMNS.map((c) => c.label), data });
}

export function buildUnpaidRecoveryFilename(opts: {
  scope: PayEntityScope;
  batchMonth: string;
  downloadDate: Date;
}): string {
  const scopeTok = scopeToParam(opts.scope);
  const batchTok = opts.batchMonth ? opts.batchMonth.replace('-', '_') : 'unknown_batch';
  const dt = opts.downloadDate;
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  const hh = String(dt.getHours()).padStart(2, '0');
  const mi = String(dt.getMinutes()).padStart(2, '0');
  return `unpaid_recovery_${scopeTok}_${batchTok}_${yyyy}${mm}${dd}_${hh}${mi}.csv`;
}

function formatCell(key: string, v: unknown): string {
  if (v == null || v === '') return '—';
  if (typeof v === 'number') {
    if (key === 'net_premium' || key === 'estimated_missing_commission') {
      return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
    }
    return v.toLocaleString();
  }
  return String(v);
}

const PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function UnpaidRecoveryPage() {
  const { batches, currentBatchId, reconciled, resolverIndex } = useBatch();
  const [scope, setScope] = usePayEntityScope();
  const [searchParams, setSearchParams] = useSearchParams();
  const [normalizedRecords, setNormalizedRecords] = useState<any[]>([]);
  const [weakOverrides, setWeakOverrides] = useState<Map<string, WeakMatchOverride>>(new Map());
  const [page, setPage] = useState(0);

  const filters = useMemo(() => parseFiltersFromSearchParams(searchParams), [searchParams]);

  // Local controlled search input (debounced into URL).
  const [searchInput, setSearchInput] = useState(filters.search);
  const debouncedSearch = useDebouncedValue(searchInput, 250);

  // On mount: reconcile URL scope param with shared usePayEntityScope. URL wins.
  useEffect(() => {
    const fromUrl = parseScopeParam(searchParams.get('scope'));
    if (fromUrl && fromUrl !== scope) {
      setScope(fromUrl);
    } else if (!fromUrl) {
      // No scope in URL — write current scope into URL for shareability.
      const next = new URLSearchParams(searchParams);
      next.set('scope', scopeToParam(scope));
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep URL scope param in sync with shared scope (other pages may change it).
  useEffect(() => {
    const current = searchParams.get('scope');
    const want = scopeToParam(scope);
    if (current === want) return;
    const next = new URLSearchParams(searchParams);
    next.set('scope', want);
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  // Sync debounced search into URL.
  useEffect(() => {
    if (debouncedSearch === filters.search) return;
    const next = new URLSearchParams(searchParams);
    if (debouncedSearch) next.set('search', debouncedSearch);
    else next.delete('search');
    setSearchParams(next, { replace: true });
    setPage(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch]);

  // Reset page when filters change.
  useEffect(() => { setPage(0); }, [filters.owner, filters.sourceType, filters.premiumBucket]);

  // Load normalized records for current batch (mirrors Dashboard).
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

  // Load weak-match overrides (mirrors Dashboard / MCE).
  useEffect(() => {
    let cancelled = false;
    loadWeakMatchOverrides()
      .then((m) => { if (!cancelled) setWeakOverrides(m); })
      .catch(() => { if (!cancelled) setWeakOverrides(new Map()); });
    return () => { cancelled = true; };
  }, [currentBatchId]);

  const currentBatch = useMemo(
    () => batches.find((b: any) => b.id === currentBatchId) ?? null,
    [batches, currentBatchId],
  );

  const coveredMonths = useMemo(
    () => getCoveredMonths(currentBatch?.statement_month),
    [currentBatch?.statement_month],
  );

  const filteredEde = useMemo(
    () => computeFilteredEde(normalizedRecords, reconciled, scope, coveredMonths, resolverIndex),
    [normalizedRecords, reconciled, scope, coveredMonths, resolverIndex],
  );

  // Mirror Dashboard / MCE: derive confirmed weak-match upgrades so unpaidRows
  // align exactly with Dashboard EBU under matching scope.
  const confirmedUpgradeMemberKeys = useMemo(() => {
    const out = new Set<string>();
    if (!weakOverrides.size || !reconciled.length || !filteredEde.uniqueMembers.length) return out;
    const periodStart = currentBatch?.statement_month ?? null;
    const candidates = findWeakMatches(filteredEde.uniqueMembers, normalizedRecords, { periodStart });
    const { confirmedKeys } = applyOverrides(candidates, weakOverrides);
    if (!confirmedKeys.size) return out;
    const inScope = filterReconciledByScope(reconciled, scope);
    for (const r of inScope) {
      if (r.in_back_office) continue;
      const key = pickStableKey({
        issuer_subscriber_id: r.issuer_subscriber_id,
        exchange_subscriber_id: r.exchange_subscriber_id,
        policy_number: r.policy_number,
      });
      if (key && confirmedKeys.has(key)) out.add(r.member_key);
    }
    return out;
  }, [filteredEde, normalizedRecords, weakOverrides, reconciled, scope, currentBatch?.statement_month]);

  const breakdown = useMemo(
    () => getExpectedPaymentBreakdown(reconciled, scope, filteredEde, confirmedUpgradeMemberKeys),
    [reconciled, scope, filteredEde, confirmedUpgradeMemberKeys],
  );

  const unpaidRows = breakdown.unpaidRows;
  const universe = breakdown.universe;

  // Single source for both the visible table AND the export.
  const filteredRows = useMemo(
    () => filterUnpaidRecoveryRows(unpaidRows, universe, filters),
    [unpaidRows, universe, filters],
  );

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const pagedRows = filteredRows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  function updateFilter<K extends keyof UnpaidRecoveryFilters>(key: K, value: UnpaidRecoveryFilters[K]) {
    const next = new URLSearchParams(searchParams);
    if (value === 'all' || value === '') next.delete(key);
    else next.set(key, String(value));
    setSearchParams(next, { replace: true });
  }

  function handleExport() {
    const batchMonth = currentBatch?.statement_month ? String(currentBatch.statement_month).substring(0, 7) : '';
    const csv = buildUnpaidRecoveryCsv(filteredRows, universe);
    const filename = buildUnpaidRecoveryFilename({ scope, batchMonth, downloadDate: new Date() });
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Unpaid Recovery</h1>
          <p className="text-sm text-muted-foreground max-w-2xl">
            Filter and export the canonical Expected But Unpaid cohort. Display-only —
            shares its row source with Dashboard EBU, MCE, and Source Coverage EBU.
          </p>
          <p
            data-testid="ur-ebu-disclaimer"
            className="text-xs text-muted-foreground italic mt-1 max-w-2xl"
          >
            {EBU_BATCH_SCOPE_DISCLAIMER}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <BatchSelector />
          <Select value={scope} onValueChange={(v) => setScope(v as PayEntityScope)}>
            <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="Coverall">Coverall</SelectItem>
              <SelectItem value="Vix">Vix</SelectItem>
              <SelectItem value="All">All</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </header>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            data-testid="ur-search"
            placeholder="Search name, policy #, sub ID, NPN, AOR..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={filters.owner} onValueChange={(v) => updateFilter('owner', v as OwnerFilter)}>
          <SelectTrigger className="w-36" data-testid="ur-owner"><SelectValue placeholder="Owner" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All owners</SelectItem>
            <SelectItem value="JF">JF</SelectItem>
            <SelectItem value="EF">EF</SelectItem>
            <SelectItem value="BS">BS</SelectItem>
            <SelectItem value="Other">Other</SelectItem>
          </SelectContent>
        </Select>
        <Select value={filters.sourceType} onValueChange={(v) => updateFilter('sourceType', v as SourceTypeFilter)}>
          <SelectTrigger className="w-40" data-testid="ur-source"><SelectValue placeholder="Source" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sources</SelectItem>
            <SelectItem value="matched">Matched</SelectItem>
            <SelectItem value="boOnly">BO Only</SelectItem>
            <SelectItem value="edeOnly">EDE Only</SelectItem>
          </SelectContent>
        </Select>
        <Select value={filters.premiumBucket} onValueChange={(v) => updateFilter('premiumBucket', v as PremiumBucketFilter)}>
          <SelectTrigger className="w-44" data-testid="ur-premium"><SelectValue placeholder="Premium" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All premium</SelectItem>
            <SelectItem value="zeroNetPremium">Zero Net Premium</SelectItem>
            <SelectItem value="hasPremium">Has Premium</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" onClick={handleExport} disabled={filteredRows.length === 0}>
          <Download className="h-4 w-4 mr-1" /> Export filtered rows
        </Button>
      </div>

      <div className="text-sm text-muted-foreground" data-testid="ur-count">
        Showing {filteredRows.length.toLocaleString()} of {unpaidRows.length.toLocaleString()} unpaid policies
      </div>

      <div className="rounded-lg border overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              {COLUMNS.map((c) => (
                <TableHead key={c.key} className="whitespace-nowrap">{c.label}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {pagedRows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={COLUMNS.length} className="text-center text-muted-foreground py-8">
                  No unpaid policies match the current filters.
                </TableCell>
              </TableRow>
            ) : pagedRows.map((r, i) => {
              const d = deriveDisplayRow(r, universe);
              return (
                <TableRow key={r.member_key ?? i} data-testid="ur-row">
                  {COLUMNS.map((c) => (
                    <TableCell key={c.key} className="whitespace-nowrap text-sm">
                      {formatCell(c.key, (d as any)[c.key])}
                    </TableCell>
                  ))}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>{filteredRows.length.toLocaleString()} rows</span>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span>Page {page + 1} of {totalPages}</span>
          <Button variant="ghost" size="sm" disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
