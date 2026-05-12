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
import { isActiveBackOfficeRecord } from './isActiveBackOfficeRecord';

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

// ===========================================================================
// Phase 1 (#X): expanded expected-payment universe + 4-bucket Source Coverage.
//
// `getEligibleCohort` (above) intentionally remains the NARROW legacy
// definition (EE ∩ BO-active ∩ eligible='Yes'). The helpers below implement
// the broader workflow universe Jason confirmed:
//
//   Should Be Paid = Matched + BO Only + EDE Only
//
// where:
//   - Matched   = in_ede ∧ in_bo_active ∧ eligible='Yes'
//   - BO Only   = !in_ede ∧ in_bo_active ∧ eligible='Yes'
//   - EDE Only  = in_ede ∧ !in_bo_active                   (NO eligibility gate —
//                 the BO record is missing or inactive, so its eligibility flag
//                 is blank/stale; the audit's 12 trailing-payment rows have
//                 eligible_for_commission='' and MUST be included)
//
// Source Coverage paid-bucket math (4 buckets, "Paid Outside Current EDE"
// removed because it overlapped Expected Payments Received):
//   Total Policies Paid =
//     Fully Matched & Paid           (Matched ∩ in_commission)
//   + Paid: Back Office Only         (BO Only ∩ in_commission)
//   + Paid: EDE Only                 (EDE Only ∩ in_commission)
//   + Paid: Commission Statement Only (!in_ede ∧ !in_bo_active ∧ in_commission)
//
// Drilldown rows for "Paid: EDE Only" carry a `bo_reason` field —
// "BO inactive/terminated" if a BO record exists in normalizedRecords but
// failed isActiveBackOfficeRecord for the period; "BO absent" if no BO row
// was found for the member at all. This is computed against raw
// normalizedRecords (not reconciled_members alone) because inactive BO rows
// are filtered out before reconciled.in_back_office=true.
// ===========================================================================

export interface ExpectedPaymentUniverse<T = any> {
  /** All rows in the universe (matched ∪ boOnly ∪ edeOnly). */
  rows: T[];
  /** in_ee_universe ∧ in_bo_active ∧ eligible='Yes'. */
  matched: T[];
  /**
   * TRUE BO Only (Interpretation C):
   *   NOT in current EE universe
   *   ∧ in_bo_active
   *   ∧ eligible='Yes'
   *   ∧ raw r.in_ede === false  ← excludes the "BO + non-current EDE" diagnostic
   */
  boOnly: T[];
  /** in_ee_universe ∧ !in_bo_active (no eligibility gate). */
  edeOnly: T[];
  /**
   * Diagnostic-only bucket (Interpretation C):
   *   NOT in current EE universe
   *   ∧ in_bo_active
   *   ∧ eligible='Yes'
   *   ∧ raw r.in_ede === true
   * NOT counted in `rows` / `total` and NOT part of Should Be Paid.
   * Most rows here are next-batch future-effective enrollments, AOR/key
   * mismatches, or non-qualified EDE statuses — kept visible as a review
   * tile rather than silently inflating the workflow universe.
   */
  boActiveNonCurrentEde: T[];
  /**
   * Phase 1.7 defensive fall-through bucket (additive return-shape field):
   *   in_ee_universe ∧ in_bo_active ∧ eligible_for_commission !== 'Yes'
   * These rows were silently dropped by the original 4-branch classifier
   * (EE ∩ active BO ∩ eligibility='No'/blank). Surfacing them prevents
   * silent loss when BO marks an EE member as not eligible.
   *
   * NOT counted in `rows` / `total`, NOT routed to Should Be Paid in
   * Phase 1.7. Future routing decision deferred. `boIneligibleCount` MUST
   * be 0 on canonical fixtures and live data; if it ever goes non-zero the
   * runtime invariant `bo-ineligible-fall-through-empty` fails loudly.
   */
  boIneligible: T[];
  total: number;
  matchedCount: number;
  boOnlyCount: number;
  edeOnlyCount: number;
  boActiveNonCurrentEdeCount: number;
  boIneligibleCount: number;
}

