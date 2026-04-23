/**
 * Date-range helpers keyed off the batch's statement month.
 *
 * Previously the app hardcoded '2026-01-01' and '2026-02-01' throughout as
 * the "expected EDE effective dates" for a batch. That only worked for the
 * February 2026 batch. Now every month driver runs through these helpers
 * so a batch for March 2026, April 2026, or anything back to 2025 works
 * identically. See §8 of ARCHITECTURE_PLAN.md.
 */

/** YYYY-MM month key format used throughout the app. */
export type MonthKey = string;

/**
 * Accepts a statement_month column (stored as 'YYYY-MM-DD' in Postgres DATE)
 * or a YYYY-MM string, and returns the YYYY-MM key. Returns '' for nullish.
 */
export function statementMonthKey(statementMonth: string | null | undefined): MonthKey {
  if (!statementMonth) return '';
  const s = String(statementMonth).trim();
  if (!s) return '';
  // Accept both YYYY-MM and YYYY-MM-DD
  return s.substring(0, 7);
}

/** Add n months to a YYYY-MM key. Negative n subtracts. */
export function addMonths(monthKey: MonthKey, n: number): MonthKey {
  const [y, m] = monthKey.split('-').map(Number);
  if (!y || !m) return monthKey;
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

/** '2026-02' → '2026-02-01' (the first of that month in YYYY-MM-DD). */
export function monthKeyToFirstOfMonth(monthKey: MonthKey): string {
  if (!monthKey) return '';
  return `${monthKey}-01`;
}

/**
 * Service months covered by a batch whose statement_month is M.
 *
 * For Ambetter and any carrier whose statement for service month S is dated
 * mid-next-month (e.g. March 22 statement covers February service), the batch
 * labeled M covers BOTH the prior month (M-1) and M itself — because a
 * member's first-eligible month might be M-1 or M depending on when we
 * became their AOR.
 *
 * Returns two YYYY-MM keys ordered prior-month-first.
 */
export function getCoveredMonths(statementMonth: string | null | undefined): MonthKey[] {
  const key = statementMonthKey(statementMonth);
  if (!key) return [];
  return [addMonths(key, -1), key];
}

/**
 * Same as getCoveredMonths but returns YYYY-MM-DD dates (first of each month).
 * This is the format stored in the normalized_records.effective_date column.
 */
export function getCoveredEffectiveDates(statementMonth: string | null | undefined): string[] {
  return getCoveredMonths(statementMonth).map(monthKeyToFirstOfMonth);
}

/** Today's calendar month as a YYYY-MM key, used as a neutral fallback. */
export function currentMonthKey(): MonthKey {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Fallback when no batch is selected. Avoids the old hardcoded '2026-01'
 * which silently pointed every newly-loaded view at a historical window.
 */
export function fallbackReconcileMonth(): MonthKey {
  return currentMonthKey();
}
