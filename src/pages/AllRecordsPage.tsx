import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useBatch } from '@/contexts/BatchContext';
import { BatchSelector } from '@/components/BatchSelector';
import { ResolvedBadge } from '@/components/ResolvedBadge';
import { lookupResolved } from '@/lib/resolvedIdentities';
import { getReconciledMembersPage } from '@/lib/persistence';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Search, Download, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { exportToCSV } from '@/lib/csvParser';

const COLUMNS = [
  { key: 'applicant_name', label: 'Name' },
  { key: 'policy_number', label: 'Policy #' },
  { key: 'exchange_subscriber_id', label: 'Sub ID' },
  { key: 'exchange_policy_id', label: 'Exchange Policy ID' },
  { key: 'issuer_policy_id', label: 'Issuer Policy ID' },
  { key: 'issuer_subscriber_id', label: 'Issuer Sub ID' },
  { key: 'agent_name', label: 'Agent' },
  { key: 'agent_npn', label: 'NPN' },
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
  if (value == null) return '—';
  if (typeof value === 'boolean') return value ? '✓' : '✗';
  if (typeof value === 'number') {
    if (key.includes('commission') || key.includes('premium')) {
      return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
    }
    return value.toLocaleString();
  }
  return String(value);
}

export default function AllRecordsPage() {
  const { currentBatchId, resolverIndex } = useBatch();

  const [page, setPage] = useState(0);
  const [searchInput, setSearchInput] = useState('');
  const [sortKey, setSortKey] = useState<string>('');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const debouncedSearch = useDebouncedValue(searchInput, 250);

  const [rows, setRows] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  // Reset to first page whenever search or batch changes — otherwise a user
  // typing on page 5 could end up looking at an empty trailing page.
  useEffect(() => { setPage(0); }, [debouncedSearch, currentBatchId, sortKey, sortDir]);

  useEffect(() => {
    if (!currentBatchId) { setRows([]); setTotal(0); return; }
    let cancelled = false;
    setLoading(true);
    getReconciledMembersPage(currentBatchId, {
      page,
      pageSize: PAGE_SIZE,
      search: debouncedSearch,
      sortKey: sortKey || undefined,
      sortDir,
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
  }, [currentBatchId, page, debouncedSearch, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const toggleSort = (key: string) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('asc'); }
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
          sortKey: sortKey || undefined,
          sortDir,
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
        <div className="rounded-lg border overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                {COLUMNS.map(col => (
                  <TableHead
                    key={col.key}
                    className="cursor-pointer select-none whitespace-nowrap"
                    onClick={() => toggleSort(col.key)}
                  >
                    {col.label} {sortKey === col.key ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={COLUMNS.length} className="text-center text-muted-foreground py-8">
                    <Loader2 className="h-4 w-4 mr-2 inline animate-spin" /> Loading…
                  </TableCell>
                </TableRow>
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={COLUMNS.length} className="text-center text-muted-foreground py-8">
                    No records found
                  </TableCell>
                </TableRow>
              ) : rows.map((row, i) => (
                <TableRow key={row.id ?? i}>
                  {COLUMNS.map(col => {
                    const override = renderResolvedCell(col.key, row);
                    return (
                      <TableCell key={col.key} className="whitespace-nowrap text-sm">
                        {override !== undefined ? override : defaultRenderCell(col.key, row[col.key])}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>{total.toLocaleString()} records{debouncedSearch ? ` matching "${debouncedSearch}"` : ''}</span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" disabled={page === 0 || loading} onClick={() => setPage(p => Math.max(0, p - 1))}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span>Page {page + 1} of {totalPages}</span>
            <Button variant="ghost" size="sm" disabled={page >= totalPages - 1 || loading} onClick={() => setPage(p => p + 1)}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
