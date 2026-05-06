/**
 * Canonical metric helpers — the ONLY functions consumer pages are allowed
 * to call to compute scope-level totals. See ARCHITECTURE_PLAN.md
 * § Canonical Definitions.
 *
 * Design contract:
 *   - Helpers are PURE functions over already-loaded data (reconciled[],
 *     normalizedRecords[], filteredEde, confirmedWeakMatchKeys). The
 *     Dashboard hydrates these once and passes them in; other pages do the
 *     same so every page sees identical inputs.
 *   - Numbers produced here MUST equal the verified-clean Dashboard values
 *     for Mar 2026 Coverall scope: NetPaid $36,640.50 · EE 1,731 · TCL 1,839 ·
 *     Found-in-BO 1,580 (+ confirmedWeakMatches.size).
 *   - Net Paid Commission is computed from RAW commission records (not
 *     per-member aggregates), matching the Dashboard's Net Paid card. Summing
 *     reconciled_members.actual_commission produces a slightly different
 *     number ($36,727.50 on Mar 2026) because of inter-member roll-ups —
 *     that's the historical drift this refactor eliminates.
 */
import type { FilteredEdeResult } from '../expectedEde';
import {
  type CanonicalScope,
  filterReconciledByScope,
  filterCommissionRowsByScope,
} from './scope';

export interface NetPaidBreakdown {
  net: number;
  gross: number;
  clawbacks: number;
  /** Number of commission rows that contributed to the net (positive + negative). */
  rowCount: number;
}

/**
 * Net Paid Commission for the scope. Sum of commission_amount on every
 * COMMISSION row in scope. Matches the Net Paid Commission card on Dashboard
 * EXACTLY (Mar 2026 Coverall = $36,640.50).
 *
 * Weak-match overrides are intentionally NOT a parameter: they upgrade
 * members from "not in BO" to "effectively in BO" but do not change which
 * commission rows exist, so they cannot affect Net Paid. The signature
 * reflects actual behavior — normalizedRecords + scope only.
 */
export function getNetPaidCommission(
  normalizedRecords: any[],
  scope: CanonicalScope,
): NetPaidBreakdown {
  const rows = filterCommissionRowsByScope(normalizedRecords, scope);
  let gross = 0;
  let clawbacks = 0;
  let rowCount = 0;
  for (const r of rows) {
    const amt = Number(r.commission_amount) || 0;
    if (amt === 0) continue;
    rowCount += 1;
    if (amt > 0) gross += amt;
    else clawbacks += amt;
  }
  return { net: gross + clawbacks, gross, clawbacks, rowCount };
}

/**
 * Expected Enrollments — count of unique members in the EE universe for the
 * scope. Sourced from `computeFilteredEde` (the canonical EE filter).
 */
export function getExpectedEnrollments(filteredEde: FilteredEdeResult): number {
  return filteredEde.uniqueKeys;
}

/**
 * Found in Back Office — members in the EE universe who have a strict join
 * to BO OR a confirmed weak-match override. Matches the Dashboard's Found
 * in BO card after weak-match upgrades are applied.
 *
 * CANONICAL DECISION (2026.04.28-ee-universe-align): the EE-universe
 * predicate is membership in `filteredEde.uniqueMembers` for the CURRENT
 * batch (span semantic, rebuilt fresh per batch), NOT the persistent
 * `reconciled_members.is_in_expected_ede_universe` flag (which can carry
 * over across batches once flipped on, causing Feb-style over-counts where
 * 302 members were flagged from prior batches but had no EDE row in this
 * batch). The persistent column is retained for backward-compat drilldowns
 * but no longer drives this metric.
 */
export function getFoundInBackOffice(
  reconciled: any[],
  scope: CanonicalScope,
  filteredEde: FilteredEdeResult,
  confirmedUpgradeMemberKeys: Set<string>,
): number {
  const inScope = filterReconciledByScope(reconciled, scope);
  const eeUniverse = new Set(filteredEde.uniqueMembers.map((m) => m.member_key));
  return inScope.filter(
    (r) =>
      eeUniverse.has(r.member_key) &&
      (r.in_back_office || confirmedUpgradeMemberKeys.has(r.member_key)),
  ).length;
}

/**
 * Not in Back Office (rows) — EE-universe members missing from BO with
 * confirmed weak-match overrides removed. Single source of truth for both
 * the Dashboard "Not in Back Office" card count AND the drilldown modal's
 * tabbed row lists. Card and modal MUST consume from this helper (or pass
 * its result around) so the two surfaces never diverge again (B1 follow-up
 * to #129).
 */
export function getNotInBackOfficeRows(
  filteredEde: FilteredEdeResult,
  confirmedWeakMatchOverrideKeys: Set<string>,
  pickStableKey: (r: { issuer_subscriber_id?: string | null; exchange_subscriber_id?: string | null; policy_number?: string | null }) => string,
): FilteredEdeResult['missingFromBO'] {
  return filteredEde.missingFromBO.filter(
    (r) => !confirmedWeakMatchOverrideKeys.has(
      pickStableKey({
        issuer_subscriber_id: r.issuer_subscriber_id,
        exchange_subscriber_id: r.exchange_subscriber_id,
        policy_number: r.policy_number,
      }),
    ),
  );
}