/**
 * Phase 1: broader Expected Payment Universe — the workflow-level
 * "should-be-paid" definition. Replaces the narrow `getEligibleCohort`
 * for the top expected-payment cards (Should Be Paid / Expected Payments
 * Received / Expected But Unpaid). `getEligibleCohort` is preserved
 * unchanged for legacy callers.
 *
 * Effective in-BO predicate: r.in_back_office (already gated through
 * isActiveBackOfficeRecord upstream in reconcile) OR confirmed weak-match.
 */
export function getExpectedPaymentUniverse(
  reconciled: any[],
  scope: CanonicalScope,
  filteredEde: FilteredEdeResult,
  confirmedUpgradeMemberKeys: Set<string>,
): ExpectedPaymentUniverse {
  const inScope = filterReconciledByScope(reconciled, scope);
  const eeUniverse = new Set(filteredEde.uniqueMembers.map((m) => m.member_key));
  const matched: any[] = [];
  const boOnly: any[] = [];
  const edeOnly: any[] = [];
  const boActiveNonCurrentEde: any[] = [];
  const boIneligible: any[] = [];
  for (const r of inScope) {
    // EDE evidence MUST be membership in current Expected Enrollments
    // (filteredEde.uniqueMembers) only — same predicate used by the EE card.
    // Using r.in_ede here would over-count rows whose EDE row didn't qualify
    // for the current EE universe (status/effective span/scope), letting
    // Matched exceed Expected Enrollments.
    const inEde = eeUniverse.has(r.member_key);
    const inBoActive = !!r.in_back_office || confirmedUpgradeMemberKeys.has(r.member_key);
    const eligibleYes = r.eligible_for_commission === 'Yes';
    const rawInEde = !!r.in_ede;
    if (inEde && inBoActive && eligibleYes) {
      matched.push(r);
    } else if (!inEde && inBoActive && eligibleYes && !rawInEde) {
      // TRUE BO Only — Interpretation C requires raw r.in_ede=false so we
      // don't sweep up next-batch future-effective enrollments or AOR-
      // mismatch rows that have raw EDE evidence elsewhere.
      boOnly.push(r);
    } else if (inEde && !inBoActive) {
      edeOnly.push(r);
    } else if (!inEde && inBoActive && eligibleYes && rawInEde) {
      // Diagnostic — visible separately, not counted toward Should Be Paid.
      boActiveNonCurrentEde.push(r);
    } else if (inEde && inBoActive && !eligibleYes) {
      // Phase 1.7 fall-through (additive): EE member, active BO, but BO
      // flags eligible_for_commission != 'Yes'. Surfaces silently-dropped
      // rows; NOT counted in Should Be Paid.
      boIneligible.push(r);
    }
  }
  const rows = [...matched, ...boOnly, ...edeOnly];
  return {
    rows,
    matched,
    boOnly,
    edeOnly,
    boActiveNonCurrentEde,
    boIneligible,
    total: rows.length,
    matchedCount: matched.length,
    boOnlyCount: boOnly.length,
    edeOnlyCount: edeOnly.length,
    boActiveNonCurrentEdeCount: boActiveNonCurrentEde.length,
    boIneligibleCount: boIneligible.length,
  };
}

export interface ExpectedPaymentBreakdown<T = any> {
  /** All universe rows. */
  universe: ExpectedPaymentUniverse<T>;
  /** Rows in universe with in_commission=true (Expected Payments Received). */
  paidRows: T[];
  /** Rows in universe with in_commission=false (Expected But Unpaid). */
  unpaidRows: T[];
  paidCount: number;
  unpaidCount: number;
  /** Compact splits used by the bottom-of-card breakdowns. */
  paidSplit: { matched: number; boOnly: number; edeOnly: number };
  unpaidSplit: { matched: number; boOnly: number; edeOnly: number };
  /**
   * Bundle 4 / 4.5: premium-evidence split of Expected But Unpaid.
   * Classification uses `net_premium` ONLY (no fallback to gross premium):
   *   - `zeroNetPremium`: value is null/undefined/blank/non-numeric/0/negative
   *   - `hasPremium`:     parsed numeric value > 0
   * Counts sum exactly to `unpaidCount` for every scope.
   */
  unpaidPremiumSplit: { zeroNetPremium: number; hasPremium: number };
}

