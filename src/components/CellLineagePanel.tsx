/**
 * Source-to-Screen Lineage — Stage 2 debug panel UI.
 *
 * Right-side Sheet that renders a merge of the clicked MonthCell display
 * state + the explainCell trace. UI-only: does not modify the classifier
 * or any business rule. Independent of the existing Debug toggle and the
 * paid-dollars audit popover.
 *
 * Close mechanisms: X button, Escape, click-outside (all native to Sheet),
 * and route-change (handled by the host hook via onOpenChange).
 */
import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import type { CellTrace, HelperCheckpoint } from '@/lib/explainCellTypes';
import type { MonthCell } from '@/lib/memberTimeline';
import { formatMonthLabel } from '@/lib/memberTimeline';
import { explainCell, type ExplainScope } from '@/lib/explainCell';
import type { NormalizedRecord } from '@/lib/normalize';
import type { ClassifierContext } from '@/lib/classifier';

// ────────────────────────────────────────────────────────────────────────
// Public hook — wires cell-click to explainCell + panel state.
// ────────────────────────────────────────────────────────────────────────

export type OpenLineageArgs = {
  memberKey: string;
  monthKey: string;
  scope: ExplainScope;
  monthCell: MonthCell;
};

export type CellLineageDeps = {
  filteredRecords: NormalizedRecord[];
  baseClassifierContext: ClassifierContext;
  pickerMapsByMemberKey: Map<string, Map<string, NormalizedRecord | null>>;
  /**
   * Test seam — defaults to the real explainCell. Tests inject a mock to
   * inspect the binding contract (member-scoped records + per-member ctx).
   */
  explainCellFn?: typeof explainCell;
};

export function useCellLineagePanel(deps: CellLineageDeps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trace, setTrace] = useState<CellTrace | null>(null);
  const [monthCell, setMonthCell] = useState<MonthCell | null>(null);
  const location = useLocation();

  // Close on route change.
  useEffect(() => {
    setOpen(false);
    setTrace(null);
    setMonthCell(null);
  }, [location.pathname]);

  const openPanel = async (args: OpenLineageArgs) => {
    setOpen(true);
    setLoading(true);
    setError(null);
    setMonthCell(args.monthCell);
    setTrace(null);
    try {
      const memberRecords = deps.filteredRecords.filter(
        (r: any) => (r.member_key || r.applicant_name || 'unknown') === args.memberKey,
      );
      const perMemberContext: ClassifierContext = {
        ...deps.baseClassifierContext,
        pickerEdeByMonth: deps.pickerMapsByMemberKey.get(args.memberKey),
      } as ClassifierContext;
      const fn = deps.explainCellFn ?? explainCell;
      const t = await fn({
        memberKey: args.memberKey,
        monthKey: args.monthKey,
        scope: args.scope,
        preloadedRecords: memberRecords,
        preloadedContext: perMemberContext,
      });
      setTrace(t);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  };

  return {
    openPanel,
    panelProps: {
      open,
      onOpenChange: setOpen,
      trace,
      monthCell,
      loading,
      error,
    },
  };
}

// ────────────────────────────────────────────────────────────────────────
// Panel component.
// ────────────────────────────────────────────────────────────────────────

export type CellLineagePanelProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trace: CellTrace | null;
  monthCell: MonthCell | null;
  loading: boolean;
  error: string | null;
};

export function CellLineagePanel({
  open, onOpenChange, trace, monthCell, loading, error,
}: CellLineagePanelProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-[540px] overflow-y-auto"
        data-testid="cell-lineage-panel"
      >
        <SheetHeader className="sr-only">
          <SheetTitle>Cell Lineage</SheetTitle>
          <SheetDescription>Source-to-screen trace for the clicked cell</SheetDescription>
        </SheetHeader>
        {loading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Computing lineage…
          </div>
        )}
        {error && (
          <div className="text-sm text-destructive">Error: {error}</div>
        )}
        {!loading && !error && trace && monthCell && (
          <PanelBody trace={trace} monthCell={monthCell} />
        )}
      </SheetContent>
    </Sheet>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Body — sections.
// ────────────────────────────────────────────────────────────────────────

