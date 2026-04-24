import { useState, useMemo, type ReactNode } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Search, Download, ChevronLeft, ChevronRight } from 'lucide-react';
import { exportToCSV } from '@/lib/csvParser';

interface DataTableProps {
  data: Record<string, unknown>[];
  columns: { key: string; label: string }[];
  exportFileName?: string;
  pageSize?: number;
  filterChips?: { label: string; value: string; field: string }[];
  /**
   * Optional per-cell render override. Return `undefined` to fall through to
   * the default rendering. Useful for adornments like a "resolved identity"
   * badge that should appear next to certain ID values.
   */
  renderCell?: (key: string, row: Record<string, unknown>) => ReactNode | undefined;
}

export function DataTable({ data, columns, exportFileName, pageSize = 25, filterChips, renderCell }: DataTableProps) {
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState('');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(0);
  const [activeChip, setActiveChip] = useState<string | null>(null);

  const filtered = useMemo(() => {
    let result = data;
    if (activeChip && filterChips) {
      const chip = filterChips.find(c => c.value === activeChip);
      if (chip) result = result.filter(r => String(r[chip.field] ?? '') === chip.value);
    }
    if (search) {
      const s = search.toLowerCase();
      result = result.filter(r => columns.some(c => String(r[c.key] ?? '').toLowerCase().includes(s)));
    }
    if (sortKey) {
      result = [...result].sort((a, b) => {
        const av = String(a[sortKey] ?? '');
        const bv = String(b[sortKey] ?? '');
        return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      });
    }
    return result;
  }, [data, search, sortKey, sortDir, activeChip, filterChips, columns]);

  const totalPages = Math.ceil(filtered.length / pageSize);
  const paged = filtered.slice(page * pageSize, (page + 1) * pageSize);

  const toggleSort = (key: string) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('asc'); }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search..." value={search} onChange={e => { setSearch(e.target.value); setPage(0); }} className="pl-9" />
        </div>
        {filterChips?.map(chip => (
          <button
            key={chip.value}
            onClick={() => { setActiveChip(activeChip === chip.value ? null : chip.value); setPage(0); }}
            className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${activeChip === chip.value ? 'bg-primary text-primary-foreground border-primary' : 'bg-secondary text-secondary-foreground border-border hover:bg-accent'}`}
          >
            {chip.label}
          </button>
        ))}
        {exportFileName && (
          <Button variant="outline" size="sm" onClick={() => exportToCSV(filtered as Record<string, unknown>[], exportFileName)}>
            <Download className="h-4 w-4 mr-1" /> Export
          </Button>
        )}
      </div>
      <div className="rounded-lg border overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map(col => (
                <TableHead key={col.key} className="cursor-pointer select-none whitespace-nowrap" onClick={() => toggleSort(col.key)}>
                  {col.label} {sortKey === col.key ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {paged.length === 0 ? (
              <TableRow><TableCell colSpan={columns.length} className="text-center text-muted-foreground py-8">No records found</TableCell></TableRow>
            ) : paged.map((row, i) => (
              <TableRow key={i}>
                {columns.map(col => (
                  <TableCell key={col.key} className="whitespace-nowrap text-sm">
                    {row[col.key] == null ? '—' : typeof row[col.key] === 'boolean' ? (row[col.key] ? '✓' : '✗') : typeof row[col.key] === 'number' ? (col.key.includes('commission') || col.key.includes('premium') ? `$${(row[col.key] as number).toLocaleString(undefined, { minimumFractionDigits: 2 })}` : (row[col.key] as number).toLocaleString()) : String(row[col.key])}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>{filtered.length} records</span>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" disabled={page === 0} onClick={() => setPage(p => p - 1)}><ChevronLeft className="h-4 w-4" /></Button>
          <span>Page {page + 1} of {totalPages || 1}</span>
          <Button variant="ghost" size="sm" disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}><ChevronRight className="h-4 w-4" /></Button>
        </div>
      </div>
    </div>
  );
}