/**
 * Bundle 4 / 4.5: classify a row's premium evidence as zero-net-premium vs
 * has-premium. Centralized so dashboards / cards / tests share one rule.
 * Bundle 4.5: net_premium ONLY — no fallback to gross premium. A null
 * net_premium (incl. true-zero collapsed by reconcile) is Zero Net Premium
 * even when gross premium is positive. Upstream zero-vs-null collapse fix
 * remains queued for Bundle 5.
 */
export function classifyUnpaidPremium(row: any): 'zeroNetPremium' | 'hasPremium' {
  const raw = row?.net_premium ?? null;
  if (raw === null || raw === undefined) return 'zeroNetPremium';
  if (typeof raw === 'string' && raw.trim() === '') return 'zeroNetPremium';
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return 'zeroNetPremium';
  return n > 0 ? 'hasPremium' : 'zeroNetPremium';
}

/**
 * Paid vs unpaid decomposition of the Expected Payment Universe. Both
 * "Expected Payments Received" and "Expected But Unpaid" cards consume from
 * here; `Should Be Paid = paidCount + unpaidCount`.
 */
export function getExpectedPaymentBreakdown(
  reconciled: any[],
  scope: CanonicalScope,
  filteredEde: FilteredEdeResult,
  confirmedUpgradeMemberKeys: Set<string>,
): ExpectedPaymentBreakdown {
  const universe = getExpectedPaymentUniverse(reconciled, scope, filteredEde, confirmedUpgradeMemberKeys);
  const paidRows: any[] = [];
  const unpaidRows: any[] = [];
  const paidSplit = { matched: 0, boOnly: 0, edeOnly: 0 };
  const unpaidSplit = { matched: 0, boOnly: 0, edeOnly: 0 };
  const unpaidPremiumSplit = { zeroNetPremium: 0, hasPremium: 0 };
  const bucketFor = new Map<any, 'matched' | 'boOnly' | 'edeOnly'>();
  for (const r of universe.matched) bucketFor.set(r, 'matched');
  for (const r of universe.boOnly) bucketFor.set(r, 'boOnly');
  for (const r of universe.edeOnly) bucketFor.set(r, 'edeOnly');
  for (const r of universe.rows) {
    const bucket = bucketFor.get(r) ?? 'matched';
    if (r.in_commission) {
      paidRows.push(r);
      paidSplit[bucket] += 1;
    } else {
      unpaidRows.push(r);
      unpaidSplit[bucket] += 1;
      unpaidPremiumSplit[classifyUnpaidPremium(r)] += 1;
    }
  }
  return {
    universe,
    paidRows,
    unpaidRows,
    paidCount: paidRows.length,
    unpaidCount: unpaidRows.length,
    paidSplit,
    unpaidSplit,
    unpaidPremiumSplit,
  };
}

/**
 * Sum `estimated_missing_commission` across the canonical Expected But Unpaid
 * row set produced by {@link getExpectedPaymentBreakdown}. Null/undefined or
 * missing per-row estimates contribute 0 — commission-less batches
 * intentionally suppress phantom estimates and we do not fall back to a
 * computed value here. Mirrors `getExpectedPaymentBreakdown`'s input shape.
 */
export function getExpectedMissingCommissionSum(
  reconciled: any[],
  scope: CanonicalScope,
  filteredEde: FilteredEdeResult,
  confirmedUpgradeMemberKeys: Set<string>,
): number {
  const breakdown = getExpectedPaymentBreakdown(
    reconciled,
    scope,
    filteredEde,
    confirmedUpgradeMemberKeys,
  );
  let total = 0;
  for (const r of breakdown.unpaidRows) {
    const v = (r as any)?.estimated_missing_commission;
    if (typeof v === 'number' && Number.isFinite(v)) total += v;
  }
  return total;
}

export interface PaidEdeOnlyRow {
  row: any;
  bo_reason: 'BO inactive/terminated' | 'BO absent';
}

export type BoActiveNonCurrentEdeReason =
  | 'future-effective'
  | 'non-qualified-status'
  | 'aor-or-key-mismatch'
  | 'unknown';

export interface BoActiveNonCurrentEdeRow {
  row: any;
  reason: BoActiveNonCurrentEdeReason;
}

