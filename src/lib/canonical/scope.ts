/**
 * Canonical scope definitions — the ONLY place pay-entity scope semantics
 * are defined. See ARCHITECTURE_PLAN.md § Canonical Definitions.
 *
 * Three scopes:
 *   - Coverall: members whose currentPolicyAOR contains a Coverall NPN
 *               (21055210, 21277051, 16531877) OR whose AOR string starts
 *               with 'Jason Fine' / 'Erica Fine' / 'Becky Shuta'.
 *   - Vix:      members whose currentPolicyAOR contains Erica's NPN
 *               (21277051) AND who appear on the Vix commission statement.
 *   - All:      union of Coverall and Vix.
 *
 * IMPORTANT: every consumer page that filters by pay entity MUST use one of
 * these helpers. Adding a new agent or carrier extends NPN_MAP / scope.ts —
 * never page-local filter logic.
 *
 * Implementation note: the actual EE-universe scope filter lives in
 * `computeFilteredEde` (expectedEde.ts), which is the verified-clean source
 * of Expected Enrollments. This module wraps it and exposes member-key sets
 * so other helpers can join in O(1).
 */
import type { ReconciledMember } from '../reconcile';
import type { FilteredEdeResult } from '../expectedEde';
import { NPN_MAP } from '../constants';
import { extractNpnFromAorString, isCoverallAORByName } from '../agents';

export type CanonicalScope = 'Coverall' | 'Vix' | 'All';

/** NPNs of all Coverall AORs. */
export const COVERALL_NPNS: readonly string[] = Object.keys(NPN_MAP);

/** NPNs whose expectedPayEntity includes Vix (today: just Erica). */
export const VIX_NPNS: readonly string[] = Object.entries(NPN_MAP)
  .filter(([, v]) => v.expectedPayEntity === 'Coverall_or_Vix')
  .map(([npn]) => npn);

/** True if the raw AOR string belongs to one of the requested NPNs/names. */
export function aorBelongsToScope(rawAor: string, scope: CanonicalScope): boolean {
  if (!rawAor) return false;
  const allowedNpns = scope === 'Vix' ? new Set(VIX_NPNS) : new Set(COVERALL_NPNS);
  const embedded = extractNpnFromAorString(rawAor);
  if (embedded) return allowedNpns.has(embedded);
  if (!isCoverallAORByName(rawAor)) return false;
  if (scope === 'Coverall' || scope === 'All') return true;
  // Vix without an embedded NPN — only Erica's name qualifies.
  return rawAor.toLowerCase().startsWith('erica');
}

/**
 * Member-key Set for the requested scope, computed from already-loaded
 * reconciled data. This is the canonical "who is in this scope?" answer used
 * by every metric helper. Mirrors the Dashboard's `filtered` derivation so
 * the numbers tie out exactly.
 *
 * CANONICAL DECISION (2026.04.27): scope membership is determined SOLELY by
 * currentPolicyAOR (the AOR-of-record on the carrier's EDE export). NOT by
 * writing-agent NPN, NOT by pay-entity. This is the only way "this member is
 * ours" stays consistent when AOR is transferred mid-policy.
 *
 * Coverall scope = current_policy_aor matches a Coverall NPN/name (via
 *                  aorBelongsToScope('Coverall', ...)).
 * Vix scope      = current_policy_aor is Erica's AND member appears on a Vix
 *                  commission row (actual_pay_entity = 'Vix').
 * All (Combined) = current_policy_aor is any Coverall NPN OR
 *                  actual_pay_entity = 'Vix'.
 */
export function getMembersInScope(
  reconciled: ReconciledMember[] | any[],
  scope: CanonicalScope,
): Set<string> {
  const out = new Set<string>();
  for (const r of reconciled) {
    const aor = String(r.current_policy_aor ?? '').trim();
    if (scope === 'All') {
      // Combined = AOR is any Coverall NPN/name OR member was paid via Vix.
      if (aorBelongsToScope(aor, 'Coverall') || r.actual_pay_entity === 'Vix') {
        out.add(r.member_key);
      }
      continue;
    }
    if (scope === 'Coverall') {
      if (aorBelongsToScope(aor, 'Coverall')) out.add(r.member_key);
      continue;
    }
    // Vix: AOR is Erica AND member appears on Vix commission statement.
    if (aorBelongsToScope(aor, 'Vix') && r.actual_pay_entity === 'Vix') {
      out.add(r.member_key);
    }
  }
  return out;
}

/**
 * Return the subset of reconciled rows in the given scope. Same semantics as
 * `getMembersInScope`, kept as a convenience for consumers that want the rows
 * (not just the keys).
 */
export function filterReconciledByScope<T extends { member_key: string }>(
  reconciled: T[],
  scope: CanonicalScope,
): T[] {
  if (scope === 'All') return reconciled;
  const keys = getMembersInScope(reconciled as any[], scope);
  return reconciled.filter((r) => keys.has(r.member_key));
}

/**
 * Filter raw normalized COMMISSION rows by scope. Commission rows carry their
 * own `pay_entity` directly (set at upload time by the file slot), so scope
 * filtering is a simple equality check — same logic the Dashboard uses for
 * Net Paid Commission aggregation.
 */
export function filterCommissionRowsByScope<T extends { source_type?: string; pay_entity?: string | null }>(
  normalizedRecords: T[],
  scope: CanonicalScope,
): T[] {
  return normalizedRecords.filter((rec) => {
    if (rec.source_type !== 'COMMISSION') return false;
    if (scope === 'All') return true;
    if (scope === 'Coverall') return rec.pay_entity === 'Coverall';
    return rec.pay_entity === 'Vix';
  });
}

/**
 * Cross-check helper — returns the EE-universe member_keys for a scope by
 * delegating to the already-computed FilteredEdeResult. The Dashboard uses
 * this same data structure for its Expected Enrollments card; the canonical
 * helpers reuse it instead of recomputing so the numbers stay aligned.
 */
export function getEdeUniverseKeys(filteredEde: FilteredEdeResult): Set<string> {
  return new Set(filteredEde.uniqueMembers.map((r) => r.member_key));
}
