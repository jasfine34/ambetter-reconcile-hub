/**
 * Canonical "is this BO record active during the statement month?" predicate.
 *
 * Phase 1 — Ineligible-BO fix. Three INDEPENDENT disqualification conditions
 * (any returns false):
 *
 *   1. eligible_for_commission — 'No' or boolean false → not active.
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
 *
 * Signature: ISO YYYY-MM-DD strings. statementMonthEnd is OPTIONAL for
 * backward compatibility with Phase 2+ callers that still pass a single
 * Date|string periodStart; when omitted, end is derived from start.
 */
import { getStatementMonthBounds } from './statementMonthBounds';

/** Minimal shape — keeps this file decoupled from the full NormalizedRecord. */
export interface ActiveBoCandidate {
  source_type?: string;
  policy_term_date?: string | null;
  paid_through_date?: string | null;
  broker_term_date?: string | null;
  eligible_for_commission?: string | boolean | null;
}

function toIsoDate(d: Date | string): string {
  if (typeof d === 'string') return d.length >= 10 ? d.substring(0, 10) : d;
  return d.toISOString().substring(0, 10);
}

function isSentinel(date: string): boolean {
  return date.startsWith('9999-');
}

export function isActiveBackOfficeRecord(
  record: ActiveBoCandidate,
  statementMonthStart: Date | string,
  statementMonthEnd?: string,
): boolean {
  // Pass-through for non-BO records.
  if (record.source_type && record.source_type !== 'BACK_OFFICE') return true;

  const startIso = toIsoDate(statementMonthStart);
  let endIso = statementMonthEnd;
  if (!endIso) {
    // Backward-compat: derive last-day-inclusive end from the start month.
    endIso = getStatementMonthBounds(startIso).end;
  }

  // (1) Eligibility flag.
  const elig = record.eligible_for_commission;
  if (elig === false) return false;
  if (typeof elig === 'string' && elig.trim().toLowerCase() === 'no') return false;

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