export interface SourceCoverageBuckets<T = any> {
  fullyMatchedPaid: { rows: T[]; count: number };
  paidBackOfficeOnly: { rows: T[]; count: number };
  paidEdeOnly: { rows: PaidEdeOnlyRow[]; count: number };
  paidCommissionStatementOnly: { rows: T[]; count: number };
  unpaidBackOfficeOnly: { rows: T[]; count: number };
  expectedButUnpaid: { rows: T[]; count: number };
  totalPoliciesPaid: { rows: T[]; count: number };
  /**
   * Diagnostic tile (Interpretation C): active BO + eligible Yes + raw
   * r.in_ede=true + NOT in current EE. Excluded from Should Be Paid /
   * Expected But Unpaid. Includes paid + unpaid; the paid subset still
   * appears in totalPoliciesPaid so paid math reconciles.
   */
  boActiveNonCurrentEde: {
    rows: BoActiveNonCurrentEdeRow[];
    count: number;
    paidCount: number;
    unpaidCount: number;
    /**
     * Aggregation of `rows[].reason` — one entry per BoActiveNonCurrentEdeReason
     * key. Cards consume these counts directly rather than re-reducing `rows`
     * inline. Keys mirror the reason classifier exactly.
     */
    reasonCounts: Record<BoActiveNonCurrentEdeReason, number>;
  };
}

/** YYYY-MM-DD → first-of-month for periodStart inputs. */
function periodStartIso(coveredMonths: string[] | string | undefined): string {
  if (!coveredMonths) return '';
  if (typeof coveredMonths === 'string') {
    return coveredMonths.length >= 7 ? `${coveredMonths.substring(0, 7)}-01` : coveredMonths;
  }
  const sorted = coveredMonths.filter(Boolean).slice().sort();
  const first = sorted[0];
  if (!first) return '';
  return `${first.substring(0, 7)}-01`;
}

/**
 * Single-helper Source Coverage tile producer. Returns rows + counts for
 * every Source Coverage tile so cards and drilldowns share one source.
 *
 * `coveredMonthsOrReconcileMonth` accepts either the Dashboard's covered-
 * months array (e.g. ['2026-01','2026-02']) or a single 'YYYY-MM' string.
 * It is used to drive the Paid: EDE Only bo_reason classification (against
 * raw BO normalizedRecords via isActiveBackOfficeRecord), distinguishing
 * "BO inactive/terminated" from "BO absent".
 */
