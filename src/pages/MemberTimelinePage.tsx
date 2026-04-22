import { useEffect, useMemo, useState } from 'react';
import { useBatch } from '@/contexts/BatchContext';
import { BatchSelector } from '@/components/BatchSelector';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Checkbox } from '@/components/ui/checkbox';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Search, Download, ChevronDown, Info } from 'lucide-react';
import { getNormalizedRecords } from '@/lib/persistence';
import { buildMemberTimeline, buildMonthList, formatMonthLabel, type MemberTimelineRow } from '@/lib/memberTimeline';
import { exportToCSV } from '@/lib/csvParser';
import { NPN_MAP } from '@/lib/constants';

const OFFICIAL_AOR_PREFIXES = ['jason fine', 'erica fine', 'becky shuta'];

type PayEntityScope = 'Coverall' | 'Vix' | 'All';
type AorScope = 'official' | 'all';

const PAY_ENTITY_STORAGE_KEY = 'timeline_pay_entity_filter';
const AOR_SCOPE_STORAGE_KEY = 'timeline_aor_scope_filter';

function getStoredPayEntity(): PayEntityScope {
  try {
    const v = localStorage.getItem(PAY_ENTITY_STORAGE_KEY);
    if (v === 'Coverall' || v === 'Vix' || v === 'All') return v;
  } catch {}
  return 'Coverall';
}
function getStoredAorScope(): AorScope {
  try {
    const v = localStorage.getItem(AOR_SCOPE_STORAGE_KEY);
    if (v === 'official' || v === 'all') return v;
  } catch {}
  return 'official';
}

const PAGE_SIZE_OPTIONS = ['25', '50', '100', '250', 'all'] as const;
type PageSizeOption = typeof PAGE_SIZE_OPTIONS[number];

function defaultRange(statementMonth: string | null | undefined): { start: string; end: string } {
  const end = statementMonth ? String(statementMonth).substring(0, 7) : '2026-02';
  // Always anchor start at January 2026 unless the batch ends earlier
  const start = end < '2026-01' ? end : '2026-01';
  return { start, end };
}