/**
 * Not in Back Office — members in the EE universe with no strict BO join and
 * no confirmed weak-match override. Delegates to {@link getNotInBackOfficeRows}
 * so the count is mechanically identical to the row list the modal renders.
 */
export function getNotInBackOffice(
  filteredEde: FilteredEdeResult,
  confirmedWeakMatchOverrideKeys: Set<string>,
  pickStableKey: (r: { issuer_subscriber_id?: string | null; exchange_subscriber_id?: string | null; policy_number?: string | null }) => string,
): number {
  return getNotInBackOfficeRows(filteredEde, confirmedWeakMatchOverrideKeys, pickStableKey).length;
}

/**
 * Eligible Cohort — members in the EE universe (per current-batch
 * `filteredEde`, NOT the persistent `is_in_expected_ede_universe` flag),
 * in BO (or confirmed weak match), AND eligible_for_commission='Yes'.
 *
 * CANONICAL DECISION (2026.05.01-eligible-cohort-current-batch): same
 * rationale as `getFoundInBackOffice` — the persistent
 * `reconciled_members.is_in_expected_ede_universe` flag carries across
 * batches once flipped on, so members whose AOR transferred OUT of scope
 * still match the persistent predicate even though they are no longer in
 * the current batch's filteredEde universe (Anna Wohler / Clifton Slone /
 * Jessica Salazar shape on Feb-Mar 2026). The `filteredEde` parameter is
 * REQUIRED to make any caller forgetting it a compile error.
 */
export function getEligibleCohort(
  reconciled: any[],
  scope: CanonicalScope,
  confirmedUpgradeMemberKeys: Set<string>,
  filteredEde: FilteredEdeResult,
): any[] {
  const inScope = filterReconciledByScope(reconciled, scope);
  const eeUniverse = new Set(filteredEde.uniqueMembers.map((m) => m.member_key));
  return inScope.filter(
    (r) =>
      eeUniverse.has(r.member_key) &&
      (r.in_back_office || confirmedUpgradeMemberKeys.has(r.member_key)) &&
      r.eligible_for_commission === 'Yes',
  );
}

/** Total Covered Lives — sum of coveredMemberCount across the EE universe. */
export function getTotalCoveredLives(filteredEde: FilteredEdeResult): number {
  let total = 0;
  for (const r of filteredEde.uniqueMembers) total += r.covered_member_count || 0;
  return total;
}

/**
 * Per-month breakdown for a metric. Currently supports 'expectedEnrollments'
 * and 'totalCoveredLives'. Returns a map of YYYY-MM → count, sourced from
 * filteredEde.byMonth (newly-effective per actual effective month, so the
 * numbers SUM to the metric total).
 */
export function getMonthlyBreakdown(
  metric: 'expectedEnrollments' | 'totalCoveredLives',
  filteredEde: FilteredEdeResult,
): Record<string, number> {
  if (metric === 'expectedEnrollments') return { ...filteredEde.byMonth };
  // totalCoveredLives — sum coveredMemberCount per actual effective month.
  const out: Record<string, number> = {};
  for (const r of filteredEde.uniqueMembers) {
    const m = r.effective_month;
    if (!m) continue;
    out[m] = (out[m] ?? 0) + (r.covered_member_count || 0);
  }
  return out;
}

/**
 * Direct-vs-downline split of Net Paid Commission. Direct = writing-agent NPN
 * is one of the Coverall NPNs. Downline = pay_entity='Coverall' but writing
 * agent is non-Coverall NPN (overrides). Used by the Dashboard's Net Paid
 * card to break out where the dollars came from.
 */
export function getDirectVsDownlineSplit(
  normalizedRecords: any[],
  scope: CanonicalScope,
  isCoverallNpn: (npn: string | null | undefined) => boolean,
): {
  coverallDirectNet: number;
  downlineNet: number;
  coverallDirectRows: number;
  downlineRows: number;
  unclassifiedRows: number;
  unclassifiedNet: number;
} {
  const rows = filterCommissionRowsByScope(normalizedRecords, scope);
  let coverallDirectNet = 0;
  let downlineNet = 0;
  let coverallDirectRows = 0;
  let downlineRows = 0;
  let unclassifiedRows = 0;
  let unclassifiedNet = 0;
  for (const rec of rows) {
    const amt = Number(rec.commission_amount) || 0;
    if (amt === 0) continue;
    if (isCoverallNpn(rec.agent_npn)) {
      coverallDirectNet += amt;
      coverallDirectRows += 1;
    } else if (rec.pay_entity === 'Coverall') {
      downlineNet += amt;
      downlineRows += 1;
    } else {
      unclassifiedRows += 1;
      unclassifiedNet += amt;
    }
  }
  return { coverallDirectNet, downlineNet, coverallDirectRows, downlineRows, unclassifiedRows, unclassifiedNet };
}