export function getSourceCoverageBuckets(
  reconciled: any[],
  scope: CanonicalScope,
  filteredEde: FilteredEdeResult,
  normalizedRecords: any[],
  coveredMonthsOrReconcileMonth: string[] | string | undefined,
  confirmedUpgradeMemberKeys: Set<string>,
): SourceCoverageBuckets {
  const inScope = filterReconciledByScope(reconciled, scope);
  const universe = getExpectedPaymentUniverse(reconciled, scope, filteredEde, confirmedUpgradeMemberKeys);
  const eeUniverse = new Set(filteredEde.uniqueMembers.map((m) => m.member_key));

  const isInEde = (r: any) => eeUniverse.has(r.member_key);
  const isBoActive = (r: any) =>
    !!r.in_back_office || confirmedUpgradeMemberKeys.has(r.member_key);

  // Index BO normalized records by every ID candidate so we can detect
  // "BO row exists but inactive" vs "BO absent" for Paid: EDE Only rows.
  const boByIssuer = new Map<string, any>();
  const boByExch = new Map<string, any>();
  const boByPolicy = new Map<string, any>();
  const boByMemberKey = new Map<string, any>();
  for (const rec of normalizedRecords) {
    if (rec.source_type !== 'BACK_OFFICE') continue;
    if (rec.issuer_subscriber_id && !boByIssuer.has(rec.issuer_subscriber_id)) boByIssuer.set(rec.issuer_subscriber_id, rec);
    if (rec.exchange_subscriber_id && !boByExch.has(rec.exchange_subscriber_id)) boByExch.set(rec.exchange_subscriber_id, rec);
    if (rec.policy_number && !boByPolicy.has(rec.policy_number)) boByPolicy.set(rec.policy_number, rec);
    if (rec.member_key && !boByMemberKey.has(rec.member_key)) boByMemberKey.set(rec.member_key, rec);
  }
  const periodStart = periodStartIso(coveredMonthsOrReconcileMonth);
  const findBoRecord = (m: any): any | null => {
    return (
      (m.issuer_subscriber_id && boByIssuer.get(m.issuer_subscriber_id)) ||
      (m.exchange_subscriber_id && boByExch.get(m.exchange_subscriber_id)) ||
      (m.policy_number && boByPolicy.get(m.policy_number)) ||
      (m.member_key && boByMemberKey.get(m.member_key)) ||
      null
    );
  };

  // Fully Matched & Paid — universe.matched ∩ in_commission.
  const fullyMatchedPaidRows = universe.matched.filter((r) => r.in_commission);
  // Paid: Back Office Only — universe.boOnly ∩ in_commission.
  const paidBackOfficeOnlyRows = universe.boOnly.filter((r) => r.in_commission);
  // Paid: EDE Only — universe.edeOnly ∩ in_commission, with bo_reason.
  const paidEdeOnlyRows: PaidEdeOnlyRow[] = [];
  for (const r of universe.edeOnly) {
    if (!r.in_commission) continue;
    const boRec = findBoRecord(r);
    let bo_reason: 'BO inactive/terminated' | 'BO absent';
    if (boRec) {
      const active = periodStart
        ? isActiveBackOfficeRecord({ source_type: 'BACK_OFFICE', ...boRec }, periodStart)
        : true;
      bo_reason = active ? 'BO absent' : 'BO inactive/terminated';
    } else {
      bo_reason = 'BO absent';
    }
    paidEdeOnlyRows.push({ row: r, bo_reason });
  }
  // Paid: Commission Statement Only — paid, NOT in EDE, NOT BO-active.
  const paidCommissionOnlyRows = inScope.filter(
    (r) => !isInEde(r) && !isBoActive(r) && r.in_commission,
  );
  // Unpaid: Back Office Only — TRUE BO-only unpaid (universe.boOnly ∩ !in_commission).
  // Interpretation C: rows with raw r.in_ede=true that fall outside the
  // current EE universe live in the diagnostic bucket, not here.
  const unpaidBackOfficeOnlyRows = universe.boOnly.filter((r) => !r.in_commission);
  // Expected But Unpaid — same as breakdown.unpaid (universe ∩ !in_commission).
  const expectedButUnpaidRows = universe.rows.filter((r) => !r.in_commission);
  // Total Policies Paid — every in-scope row with in_commission=true.
  const totalPoliciesPaidRows = inScope.filter((r) => r.in_commission);

  // ----- Diagnostic: BO Active w/ Non-current EDE -----
  // Index EDE normalized rows by every member-id candidate so we can attempt
  // a reason classification (future-effective / non-qualified / mismatch).
  const edeByIssuer = new Map<string, any[]>();
  const edeByExch = new Map<string, any[]>();
  const edeByPolicy = new Map<string, any[]>();
  const edeByMemberKey = new Map<string, any[]>();
  const pushIdx = (m: Map<string, any[]>, k: string | undefined | null, v: any) => {
    if (!k) return;
    const arr = m.get(k); if (arr) arr.push(v); else m.set(k, [v]);
  };
  for (const rec of normalizedRecords) {
    if (rec.source_type !== 'EDE') continue;
    pushIdx(edeByIssuer, rec.issuer_subscriber_id, rec);
    pushIdx(edeByExch, rec.exchange_subscriber_id, rec);
    pushIdx(edeByPolicy, rec.policy_number, rec);
    pushIdx(edeByMemberKey, rec.member_key, rec);
  }
  const findEdeRows = (m: any): any[] => {
    const acc: any[] = [];
    const seen = new Set<any>();
    const push = (rows?: any[]) => {
      if (!rows) return;
      for (const r of rows) { if (!seen.has(r)) { seen.add(r); acc.push(r); } }
    };
    push(edeByIssuer.get(m.issuer_subscriber_id));
    push(edeByExch.get(m.exchange_subscriber_id));
    push(edeByPolicy.get(m.policy_number));
    push(edeByMemberKey.get(m.member_key));
    return acc;
  };
  const QUALIFIED_RAW_STATUSES = new Set(['effectuated', 'pendingeffectuation', 'pendingtermination']);
  const earliestCovered = (() => {
    if (!coveredMonthsOrReconcileMonth) return '';
    if (typeof coveredMonthsOrReconcileMonth === 'string') return coveredMonthsOrReconcileMonth.substring(0, 7);
    const sorted = coveredMonthsOrReconcileMonth.filter(Boolean).slice().sort();
    return (sorted[0] || '').substring(0, 7);
  })();
  const latestCovered = (() => {
    if (!coveredMonthsOrReconcileMonth) return '';
    if (typeof coveredMonthsOrReconcileMonth === 'string') return coveredMonthsOrReconcileMonth.substring(0, 7);
    const sorted = coveredMonthsOrReconcileMonth.filter(Boolean).slice().sort();
    return (sorted[sorted.length - 1] || '').substring(0, 7);
  })();
  const classifyReason = (m: any): BoActiveNonCurrentEdeReason => {
    const edeRows = findEdeRows(m);
    if (edeRows.length === 0) return 'aor-or-key-mismatch';
    let sawFutureEffective = false;
    let sawNonQualified = false;
    let sawAnyQualified = false;
    for (const er of edeRows) {
      const raw = (er.raw_json || {}) as Record<string, any>;
      const status = String(raw.policyStatus ?? er.status ?? '').toLowerCase().replace(/\s+/g, '');
      const qualified = QUALIFIED_RAW_STATUSES.has(status);
      if (!qualified) { sawNonQualified = true; continue; }
      sawAnyQualified = true;
      const eff = String(er.effective_date || '').substring(0, 7);
      if (latestCovered && eff && eff > latestCovered) sawFutureEffective = true;
    }
    if (sawFutureEffective) return 'future-effective';
    if (!sawAnyQualified && sawNonQualified) return 'non-qualified-status';
    // Qualified EDE evidence exists in scope but didn't land in this batch's
    // EE universe — most often AOR routing or member-key resolution issue.
    if (sawAnyQualified) return 'aor-or-key-mismatch';
    return 'unknown';
  };
  const boActiveNonCurrentEdeRows: BoActiveNonCurrentEdeRow[] = universe.boActiveNonCurrentEde.map(
    (r) => ({ row: r, reason: classifyReason(r) }),
  );
  const boActiveNonCurrentEdePaidCount = boActiveNonCurrentEdeRows.filter((x) => x.row.in_commission).length;
  const boActiveNonCurrentEdeUnpaidCount = boActiveNonCurrentEdeRows.length - boActiveNonCurrentEdePaidCount;
  const reasonCounts: Record<BoActiveNonCurrentEdeReason, number> = {
    'future-effective': 0,
    'non-qualified-status': 0,
    'aor-or-key-mismatch': 0,
    'unknown': 0,
  };
  for (const r of boActiveNonCurrentEdeRows) {
    reasonCounts[r.reason] = (reasonCounts[r.reason] ?? 0) + 1;
  }

  return {
    fullyMatchedPaid: { rows: fullyMatchedPaidRows, count: fullyMatchedPaidRows.length },
    paidBackOfficeOnly: { rows: paidBackOfficeOnlyRows, count: paidBackOfficeOnlyRows.length },
    paidEdeOnly: { rows: paidEdeOnlyRows, count: paidEdeOnlyRows.length },
    paidCommissionStatementOnly: { rows: paidCommissionOnlyRows, count: paidCommissionOnlyRows.length },
    unpaidBackOfficeOnly: { rows: unpaidBackOfficeOnlyRows, count: unpaidBackOfficeOnlyRows.length },
    expectedButUnpaid: { rows: expectedButUnpaidRows, count: expectedButUnpaidRows.length },
    totalPoliciesPaid: { rows: totalPoliciesPaidRows, count: totalPoliciesPaidRows.length },
    boActiveNonCurrentEde: {
      rows: boActiveNonCurrentEdeRows,
      count: boActiveNonCurrentEdeRows.length,
      paidCount: boActiveNonCurrentEdePaidCount,
      unpaidCount: boActiveNonCurrentEdeUnpaidCount,
      reasonCounts,
    },
  };
}