function PanelBody({ trace, monthCell }: { trace: CellTrace; monthCell: MonthCell }) {
  const displayOverride =
    !!trace.final.state && trace.final.state !== monthCell.state;

  return (
    <div className="space-y-5 pt-2">
      {/* Identity header */}
      <div className="border-b pb-3">
        <div className="text-sm font-semibold">
          {trace.member.name || trace.member.memberKey}
        </div>
        <div className="text-xs text-muted-foreground font-mono">
          {trace.member.policyNumber || trace.member.memberKey}
        </div>
        <div className="text-xs text-muted-foreground mt-1">
          {formatMonthLabel(trace.cell.month)} · scope: <span className="font-mono">{trace.cell.scope}</span>
        </div>
      </div>

      {/* Section 1 — Final state + chips/badges (always expanded; from MonthCell) */}
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
          Displayed state
        </h3>
        <div className="space-y-2">
          <Badge variant="outline" className="font-mono text-[11px]">
            {(monthCell.state ?? 'n/a').replace(/_/g, ' ')}
          </Badge>
          {monthCell.state_reason && (
            <div className="text-[11px] text-muted-foreground italic">
              {monthCell.state_reason}
            </div>
          )}
          <div className="flex flex-wrap gap-1">
            {monthCell.in_ede && <Badge variant="secondary" className="text-[9px] font-mono">E</Badge>}
            {monthCell.in_back_office && <Badge variant="secondary" className="text-[9px] font-mono">B</Badge>}
            {monthCell.in_commission && <Badge variant="secondary" className="text-[9px] font-mono">C</Badge>}
            {monthCell.carrier_recognition && (
              <Badge variant="outline" className="text-[9px] font-mono border-amber-500/60 text-amber-700 dark:text-amber-500">
                CR
              </Badge>
            )}
            {monthCell.netBucket && (
              <Badge variant="outline" className="text-[9px] font-mono">{monthCell.netBucket}</Badge>
            )}
          </div>
          <div className="text-[11px]">
            Paid: <span className="font-mono">${monthCell.paid_amount.toFixed(2)}</span>
          </div>
          {monthCell.reversal_evidence && (
            <div className="rounded border bg-muted/30 p-2 text-[11px] space-y-0.5">
              <div className="font-semibold">Reversal evidence</div>
              <div>
                Amount: <span className="font-mono">${monthCell.reversal_evidence.amount.toFixed(2)}</span>
              </div>
              <div>+TXN: <span className="font-mono">{monthCell.reversal_evidence.positiveTransactionId ?? '—'}</span></div>
              <div>−TXN: <span className="font-mono">{monthCell.reversal_evidence.negativeTransactionId ?? '—'}</span></div>
              <div>Paid-to: <span className="font-mono">{monthCell.reversal_evidence.paidToDate}</span></div>
            </div>
          )}
          {displayOverride && (
            <div
              data-testid="display-override-note"
              className="text-[11px] rounded border border-amber-500/40 bg-amber-500/10 p-2"
            >
              <strong>Display override:</strong> classifier emitted{' '}
              <span className="font-mono">{trace.final.state}</span> but display layer applied{' '}
              <span className="font-mono">applyNoSourceInvariantToMonthCell</span> →{' '}
              <span className="font-mono">{monthCell.state}</span>.
            </div>
          )}
        </div>
      </section>

      {/* Section 2 — Classifier output (pre-display) */}
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
          Classifier output (pre-display)
        </h3>
        {trace.firingRule ? (
          <div className="rounded border bg-card p-2 text-[11px] space-y-1">
            <div>
              <span className="text-muted-foreground">State:</span>{' '}
              <span className="font-mono">{trace.final.state}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Firing rule:</span>{' '}
              <span className="font-mono">{trace.firingRule.name}</span>
            </div>
            <div className="text-muted-foreground italic">{trace.firingRule.reason}</div>
          </div>
        ) : (
          <div className="text-[11px] text-muted-foreground italic">
            no firing rule recorded
          </div>
        )}
      </section>

      {/* Section 3 — Helper outputs (always expanded; from trace) */}
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
          Helper outputs ({trace.helpers.length})
        </h3>
        {trace.helpers.length === 0 ? (
          <div className="text-[11px] text-muted-foreground italic">none recorded</div>
        ) : (
          <div className="space-y-1.5">
            {trace.helpers.map((h, i) => (
              <HelperRow key={`${h.name}-${i}`} helper={h} />
            ))}
          </div>
        )}
      </section>

      {/* Section 4 — Scoped normalized rows (collapsed) */}
      <Collapsible title={`Scoped normalized rows (${trace.scopedRows.length})`}>
        <ScopedRows rows={trace.scopedRows} />
        <div className="text-[10px] text-muted-foreground mt-3 italic">
          Showing the raw_json subset available in this view. Full raw CSV row is
          not loaded; deferred for a future audit-fetch directive.
        </div>
      </Collapsible>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

function Collapsible({
  title, defaultOpen = false, children,
}: { title: string; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-t pt-3">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2 -ml-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
        onClick={() => setOpen(v => !v)}
      >
        {open ? <ChevronDown className="h-3.5 w-3.5 mr-1" /> : <ChevronRight className="h-3.5 w-3.5 mr-1" />}
        {title}
      </Button>
      {open && <div className="mt-2">{children}</div>}
    </section>
  );
}

function HelperRow({ helper }: { helper: HelperCheckpoint }) {
  const [open, setOpen] = useState(false);
  const summary = summarize(helper.output);
  return (
    <div className="rounded border bg-card text-[11px]">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between gap-2 px-2 py-1 text-left hover:bg-accent/50"
      >
        <span className="font-mono">{helper.name}</span>
        <span className="text-muted-foreground truncate max-w-[260px]">{summary}</span>
      </button>
      {open && (
        <div className="px-2 pb-2 space-y-1">
          {helper.notes && <div className="text-muted-foreground italic">{helper.notes}</div>}
          <pre className="bg-muted/40 p-2 rounded text-[10px] overflow-x-auto">
{safeJson(helper.output)}
          </pre>
        </div>
      )}
    </div>
  );
}

function ScopedRows({ rows }: { rows: NormalizedRecord[] }) {
  const grouped = useMemo(() => {
    const m = new Map<string, NormalizedRecord[]>();
    for (const r of rows) {
      const k = String((r as any).source_type ?? 'OTHER');
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(r);
    }
    return m;
  }, [rows]);

  return (
    <div className="space-y-3">
      {Array.from(grouped.entries()).map(([type, rs]) => (
        <div key={type}>
          <div className="text-[10px] font-semibold uppercase text-muted-foreground mb-1">
            {type} ({rs.length})
          </div>
          <div className="space-y-1">
            {rs.map((r, i) => (
              <RowCard key={(r as any).id ?? `${type}-${i}`} row={r} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function RowCard({ row }: { row: NormalizedRecord }) {
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const r = row as any;
  const header = `${r.policy_number ?? ''} · ${r.batch_id ?? ''} · ${r.applicant_name ?? ''}`;
  return (
    <div className="rounded border bg-card text-[11px]">
      <button
        type="button"
        onClick={() => setStep(s => (s === 0 ? 1 : s === 1 ? 2 : 0) as 0 | 1 | 2)}
        className="w-full px-2 py-1 text-left hover:bg-accent/50 font-mono truncate"
      >
        {header || r.id}
      </button>
      {step >= 1 && <CuratedFields row={row} />}
      {step >= 2 && <RawSubset row={row} />}
    </div>
  );
}

const CURATED: Record<string, string[]> = {
  BACK_OFFICE: [
    'effective_date', 'broker_effective_date', 'policy_term_date', 'broker_term_date',
    'paid_through_date', 'eligible_for_commission', 'agent_npn', 'member_responsibility',
    'premium', 'net_premium', 'status',
  ],
  EDE: ['effective_date', 'net_premium', 'agent_npn'],
  COMMISSION: ['pay_entity', 'commission_amount', 'paid_to_date', 'months_paid', 'agent_npn'],
};

const EDE_RAW_SUBKEYS = ['current_policy_aor', 'policy_status', 'issuer'];

function CuratedFields({ row }: { row: NormalizedRecord }) {
  const r = row as any;
  const fields = CURATED[String(r.source_type)] ?? [];
  return (
    <div className="px-2 pb-2 space-y-0.5">
      <div className="text-[10px] text-muted-foreground">file: {r.source_file_label ?? '—'}</div>
      {fields.map(f => (
        <div key={f} className="flex justify-between gap-2">
          <span className="text-muted-foreground">{f}</span>
          <span className="font-mono truncate max-w-[260px] text-right">
            {fmtVal(r[f])}
          </span>
        </div>
      ))}
      {r.source_type === 'EDE' && EDE_RAW_SUBKEYS.map(k => (
        <div key={k} className="flex justify-between gap-2">
          <span className="text-muted-foreground">raw.{k}</span>
          <span className="font-mono truncate max-w-[260px] text-right">
            {fmtVal((r.raw_json ?? {})[k] ?? (r.raw_json ?? {})[toCamel(k)])}
          </span>
        </div>
      ))}
    </div>
  );
}

const RAW_SUBSET_KEYS = [
  'ffmAppId', 'currentPolicyAOR', 'policyStatus', 'issuer', 'lastEDESync',
  'Months Paid', 'Broker Name', 'broker_name', 'Transaction ID',
];

function RawSubset({ row }: { row: NormalizedRecord }) {
  const raw = ((row as any).raw_json ?? {}) as Record<string, unknown>;
  const subset: Record<string, unknown> = {};
  for (const k of RAW_SUBSET_KEYS) {
    if (k in raw) subset[k] = raw[k];
  }
  return (
    <div className="px-2 pb-2">
      <pre className="bg-muted/40 p-2 rounded text-[10px] overflow-x-auto">
{safeJson(subset)}
      </pre>
    </div>
  );
}

function toCamel(snake: string): string {
  return snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function fmtVal(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function summarize(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') return String(v);
  if (typeof v === 'object') {
    const o = v as any;
    if ('matched' in o) return o.matched ? 'matched' : 'no match';
    const keys = Object.keys(o);
    return `{${keys.slice(0, 3).join(', ')}${keys.length > 3 ? '…' : ''}}`;
  }
  return '';
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}
