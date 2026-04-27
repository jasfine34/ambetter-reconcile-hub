import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
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
import { Search, Download, ChevronDown, ChevronLeft, Info, Bug } from 'lucide-react';
import { getNormalizedRecords, getAllNormalizedRecords } from '@/lib/persistence';
import { buildMemberTimeline, buildMonthList, formatMonthLabel, type MemberTimelineRow } from '@/lib/memberTimeline';
import { assignMergedMemberKeys } from '@/lib/memberMerge';
import { exportToCSV } from '@/lib/csvParser';
import { NPN_MAP } from '@/lib/constants';
import { isCoverallAORByName } from '@/lib/agents';
import { statementMonthKey, currentMonthKey, addMonths } from '@/lib/dateRange';
import { classifyMember, buildClassifierContext } from '@/lib/classifier';
import { buildPaidDollarsAudit } from '@/lib/paidDollarsAudit';
import { PaidDollarsAuditPanel } from '@/components/PaidDollarsAuditPanel';
import { CellAttributionPopover } from '@/components/CellAttributionPopover';
import { ResolvedBadge } from '@/components/ResolvedBadge';
import { lookupResolved } from '@/lib/resolvedIdentities';

type PayEntityScope = 'Coverall' | 'Vix' | 'All';
type AorScope = 'official' | 'all';

const PAY_ENTITY_STORAGE_KEY = 'timeline_pay_entity_filter';
const AOR_SCOPE_STORAGE_KEY = 'timeline_aor_scope_filter';
const BATCH_SCOPE_STORAGE_KEY = 'timeline_batch_scope_filter';

type BatchScope = 'current' | 'all';
function getStoredBatchScope(): BatchScope {
  try {
    const v = localStorage.getItem(BATCH_SCOPE_STORAGE_KEY);
    if (v === 'current' || v === 'all') return v;
  } catch {}
  return 'current';
}

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

/**
 * Pre-built dropdown options for Start/End month pickers. Spans Jan 2025 to
 * end-of-next-year so any reasonable reconciliation window is selectable.
 * Replaces native <input type="month"> which rendered inconsistently across
 * browsers and wasn't clearly interactive.
 */
const MONTH_OPTIONS: { value: string; label: string }[] = (() => {
  const out: { value: string; label: string }[] = [];
  const startYear = 2025;
  const endYear = new Date().getFullYear() + 1;
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                      'July', 'August', 'September', 'October', 'November', 'December'];
  for (let y = startYear; y <= endYear; y++) {
    for (let m = 1; m <= 12; m++) {
      const value = `${y}-${String(m).padStart(2, '0')}`;
      const label = `${monthNames[m - 1]} ${y}`;
      out.push({ value, label });
    }
  }
  return out;
})();

function defaultRange(statementMonth: string | null | undefined): { start: string; end: string } {
  // End at the batch's statement month (or the current calendar month if no
  // batch is selected). Start at January of the same year, so the timeline
  // shows the full year-to-date by default.
  const end = statementMonthKey(statementMonth) || currentMonthKey();
  const [year] = end.split('-');
  const january = `${year}-01`;
  // Clamp so we never pick a start after end (e.g. if the batch is literally
  // January, start=end rather than a prior year's January).
  const start = january <= end ? january : addMonths(end, -1);
  return { start, end };
}

