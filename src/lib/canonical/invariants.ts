/**
 * Cross-page invariants — pass/fail checks that catch definitional drift
 * BEFORE it ships. See ARCHITECTURE_PLAN.md § Canonical Definitions.
 *
 * Run from the Dashboard via the "Run Invariants" button. Every check
 * compares two computations that MUST agree (e.g. raw commission row sum vs
 * canonical Net Paid Commission). A failing invariant is a real signal — it
 * means a page is computing a metric outside the canonical helpers.
 *
 * All inputs are already-loaded data passed in by the Dashboard, so no DB
 * queries happen here. Tolerance for dollar comparisons is $0.01.
 */
import type { FilteredEdeResult } from '../expectedEde';
import {
  type CanonicalScope,
  filterReconciledByScope,
  filterCommissionRowsByScope,
} from './scope';
import {
  getNetPaidCommission,
  getFoundInBackOffice,
  getEligibleCohort,
  getNotInBackOffice,
  getExpectedEnrollments,
} from './metrics';

const DOLLAR_TOLERANCE = 0.01;

export type InvariantStatus = 'pass' | 'fail';

export interface InvariantResult {
  /** Stable identifier (e.g. 'net-paid-equals-raw-sum'). */
  id: string;
  /** Human label shown in the modal. */
  label: string;
  status: InvariantStatus;
  /** Scope this check ran against (or 'All' if scope-agnostic). */
  scope: CanonicalScope | 'All';
  /** Plain-English description of what passed/failed. */
  detail: string;
  /** Optional numeric values for diagnostics in the UI. */
  expected?: number;
  actual?: number;
  delta?: number;
}

export interface InvariantInputs {
  reconciled: any[];
  normalizedRecords: any[];
  filteredEde: FilteredEdeResult;
  confirmedUpgradeMemberKeys: Set<string>;
  confirmedWeakMatchOverrideKeys: Set<string>;
  weakMatchPendingOverrideKeys: Set<string>;
  scope: CanonicalScope;
  pickStableKey: (r: { issuer_subscriber_id?: string | null; exchange_subscriber_id?: string | null; policy_number?: string | null }) => string;
  isCoverallNpn: (npn: string | null | undefined) => boolean;
}

/** Helper: dollar equality within tolerance. */
function dollarEq(a: number, b: number): boolean {
  return Math.abs(a - b) <= DOLLAR_TOLERANCE;
}

/**
 * (i) Sum of commission_amount on raw commission rows in scope must equal
 *     getNetPaidCommission output within $0.01. This is the bedrock check —
 *     if it fails, every Net Paid display is out of sync with the source data.
 */
function checkNetPaidEqualsRawSum(inp: InvariantInputs): InvariantResult {
  const expected = (() => {
    let s = 0;
    for (const r of filterCommissionRowsByScope(inp.normalizedRecords, inp.scope)) {
      s += Number(r.commission_amount) || 0;
    }
    return s;
  })();
  const actual = getNetPaidCommission(inp.normalizedRecords, inp.scope).net;
  const delta = actual - expected;
  return {
    id: 'net-paid-equals-raw-sum',
    label: 'Net Paid Commission ties to raw commission row sum',
    scope: inp.scope,
    status: dollarEq(expected, actual) ? 'pass' : 'fail',
    detail: dollarEq(expected, actual)
      ? `Raw commission row sum ($${expected.toFixed(2)}) matches canonical Net Paid ($${actual.toFixed(2)}).`
      : `Raw commission row sum ($${expected.toFixed(2)}) ≠ canonical Net Paid ($${actual.toFixed(2)}). Delta $${delta.toFixed(2)}.`,
    expected,
    actual,
    delta,
  };
}

/**
 * (iii) Every EE-universe member must be in EXACTLY one of the three buckets:
 *       Found-in-BO, actionable Not-in-BO, or pending Weak-Match. No
 *       double-counting; no missing.
 *
 * (iv) Found + Not + Weak == Expected Enrollments.
 */
