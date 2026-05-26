/**
 * Canonical day-aware term-boundary helper.
 *
 * Per R-INELIG-001 (data-dictionary.md:45 + Jason 2026-05-26):
 *   - A term date on day 1 means the policy/broker was NOT active for that month.
 *     → last active month = month BEFORE the term month.
 *   - A term date on day 2 or later means the policy/broker WAS active for at
 *     least part of that month.
 *     → last active month = the term month itself.
 *
 * Returns null for nullish/blank input or the `9999-*` sentinel (treated as
 * "no real end"). YYYY-MM-only input is conservatively treated as a day-1
 * term (no day evidence → previous month is the last fully-active one).
 *
 * Used by memberTimeline cell-assembly + classifier (hasEdeForMonth,
 * netPremiumForServiceMonth) to share one definition of "active through
 * which month" given an ISO term date.
 */
export function lastActiveMonthForTermDate(
  termDateISO: string | null | undefined,
): string | null {
  if (!termDateISO) return null;
  const s = String(termDateISO).trim();
  if (!s) return null;
  if (s.startsWith('9999-')) return null;

  const fullMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (fullMatch) {
    const [, y, mo, d] = fullMatch;
    const ym = `${y}-${mo}`;
    if (d === '01') return addMonthsYM(ym, -1);
    return ym;
  }

  const ymOnly = s.match(/^(\d{4})-(\d{2})$/);
  if (ymOnly) {
    const ym = `${ymOnly[1]}-${ymOnly[2]}`;
    return addMonthsYM(ym, -1);
  }

  return null;
}

function addMonthsYM(ym: string, n: number): string {
  const [y, mo] = ym.split('-').map(Number);
  const total = y * 12 + (mo - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}