export default function MemberTimelinePage() {
  const { currentBatchId, batches, resolverIndex } = useBatch();
  const navigate = useNavigate();
  const [tlSearchParams] = useSearchParams();
  const fromRecords = tlSearchParams.get('from') === 'records';
  const currentBatch = batches.find((b: any) => b.id === currentBatchId);
  const initial = defaultRange(currentBatch?.statement_month);

  // Applied (active) filters drive the table
  const [startMonth, setStartMonth] = useState(initial.start);
  const [endMonth, setEndMonth] = useState(initial.end);
  const [carrier, setCarrier] = useState<string>('all');
  const [aorBuckets, setAorBuckets] = useState<string[]>([]); // empty = all
  const [aorScope, setAorScope] = useState<AorScope>(getStoredAorScope);
  const [batchScope, setBatchScope] = useState<BatchScope>(getStoredBatchScope);
  const [payEntity, setPayEntity] = useState<PayEntityScope>(getStoredPayEntity);
  // Only date range is gated behind Apply (carrier/AOR apply immediately)
  const [draftStartMonth, setDraftStartMonth] = useState(initial.start);
  const [draftEndMonth, setDraftEndMonth] = useState(initial.end);
  const [records, setRecords] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'unpaid' | 'paid' | 'partial' | 'pending' | 'review'>('all');
  const [page, setPage] = useState(0);
  const [debugOpen, setDebugOpen] = useState(false);

  useEffect(() => {
    try { localStorage.setItem(PAY_ENTITY_STORAGE_KEY, payEntity); } catch {}
  }, [payEntity]);
  useEffect(() => {
    try { localStorage.setItem(AOR_SCOPE_STORAGE_KEY, aorScope); } catch {}
  }, [aorScope]);
  useEffect(() => {
    try { localStorage.setItem(BATCH_SCOPE_STORAGE_KEY, batchScope); } catch {}
  }, [batchScope]);

  const hasPendingChanges =
    draftStartMonth !== startMonth ||
    draftEndMonth !== endMonth;

  const applyFilters = () => {
    setStartMonth(draftStartMonth);
    setEndMonth(draftEndMonth);
  };

  useEffect(() => {
    setLoading(true);
    const fetch = batchScope === 'all'
      ? getAllNormalizedRecords()
      : currentBatchId
        ? getNormalizedRecords(currentBatchId)
        : Promise.resolve([] as any[]);
    fetch
      .then(recs => {
        // Re-key records using the same multi-strategy union-find that
        // reconcile uses, so the same person across EDE / Back Office /
        // Commission collapses into ONE timeline row (e.g. Aaron Barrett by
        // U-sub-id + by Ambetter policy number). Also merges cross-batch
        // records for the same member when batchScope is 'all'.
        assignMergedMemberKeys(recs as any);
        setRecords(recs);
      })
      .catch(() => setRecords([]))
      .finally(() => setLoading(false));
  }, [currentBatchId, batchScope]);

  // Reset start/end to sensible defaults on initial mount and when the batch
  // scope changes. Deliberately NOT dependent on currentBatchId — switching
  // the top batch filter should not wipe a user-customized month range. The
  // dependencies below cover: initial batches load, scope toggle.
  useEffect(() => {
    let r: { start: string; end: string };
    if (batchScope === 'all') {
      const months = batches
        .map((b: any) => statementMonthKey(b.statement_month))
        .filter(Boolean)
        .sort();
      if (months.length > 0) {
        r = { start: months[0], end: months[months.length - 1] };
      } else {
        r = defaultRange(currentBatch?.statement_month);
      }
    } else {
      r = defaultRange(currentBatch?.statement_month);
    }
    setStartMonth(r.start);
    setEndMonth(r.end);
    setDraftStartMonth(r.start);
    setDraftEndMonth(r.end);
    setCarrier('all');
    setAorBuckets([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchScope, batches.length]);

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

  // Per-record predicate: does THIS record's AOR / pay-entity belong to us?
  // Applied at the month-cell level inside buildMemberTimeline so a member
  // who transferred away mid-period only counts due months while their AOR
  // was still ours. Source presence (E/B/C badges) and paid amounts still
  // appear in the cells regardless, so context is preserved.
  const isDueEligibleRecord = useMemo(() => {
    return (r: any): boolean => {
      const isCommission = r.source_type === 'COMMISSION';

      // AOR scope: record must be tied to one of our official AORs.
      //
      // Business rule: COMMISSION records are scoped by which statement slot
      // they were uploaded into (pay_entity), NOT by writing-agent identity.
      // Downline commissions and former-employee book commissions appearing
      // on a Coverall/Vix statement are that entity's property regardless of
      // current AOR mapping. So skip the AOR check for commissions entirely.
      if (aorScope === 'official' && !isCommission) {
        // Match on any of the three identifying strings carried by a record:
        // aor_bucket (our own normalization), EDE's currentPolicyAOR, or
        // BO's Broker Name. Centralized in isCoverallAORByName so adding or
        // removing an AOR is a one-file change in src/lib/agents.ts.
        const aorMatch =
          isCoverallAORByName(r.aor_bucket) ||
          isCoverallAORByName(r.raw_json?.['currentPolicyAOR'] as string | undefined) ||
          isCoverallAORByName(
            (r.raw_json?.['Broker Name'] as string | undefined) ??
            (r.raw_json?.['broker_name'] as string | undefined)
          );
        if (!aorMatch) return false;
      }
      // Pay entity filtering — different rules for commission vs enrollment data:
      //
      //   - COMMISSION records carry a direct `pay_entity` from the upload slot
      //     they came in on ("Coverall Commission Statement" → 'Coverall',
      //     "Vix Commission Statement" → 'Vix'). Filter strictly on that —
      //     anything on a statement belongs to that entity (downline included).
      //
      //   - EDE / BO records have no pay_entity on the record — use the
      //     agent's expected_pay_entity from NPN_MAP instead.
      if (payEntity !== 'All') {
        if (isCommission) {
          const recPayEntity = String(r.pay_entity || '').trim();
          if (recPayEntity !== payEntity) return false;
        } else {
          const npn = String(r.agent_npn || '').trim();
          const info = NPN_MAP[npn as keyof typeof NPN_MAP];
          if (!info) return false;
          if (info.expectedPayEntity !== payEntity && info.expectedPayEntity !== 'Coverall_or_Vix') {
            return false;
          }
        }
      }
      return true;
    };
  }, [aorScope, payEntity]);

  const filteredRecords = useMemo(() => {
    let out = records;
    if (carrier !== 'all') out = out.filter(r => carrierFamily(r.carrier || '') === carrier);
    if (aorBuckets.length > 0) out = out.filter(r => aorBuckets.includes((r.aor_bucket || '').trim()));
    return out;
  }, [records, carrier, aorBuckets]);

  const allRows = useMemo(
    () => buildMemberTimeline(filteredRecords as any, monthList, isDueEligibleRecord),
    [filteredRecords, monthList, isDueEligibleRecord]
  );

  // Phase 2c — enrich each row's cells with the classifier's per-cell state
  // and compute the member-level rollup. Runs once per render of filteredRecords
  // and monthList; relatively cheap since the classifier is pure TS.
  const classifiedRows = useMemo(() => {
    if (allRows.length === 0 || monthList.length === 0) return allRows;

    // Apply the same per-record pay-entity / AOR scope filter that
    // buildMemberTimeline uses for cell-level paid_amount, so the classifier
    // sees the SAME commission rows the cell displays. Without this, an
    // off-scope commission (e.g. a Vix $4.50 row when viewing Coverall) would
    // trigger Rule 1 (Paid) in the classifier even though the cell shows $0.00,
    // producing green "paid" cells with no dollars.
    const classifierRecords = filteredRecords.filter(isDueEligibleRecord);

    // Group records by member_key (same key buildMemberTimeline used)
    const byMember = new Map<string, any[]>();
    for (const r of classifierRecords) {
      const key = r.member_key || r.applicant_name || 'unknown';
      let arr = byMember.get(key);
      if (!arr) { arr = []; byMember.set(key, arr); }
      arr.push(r);
    }

    // Build a context. boSnapshotDates is empty — snapshot dates aren't
    // plumbed onto records yet (they live on the bo_snapshots table). When
    // empty, the classifier falls back to commission-statement-only ripeness,
    // which matches the operational question the user actually asks: "has
    // the statement that would pay for this service month arrived?"
    //
    // Practical consequence: if you've uploaded the Feb 21 statement (pays
    // January service), Jan cells evaluate fully and Feb cells show as
    // "pending" until the March 21 statement is uploaded into its batch.
    const context = buildClassifierContext(classifierRecords as any, monthList, []);

    return allRows.map(row => {
      const recs = byMember.get(row.member_key) ?? [];
      if (recs.length === 0) return row;
      const classification = classifyMember(recs as any, context);
      const newCells = { ...row.cells };
      // Recompute per-member counters based on the classifier state so filter
      // pills reflect the same truth the cells display. Legacy `due` flag only
      // said "active this month"; classifier says paid/unpaid/pending/review.
      let months_paid = 0;
      let months_unpaid = 0;
      let months_pending = 0;
      let months_due = 0;
      for (const m of monthList) {
        const c = classification.cells[m];
        const existing = newCells[m];
        if (!c || !existing) continue;
        newCells[m] = {
          ...existing,
          state: c.state,
          state_reason: c.reason,
        };
        // Count states. Only eligible cells contribute to due/paid/unpaid.
        switch (c.state) {
          case 'paid':
            months_paid++;
            months_due++;
            break;
          case 'unpaid':
            months_unpaid++;
            months_due++;
            break;
          case 'pending':
            months_pending++;
            months_due++;
            break;
          case 'manual_review':
            // Counts as due but doesn't resolve to paid or unpaid
            months_due++;
            break;
          default:
            // not_expected_* — not due, skip
            break;
        }
      }
      return {
        ...row,
        cells: newCells,
        rollup: classification.rollup,
        needs_manual_review: classification.needs_manual_review,
        months_paid,
        months_unpaid,
        months_due,
      } as MemberTimelineRow;
    });
  }, [allRows, filteredRecords, monthList, isDueEligibleRecord]);

  const filteredRows = useMemo(() => {
    // Base set: only members with at least one due month in the selected range.
    // Members with no due months have nothing to reconcile and are excluded from all buckets.
    let rows = classifiedRows.filter(r => r.months_due > 0);
    const isPending = (r: MemberTimelineRow): boolean =>
      Object.values(r.cells).some(c => c.state === 'pending');
    if (filter === 'unpaid') rows = rows.filter(r => r.months_unpaid > 0);
    else if (filter === 'paid') {
      // Fully paid = every due month is paid (not just "no unpaid"). Members
      // with pending cells don't qualify — they're waiting, not resolved.
      rows = rows.filter(r => r.months_paid === r.months_due && r.months_due > 0);
    }
    else if (filter === 'partial') rows = rows.filter(r => r.months_paid > 0 && r.months_unpaid > 0);
    else if (filter === 'pending') rows = rows.filter(r => isPending(r));
    else if (filter === 'review') rows = rows.filter(r => r.needs_manual_review);
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
  }, [classifiedRows, filter, search]);

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

  /**
   * Paid Dollars audit — built only when the Debug panel is open so we don't
   * pay for the extra pass on every render. Uses the same record set + scope
   * predicate as buildMemberTimeline, so its attributed_total must equal
   * summary.totalPaid (this is the self-check displayed in the panel).
   *
   * NOTE: filteredRows already applies the search filter (name/policy/etc).
   * The audit intentionally ignores `search` — it audits the full visible
   * timeline scope (batches × pay entity × AOR × carrier × date range), not
   * the search-narrowed slice. The panel has its own search field for
   * filtering the audit display without affecting the totals.
   */
  const audit = useMemo(() => {
    if (!debugOpen) return null;
    return buildPaidDollarsAudit({
      allRecords: filteredRecords as any,
      monthList,
      isDueEligibleRecord: isDueEligibleRecord as any,
      payEntity,
      aorScope,
      batches,
    });
  }, [debugOpen, filteredRecords, monthList, isDueEligibleRecord, payEntity, aorScope, batches]);

  /**
   * For the audit's "Member Timeline Total Paid" self-check we need the total
   * computed over the SAME scope the audit saw — i.e. before search filtering.
   * Otherwise typing in the search box would make the audit "drift" against
   * the timeline by definition.
   */
  const unsearchedTotalPaid = useMemo(() => {
    let t = 0;
    for (const r of classifiedRows) {
      if (r.months_due > 0) t += r.total_paid;
    }
    return t;
  }, [classifiedRows]);

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
        {fromRecords && (
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ChevronLeft className="h-4 w-4" /> Back to All Records
          </button>
        )}
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
            <div className="grid grid-cols-1 md:grid-cols-9 gap-4 items-end">
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block flex items-center gap-1">
                  Batches
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="cursor-help inline-flex"><Info className="h-3 w-3 opacity-60" /></span>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-[300px] text-xs leading-relaxed">
                      <strong>Current batch:</strong> only records from the batch selected at the top. Good for inspecting what a specific statement paid for.
                      <br />
                      <strong>All batches:</strong> combines records across every batch so retroactive catch-ups on later statements flip earlier months to paid. Recommended for year-to-date review.
                    </TooltipContent>
                  </Tooltip>
                </label>
                <Select value={batchScope} onValueChange={(v) => setBatchScope(v as BatchScope)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="current">Current batch</SelectItem>
                    <SelectItem value="all">All batches</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block flex items-center gap-1">
                  AOR scope
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
                <Select value={draftStartMonth} onValueChange={setDraftStartMonth}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent className="max-h-[280px]">
                    {MONTH_OPTIONS.map(opt => (
                      <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">End month</label>
                <Select value={draftEndMonth} onValueChange={setDraftEndMonth}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent className="max-h-[280px]">
                    {MONTH_OPTIONS.map(opt => (
                      <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
                variant={debugOpen ? 'default' : 'outline'}
                size="sm"
                onClick={() => setDebugOpen(v => !v)}
                title="Show paid-dollars audit panel and clickable cell breakdowns"
              >
                <Bug className="h-4 w-4 mr-1" />
                {debugOpen ? 'Debug on' : 'Debug'}
              </Button>
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
            const dueRows = classifiedRows.filter(r => r.months_due > 0);
            const isPending = (r: MemberTimelineRow): boolean =>
              Object.values(r.cells).some(c => c.state === 'pending');
            const counts = {
              all: dueRows.length,
              unpaid: dueRows.filter(r => r.months_unpaid > 0).length,
              partial: dueRows.filter(r => r.months_paid > 0 && r.months_unpaid > 0).length,
              paid: dueRows.filter(r => r.months_paid === r.months_due).length,
              pending: dueRows.filter(r => isPending(r)).length,
              review: dueRows.filter(r => r.needs_manual_review).length,
            };
            return (['all', 'unpaid', 'partial', 'paid', 'pending', 'review'] as const).map(f => {
              const tip =
                f === 'all'
                  ? 'All members with at least one due month in the selected range.'
                  : f === 'unpaid'
                  ? 'Members with at least one due month classified as unpaid — commission expected and not received.'
                  : f === 'partial'
                  ? 'Members paid for some due months but unpaid in others. Excludes pending (not-yet-ripe) months.'
                  : f === 'paid'
                  ? 'Members where every due month in the range has been paid. Excludes members with any pending or manual-review cells.'
                  : f === 'pending'
                  ? 'Members with at least one month that is not yet ripe — the commission statement that would pay for that service month has not been uploaded into this batch.'
                  : 'Members where the classifier could not determine eligibility automatically — signals conflict or are inconclusive. Check the cell tooltips for details.';
              const label =
                f === 'all'
                  ? `All (${counts.all})`
                  : f === 'unpaid'
                  ? `Has unpaid (${counts.unpaid})`
                  : f === 'partial'
                  ? `Partially paid (${counts.partial})`
                  : f === 'paid'
                  ? `Fully paid (${counts.paid})`
                  : f === 'pending'
                  ? `Has pending (${counts.pending})`
                  : `Needs review (${counts.review})`;
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
                        {(() => {
                          const display = row.policy_number || row.issuer_subscriber_id || row.exchange_subscriber_id || '—';
                          // Badge only when the displayed token is the issuer_subscriber_id AND
                          // the resolver has a matching winning value for this row.
                          const isIsidShown = !row.policy_number && !!row.issuer_subscriber_id && display === row.issuer_subscriber_id;
                          if (!isIsidShown || !resolverIndex || resolverIndex.totalRows === 0) return display;
                          const hit = lookupResolved(row as any, resolverIndex);
                          if (!hit || !hit.resolved_issuer_subscriber_id) return display;
                          if (String(hit.resolved_issuer_subscriber_id) !== String(row.issuer_subscriber_id)) return display;
                          return <span>{display}<ResolvedBadge sourceKind={hit.source_kind ?? undefined} batchMonth={hit.source_batch_month} /></span>;
                        })()}
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

                        // Phase 2c — prefer classifier state when present, fall
                        // back to the due/paid_amount shape for legacy callers.
                        let cellCls = 'bg-transparent';
                        let inlineLabel: ReactNode = '';
                        switch (c.state) {
                          case 'paid':
                            cellCls = 'bg-success/15 border border-success/30';
                            inlineLabel = `$${c.paid_amount.toFixed(2)}`;
                            break;
                          case 'unpaid':
                            cellCls = 'bg-destructive/15 border border-destructive/30';
                            inlineLabel = <span className="text-destructive">unpaid</span>;
                            break;
                          case 'pending':
                            cellCls = 'bg-amber-200/30 border border-amber-400/40 dark:bg-amber-500/15';
                            inlineLabel = <span className="text-amber-700 dark:text-amber-500">pending</span>;
                            break;
                          case 'manual_review':
                            cellCls = 'bg-purple-200/30 border border-purple-400/40 dark:bg-purple-500/15';
                            inlineLabel = <span className="text-purple-700 dark:text-purple-400">review</span>;
                            break;
                          case 'not_expected_premium_unpaid':
                          case 'not_expected_pre_eligibility':
                          case 'not_expected_cancelled':
                          case 'not_expected_not_ours':
                            cellCls = 'bg-muted/40 border border-dashed border-border';
                            inlineLabel = hasAny ? <span className="text-muted-foreground/70 text-[9px]">n/a</span> : '';
                            break;
                          default:
                            // No classifier state — use original visual
                            if (c.due && c.paid_amount > 0.0001) {
                              cellCls = 'bg-success/15 border border-success/30';
                              inlineLabel = `$${c.paid_amount.toFixed(2)}`;
                            } else if (c.due) {
                              cellCls = 'bg-destructive/15 border border-destructive/30';
                              inlineLabel = <span className="text-destructive">unpaid</span>;
                            } else if (hasAny) {
                              cellCls = 'bg-muted/40 border border-border';
                            }
                        }

                        const cellInner = (
                          <div
                            className={`rounded-md px-2 py-1.5 ${cellCls} ${
                              debugOpen && audit ? 'cursor-pointer hover:ring-2 hover:ring-primary/40' : 'cursor-default'
                            }`}
                          >
                            <div className="flex justify-center gap-0.5 mb-0.5">
                              {c.in_ede && <Badge variant="secondary" className="h-4 px-1 text-[9px] font-mono">E</Badge>}
                              {c.in_back_office && <Badge variant="secondary" className="h-4 px-1 text-[9px] font-mono">B</Badge>}
                              {c.in_commission && <Badge variant="secondary" className="h-4 px-1 text-[9px] font-mono">C</Badge>}
                              {!hasAny && <span className="text-muted-foreground/50 text-[10px]">—</span>}
                            </div>
                            <div className="text-[10px] font-medium text-foreground leading-tight">
                              {inlineLabel}
                            </div>
                          </div>
                        );

                        return (
                          <td key={m} className="px-1 py-1 text-center align-middle">
                            {debugOpen && audit ? (
                              <CellAttributionPopover
                                audit={audit}
                                member_key={row.member_key}
                                member_name={row.applicant_name}
                                cell={c}
                                month={m}
                              >
                                {cellInner}
                              </CellAttributionPopover>
                            ) : (
                              <Tooltip>
                                <TooltipTrigger asChild>{cellInner}</TooltipTrigger>
                                <TooltipContent side="top" className="text-xs max-w-[280px]">
                                  <div className="font-semibold mb-1">{formatMonthLabel(m)}</div>
                                  {c.state && (
                                    <div className="mb-1 text-[11px]">
                                      <span className="font-medium">State:</span> {c.state.replace(/_/g, ' ')}
                                    </div>
                                  )}
                                  {c.state_reason && (
                                    <div className="mb-1 text-muted-foreground">{c.state_reason}</div>
                                  )}
                                  <div>EDE: {c.in_ede ? 'yes' : 'no'}</div>
                                  <div>Back Office: {c.in_back_office ? 'active' : 'no'}</div>
                                  <div>Commission: {c.in_commission ? `${c.payment_count} payment(s)` : 'no'}</div>
                                  <div>Paid: ${c.paid_amount.toFixed(2)}</div>
                                  <div>Due: {c.due ? 'yes' : 'no'}</div>
                                </TooltipContent>
                              </Tooltip>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex items-center justify-between mt-3 text-sm text-muted-foreground">
              <div className="flex items-center gap-3 flex-wrap">
                <span className="flex items-center gap-1.5">
                  <span className="inline-block w-3 h-3 rounded bg-success/30 border border-success/50" />
                  Paid
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block w-3 h-3 rounded bg-destructive/30 border border-destructive/50" />
                  Unpaid (disputable)
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block w-3 h-3 rounded bg-amber-200/60 border border-amber-400/60 dark:bg-amber-500/30" />
                  Pending (not ripe)
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block w-3 h-3 rounded bg-purple-200/60 border border-purple-400/60 dark:bg-purple-500/30" />
                  Needs review
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block w-3 h-3 rounded bg-muted border border-dashed border-border" />
                  Not expected
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

        {debugOpen && audit && (
          <PaidDollarsAuditPanel
            audit={audit}
            monthList={monthList}
            timelineTotalPaid={unsearchedTotalPaid}
          />
        )}
      </div>
    </TooltipProvider>
  );
}
