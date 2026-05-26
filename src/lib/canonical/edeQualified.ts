/**
 * Canonical "is this EDE row qualified for active-chase state?" predicate.
 *
 * Per data-dictionary.md:67,77: qualified statuses are
 *   - effectuated
 *   - pending effectuated  (a.k.a. pendingeffectuation)
 *   - pending termination  (a.k.a. pendingtermination)
 * Cancelled/terminated/expired rows do NOT support active chase state.
 *
 * Status is read from raw_json.policyStatus when present (most fidelity),
 * falling back to the normalized `status` field. Issuer must match Ambetter
 * (case-insensitive substring) because Ambetter is the only carrier whose
 * EDE flow our reconciliation currently consumes.
 *
 * Extracted from memberTimeline.ts + classifier.ts so both cell-assembly
 * and classifier use the same definition (Fix 6).
 */
export interface QualifiedEdeCandidate {
  source_type?: string;
  status?: string | null;
  carrier?: string | null;
  raw_json?: Record<string, unknown> | null;
}

const QUALIFIED_EDE_STATUSES = new Set([
  'effectuated',
  'pendingeffectuation',
  'pendingtermination',
]);

function statusKey(r: QualifiedEdeCandidate): string {
  const raw = (r.raw_json?.['policyStatus'] ?? r.status ?? '') as string;
  return String(raw).toLowerCase().replace(/\s+/g, '');
}

function issuerKey(r: QualifiedEdeCandidate): string {
  const raw = (r.raw_json?.['issuer'] ?? r.carrier ?? '') as string;
  return String(raw).toLowerCase();
}

export function isEDEQualified(r: QualifiedEdeCandidate): boolean {
  if (r.source_type !== 'EDE') return false;
  if (!QUALIFIED_EDE_STATUSES.has(statusKey(r))) return false;
  if (!issuerKey(r).includes('ambetter')) return false;
  return true;
}
