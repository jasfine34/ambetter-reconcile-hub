import { useEffect, useMemo, useState } from 'react';
import { useBatch } from '@/contexts/BatchContext';
import { BatchSelector } from '@/components/BatchSelector';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Search, Download } from 'lucide-react';
import { getNormalizedRecords } from '@/lib/persistence';
import { buildMemberTimeline, buildMonthList, formatMonthLabel, type MemberTimelineRow } from '@/lib/memberTimeline';
import { exportToCSV } from '@/lib/csvParser';

const PAGE_SIZE = 50;

function defaultRange(statementMonth: string | null | undefined): { start: string; end: string } {
  const end = statementMonth ? String(statementMonth).substring(0, 7) : '2026-02';
  const [y, m] = end.split('-').map(Number);
  let sm = m - 5, sy = y;
  while (sm < 1) { sm += 12; sy -= 1; }
  const start = `${sy}-${String(sm).padStart(2, '0')}`;
  return { start, end };
}

export default function MemberTimelinePage() {
  const { currentBatchId, batches } = useBatch();
  const currentBatch = batches.find((b: any) => b.id === currentBatchId);
  const initial = defaultRange(currentBatch?.statement_month);

  const [startMonth, setStartMonth] = useState(initial.start);
  const [endMonth, setEndMonth] = useState(initial.end);
  const [records, setRecords] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'unpaid' | 'paid' | 'partial'>('all');
  const [carrier, setCarrier] = useState<string>('all');
  const [page, setPage] = useState(0);

  useEffect(() => {
    if (!currentBatchId) { setRecords([]); return; }
    setLoading(true);
    getNormalizedRecords(currentBatchId)
      .then(setRecords)
      .finally(() => setLoading(false));
  }, [currentBatchId]);

  // Reset to default range when batch changes
  useEffect(() => {
    const r = defaultRange(currentBatch?.statement_month);
    setStartMonth(r.start);
    setEndMonth(r.end);
  }, [currentBatchId]);

  const monthList = useMemo(() => {
    if (startMonth > endMonth) return [];
    return buildMonthList(startMonth, endMonth);
  }, [startMonth, endMonth]);

  const carrierOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of records) {
      const c = (r.carrier || '').trim();
      if (c) set.add(c);
    }
    return Array.from(set).sort();
  }, [records]);

  const filteredRecords = useMemo(() => {
    if (carrier === 'all') return records;
    const target = carrier.toLowerCase();
    return records.filter(r => (r.carrier || '').toLowerCase() === target);
  }, [records, carrier]);

  const allRows = useMemo(() => buildMemberTimeline(filteredRecords as any, monthList), [filteredRecords, monthList]);

  const filteredRows = useMemo(() => {
    let rows = allRows;
    if (filter === 'unpaid') rows = rows.filter(r => r.months_unpaid > 0);
    else if (filter === 'paid') rows = rows.filter(r => r.months_due > 0 && r.months_unpaid === 0);
    else if (filter === 'partial') rows = rows.filter(r => r.months_paid > 0 && r.months_unpaid > 0);
    if (search) {
      const s = search.toLowerCase();
      rows = rows.filter(r =>
        r.applicant_name.toLowerCase().includes(s) ||
        r.policy_number.toLowerCase().includes(s) ||
        r.exchange_subscriber_id.toLowerCase().includes(s) ||
        r.issuer_subscriber_id.toLowerCase().includes(s) ||
        r.agent_name.toLowerCase().includes(s)
      );
    }
    return rows;
  }, [allRows, filter, search]);

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const pageRows = filteredRows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  useEffect(() => { setPage(0); }, [filter, search, startMonth, endMonth]);

  const summary = useMemo(() => {
    let totalPaid = 0, totalUnpaidMonths = 0, membersWithUnpaid = 0;
    for (const r of filteredRows) {
      totalPaid += r.total_paid;
      totalUnpaidMonths += r.months_unpaid;
      if (r.months_unpaid > 0) membersWithUnpaid++;
    }
    return { totalPaid, totalUnpaidMonths, membersWithUnpaid };
  }, [filteredRows]);

  const handleExport = () => {
    const flat = filteredRows.map(r => {
      const base: Record<string, unknown> = {
        member: r.applicant_name,
        policy_number: r.policy_number,
        exchange_subscriber_id: r.exchange_subscriber_id,
        issuer_subscriber_id: r.issuer_subscriber_id,
        agent_name: r.agent_name,
        aor_bucket: r.aor_bucket,
        months_due: r.months_due,
        months_paid: r.months_paid,
        months_unpaid: r.months_unpaid,
        total_paid: r.total_paid.toFixed(2),
      };
      for (const m of monthList) {
        const c = r.cells[m];
        const sources = [c.in_ede && 'EDE', c.in_back_office && 'BO', c.in_commission && 'COM']
          .filter(Boolean).join('+');
        base[`${m}_status`] = c.due ? (c.paid_amount > 0.0001 ? 'PAID' : 'UNPAID') : (sources ? 'PRESENT' : '');
        base[`${m}_paid`] = c.paid_amount.toFixed(2);
        base[`${m}_sources`] = sources;
      }
      return base;
    });
    exportToCSV(flat, `member_timeline_${startMonth}_${endMonth}.csv`);
  };

  return (
    <TooltipProvider delayDuration={150}>
      <div className="space-y-6">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-2xl font-bold text-foreground">Member Timeline</h2>
            <p className="text-sm text-muted-foreground">
              Per-month commission status by member — sources, paid amounts, gaps
            </p>
          </div>
          <BatchSelector />
        </div>

        <Card>
          <CardContent className="pt-6 grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Start month</label>
              <Input type="month" value={startMonth} onChange={e => setStartMonth(e.target.value)} />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">End month</label>
              <Input type="month" value={endMonth} onChange={e => setEndMonth(e.target.value)} />
            </div>
            <div className="md:col-span-2 flex gap-2 items-end">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search name, policy, sub ID, agent..."
                  className="pl-9"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
              </div>
              <Button variant="outline" size="sm" onClick={handleExport} disabled={filteredRows.length === 0}>
                <Download className="h-4 w-4 mr-1" /> Export
              </Button>
            </div>
          </CardContent>
        </Card>

        <div className="flex items-center gap-2 flex-wrap text-xs">
          {(['all', 'unpaid', 'partial', 'paid'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1 rounded-full font-medium border transition-colors ${
                filter === f
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-secondary text-secondary-foreground border-border hover:bg-accent'
              }`}
            >
              {f === 'all' && `All (${allRows.length})`}
              {f === 'unpaid' && `Has unpaid (${allRows.filter(r => r.months_unpaid > 0).length})`}
              {f === 'partial' && `Partially paid (${allRows.filter(r => r.months_paid > 0 && r.months_unpaid > 0).length})`}
              {f === 'paid' && `Fully paid (${allRows.filter(r => r.months_due > 0 && r.months_unpaid === 0).length})`}
            </button>
          ))}
          <div className="ml-auto flex gap-4 text-muted-foreground">
            <span>Total paid: <strong className="text-foreground">${summary.totalPaid.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></span>
            <span>Members w/ gaps: <strong className="text-foreground">{summary.membersWithUnpaid}</strong></span>
            <span>Unpaid month-events: <strong className="text-foreground">{summary.totalUnpaidMonths}</strong></span>
          </div>
        </div>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              {loading ? 'Loading…' : `${filteredRows.length} members · ${monthList.length} months`}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="overflow-auto rounded-lg border">
              <table className="w-full text-xs">
                <thead className="bg-muted/40 sticky top-0">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground sticky left-0 bg-muted/40 z-10 min-w-[180px]">
                      Member
                    </th>
                    <th className="text-left px-2 py-2 font-medium text-muted-foreground whitespace-nowrap">Policy</th>
                    <th className="text-left px-2 py-2 font-medium text-muted-foreground whitespace-nowrap">Agent</th>
                    <th className="text-right px-2 py-2 font-medium text-muted-foreground whitespace-nowrap">Total $</th>
                    <th className="text-center px-2 py-2 font-medium text-muted-foreground whitespace-nowrap">Due/Paid</th>
                    {monthList.map(m => (
                      <th key={m} className="text-center px-2 py-2 font-medium text-muted-foreground whitespace-nowrap min-w-[88px]">
                        {formatMonthLabel(m)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pageRows.length === 0 ? (
                    <tr>
                      <td colSpan={5 + monthList.length} className="text-center text-muted-foreground py-10">
                        {loading ? 'Loading records...' : 'No members match filter'}
                      </td>
                    </tr>
                  ) : pageRows.map(row => (
                    <tr key={row.member_key} className="border-t hover:bg-muted/30">
                      <td className="px-3 py-2 sticky left-0 bg-card z-10">
                        <div className="font-medium text-foreground truncate max-w-[180px]" title={row.applicant_name}>
                          {row.applicant_name || '—'}
                        </div>
                        <div className="text-[10px] text-muted-foreground truncate max-w-[180px]">
                          {row.aor_bucket || '—'}
                        </div>
                      </td>
                      <td className="px-2 py-2 font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                        {row.policy_number || row.issuer_subscriber_id || row.exchange_subscriber_id || '—'}
                      </td>
                      <td className="px-2 py-2 text-muted-foreground whitespace-nowrap truncate max-w-[140px]" title={row.agent_name}>
                        {row.agent_name || '—'}
                      </td>
                      <td className="px-2 py-2 text-right font-medium text-foreground whitespace-nowrap">
                        ${row.total_paid.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                      <td className="px-2 py-2 text-center whitespace-nowrap">
                        <span className="text-foreground font-medium">{row.months_paid}</span>
                        <span className="text-muted-foreground">/{row.months_due}</span>
                      </td>
                      {monthList.map(m => {
                        const c = row.cells[m];
                        const hasAny = c.in_ede || c.in_back_office || c.in_commission;
                        let cellCls = 'bg-transparent';
                        if (c.due && c.paid_amount > 0.0001) cellCls = 'bg-success/15 border border-success/30';
                        else if (c.due) cellCls = 'bg-destructive/15 border border-destructive/30';
                        else if (hasAny) cellCls = 'bg-muted/40 border border-border';

                        return (
                          <td key={m} className="px-1 py-1 text-center align-middle">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <div className={`rounded-md px-2 py-1.5 ${cellCls} cursor-default`}>
                                  <div className="flex justify-center gap-0.5 mb-0.5">
                                    {c.in_ede && <Badge variant="secondary" className="h-4 px-1 text-[9px] font-mono">E</Badge>}
                                    {c.in_back_office && <Badge variant="secondary" className="h-4 px-1 text-[9px] font-mono">B</Badge>}
                                    {c.in_commission && <Badge variant="secondary" className="h-4 px-1 text-[9px] font-mono">C</Badge>}
                                    {!hasAny && <span className="text-muted-foreground/50 text-[10px]">—</span>}
                                  </div>
                                  <div className="text-[10px] font-medium text-foreground leading-tight">
                                    {c.paid_amount > 0.0001
                                      ? `$${c.paid_amount.toFixed(2)}`
                                      : c.due ? <span className="text-destructive">unpaid</span> : ''}
                                  </div>
                                </div>
                              </TooltipTrigger>
                              <TooltipContent side="top" className="text-xs">
                                <div className="font-semibold mb-1">{formatMonthLabel(m)}</div>
                                <div>EDE: {c.in_ede ? 'yes' : 'no'}</div>
                                <div>Back Office: {c.in_back_office ? 'active' : 'no'}</div>
                                <div>Commission: {c.in_commission ? `${c.payment_count} payment(s)` : 'no'}</div>
                                <div>Paid: ${c.paid_amount.toFixed(2)}</div>
                                <div>Due: {c.due ? 'yes' : 'no'}</div>
                              </TooltipContent>
                            </Tooltip>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex items-center justify-between mt-3 text-sm text-muted-foreground">
              <div className="flex items-center gap-3">
                <span className="flex items-center gap-1.5">
                  <span className="inline-block w-3 h-3 rounded bg-success/30 border border-success/50" />
                  Paid
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block w-3 h-3 rounded bg-destructive/30 border border-destructive/50" />
                  Due, unpaid
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block w-3 h-3 rounded bg-muted border border-border" />
                  Present, not due
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" disabled={page === 0} onClick={() => setPage(p => p - 1)}>Prev</Button>
                <span>Page {page + 1} of {totalPages}</span>
                <Button variant="ghost" size="sm" disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>Next</Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </TooltipProvider>
  );
}
