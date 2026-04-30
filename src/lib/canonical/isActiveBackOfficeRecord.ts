/**
 * Canonical "is this BO record active during the reconcile period?" predicate.
 *
 * Single source of truth for BO active-record disqualification — replaces
 * three divergent inline implementations in:
 *   - src/lib/reconcile.ts (per-member BO active filter)
 *   - src/lib/classifier.ts (Source Funnel BO predicate)
 *   - src/pages/DashboardPage.tsx (BO mismatch reason inference)
 *
 * Disqualification rules (any one returns false):
 *   1. Policy Term Date past — policy_term_date set and <= periodStart.
 *      Falls back to paid_through_date when policy_term_date is null.
 *   2. Broker Term Date past — broker_term_date set and <= periodStart.
 *      The 12/31/9999 sentinel (Ambetter convention for "no end") is
 *      treated as null/active.
 *   3. Eligible for Commission flag — 'No' or boolean false → not active.
 *
 * Carrier-specific column mapping happens upstream in adapters; this
 * function operates on the normalized field names only and is therefore
 * carrier-agnostic.
 *
 * Non-BACK_OFFICE records are passed through as active (true) so callers
 * can apply this predicate to mixed record streams without pre-filtering.
 */

/** Minimal shape — keeps this file decoupled from the full NormalizedRecord. */
export interface ActiveBoCandidate {
  source_type?: string;
  policy_term_date?: string | null;
  paid_through_date?: string | null;
  broker_term_date?: string | null;
  eligible_for_commission?: string | boolean | null;
}

/** Sentinel "no end date" value used by Ambetter feeds. */
const FAR_FUTURE_SENTINEL = '9999-12-31';

function toIsoDate(d: Date | string): string {
  if (typeof d === 'string') return d.length >= 10 ? d.substring(0, 10) : d;
  return d.toISOString().substring(0, 10);
}

function isSentinel(date: string): boolean {
  // Treat any 9999-* date as the "no end" sentinel.
  return date.startsWith('9999-');
}

export function isActiveBackOfficeRecord(
  record: ActiveBoCandidate,
  periodStart: Date | string,
): boolean {
  // Pass-through for non-BO records so this can be applied to mixed streams.
  if (record.source_type && record.source_type !== 'BACK_OFFICE') return true;

  const periodIso = toIsoDate(periodStart);

  // (3) Eligibility flag.
  const elig = record.eligible_for_commission;
  if (elig === false) return false;
  if (typeof elig === 'string' && elig.trim().toLowerCase() === 'no') return false;

  // (1) Policy term date — fall back to paid_through_date when absent.
  const policyTerm = record.policy_term_date || record.paid_through_date || '';
  if (policyTerm && !isSentinel(policyTerm) && policyTerm <= periodIso) return false;

  // (2) Broker term date.
  const brokerTerm = record.broker_term_date || '';
  if (brokerTerm && !isSentinel(brokerTerm) && brokerTerm <= periodIso) return false;

  return true;
}
