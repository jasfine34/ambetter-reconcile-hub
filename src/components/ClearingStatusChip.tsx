/**
 * Bundle 13c — Clearing-state chip used on row screens (UR, MCE preview)
 * and surface chips. Uses only existing Badge variants + className.
 */
import { Badge, type BadgeProps } from '@/components/ui/badge';
import type { ClearingState } from '@/lib/canonical/crossBatchOverlay';

const CHIP_CONFIG: Record<ClearingState, { label: string; variant: BadgeProps['variant']; className?: string }> = {
  fully_cleared: {
    label: 'Cleared (cross-batch)',
    variant: 'outline',
    className: 'border-emerald-300 bg-emerald-50 text-emerald-700',
  },
  partially_cleared: { label: 'Partially cleared', variant: 'secondary' },
  cleared_then_reversed: { label: 'Cleared then reversed', variant: 'destructive' },
  zero_expected_no_payment_required: {
    label: 'No commission owed',
    variant: 'outline',
    className: 'border-slate-300 bg-slate-50 text-slate-700',
  },
  manual_review_required: {
    label: 'Needs review',
    variant: 'outline',
    className: 'border-amber-300 bg-amber-50 text-amber-700',
  },
  not_cleared: { label: 'Not cleared', variant: 'outline' },
};

export function ClearingStatusChip({ state }: { state: ClearingState }) {
  const cfg = CHIP_CONFIG[state];
  if (!cfg) return null;
  return (
    <Badge variant={cfg.variant} className={cfg.className} data-testid={`clearing-chip-${state}`}>
      {cfg.label}
    </Badge>
  );
}
