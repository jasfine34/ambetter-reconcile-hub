import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useBatch } from '@/contexts/BatchContext';
import { BatchSelector } from '@/components/BatchSelector';
import { ResolvedBadge } from '@/components/ResolvedBadge';
import { lookupResolved } from '@/lib/resolvedIdentities';
import { getReconciledMembersPage } from '@/lib/persistence';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Search, Download, ChevronLeft, ChevronRight, Loader2, ChevronRight as RowArrow } from 'lucide-react';
import { exportToCSV } from '@/lib/csvParser';

/**
 * Column model for All Records.
 *
 * AOR-canonical convention (2026-04-27):
 *   - "Writing Agent" (key: aor_bucket)  → derived from agent_npn via NPN_MAP.
 *     Tells you WHO wrote the policy. Useful for compensation tracking.
 *   - "AOR" (key: current_policy_aor)    → from EDE's currentPolicyAOR field
 *     (the canonical "Agent of Record" the carrier currently honors). Tells
 *     you WHO OWNS the policy today. This is the canonical "is this member
 *     ours?" signal going forward; AOR transfers update this without
 *     touching the writing agent.
 *
 * See ARCHITECTURE_PLAN.md §3.2 and src/lib/normalize.ts header comment.
 */
const COLUMNS = [
  { key: 'applicant_name', label: 'Name' },
  { key: 'policy_number', label: 'Policy #' },
  { key: 'exchange_subscriber_id', label: 'Sub ID' },
  { key: 'exchange_policy_id', label: 'Exchange Policy ID' },
  { key: 'issuer_policy_id', label: 'Issuer Policy ID' },
  { key: 'issuer_subscriber_id', label: 'Issuer Sub ID' },
  { key: 'agent_name', label: 'Agent' },
  { key: 'agent_npn', label: 'NPN' },
  { key: 'aor_bucket', label: 'Writing Agent' },
  { key: 'current_policy_aor', label: 'AOR' },
  { key: 'in_ede', label: 'EDE' },
  { key: 'in_back_office', label: 'Back Office' },
  { key: 'in_commission', label: 'Commission' },
  { key: 'eligible_for_commission', label: 'Eligible' },
  { key: 'expected_pay_entity', label: 'Expected Entity' },
  { key: 'actual_pay_entity', label: 'Actual Entity' },
  { key: 'actual_commission', label: 'Commission $' },
  { key: 'issue_type', label: 'Issue' },
];

const RESOLVED_FIELD_TO_RESOLVED_KEY: Record<string, 'resolved_issuer_subscriber_id' | 'resolved_issuer_policy_id' | 'resolved_exchange_policy_id'> = {
  issuer_subscriber_id: 'resolved_issuer_subscriber_id',
  issuer_policy_id: 'resolved_issuer_policy_id',
  exchange_policy_id: 'resolved_exchange_policy_id',
};

const PAGE_SIZE = 50;

/**
 * Renders one cell with the same defaults the legacy DataTable used:
 * dollar formatting for commission/premium, ✓/✗ for booleans, "—" for null.
 */
function defaultRenderCell(key: string, value: unknown): ReactNode {
  if (value == null || value === '') return '—';
  if (typeof value === 'boolean') return value ? '✓' : '✗';
  if (typeof value === 'number') {
    if (key.includes('commission') || key.includes('premium')) {
      return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
    }
    return value.toLocaleString();
  }
  return String(value);
}

/**
 * Session-storage key used to remember the scroll offset of the table
 * container so router.back() from Member Timeline lands on the same row,
 * not at the top of the list. Per-batch so different batches don't collide.
 */
const SCROLL_KEY_PREFIX = 'all-records-scroll:';

