/**
 * Source Funnel — §4.5 of ARCHITECTURE_PLAN.md
 *
 * Visualizes the EDE → Back Office → Commission pipeline per service month,
 * and surfaces BO-only members (state-exchange-written, auto-renewal) as a
 * separate lane. The two gaps that matter operationally are:
 *
 *   1. EDE → BO gap (carrier failed to attribute) — feeds the BO Attribution
 *      Reconciliation workflow (§5b) in Phase 3.
 *   2. BO → Commission gap (carrier attributed but didn't pay) — feeds the
 *      Commission Dispute workflow in Phase 3.
 *
 * Today this card is observational: it tells the user where leakage is,
 * without launching a dispute. Phase 3 wires the workflows.
 */
import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ArrowRight, Info, TrendingDown } from 'lucide-react';
import { assignMergedMemberKeys } from '@/lib/memberMerge';
import { computeFunnelForMonth, type FunnelCounts } from '@/lib/classifier';

interface SourceFunnelCardProps {
  /** All normalized records for the selected batch (current, non-superseded). */
  normalizedRecords: any[];
  /** Months to compute funnels for — usually batch's covered months (prior + statement). */
  coveredMonths: string[];
  /**
   * Canonical carrier key ('ambetter'), or '' to include all carriers.
   * Defaults to 'ambetter' since the dashboard's Expected Enrollments metric
   * is carrier-specific and we want the funnel to align.
   */
  carrierKey?: string;
}

function formatMonth(ym: string): string {
  if (!ym) return '';
  const [y, m] = ym.split('-');
  if (!y || !m) return ym;
  const d = new Date(parseInt(y), parseInt(m) - 1, 1);
  return d.toLocaleString('en-US', { month: 'short', year: 'numeric' });
}

export function SourceFunnelCard({ normalizedRecords, coveredMonths, carrierKey = 'ambetter' }: SourceFunnelCardProps) {
  // Group records by merged member_key so classifier sees each person once.
  const recordsByMember = useMemo(() => {
    if (normalizedRecords.length === 0) return new Map<string, any[]>();
    // Shallow clone so assignMergedMemberKeys can mutate member_key safely
    const records = normalizedRecords.map(r => ({ ...r })) as any[];
    assignMergedMemberKeys(records);
    const map = new Map<string, any[]>();
    for (const r of records) {
      const key = r.member_key || 'unknown';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(r);
    }
    return map;
  }, [normalizedRecords]);

  const funnelsByMonth = useMemo(() => {
    return coveredMonths.map(m => ({
      month: m,
      funnel: computeFunnelForMonth(recordsByMember, m, carrierKey),
    }));
  }, [recordsByMember, coveredMonths, carrierKey]);

  if (coveredMonths.length === 0) return null;

  return (
    <TooltipProvider delayDuration={150}>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingDown className="h-4 w-4" />
            Source Funnel
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-help inline-flex">
                  <Info className="h-3 w-3 opacity-60" />
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-[320px] text-xs leading-relaxed">
                Tracks the EDE → Back Office → Commission pipeline per service month.
                Gaps between stages are the operational signal: EDE→BO gaps become BO
                attribution alerts; BO→Commission gaps become dispute candidates.
              </TooltipContent>
            </Tooltip>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {funnelsByMonth.map(({ month, funnel }) => (
            <FunnelRow key={month} month={month} funnel={funnel} />
          ))}
        </CardContent>
      </Card>
    </TooltipProvider>
  );
}

function FunnelRow({ month, funnel }: { month: string; funnel: FunnelCounts }) {
  const edeToBoGap = funnel.edeOnly;
  const boToCommGap = funnel.edeAndBo - funnel.edeAndBoAndCommission;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-foreground">{formatMonth(month)}</h4>
        <span className="text-xs text-muted-foreground">
          EDE eligible: <strong className="text-foreground">{funnel.edeEligible}</strong>
        </span>
      </div>

      {/* EDE-driven lane */}
      <div className="flex items-stretch gap-1 flex-wrap">
        <FunnelStage
          label="EDE eligible"
          value={funnel.edeEligible}
          tooltip="Members in expected EDE universe for this month: our AOR, qualifying status, effective date on or before month-start."
        />
        <ArrowRight className="h-4 w-4 text-muted-foreground self-center" />
        <FunnelStage
          label="BO attributed"
          value={funnel.edeAndBo}
          variant="info"
          tooltip="Of the EDE-eligible members above, how many the carrier has correctly attributed to us in the back office for this month."
        />
        <ArrowRight className="h-4 w-4 text-muted-foreground self-center" />
        <FunnelStage
          label="Commission paid"
          value={funnel.edeAndBoAndCommission}
          variant="success"
          tooltip="Of the BO-attributed members, how many had commission paid for this service month."
        />
      </div>

      {/* Gap callouts */}
      {(edeToBoGap > 0 || boToCommGap > 0) && (
        <div className="flex flex-wrap gap-3 text-xs">
          {edeToBoGap > 0 && (
            <GapBadge
              value={edeToBoGap}
              label="EDE → BO gap"
              tooltip={`${edeToBoGap} members are in our EDE universe for this month but the carrier hasn't attributed them in the back office. These become BO attribution alerts once the workflow is wired up.`}
            />
          )}
          {boToCommGap > 0 && (
            <GapBadge
              value={boToCommGap}
              label="BO → Commission gap"
              tooltip={`${boToCommGap} members are attributed in the back office but no commission landed for this month. These become dispute candidates.`}
            />
          )}
        </div>
      )}

      {/* BO-only parallel lane (auto-renewals, state-exchange-written) */}
      {funnel.boOnly > 0 && (
        <div className="flex items-stretch gap-1 flex-wrap border-t pt-2">
          <FunnelStage
            label="BO-only (no EDE)"
            value={funnel.boOnly}
            variant="muted"
            tooltip="Members in the back office with our AOR but not in EDE — typically auto-renewals or policies written through the state exchange."
          />
          <ArrowRight className="h-4 w-4 text-muted-foreground self-center" />
          <FunnelStage
            label="Commission paid"
            value={funnel.boOnlyPaid}
            variant="success"
            tooltip="Of the BO-only members, how many had commission paid for this month."
          />
        </div>
      )}
    </div>
  );
}

function FunnelStage({
  label,
  value,
  tooltip,
  variant = 'default',
}: {
  label: string;
  value: number;
  tooltip: string;
  variant?: 'default' | 'info' | 'success' | 'muted';
}) {
  const styles: Record<string, string> = {
    default: 'bg-card border-border text-foreground',
    info: 'bg-info/10 border-info/30 text-info-foreground',
    success: 'bg-success/10 border-success/30 text-success-foreground',
    muted: 'bg-muted border-border text-muted-foreground',
  };
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className={`flex-1 min-w-[120px] border rounded-md px-3 py-2 ${styles[variant]}`}>
          <div className="text-xs font-medium opacity-80">{label}</div>
          <div className="text-lg font-semibold">{value.toLocaleString()}</div>
        </div>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[280px] text-xs leading-relaxed">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}

function GapBadge({ value, label, tooltip }: { value: number; label: string; tooltip: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-help inline-flex items-center gap-1 bg-destructive/10 text-destructive border border-destructive/30 rounded-full px-2 py-0.5 font-medium">
          {label}: <strong>{value}</strong>
          <Info className="h-3 w-3 opacity-70" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[320px] text-xs leading-relaxed">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}