// ===========================================================================
// Bundle 4 — Total Policies Paid attribution split (JF/EF/BS/Downlines/Vix).
//
// Maps each Total Policies Paid policy back to its positive normalized
// commission-row evidence and assigns ONE bucket per policy via priority:
//   Vix  > EF > JF > BS > Downlines
// (Erica's Vix-statement activity belongs under Vix, not EF — Vix wins by
// pay_entity regardless of agent NPN.) Counts sum exactly to the parent
// totalPoliciesPaid count under All / Coverall scopes when commission
// evidence exists for every paid row, which is the canonical invariant
// (a row only enters totalPoliciesPaid when in_commission=true).
// ===========================================================================

export type PaidAttributionBucket = 'JF' | 'EF' | 'BS' | 'Downlines' | 'Vix';

export interface PaidAttributionSplitCounts {
  JF: number;
  EF: number;
  BS: number;
  Downlines: number;
  Vix: number;
  /** Rows with no positive commission evidence — should be 0; surfaced for diagnostics. */
  unattributed: number;
}

const ATTRIBUTION_NPN_JF = '21055210';
const ATTRIBUTION_NPN_EF = '21277051';
const ATTRIBUTION_NPN_BS = '16531877';

function recHasNpn(rec: any, npn: string): boolean {
  return (
    String(rec?.agent_npn ?? '').trim() === npn ||
    String(rec?.writing_agent_carrier_id ?? '').trim() === npn
  );
}