export default function AllRecordsPage() {
  const { currentBatchId, resolverIndex } = useBatch();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // --- URL-backed view state (FIX B3) ---------------------------------------
  // search/page/sort live in the query string so:
  //   1. /records?search=Sanders&page=3&sort=applicant_name renders the same view
  //   2. browser back/forward restores prior filtered state
  //   3. URLs are shareable
  const urlSearch = searchParams.get('search') ?? '';
  const urlPage = Math.max(0, parseInt(searchParams.get('page') ?? '0', 10) || 0);
  const urlSortKey = searchParams.get('sort') ?? '';
  const urlSortDir = (searchParams.get('dir') === 'desc' ? 'desc' : 'asc') as 'asc' | 'desc';

  const [searchInput, setSearchInput] = useState(urlSearch);
  const debouncedSearch = useDebouncedValue(searchInput, 250);

  // Sync debounced search back to the URL (replace, not push, so each keystroke
  // doesn't pollute history — only the *latest* search lands in history when
  // the user navigates away).
  useEffect(() => {
    if (debouncedSearch === urlSearch) return;
    const next = new URLSearchParams(searchParams);
    if (debouncedSearch) next.set('search', debouncedSearch);
    else next.delete('search');
    // Reset to page 0 whenever the search query changes — otherwise the user
    // typing on page 5 could end up on an empty trailing page.
    next.delete('page');
    setSearchParams(next, { replace: true });
  }, [debouncedSearch]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset to page 0 whenever the batch changes (different result set entirely).
  useEffect(() => {
    if (urlPage === 0) return;
    const next = new URLSearchParams(searchParams);
    next.delete('page');
    setSearchParams(next, { replace: true });
  }, [currentBatchId]); // eslint-disable-line react-hooks/exhaustive-deps

  const setPage = (p: number) => {
    const next = new URLSearchParams(searchParams);
    if (p === 0) next.delete('page');
    else next.set('page', String(p));
    // Page changes are PUSHed so back-button steps through prior pages.
    setSearchParams(next);
  };

  const toggleSort = (key: string) => {
    const next = new URLSearchParams(searchParams);
    if (urlSortKey === key) {
      next.set('sort', key);
      next.set('dir', urlSortDir === 'asc' ? 'desc' : 'asc');
    } else {
      next.set('sort', key);
      next.set('dir', 'asc');
    }
    next.delete('page'); // sort changes drop you back to page 0
    setSearchParams(next, { replace: true });
  };

  // --- Fetch ---------------------------------------------------------------
  const [rows, setRows] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (!currentBatchId) { setRows([]); setTotal(0); return; }
    let cancelled = false;
    setLoading(true);
    getReconciledMembersPage(currentBatchId, {
      page: urlPage,
      pageSize: PAGE_SIZE,
      search: debouncedSearch,
      sortKey: urlSortKey || undefined,
      sortDir: urlSortDir,
    })
      .then(({ rows, total }) => {
        if (cancelled) return;
        setRows(rows);
        setTotal(total);
      })
      .catch(() => {
        if (cancelled) return;
        setRows([]);
        setTotal(0);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [currentBatchId, urlPage, debouncedSearch, urlSortKey, urlSortDir]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // --- Scroll restoration (FIX B4) -----------------------------------------
  // Save the table container's scrollTop on every scroll event AND save once
  // more right before navigating away (row-click handler). On mount, restore
  // from sessionStorage if present. Per-batch key so navigating between
  // batches doesn't bleed offsets.
  const tableContainerRef = useRef<HTMLDivElement | null>(null);
  const scrollStorageKey = currentBatchId ? `${SCROLL_KEY_PREFIX}${currentBatchId}` : null;

  // Restore once data is loaded (so the container actually has scrollable
  // content). Wait one paint via requestAnimationFrame for the table to lay out.
  useEffect(() => {
    if (loading || !scrollStorageKey || rows.length === 0) return;
    const saved = sessionStorage.getItem(scrollStorageKey);
    if (!saved) return;
    const offset = parseInt(saved, 10);
    if (!Number.isFinite(offset)) return;
    const raf = requestAnimationFrame(() => {
      if (tableContainerRef.current) tableContainerRef.current.scrollTop = offset;
    });
    return () => cancelAnimationFrame(raf);
  }, [loading, scrollStorageKey, rows.length, urlPage, urlSortKey, urlSortDir]);

  const saveScroll = () => {
    if (!scrollStorageKey || !tableContainerRef.current) return;
    sessionStorage.setItem(scrollStorageKey, String(tableContainerRef.current.scrollTop));
  };

  // Export pulls the FULL filtered set in one shot. Held off the render path
  // so the user only pays the cost when they click Export. Page size 1000 is
  // a server-side cap; we loop until count is exhausted.
  const handleExport = async () => {
    if (!currentBatchId) return;
    setExporting(true);
    try {
      const all: any[] = [];
      const chunk = 1000;
      const pages = Math.ceil(total / chunk);
      for (let p = 0; p < pages; p++) {
        const { rows } = await getReconciledMembersPage(currentBatchId, {
          page: p,
          pageSize: chunk,
          search: debouncedSearch,
          sortKey: urlSortKey || undefined,
          sortDir: urlSortDir,
        });
        all.push(...rows);
        if (rows.length < chunk) break;
      }
      exportToCSV(all as Record<string, unknown>[], 'all_reconciled_records.csv');
    } finally {
      setExporting(false);
    }
  };

  const renderResolvedCell = (key: string, row: any): ReactNode | undefined => {
    const resolvedKey = RESOLVED_FIELD_TO_RESOLVED_KEY[key];
    if (!resolvedKey) return undefined;
    const v = row[key];
    if (v == null || v === '') return undefined;
    if (!resolverIndex || resolverIndex.totalRows === 0) return undefined;
    const hit = lookupResolved(row, resolverIndex);
    if (!hit) return undefined;
    const winning = (hit as any)[resolvedKey];
    if (!winning || String(winning) !== String(v)) return undefined;
    return <span>{String(v)}<ResolvedBadge sourceKind={hit.source_kind ?? undefined} batchMonth={hit.source_batch_month} /></span>;
  };

  // Row-click handler (FIX B1): save scroll, then navigate to Member Timeline
  // with `from=records` so the timeline page can render the back-breadcrumb.
  const handleRowClick = (row: any) => {
    if (!row?.member_key) return;
    saveScroll();
    navigate(`/member-timeline?member=${encodeURIComponent(row.member_key)}&from=records`);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-foreground">All Reconciled Records</h2>
          <p className="text-sm text-muted-foreground">{total.toLocaleString()} total records</p>
        </div>
        <BatchSelector />
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search name, policy #, sub ID, agent..."
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              className="pl-9"
            />
          </div>
          <Button variant="outline" size="sm" onClick={handleExport} disabled={exporting || total === 0}>
            {exporting
              ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Exporting…</>
              : <><Download className="h-4 w-4 mr-1" /> Export</>}
          </Button>
        </div>
        <div
          ref={tableContainerRef}
          onScroll={saveScroll}
          className="rounded-lg border overflow-auto max-h-[70vh]"
        >
          <Table>
            <TableHeader>
              <TableRow>
                {COLUMNS.map(col => (
                  <TableHead
                    key={col.key}
                    className="cursor-pointer select-none whitespace-nowrap"
                    onClick={() => toggleSort(col.key)}
                  >
                    {col.label} {urlSortKey === col.key ? (urlSortDir === 'asc' ? '↑' : '↓') : ''}
                  </TableHead>
                ))}
                {/* Row-arrow affordance */}
                <TableHead className="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={COLUMNS.length + 1} className="text-center text-muted-foreground py-8">
                    <Loader2 className="h-4 w-4 mr-2 inline animate-spin" /> Loading…
                  </TableCell>
                </TableRow>
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={COLUMNS.length + 1} className="text-center text-muted-foreground py-8">
                    No records found
                  </TableCell>
                </TableRow>
              ) : rows.map((row, i) => (
                <TableRow
                  key={row.id ?? i}
                  onClick={() => handleRowClick(row)}
                  className="cursor-pointer group hover:bg-muted/40 transition-colors"
                  title="Open member timeline"
                >
                  {COLUMNS.map(col => {
                    const override = renderResolvedCell(col.key, row);
                    return (
                      <TableCell key={col.key} className="whitespace-nowrap text-sm">
                        {override !== undefined ? override : defaultRenderCell(col.key, row[col.key])}
                      </TableCell>
                    );
                  })}
                  <TableCell className="w-8 text-muted-foreground/40 group-hover:text-muted-foreground transition-colors">
                    <RowArrow className="h-4 w-4" />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>{total.toLocaleString()} records{debouncedSearch ? ` matching "${debouncedSearch}"` : ''}</span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" disabled={urlPage === 0 || loading} onClick={() => setPage(Math.max(0, urlPage - 1))}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span>Page {urlPage + 1} of {totalPages}</span>
            <Button variant="ghost" size="sm" disabled={urlPage >= totalPages - 1 || loading} onClick={() => setPage(urlPage + 1)}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
