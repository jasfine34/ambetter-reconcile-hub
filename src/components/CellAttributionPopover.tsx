import type { ReactNode } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Badge } from '@/components/ui/badge';
import {
  type PaidDollarsAuditResult,
  type PaidAttribution,
  type UnattributedRow,
  getCellContributions,
  getCellNearMissExplanation,
} from '@/lib/paidDollarsAudit';
import { formatMonthLabel, type MonthCell } from '@/lib/memberTimeline';

interface CellAttributionPopoverProps {
  audit: PaidDollarsAuditResult;
  member_key: string;
  member_name: string;
  cell: MonthCell;
  month: string;
  children: ReactNode;
}

function fmt(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function CellAttributionPopover({
  audit,
  member_key,
  member_name,
  cell,
  month,
  children,
}: CellAttributionPopoverProps) {
  const contributions = getCellContributions(audit, member_key, month);
  const total = contributions.reduce((s, c) => s + c.amount, 0);
  const nearMiss = contributions.length === 0 ? getCellNearMissExplanation(audit, member_key, month) : null;

  return (
    <Popover>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-[440px] p-0" align="center" side="top">
        <div className="px-4 py-3 border-b">
          <div className="text-sm font-semibold">{member_name || member_key}</div>
          <div className="text-xs text-muted-foreground">{formatMonthLabel(month)}</div>
          {cell.state && (
            <div className="text-[10px] mt-1">
              <Badge variant="outline" className="font-mono">{cell.state.replace(/_/g, ' ')}</Badge>
            </div>
          )}
          {cell.state_reason && (
            <div className="text-[11px] text-muted-foreground mt-1 italic">{cell.state_reason}</div>
          )}
        </div>

        <div className="px-4 py-3 space-y-3 max-h-[420px] overflow-auto">
          {/* Cell summary */}
          <div className="grid grid-cols-2 gap-2 text-[11px]">
            <div className="rounded bg-muted/40 px-2 py-1">
              <div className="text-muted-foreground">Sources</div>
              <div className="font-medium">
                {[
                  cell.in_ede && 'EDE',
                  cell.in_back_office && 'Back Office',
                  cell.in_commission && 'Commission',
                ].filter(Boolean).join(', ') || '—'}
              </div>
            </div>
            <div className="rounded bg-muted/40 px-2 py-1">
              <div className="text-muted-foreground">Cell paid amount</div>
              <div className="font-mono font-medium">${fmt(cell.paid_amount)}</div>
            </div>
          </div>

          {/* Contributions */}
          {contributions.length > 0 ? (
            <div>
              <div className="text-xs font-semibold mb-1.5">
                Commission contributions ({contributions.length})
              </div>
              <div className="space-y-2">
                {contributions.map(({ attribution: a, amount }) => (
                  <ContributionCard key={a.record_id} a={a} amount={amount} />
                ))}
              </div>
              {Math.abs(total - cell.paid_amount) > 0.01 && (
                <div className="mt-2 text-[10px] text-destructive">
                  ⚠ Audit total ${fmt(total)} disagrees with cell paid_amount ${fmt(cell.paid_amount)}
                </div>
              )}
            </div>
          ) : (
            <ZeroCellExplanation cell={cell} nearMiss={nearMiss} month={month} />
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ContributionCard({ a, amount }: { a: PaidAttribution; amount: number }) {
  return (
    <div className="rounded-md border bg-card px-2.5 py-2 text-[11px] space-y-1">
      <div className="flex items-center justify-between">
        <span className="font-mono font-semibold">${fmt(amount)}</span>
        <span className="text-muted-foreground">of ${fmt(a.gross)} gross / {a.months_paid} mo</span>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px]">
        <div><span className="text-muted-foreground">Policy:</span> <span className="font-mono">{a.policy_id || '—'}</span></div>
        <div><span className="text-muted-foreground">Paid-to:</span> <span className="font-mono">{a.paid_to_date || '—'}</span></div>
        <div className="col-span-2">
          <span className="text-muted-foreground">Service span:</span>{' '}
          <span className="font-mono">{a.service_span[0]} → {a.service_span[a.service_span.length - 1]}</span>
        </div>
        <div><span className="text-muted-foreground">Pay entity:</span> {a.pay_entity || '—'}</div>
        <div className="truncate" title={a.source_batch_label}>
          <span className="text-muted-foreground">Batch:</span> {a.source_batch_label}
        </div>
        <div className="col-span-2 truncate text-muted-foreground" title={a.source_file_label}>
          File: {a.source_file_label}
        </div>
      </div>
    </div>
  );
}

function ZeroCellExplanation({
  cell,
  nearMiss,
  month,
}: {
  cell: MonthCell;
  nearMiss: { excluded: UnattributedRow[]; attributed_elsewhere: PaidAttribution[] } | null;
  month: string;
}) {
  return (
    <div className="space-y-2 text-[11px]">
      <div className="font-semibold">Why this cell shows ${fmt(cell.paid_amount)}</div>
      {!cell.in_commission && (
        <div className="text-muted-foreground">
          No commission row in scope landed a service month on {formatMonthLabel(month)} for this member.
        </div>
      )}
      {nearMiss && nearMiss.attributed_elsewhere.length > 0 && (
        <div>
          <div className="text-muted-foreground mb-1">
            This member has commission rows that landed in OTHER months in the visible range:
          </div>
          <div className="space-y-1">
            {nearMiss.attributed_elsewhere.slice(0, 5).map(a => (
              <div key={a.record_id} className="rounded bg-muted/40 px-2 py-1">
                <span className="font-mono">${fmt(a.gross)}</span>{' '}
                <span className="text-muted-foreground">paid-to {a.paid_to_date} → </span>
                <span className="font-mono">{a.contributing_months.join(', ')}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {nearMiss && nearMiss.excluded.length > 0 && (
        <div>
          <div className="text-muted-foreground mb-1">
            Excluded commission rows for this member:
          </div>
          <div className="space-y-1">
            {nearMiss.excluded.slice(0, 5).map(u => (
              <div key={u.record_id} className="rounded bg-muted/40 px-2 py-1">
                <span className="font-mono">${fmt(u.gross)}</span>{' '}
                <Badge variant="outline" className="font-mono text-[9px] ml-1">{u.reason}</Badge>
                <div className="text-muted-foreground text-[10px]">{u.reason_detail}</div>
              </div>
            ))}
          </div>
        </div>
      )}
      {nearMiss &&
        nearMiss.attributed_elsewhere.length === 0 &&
        nearMiss.excluded.length === 0 && (
          <div className="text-muted-foreground">
            No commission rows for this member exist in scope at all.
          </div>
        )}
    </div>
  );
}
