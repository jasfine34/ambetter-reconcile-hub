/**
 * Canonical "is this BO record active during the statement month?" predicate.
 *
 * Phase 1 + v5-prerequisite — strict signature. Both `statementMonthStart`
 * and `statementMonthEnd` are REQUIRED ISO YYYY-MM-DD strings. Use
 * `getStatementMonthBounds(monthStr)` at the call site if you only have a
 * YYYY-MM string.
 *
 * Three INDEPENDENT disqualification conditions (any returns false):
 *
 *   1. eligible_for_commission — 14-variant token normalization.
 *   2. policy_term_date — set and <= statementMonthStart → terminated.
 *      (R-INELIG-001 day-of-month: term `2026-02-01` <= `2026-02-01` start
 *      → February inactive, matching "term on day 1 = not active for that
 *      month". Term `2026-01-31` <= `2026-02-01` start → February inactive.
 *      Term `2026-04-15` not <= `2026-04-01` start → April active.)
 *   3. broker_effective_date — set and > statementMonthEnd → broker not yet
 *      effective for this service month (Fix 5 / data-dictionary.md:42).
 *
 * Plus the existing broker_term check (with 9999-* sentinel) is preserved.
 *
 * REMOVED in v5 prerequisite (Fix 1): `paid_through_date` disqualifier.
 * Per R-INELIG-002, paid_through is the MEMBER's premium-paid-through date,
 * NOT a commission disqualifier. A paid-up member is the NORMAL chase-
 * eligible state.
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
  broker_effective_date?: string | null;
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

  // (1) Eligibility flag.
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

  // (2) Policy term date — independent.
  const policyTerm = record.policy_term_date || '';
  if (policyTerm && !isSentinel(policyTerm) && policyTerm <= startIso) return false;

  // (3) Broker effective date — Fix 5. If broker isn't yet effective by the
  // end of the service month, this row does not support that month.
  const brokerEff = record.broker_effective_date || '';
  if (brokerEff && !isSentinel(brokerEff) && brokerEff > endIso) return false;

  // Broker term date (preserved active-window guard).
  const brokerTerm = record.broker_term_date || '';
  if (brokerTerm && !isSentinel(brokerTerm) && brokerTerm <= startIso) return false;

  // NOTE: paid_through_date intentionally NOT checked here — see R-INELIG-002.

  return true;
}
