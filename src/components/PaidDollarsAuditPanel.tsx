import { useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Download, Search, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { exportToCSV } from '@/lib/csvParser';
import {
  type PaidDollarsAuditResult,
  type PaidAttribution,
  type UnattributedRow,
} from '@/lib/paidDollarsAudit';
import { formatMonthLabel } from '@/lib/memberTimeline';

interface PaidDollarsAuditPanelProps {
  audit: PaidDollarsAuditResult;
  monthList: string[];
  /** Total Paid currently shown on the timeline summary — for the self-check. */
  timelineTotalPaid: number;
}

function fmt(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function PaidDollarsAuditPanel({
  audit,
  monthList,
  timelineTotalPaid,
}: PaidDollarsAuditPanelProps) {
  const [search, setSearch] = useState('');

  const filteredAttributions = useMemo(() => {
    if (!search) return audit.attributions;
    const s = search.toLowerCase();
    return audit.attributions.filter(
      a =>
        a.member_name.toLowerCase().includes(s) ||
        a.policy_id.toLowerCase().includes(s) ||
        a.source_batch_label.toLowerCase().includes(s) ||
        a.source_file_label.toLowerCase().includes(s) ||
        a.pay_entity.toLowerCase().includes(s)
    );
  }, [audit.attributions, search]);

  const filteredUnattributed = useMemo(() => {
    if (!search) return audit.unattributed;
    const s = search.toLowerCase();
    return audit.unattributed.filter(
      u =>
        u.member_name.toLowerCase().includes(s) ||
        u.policy_id.toLowerCase().includes(s) ||
        u.source_batch_label.toLowerCase().includes(s) ||
        u.source_file_label.toLowerCase().includes(s) ||
        u.reason.toLowerCase().includes(s)
    );
  }, [audit.unattributed, search]);

  const grouped = useMemo(() => {
    // Group attributions by service month for display. Each attribution
    // appears once per contributing_month with its per_month amount.
    const byMonth = new Map<string, Array<{ attribution: PaidAttribution; amount: number }>>();
    for (const m of monthList) byMonth.set(m, []);
    for (const a of filteredAttributions) {
      for (const m of a.contributing_months) {
        if (!byMonth.has(m)) continue;
        byMonth.get(m)!.push({ attribution: a, amount: a.per_month });
      }
    }
    // Sort each month's rows by amount desc.
    for (const arr of byMonth.values()) {
      arr.sort((x, y) => y.amount - x.amount);
    }
    return byMonth;
  }, [filteredAttributions, monthList]);

  const checkOk = Math.abs(audit.attributed_total - timelineTotalPaid) < 0.01;
  const reconcileOk =
    Math.abs(
      audit.in_scope_gross_total - (audit.attributed_total + audit.unattributed_total)
    ) < 0.01;

  const exportAttributed = () => {
    const rows: Record<string, unknown>[] = [];
    for (const m of monthList) {
      const arr = grouped.get(m) ?? [];
      for (const { attribution: a, amount } of arr) {
        rows.push({
          service_month: m,
          member: a.member_name,
          policy_id: a.policy_id,
          paid_to_date: a.paid_to_date,
          months_paid: a.months_paid,
          service_span: a.service_span.join(' → '),
          gross: a.gross.toFixed(2),
          per_month_allocation: amount.toFixed(2),
          pay_entity: a.pay_entity,
          source_batch: a.source_batch_label,
          source_file: a.source_file_label,
        });
      }
    }
    exportToCSV(rows, `paid_dollars_audit_${monthList[0]}_${monthList[monthList.length - 1]}.csv`);
  };

  const exportUnattributed = () => {
    const rows = filteredUnattributed.map(u => ({
      member: u.member_name,
      policy_id: u.policy_id,
      paid_to_date: u.paid_to_date_raw ?? '',
      months_paid: u.months_paid_raw ?? '',
      gross: u.gross.toFixed(2),
      pay_entity: u.pay_entity,
      reason: u.reason,
      reason_detail: u.reason_detail,
      source_batch: u.source_batch_label,
      source_file: u.source_file_label,
    }));
    exportToCSV(rows, `unattributed_commissions_${monthList[0]}_${monthList[monthList.length - 1]}.csv`);
  };

  return (
    <Card className="border-amber-400/40 bg-amber-50/30 dark:bg-amber-500/5">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-500" />
              Paid Dollars Audit
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              Read-only inspection of where each commission dollar landed.
              Self-check: Attributed must equal Member Timeline Total Paid.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Filter rows…"
                className="pl-9 h-9 w-[260px]"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0 space-y-6">
        {/* Self-check banner */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
          <div className="rounded-lg border bg-card p-3">
            <div className="text-xs text-muted-foreground">Attributed</div>
            <div className="text-lg font-bold">${fmt(audit.attributed_total)}</div>
            <div className="text-[10px] text-muted-foreground mt-1">
              Sum of per-month allocations landing inside the visible months.
            </div>
          </div>
          <div className="rounded-lg border bg-card p-3">
            <div className="text-xs text-muted-foreground">Member Timeline Total Paid</div>
            <div className="text-lg font-bold">${fmt(timelineTotalPaid)}</div>
            <div
              className={`text-[10px] mt-1 inline-flex items-center gap-1 ${
                checkOk ? 'text-success' : 'text-destructive'
              }`}
            >
              {checkOk ? (
                <>
                  <CheckCircle2 className="h-3 w-3" />
                  Matches
                </>
              ) : (
                <>
                  <AlertTriangle className="h-3 w-3" />
                  Drift: ${fmt(timelineTotalPaid - audit.attributed_total)}
                </>
              )}
            </div>
          </div>
          <div className="rounded-lg border bg-card p-3">
            <div className="text-xs text-muted-foreground">In-scope Gross / Reconciliation</div>
            <div className="text-lg font-bold">${fmt(audit.in_scope_gross_total)}</div>
            <div
              className={`text-[10px] mt-1 inline-flex items-center gap-1 ${
                reconcileOk ? 'text-success' : 'text-destructive'
              }`}
            >
              {reconcileOk ? (
                <>
                  <CheckCircle2 className="h-3 w-3" />
                  Attributed + Unattributed = Gross
                </>
              ) : (
                <>
                  <AlertTriangle className="h-3 w-3" />
                  Off by ${fmt(audit.in_scope_gross_total - audit.attributed_total - audit.unattributed_total)}
                </>
              )}
            </div>
          </div>
        </div>

        {/* Attributions, grouped by month */}
        <section>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold">Attributed contributions ({filteredAttributions.length} rows)</h3>
            <Button variant="outline" size="sm" onClick={exportAttributed}>
              <Download className="h-3.5 w-3.5 mr-1" />
              Export CSV
            </Button>
          </div>
          <div className="overflow-auto rounded-lg border bg-card">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 sticky top-0">
                <tr>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">Member</th>
                  <th className="text-left px-2 py-2 font-medium text-muted-foreground">Policy</th>
                  <th className="text-left px-2 py-2 font-medium text-muted-foreground whitespace-nowrap">Paid-to date</th>
                  <th className="text-center px-2 py-2 font-medium text-muted-foreground">M.Paid</th>
                  <th className="text-left px-2 py-2 font-medium text-muted-foreground whitespace-nowrap">Service span</th>
                  <th className="text-right px-2 py-2 font-medium text-muted-foreground">Gross</th>
                  <th className="text-right px-2 py-2 font-medium text-muted-foreground">Per-month</th>
                  <th className="text-left px-2 py-2 font-medium text-muted-foreground">Pay entity</th>
                  <th className="text-left px-2 py-2 font-medium text-muted-foreground">Source batch</th>
                </tr>
              </thead>
              <tbody>
                {monthList.map(m => {
                  const rows = grouped.get(m) ?? [];
                  const subtotal = rows.reduce((s, r) => s + r.amount, 0);
                  return (
                    <>
                      <tr key={`${m}-hd`} className="bg-muted/20 border-t">
                        <td colSpan={9} className="px-3 py-1.5 font-semibold text-foreground">
                          {formatMonthLabel(m)}
                          <span className="ml-3 text-xs font-normal text-muted-foreground">
                            {rows.length} row{rows.length === 1 ? '' : 's'} · Subtotal{' '}
                            <span className="font-mono text-foreground">${fmt(subtotal)}</span>
                          </span>
                        </td>
                      </tr>
                      {rows.length === 0 && (
                        <tr key={`${m}-empty`} className="border-t">
                          <td colSpan={9} className="px-3 py-1.5 text-muted-foreground italic text-[11px]">
                            No commission rows attributed to this month.
                          </td>
                        </tr>
                      )}
                      {rows.map(({ attribution: a, amount }) => (
                        <tr key={`${m}-${a.record_id}`} className="border-t hover:bg-muted/30">
                          <td className="px-3 py-1.5 truncate max-w-[180px]" title={a.member_name}>
                            {a.member_name || '—'}
                          </td>
                          <td className="px-2 py-1.5 font-mono text-[11px]">{a.policy_id || '—'}</td>
                          <td className="px-2 py-1.5 whitespace-nowrap">{a.paid_to_date || '—'}</td>
                          <td className="px-2 py-1.5 text-center">{a.months_paid}</td>
                          <td className="px-2 py-1.5 whitespace-nowrap text-muted-foreground text-[11px]">
                            {a.service_span[0]} → {a.service_span[a.service_span.length - 1]}
                          </td>
                          <td className="px-2 py-1.5 text-right font-mono">${fmt(a.gross)}</td>
                          <td className="px-2 py-1.5 text-right font-mono font-semibold">${fmt(amount)}</td>
                          <td className="px-2 py-1.5">{a.pay_entity || '—'}</td>
                          <td className="px-2 py-1.5 text-muted-foreground text-[11px] truncate max-w-[200px]" title={`${a.source_batch_label} · ${a.source_file_label}`}>
                            {a.source_batch_label}
                          </td>
                        </tr>
                      ))}
                    </>
                  );
                })}
                <tr className="border-t-2 border-foreground/40 bg-muted/40 font-semibold">
                  <td colSpan={6} className="px-3 py-2 text-right">Grand total</td>
                  <td className="px-2 py-2 text-right font-mono">${fmt(audit.attributed_total)}</td>
                  <td colSpan={2} />
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        {/* Unattributed */}
        <section>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold">
              Unattributed commissions ({filteredUnattributed.length} rows · ${fmt(audit.unattributed_total)})
            </h3>
            <Button variant="outline" size="sm" onClick={exportUnattributed} disabled={filteredUnattributed.length === 0}>
              <Download className="h-3.5 w-3.5 mr-1" />
              Export CSV
            </Button>
          </div>
          {filteredUnattributed.length === 0 ? (
            <div className="rounded-lg border border-dashed p-6 text-center text-muted-foreground text-sm">
              No unattributed commission rows in scope. Every dollar landed in a visible cell.
            </div>
          ) : (
            <div className="overflow-auto rounded-lg border bg-card">
              <table className="w-full text-xs">
                <thead className="bg-muted/40 sticky top-0">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground">Member</th>
                    <th className="text-left px-2 py-2 font-medium text-muted-foreground">Policy</th>
                    <th className="text-left px-2 py-2 font-medium text-muted-foreground">Paid-to (raw)</th>
                    <th className="text-left px-2 py-2 font-medium text-muted-foreground">M.Paid</th>
                    <th className="text-right px-2 py-2 font-medium text-muted-foreground">Gross</th>
                    <th className="text-left px-2 py-2 font-medium text-muted-foreground">Pay entity</th>
                    <th className="text-left px-2 py-2 font-medium text-muted-foreground">Reason</th>
                    <th className="text-left px-2 py-2 font-medium text-muted-foreground">Detail</th>
                    <th className="text-left px-2 py-2 font-medium text-muted-foreground">Source batch</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredUnattributed.map(u => (
                    <tr key={u.record_id} className="border-t hover:bg-muted/30">
                      <td className="px-3 py-1.5 truncate max-w-[180px]" title={u.member_name}>
                        {u.member_name || '—'}
                      </td>
                      <td className="px-2 py-1.5 font-mono text-[11px]">{u.policy_id || '—'}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap text-[11px]">{u.paid_to_date_raw || '—'}</td>
                      <td className="px-2 py-1.5">{String(u.months_paid_raw ?? '—')}</td>
                      <td className="px-2 py-1.5 text-right font-mono">${fmt(u.gross)}</td>
                      <td className="px-2 py-1.5">{u.pay_entity || '—'}</td>
                      <td className="px-2 py-1.5">
                        <Badge variant="outline" className="font-mono text-[10px]">
                          {u.reason}
                        </Badge>
                      </td>
                      <td className="px-2 py-1.5 text-[11px] text-muted-foreground max-w-[280px]">
                        {u.reason_detail}
                      </td>
                      <td className="px-2 py-1.5 text-muted-foreground text-[11px] truncate max-w-[200px]" title={`${u.source_batch_label} · ${u.source_file_label}`}>
                        {u.source_batch_label}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
