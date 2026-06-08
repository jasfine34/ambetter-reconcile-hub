import { useEffect, useState } from 'react';
import { getAllNormalizedRecordsForMemberTimeline } from '@/lib/persistence';
import { useAllBatchesDataVersion } from '@/hooks/useBatchDataVersion';
import { getMtAllBatchProjection } from '@/lib/canonical/mtApprovedMceCache';
import {
  latestAuthoritativeBoTermDates,
  makeBoRecency,
  type LatestAuthoritativeBoOverlay,
} from '@/lib/canonical/latestAuthoritativeBo';

/**
 * C2a — Shared latest-BO supersession overlay hook for secondary-surface
 * alignment (Dashboard / Agent Summary / Unpaid Recovery). Extracts the
 * exact overlay-build block first verified inline on DashboardPage
 * (commit e8fd6cd6, lines 383-414) so the three pages share ONE
 * cross-batch projection + overlay derivation.
 *
 * Contract:
 *   - `overlay` is null while the all-batch projection is still loading
 *     (or whenever the key {statementMonth, allBatchesDataVersion,
 *     resolverIndex, batches} changes — reset to null on each effect run).
 *   - `loading` is true when statementMonth is empty OR overlay is still null.
 *   - `statementMonthStartIso` is `${statementMonth}-01` (or '' if no month).
 *
 * Note: Dashboard's verified inline build (e8fd6cd6) is intentionally left
 * in place by Stage 3; folding Dashboard onto this hook is out of scope.
 */
export function useLatestBoOverlay(
  statementMonth: string,
  batches: any[],
  resolverIndex: any,
): { overlay: LatestAuthoritativeBoOverlay | null; loading: boolean; statementMonthStartIso: string } {
  const allBatchesDataVersion = useAllBatchesDataVersion();
  const [overlay, setOverlay] = useState<LatestAuthoritativeBoOverlay | null>(null);
  const statementMonthStartIso = statementMonth ? `${statementMonth}-01` : '';

  useEffect(() => {
    let cancelled = false;
    setOverlay(null);
    if (!statementMonth) return;
    const batchMonthByBatchIdObj: Record<string, string> = {};
    for (const b of batches as any[]) {
      const ym = b?.statement_month ? String(b.statement_month).substring(0, 7) : '';
      batchMonthByBatchIdObj[b.id] = ym;
    }
    const dedupCtx = { batchMonthByBatchId: batchMonthByBatchIdObj };
    (async () => {
      try {
        const projection = await getMtAllBatchProjection({
          allBatchesDataVersion,
          resolverIndex,
          loader: () => getAllNormalizedRecordsForMemberTimeline(dedupCtx),
        });
        if (cancelled) return;
        const recency = makeBoRecency({
          batchMonthByBatchId: new Map(Object.entries(batchMonthByBatchIdObj)),
        });
        const next = latestAuthoritativeBoTermDates(projection.records || [], recency);
        if (!cancelled) setOverlay(next);
      } catch {
        if (!cancelled) setOverlay(null);
      }
    })();
    return () => { cancelled = true; };
  }, [statementMonth, allBatchesDataVersion, resolverIndex, batches]);

  const loading = !statementMonthStartIso || overlay === null;
  return { overlay, loading, statementMonthStartIso };
}
