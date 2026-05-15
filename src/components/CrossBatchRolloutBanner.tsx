/**
 * Bundle 13c — One-time rollout banner. Uses localStorage flag
 * `cross_batch_clearings_rollout_seen`. Dismiss persists forever.
 *
 * Bundle 13c continuation (C4): adds a "Show details" / "Hide details"
 * disclosure with four bullets explaining the rollout.
 */
import { useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Info, X } from 'lucide-react';

const STORAGE_KEY = 'cross_batch_clearings_rollout_seen';

export function CrossBatchRolloutBanner() {
  const [visible, setVisible] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    try {
      if (typeof window !== 'undefined' && !window.localStorage.getItem(STORAGE_KEY)) {
        setVisible(true);
      }
    } catch { /* ignore */ }
  }, []);

  if (!visible) return null;

  const dismiss = () => {
    try { window.localStorage.setItem(STORAGE_KEY, '1'); } catch { /* ignore */ }
    setVisible(false);
  };

  return (
    <Card className="border-primary/40 bg-primary/5" data-testid="cross-batch-rollout-banner">
      <CardContent className="px-4 py-3">
        <div className="flex items-start gap-3 text-sm">
          <Info className="h-4 w-4 mt-0.5 shrink-0 text-primary" />
          <div className="flex-1 space-y-2">
            <div className="font-medium text-foreground">
              Update: Unpaid counts now reflect cross-batch payment clearings.
            </div>
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="text-xs text-primary hover:underline"
              data-testid="cross-batch-rollout-disclosure"
            >
              {expanded ? 'Hide details' : 'Show details'}
            </button>
            {expanded && (
              <ul
                className="list-disc pl-5 space-y-1 text-xs text-muted-foreground"
                data-testid="cross-batch-rollout-details"
              >
                <li>Payments that appear in later commission statements now reduce unpaid counts and dollars.</li>
                <li>After rebuilding any batch, click <strong>Rebuild Cross-Batch Clearings</strong> in the Dashboard header to refresh.</li>
                <li>A yellow banner appears when the sweep is older than your most recent rebuild — numbers may be stale.</li>
                <li>The new <strong>Cleared then reversed</strong> tile tracks payments that came in and were later clawed back.</li>
              </ul>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={dismiss} data-testid="cross-batch-rollout-dismiss">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