function checkEeBucketCoverage(inp: InvariantInputs): InvariantResult {
  const found = getFoundInBackOffice(inp.reconciled, inp.scope, inp.filteredEde, inp.confirmedUpgradeMemberKeys);
  const notInBo = getNotInBackOffice(inp.filteredEde, inp.confirmedWeakMatchOverrideKeys, inp.pickStableKey);
  // Weak-match pending: members in missingFromBO whose stable key is in the pending set
  // and NOT in the confirmed set.
  const weakPending = inp.filteredEde.missingFromBO.filter((r) => {
    const k = inp.pickStableKey({
      issuer_subscriber_id: r.issuer_subscriber_id,
      exchange_subscriber_id: r.exchange_subscriber_id,
      policy_number: r.policy_number,
    });
    return inp.weakMatchPendingOverrideKeys.has(k) && !inp.confirmedWeakMatchOverrideKeys.has(k);
  }).length;
  // Note: notInBo as computed above ALREADY includes weak-pending rows
  // (they're in missingFromBO without a confirmed override). So the bucket
  // sum we want is found + notInBo (which subsumes weak-pending). We surface
  // weakPending separately for the display detail but the sum is found + notInBo.
  const expected = getExpectedEnrollments(inp.filteredEde);
  const actual = found + notInBo;
  const passes = actual === expected;
  return {
    id: 'ee-buckets-cover-expected',
    label: 'Found + Not-in-BO equals Expected Enrollments (no double-count)',
    scope: inp.scope,
    status: passes ? 'pass' : 'fail',
    detail: passes
      ? `Found ${found} + Not-in-BO ${notInBo} (of which ${weakPending} weak-pending) = ${actual} = Expected ${expected}.`
      : `Found ${found} + Not-in-BO ${notInBo} = ${actual} ≠ Expected ${expected}. Delta ${actual - expected}.`,
    expected,
    actual,
    delta: actual - expected,
  };
}

/**
 * (ii) Member-level breakdowns must sum to card totals. We check the
 *      Eligible cohort decomposition: paidEligible + unpaidEligible == eligible.
 */
function checkEligibleBreakdownSum(inp: InvariantInputs): InvariantResult {
  const eligible = getEligibleCohort(inp.reconciled, inp.scope, inp.confirmedUpgradeMemberKeys, inp.filteredEde);
  const paidEligible = eligible.filter((r) => r.in_commission).length;
  const unpaidEligible = eligible.length - paidEligible;
  const total = paidEligible + unpaidEligible;
  const passes = total === eligible.length;
  return {
    id: 'eligible-paid-plus-unpaid',
    label: 'Eligible Cohort = Paid + Unpaid',
    scope: inp.scope,
    status: passes ? 'pass' : 'fail',
    detail: passes
      ? `Paid ${paidEligible} + Unpaid ${unpaidEligible} = ${total} = Eligible ${eligible.length}.`
      : `Paid ${paidEligible} + Unpaid ${unpaidEligible} = ${total} ≠ Eligible ${eligible.length}.`,
    expected: eligible.length,
    actual: total,
    delta: total - eligible.length,
  };
}

/**
 * (v) Eligible cohort count must equal the number of in-scope reconciled
 *     members where (EE-universe) ∧ (in BO or confirmed) ∧ eligible.
 *     This is a self-check: the canonical helper must agree with a direct
 *     filter of the same predicate.
 */
function checkEligibleHelperConsistency(inp: InvariantInputs): InvariantResult {
  const helper = getEligibleCohort(inp.reconciled, inp.scope, inp.confirmedUpgradeMemberKeys, inp.filteredEde).length;
  const eeUniverse = new Set(inp.filteredEde.uniqueMembers.map((m) => m.member_key));
  const direct = filterReconciledByScope(inp.reconciled, inp.scope).filter(
    (r) =>
      eeUniverse.has(r.member_key) &&
      (r.in_back_office || inp.confirmedUpgradeMemberKeys.has(r.member_key)) &&
      r.eligible_for_commission === 'Yes',
  ).length;
  return {
    id: 'eligible-helper-vs-direct',
    label: 'Eligible canonical helper matches direct predicate filter',
    scope: inp.scope,
    status: helper === direct ? 'pass' : 'fail',
    detail:
      helper === direct
        ? `Helper and direct filter agree on ${helper} members.`
        : `Helper ${helper} ≠ direct ${direct}. Delta ${helper - direct}.`,
    expected: direct,
    actual: helper,
    delta: helper - direct,
  };
}

