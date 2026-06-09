/**
 * C3a Extraction B — shared `latestBoPaidThrough(records)`.
 *
 * Behavior-preserving extraction of the previously-private helper from
 * `src/lib/classifier.ts:305-314`. Returns the most-recent BO
 * paid-through date across all snapshots as a MonthKey ('YYYY-MM'), or
 * '' if no BO record has a paid_through_date.
 *
 * Pure / headless — no Supabase, no React.
 */
import type { NormalizedRecord } from '../normalize';
import type { MonthKey } from '../dateRange';

function dateToMonthKey(date: string | null | undefined): MonthKey {
  if (!date) return '';
  return String(date).substring(0, 7);
}

export function latestBoPaidThrough(records: NormalizedRecord[]): MonthKey {
  let latest = '';
  for (const r of records) {
    if (r.source_type !== 'BACK_OFFICE') continue;
    const pt = dateToMonthKey(r.paid_through_date);
    if (pt && pt > latest) latest = pt;
  }
  return latest;
}
