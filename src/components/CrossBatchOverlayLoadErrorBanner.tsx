/**
 * Bundle 13c — Overlay-load error banner. Surfaced when
 * `useCrossBatchOverlay()` returns a non-null `error`. Surfaces fall back
 * to legacy batch-only behavior; this banner explains why.
 */
import { Card, CardContent } from '@/components/ui/card';
import { AlertTriangle } from 'lucide-react';

export const OVERLAY_LOAD_ERROR_MESSAGE =
  "Cross-batch payment clearings couldn't be loaded — showing batch-only unpaid figures. Try refreshing or contact support if this persists.";

export function CrossBatchOverlayLoadErrorBanner() {
  return (
    <Card className="border-amber-400/50 bg-amber-50/50" data-testid="cross-batch-overlay-load-error">
      <CardContent className="px-4 py-3">
        <div className="flex items-start gap-3 text-sm">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-amber-600" />
          <div className="flex-1 text-foreground">{OVERLAY_LOAD_ERROR_MESSAGE}</div>
        </div>
      </CardContent>
    </Card>
  );
}