export default function MemberTimelinePage() {
  const { currentBatchId, batches } = useBatch();
  const currentBatch = batches.find((b: any) => b.id === currentBatchId);
  const initial = defaultRange(currentBatch?.statement_month);

  // Applied (active) filters drive the table
  const [startMonth, setStartMonth] = useState(initial.start);
  const [endMonth, setEndMonth] = useState(initial.end);
  const [carrier, setCarrier] = useState<string>('all');
  const [aorBuckets, setAorBuckets] = useState<string[]>([]); // empty = all
  const [aorScope, setAorScope] = useState<AorScope>(getStoredAorScope);
  const [payEntity, setPayEntity] = useState<PayEntityScope>(getStoredPayEntity);
  // Only date range is gated behind Apply (carrier/AOR apply immediately)
  const [draftStartMonth, setDraftStartMonth] = useState(initial.start);
  const [draftEndMonth, setDraftEndMonth] = useState(initial.end);
  const [records, setRecords] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'unpaid' | 'paid' | 'partial'>('all');
  const [page, setPage] = useState(0);

  useEffect(() => {
    try { localStorage.setItem(PAY_ENTITY_STORAGE_KEY, payEntity); } catch {}
  }, [payEntity]);
  useEffect(() => {
    try { localStorage.setItem(AOR_SCOPE_STORAGE_KEY, aorScope); } catch {}
  }, [aorScope]);

  const hasPendingChanges =
    draftStartMonth !== startMonth ||
    draftEndMonth !== endMonth;

  const applyFilters = () => {
    setStartMonth(draftStartMonth);
    setEndMonth(draftEndMonth);
  };

  useEffect(() => {
    if (!currentBatchId) { setRecords([]); return; }
    setLoading(true);
    getNormalizedRecords(currentBatchId)
      .then(setRecords)
      .finally(() => setLoading(false));
  }, [currentBatchId]);

  // Reset to default range when batch changes (apply immediately)
  useEffect(() => {
    const r = defaultRange(currentBatch?.statement_month);
    setStartMonth(r.start);
    setEndMonth(r.end);
    setDraftStartMonth(r.start);
    setDraftEndMonth(r.end);
    setCarrier('all');
    setAorBuckets([]);
  }, [currentBatchId]);

  const monthList = useMemo(() => {
    if (startMonth > endMonth) return [];
    return buildMonthList(startMonth, endMonth);
  }, [startMonth, endMonth]);

  // Extract a normalized "carrier family" (e.g. "Ambetter from Sunshine Health" -> "ambetter")
  // so commission files (often labeled with the issuer entity) match EDE/BO carrier values.
  const carrierFamily = (raw: string): string => {
    const s = (raw || '').toLowerCase().trim();
    if (!s) return '';
    if (s.includes('ambetter')) return 'ambetter';
    if (s.includes('molina')) return 'molina';
    if (s.includes('oscar')) return 'oscar';
    if (s.includes('cigna')) return 'cigna';
    if (s.includes('aetna')) return 'aetna';
    if (s.includes('anthem')) return 'anthem';
    if (s.includes('blue cross') || s.includes('bcbs')) return 'bcbs';
    if (s.includes('united')) return 'unitedhealthcare';
    if (s.includes('humana')) return 'humana';
    if (s.includes('kaiser')) return 'kaiser';
    if (s.includes('centene')) return 'centene';
    return s;
  };

  const carrierOptions = useMemo(() => {
    const map = new Map<string, string>(); // family -> display label
    for (const r of records) {
      const fam = carrierFamily(r.carrier || '');
      if (!fam) continue;
      if (!map.has(fam)) {
        // Use Title Case of family as display
        map.set(fam, fam.charAt(0).toUpperCase() + fam.slice(1));
      }
    }
    return Array.from(map.entries())
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [records]);

  const aorOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of records) {
      const a = (r.aor_bucket || '').trim();
      if (a) set.add(a);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [records]);

  // Compute, per member_key, whether they pass AOR scope + pay-entity filters.
  // A member passes AOR scope = "official" if ANY of their records has an aor_bucket OR
  // EDE currentPolicyAOR that starts with one of the official AOR prefixes.
  // A member passes pay-entity = "Coverall" / "Vix" if ANY of their records has an
  // agent_npn whose NPN_MAP expectedPayEntity matches (Coverall_or_Vix matches both).
  const allowedMemberKeys = useMemo(() => {
    if (aorScope === 'all' && payEntity === 'All') return null; // no scope filter
    const byMember = new Map<string, any[]>();
    for (const r of records) {
      const k = r.member_key || r.applicant_name || 'unknown';
      let arr = byMember.get(k);
      if (!arr) { arr = []; byMember.set(k, arr); }
      arr.push(r);
    }
    const allowed = new Set<string>();
    for (const [key, recs] of byMember) {
      // AOR scope check
      if (aorScope === 'official') {
        const matchesAor = recs.some(r => {
          const bucket = String(r.aor_bucket || '').toLowerCase().trim();
          if (OFFICIAL_AOR_PREFIXES.some(p => bucket.startsWith(p))) return true;
          const rawAor = String(r.raw_json?.['currentPolicyAOR'] || '').toLowerCase().trim();
          return OFFICIAL_AOR_PREFIXES.some(p => rawAor.startsWith(p));
        });
        if (!matchesAor) continue;
      }
      // Pay entity check
      if (payEntity !== 'All') {
        const matchesEntity = recs.some(r => {
          const npn = String(r.agent_npn || '').trim();
          const info = NPN_MAP[npn as keyof typeof NPN_MAP];
          if (!info) return false;
          if (info.expectedPayEntity === payEntity) return true;
          if (info.expectedPayEntity === 'Coverall_or_Vix') return true;
          return false;
        });
        if (!matchesEntity) continue;
      }
      allowed.add(key);
    }
    return allowed;
  }, [records, aorScope, payEntity]);

  const filteredRecords = useMemo(() => {
    let out = records;
    if (allowedMemberKeys) {
      out = out.filter(r => allowedMemberKeys.has(r.member_key || r.applicant_name || 'unknown'));
    }
    if (carrier !== 'all') out = out.filter(r => carrierFamily(r.carrier || '') === carrier);
    if (aorBuckets.length > 0) out = out.filter(r => aorBuckets.includes((r.aor_bucket || '').trim()));
    return out;
  }, [records, allowedMemberKeys, carrier, aorBuckets]);

  const allRows = useMemo(() => buildMemberTimeline(filteredRecords as any, monthList), [filteredRecords, monthList]);

  const filteredRows = useMemo(() => {
    // Base set: only members with at least one due month in the selected range.
    // Members with no due months have nothing to reconcile and are excluded from all buckets.
    let rows = allRows.filter(r => r.months_due > 0);
    if (filter === 'unpaid') rows = rows.filter(r => r.months_unpaid > 0);
    else if (filter === 'paid') rows = rows.filter(r => r.months_unpaid === 0);
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

  const [pageSizeOpt, setPageSizeOpt] = useState<PageSizeOption>('50');
  const showAll = pageSizeOpt === 'all';
  const pageSize = showAll ? Math.max(filteredRows.length, 1) : parseInt(pageSizeOpt);
  const totalPages = showAll ? 1 : Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const pageRows = showAll ? filteredRows : filteredRows.slice(page * pageSize, (page + 1) * pageSize);

  useEffect(() => { setPage(0); }, [filter, search, startMonth, endMonth, carrier, aorBuckets, aorScope, payEntity, pageSizeOpt]);

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
          <CardContent className="pt-6 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-7 gap-4 items-end">
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block flex items-center gap-1">
                  Scope
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="cursor-help inline-flex"><Info className="h-3 w-3 opacity-60" /></span>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-[260px] text-xs leading-relaxed">
                      <strong>Official AORs only:</strong> matches the dashboard — restricts to members tied to Jason Fine, Erica Fine, or Becky Shuta. <strong>All AORs:</strong> includes every member regardless of AOR.
                    </TooltipContent>
                  </Tooltip>
                </label>
                <Select value={aorScope} onValueChange={(v) => setAorScope(v as AorScope)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="official">Official AORs only</SelectItem>
                    <SelectItem value="all">All AORs</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block flex items-center gap-1">
                  Pay entity
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="cursor-help inline-flex"><Info className="h-3 w-3 opacity-60" /></span>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-[260px] text-xs leading-relaxed">
                      Filter by expected pay entity (NPN-based). Erica's members count for both Coverall and Vix. "All" includes everyone.
                    </TooltipContent>
                  </Tooltip>
                </label>
                <Select value={payEntity} onValueChange={(v) => setPayEntity(v as PayEntityScope)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Coverall">Coverall</SelectItem>
                    <SelectItem value="Vix">Vix Health</SelectItem>
                    <SelectItem value="All">All entities</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Carrier</label>
                <Select value={carrier} onValueChange={setCarrier}>
                  <SelectTrigger>
                    <SelectValue placeholder="All carriers" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All carriers</SelectItem>
                    {carrierOptions.map(c => (
                      <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">AOR</label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" className="w-full justify-between font-normal">
                      <span className="truncate">
                        {aorBuckets.length === 0
                          ? 'All AORs'
                          : aorBuckets.length === 1
                            ? aorBuckets[0]
                            : `${aorBuckets.length} selected`}
                      </span>
                      <ChevronDown className="h-4 w-4 opacity-50 shrink-0 ml-2" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[260px] p-2" align="start">
                    <div className="space-y-1 max-h-64 overflow-auto">
                      <button
                        type="button"
                        onClick={() => setAorBuckets([])}
                        className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-accent ${
                          aorBuckets.length === 0 ? 'bg-accent' : ''
                        }`}
                      >
                        <Checkbox checked={aorBuckets.length === 0} className="pointer-events-none" />
                        <span className="font-medium">All AORs</span>
                      </button>
                      <div className="h-px bg-border my-1" />
                      {aorOptions.length === 0 ? (
                        <div className="px-2 py-1.5 text-xs text-muted-foreground">No AORs available</div>
                      ) : aorOptions.map(a => {
                        const checked = aorBuckets.includes(a);
                        return (
                          <button
                            key={a}
                            type="button"
                            onClick={() => {
                              setAorBuckets(prev =>
                                prev.includes(a) ? prev.filter(x => x !== a) : [...prev, a]
                              );
                            }}
                            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-accent"
                          >
                            <Checkbox checked={checked} className="pointer-events-none" />
                            <span className="truncate">{a}</span>
                          </button>
                        );
                      })}
                    </div>
                  </PopoverContent>
                </Popover>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Start month</label>
                <Input
                  type="month"
                  value={draftStartMonth}
                  onChange={e => setDraftStartMonth(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') applyFilters(); }}
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">End month</label>
                <Input
                  type="month"
                  value={draftEndMonth}
                  onChange={e => setDraftEndMonth(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') applyFilters(); }}
                />
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
            </div>
            <div className="flex items-center justify-end gap-2">
              {hasPendingChanges && (
                <span className="text-xs text-muted-foreground">Unapplied changes</span>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setDraftStartMonth(startMonth);
                  setDraftEndMonth(endMonth);
                }}
                disabled={!hasPendingChanges}
              >
                Reset
              </Button>
              <Button size="sm" onClick={applyFilters} disabled={!hasPendingChanges}>
                Apply Filter
              </Button>
            </div>
          </CardContent>
        </Card>

        <div className="flex items-center gap-2 flex-wrap text-xs">
          {(() => {
            const dueRows = allRows.filter(r => r.months_due > 0);
            const counts = {
              all: dueRows.length,
              unpaid: dueRows.filter(r => r.months_unpaid > 0).length,
              partial: dueRows.filter(r => r.months_paid > 0 && r.months_unpaid > 0).length,
              paid: dueRows.filter(r => r.months_unpaid === 0).length,
            };
            return (['all', 'unpaid', 'partial', 'paid'] as const).map(f => {
              const tip =
                f === 'all'
                  ? 'All members with at least one due month in the selected range.'
                  : f === 'unpaid'
                  ? 'Members with at least one due month that has not been paid (gap in commission).'
                  : f === 'partial'
                  ? 'Members who have been paid for some due months but still have one or more unpaid due months.'
                  : 'Members where every due month in the range has been paid in full.';
              const label =
                f === 'all'
                  ? `All (${counts.all})`
                  : f === 'unpaid'
                  ? `Has unpaid (${counts.unpaid})`
                  : f === 'partial'
                  ? `Partially paid (${counts.partial})`
                  : `Fully paid (${counts.paid})`;
              return (
                <div key={f} className="inline-flex items-center">
                  <button
                    onClick={() => setFilter(f)}
                    className={`pl-3 pr-2 py-1 rounded-full font-medium border transition-colors inline-flex items-center gap-1.5 ${
                      filter === f
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-secondary text-secondary-foreground border-border hover:bg-accent'
                    }`}
                  >
                    <span>{label}</span>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span
                          onClick={e => e.stopPropagation()}
                          className="opacity-70 hover:opacity-100 transition-opacity cursor-help inline-flex"
                        >
                          <Info className="h-3 w-3" />
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="max-w-[260px] text-xs leading-relaxed">
                        {tip}
                      </TooltipContent>
                    </Tooltip>
                  </button>
                </div>
              );
            });
          })()}
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
                    <th className="text-left px-2 py-2 font-medium text-muted-foreground whitespace-nowrap">Policy/Subs ID</th>
                    <th className="text-left px-2 py-2 font-medium text-muted-foreground whitespace-nowrap">AOR</th>
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
                      <td className="px-2 py-2 text-muted-foreground whitespace-nowrap truncate max-w-[160px]" title={row.current_policy_aor || row.aor_bucket}>
                        {row.current_policy_aor || row.aor_bucket || '—'}
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
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs">Show</span>
                  <Select value={pageSizeOpt} onValueChange={v => setPageSizeOpt(v as PageSizeOption)}>
                    <SelectTrigger className="h-8 w-[88px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PAGE_SIZE_OPTIONS.map(opt => (
                        <SelectItem key={opt} value={opt}>{opt === 'all' ? 'All' : opt}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {!showAll ? (
                  <>
                    <Button variant="ghost" size="sm" disabled={page === 0} onClick={() => setPage(p => p - 1)}>Prev</Button>
                    <span>Page {page + 1} of {totalPages}</span>
                    <Button variant="ghost" size="sm" disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>Next</Button>
                  </>
                ) : (
                  <span>{filteredRows.length} rows</span>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </TooltipProvider>
  );
}