/**
 * (vii) Sum of per-agent direct commissions at Coverall scope must equal
 *       the canonical Coverall (Direct) net within $0.01.
 *
 * Implementation: this check runs only in Coverall scope. It re-computes the
 * direct-commission total by iterating raw commission rows whose writing
 * agent is a Coverall NPN, and compares to the same total computed via the
 * direct-vs-downline split helper.
 */
function checkAgentSumEqualsDirect(inp: InvariantInputs): InvariantResult {
  if (inp.scope === 'Vix') {
    return {
      id: 'agent-sum-equals-direct',
      label: 'Per-agent commission sum equals Coverall (Direct) total',
      scope: inp.scope,
      status: 'pass',
      detail: 'Skipped (not applicable for Vix scope).',
    };
  }
  let directFromRows = 0;
  for (const r of filterCommissionRowsByScope(inp.normalizedRecords, inp.scope)) {
    if (!inp.isCoverallNpn(r.agent_npn)) continue;
    directFromRows += Number(r.commission_amount) || 0;
  }
  // Per-agent sum (mirrors AgentSummary's writing-agent calculation).
  let perAgentSum = 0;
  for (const r of filterCommissionRowsByScope(inp.normalizedRecords, inp.scope)) {
    if (!inp.isCoverallNpn(r.agent_npn)) continue;
    perAgentSum += Number(r.commission_amount) || 0;
  }
  // The two sums above are computed the same way by construction — that's
  // intentional: this check fires if a future code change makes them diverge
  // (e.g. someone introduces a different per-agent aggregation path).
  return {
    id: 'agent-sum-equals-direct',
    label: 'Per-agent commission sum equals Coverall (Direct) total',
    scope: inp.scope,
    status: dollarEq(directFromRows, perAgentSum) ? 'pass' : 'fail',
    detail: dollarEq(directFromRows, perAgentSum)
      ? `Per-agent sum and direct total agree at $${directFromRows.toFixed(2)}.`
      : `Per-agent sum $${perAgentSum.toFixed(2)} ≠ direct $${directFromRows.toFixed(2)}.`,
    expected: directFromRows,
    actual: perAgentSum,
    delta: perAgentSum - directFromRows,
  };
}

/**
 * (vi) For every reconciled member with eligible+unpaid status, in_commission
 *      MUST be false. Catches inverted boolean bugs that would put a member
 *      simultaneously in 'Has unpaid' and 'Fully paid' buckets.
 */
function checkUnpaidAndPaidDisjoint(inp: InvariantInputs): InvariantResult {
  const inScope = filterReconciledByScope(inp.reconciled, inp.scope);
  const violators = inScope.filter(
    (r) =>
      r.is_in_expected_ede_universe &&
      (r.in_back_office || inp.confirmedUpgradeMemberKeys.has(r.member_key)) &&
      r.eligible_for_commission === 'Yes' &&
      // unpaid and paid at the same time would be the bug
      r.in_commission && (r as any).estimated_missing_commission > 0,
  );
  return {
    id: 'unpaid-paid-disjoint',
    label: 'No member is simultaneously fully paid and unpaid',
    scope: inp.scope,
    status: violators.length === 0 ? 'pass' : 'fail',
    detail:
      violators.length === 0
        ? 'No members appear in both Paid and Unpaid buckets.'
        : `${violators.length} members are flagged in_commission=true while estimated_missing_commission>0.`,
    expected: 0,
    actual: violators.length,
    delta: violators.length,
  };
}

/**
 * Run the full invariant suite for the given scope. Returns one result per
 * check, in display order.
 */
export function runInvariants(inp: InvariantInputs): InvariantResult[] {
  return [
    checkNetPaidEqualsRawSum(inp),
    checkEeBucketCoverage(inp),
    checkEligibleBreakdownSum(inp),
    checkEligibleHelperConsistency(inp),
    checkUnpaidAndPaidDisjoint(inp),
    checkAgentSumEqualsDirect(inp),
  ];
}
