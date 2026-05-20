/**
 * Canonical "is this BO record active during the statement month?" predicate.
 *
 * Phase 2 — strict signature. Both `statementMonthStart` and
 * `statementMonthEnd` are REQUIRED ISO YYYY-MM-DD strings. The Phase 1
 * backward-compat overload (`Date | string`, optional end) was removed —
 * callers MUST pass real bounds. Use `getStatementMonthBounds(monthStr)`
 * at the call site if you only have a YYYY-MM string.
 *
 * Three INDEPENDENT disqualification conditions (any returns false):
 *
 *   1. eligible_for_commission — 14-variant token normalization (Phase 1).
 *   2. policy_term_date — set and <= statementMonthStart → terminated.
 *   3. paid_through_date — set and >= statementMonthEnd → already paid through
 *      the statement month (last-day-inclusive).
 *
 * Plus the existing broker_term check (with 9999-* sentinel) is preserved
 * as the "active window" guard.
 *
 * Single source of truth shared by reconcile, classifier, weakMatch,
 * metrics, dashboard (Phase 2+ surfaces). Carrier-agnostic — column mapping
 * happens upstream in adapters.
 *
 * Non-BACK_OFFICE records pass through as active (true) so callers can
 * apply this predicate to mixed record streams without pre-filtering.
 */

/** Minimal shape — keeps this file decoupled from the full NormalizedRecord. */
export interface ActiveBoCandidate {
  source_type?: string;
  policy_term_date?: string | null;
  paid_through_date?: string | null;
  broker_term_date?: string | null;
  eligible_for_commission?: string | boolean | number | null;
}

function isSentinel(date: string): boolean {
  return date.startsWith('9999-');
}

export function isActiveBackOfficeRecord(
  record: ActiveBoCandidate,
  statementMonthStart: string,
  statementMonthEnd: string,
): boolean {
  // Pass-through for non-BO records.
  if (record.source_type && record.source_type !== 'BACK_OFFICE') return true;

  const startIso = statementMonthStart;
  const endIso = statementMonthEnd;

  // (1) Eligibility flag — Phase 1: normalize all ineligible variants
  // (case-insensitive 'no'/'n'/'false', numeric 0, string '0', boolean false).
  // null/undefined treated as "not explicitly ineligible" → pass.
  const eligValue = record.eligible_for_commission;
  if (eligValue !== null && eligValue !== undefined) {
    const normalized =
      typeof eligValue === 'string' ? eligValue.trim().toLowerCase() : eligValue;
    const ineligibleTokens: Set<unknown> = new Set([
      'no',
      'n',
      'false',
      '0',
      0,
      false,
    ]);
    if (ineligibleTokens.has(normalized)) return false;
  }

  // (2) Policy term date — independent (no fallback to paid_through_date).
  const policyTerm = record.policy_term_date || '';
  if (policyTerm && !isSentinel(policyTerm) && policyTerm <= startIso) return false;

  // (3) Paid Through Date — independent, last-day-inclusive.
  const paidThrough = record.paid_through_date || '';
  if (paidThrough && !isSentinel(paidThrough) && paidThrough >= endIso) return false;

  // Broker term date (preserved active-window guard).
  const brokerTerm = record.broker_term_date || '';
  if (brokerTerm && !isSentinel(brokerTerm) && brokerTerm <= startIso) return false;

  return true;
}
