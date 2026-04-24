import { Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

interface ResolvedBadgeProps {
  /** e.g. 'ede', 'commission', 'back_office' */
  sourceKind?: string;
  /** 'YYYY-MM' or empty */
  batchMonth?: string;
}

/** Format 'YYYY-MM' as 'Feb 2026'. Falls back to the raw string. */
function formatMonth(ym: string | undefined): string {
  if (!ym) return '';
  const m = ym.match(/^(\d{4})-(\d{2})/);
  if (!m) return ym;
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const idx = parseInt(m[2], 10) - 1;
  if (idx < 0 || idx > 11) return ym;
  return `${monthNames[idx]} ${m[1]}`;
}

/**
 * Small blue info badge shown next to an ID value that was filled in from
 * the cross-batch resolved_identities sidecar. Hover reveals provenance.
 */
export function ResolvedBadge({ sourceKind, batchMonth }: ResolvedBadgeProps) {
  const monthLabel = formatMonth(batchMonth);
  const sourceLabel = sourceKind || 'another batch';
  const tip = `Resolved from ${sourceLabel}${monthLabel ? ' ' + monthLabel : ''} — original file had this blank`;
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex align-middle ml-1 cursor-help text-primary">
            <Info className="h-3 w-3" aria-label="Resolved identity" />
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[280px] text-xs leading-relaxed">
          {tip}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