/**
 * Classify one paid policy into a single attribution bucket given its
 * positive commission evidence rows. Priority: Vix > EF > JF > BS > Downlines.
 * Returns null when no positive evidence exists.
 */
export function classifyPaidAttribution(
  positiveEvidence: any[],
): PaidAttributionBucket | null {
  if (!positiveEvidence || positiveEvidence.length === 0) return null;
  if (positiveEvidence.some((r) => r.pay_entity === 'Vix')) return 'Vix';
  if (positiveEvidence.some((r) => r.pay_entity === 'Coverall' && recHasNpn(r, ATTRIBUTION_NPN_EF))) return 'EF';
  if (positiveEvidence.some((r) => r.pay_entity === 'Coverall' && recHasNpn(r, ATTRIBUTION_NPN_JF))) return 'JF';
  if (positiveEvidence.some((r) => r.pay_entity === 'Coverall' && recHasNpn(r, ATTRIBUTION_NPN_BS))) return 'BS';
  if (positiveEvidence.some((r) => r.pay_entity === 'Coverall')) return 'Downlines';
  return null;
}

/**
 * For each Total Policies Paid policy, find its positive commission rows in
 * `normalizedRecords` and assign one bucket per priority order.
 *
 * Bundle 4.5: evidence is indexed by multiple stable identity fields
 * (member_key, policy_number, issuer_subscriber_id, exchange_subscriber_id)
 * so paid rows whose reconciled member_key differs from the raw normalized
 * commission-row key still attribute. A paid row's evidence is the union of
 * matches across any of these keys (de-duplicated). Returns split counts.
 */
function evidenceKeysOf(rec: any): string[] {
  const keys: string[] = [];
  const push = (prefix: string, v: any) => {
    if (v === null || v === undefined) return;
    const s = String(v).trim();
    if (!s) return;
    keys.push(`${prefix}:${s}`);
  };
  push('mk', rec.member_key);
  push('pol', rec.policy_number);
  push('iss', rec.issuer_subscriber_id);
  push('exc', rec.exchange_subscriber_id);
  return keys;
}

export function getTotalPoliciesPaidAttribution(
  totalPoliciesPaidRows: any[],
  normalizedRecords: any[],
): PaidAttributionSplitCounts {
  const positiveByKey = new Map<string, any[]>();
  for (const rec of normalizedRecords) {
    if (rec.source_type !== 'COMMISSION') continue;
    if (!(Number(rec.commission_amount) > 0)) continue;
    for (const k of evidenceKeysOf(rec)) {
      const arr = positiveByKey.get(k);
      if (arr) arr.push(rec); else positiveByKey.set(k, [rec]);
    }
  }
  const out: PaidAttributionSplitCounts = {
    JF: 0, EF: 0, BS: 0, Downlines: 0, Vix: 0, unattributed: 0,
  };
  for (const r of totalPoliciesPaidRows) {
    const seen = new Set<any>();
    const evidence: any[] = [];
    for (const k of evidenceKeysOf(r)) {
      const arr = positiveByKey.get(k);
      if (!arr) continue;
      for (const rec of arr) {
        if (seen.has(rec)) continue;
        seen.add(rec);
        evidence.push(rec);
      }
    }
    const bucket = classifyPaidAttribution(evidence);
    if (bucket) out[bucket] += 1;
    else out.unattributed += 1;
  }
  return out;
}
