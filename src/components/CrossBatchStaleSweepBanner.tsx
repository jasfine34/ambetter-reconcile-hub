/**
 * Bundle 13c — Passive stale-sweep banner.
 *
 * Self-contained. Loads upload_batches.last_full_rebuild_at internally.
 *
 * Show rules:
 *  - overlay null AND maxRebuild non-null → "never run" banner.
 *  - overlay non-null AND maxRebuild non-null AND maxRebuild > overlay → stale.
 *  - both null → hide.
 *  - else → hide.
 *
 * Session-only dismiss (sessionStorage).
 */
import { useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { AlertTriangle, X } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useCrossBatchOverlay } from '@/hooks/useCrossBatchOverlay';

const SESSION_KEY = 'cross_batch_stale_sweep_dismissed';
const REBUILD_EVENT = 'crossBatchClearings:rebuilt';

function relativeTime(iso: string): string {
  try {
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return iso;
    const diff = Date.now() - then;
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
    const d = Math.floor(h / 24);
    return `${d} day${d === 1 ? '' : 's'} ago`;
  } catch {
    return iso;
  }
}

export function CrossBatchStaleSweepBanner() {
  const { overlay } = useCrossBatchOverlay();
  const [maxRebuild, setMaxRebuild] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    try {
      if (typeof window !== 'undefined' && window.sessionStorage.getItem(SESSION_KEY)) {
        setDismissed(true);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const { data, error } = await (supabase as any)
          .from('upload_batches')
          .select('last_full_rebuild_at');
        if (error) return;
        if (cancelled) return;
        let max: string | null = null;
        for (const r of data ?? []) {
          const v = r?.last_full_rebuild_at;
          if (!v) continue;
          if (!max || v > max) max = v;
        }
        setMaxRebuild(max);
      } catch { /* ignore */ }
    };
    void load();
    const handler = () => { void load(); };
    window.addEventListener(REBUILD_EVENT, handler);
    return () => {
      cancelled = true;
      window.removeEventListener(REBUILD_EVENT, handler);
    };
  }, []);

  if (dismissed) return null;
  const lastEvaluatedAt = overlay.lastEvaluatedAt;

  // No rebuild timestamp means there is nothing to compare against.
  if (!maxRebuild) return null;

  // Sweep fresh enough → hide.
  if (lastEvaluatedAt && maxRebuild <= lastEvaluatedAt) return null;

  // Reaching here means maxRebuild is non-null AND (lastEvaluatedAt is null OR maxRebuild > lastEvaluatedAt).
  const isNeverRun = !lastEvaluatedAt;

  const dismiss = () => {
    try { window.sessionStorage.setItem(SESSION_KEY, '1'); } catch { /* ignore */ }
    setDismissed(true);
  };

  return (
    <Card className="border-amber-400/50 bg-amber-50/50" data-testid="cross-batch-stale-banner">
      <CardContent className="px-4 py-3">
        <div className="flex items-start gap-3 text-sm">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-amber-600" />
          <div className="flex-1">
            {isNeverRun ? (
              <div className="font-medium text-foreground">
                Cross-batch clearings have not been run yet. Click Rebuild Cross-Batch Clearings to compute them.
              </div>
            ) : (
              <div className="font-medium text-foreground">
                Cross-batch clearings may be stale — last sweep ran {relativeTime(lastEvaluatedAt!)}.
                You've rebuilt batches since then. Click Rebuild Cross-Batch Clearings to refresh.
              </div>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={dismiss} data-testid="cross-batch-stale-dismiss">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
