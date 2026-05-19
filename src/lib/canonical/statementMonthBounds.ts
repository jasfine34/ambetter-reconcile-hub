/**
 * Phase 1 — Ineligible-BO canonical helper support.
 *
 * Returns ISO YYYY-MM-DD bounds for a statement month. `end` is
 * LAST-DAY-INCLUSIVE (calendar-aware: 28/29/30/31).
 *
 * Accepts 'YYYY-MM' or 'YYYY-MM-DD' input. Anything past the first 7 chars
 * is ignored — we re-derive bounds from year+month only.
 */
export function getStatementMonthBounds(monthStr: string): {
  start: string;
  end: string;
} {
  if (!monthStr || monthStr.length < 7) {
    throw new Error(`getStatementMonthBounds: invalid monthStr "${monthStr}"`);
  }
  const ym = monthStr.substring(0, 7); // 'YYYY-MM'
  const year = Number(ym.substring(0, 4));
  const month = Number(ym.substring(5, 7)); // 1-12
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    throw new Error(`getStatementMonthBounds: invalid monthStr "${monthStr}"`);
  }
  // Day 0 of month+1 = last day of month (calendar-aware, handles leap years).
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const mm = String(month).padStart(2, '0');
  const dd = String(lastDay).padStart(2, '0');
  return { start: `${year}-${mm}-01`, end: `${year}-${mm}-${dd}` };
}
