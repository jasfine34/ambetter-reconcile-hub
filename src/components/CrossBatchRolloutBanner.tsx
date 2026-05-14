/**
 * Bundle 13c — One-time rollout banner. Uses localStorage flag
 * `cross_batch_clearings_rollout_seen`. Dismiss persists forever.
 */
import { useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Info, X } from 'lucide-react';

const STORAGE_KEY = 'cross_batch_clearings_rollout_seen';

export function CrossBatchRolloutBanner() {
  const [visible, setVisible] = useState(false);

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
          <div className="flex-1">
            <div className="font-medium text-foreground">Update: Unpaid counts now reflect cross-batch payment clearings.</div>
            <div className="text-muted-foreground text-xs mt-1">
              Some policies are no longer shown as unpaid because the carrier paid them in a later batch.
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={dismiss} data-testid="cross-batch-rollout-dismiss">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
