/**
 * Phase C1a — Blocker-facts layer.
 *
 * PURE computed layer. NO writes (no operator_decisions rows, nothing).
 * NO routing, NO queues, NO UI. Caller assembles the inputs from the
 * certified MT/MCE pipeline (cached all-batch projection, classifier per
 * scope, picker map) and passes them in here.
 *
 * Four facts per (member, service_month, target_scope):
 *
 *   premium                — passthrough of the certified target-scope cell
 *                            state; never recomputed.
 *   dmi                    — active DMI on the picked service-month EDE
 *                            record (raw accessor in dmiSignal.ts). Stale
 *                            historical EDE rows are never scanned. Picker
 *                            null → no DMI. surfaceEligible is unpaid-cohort
 *                            only (MVP gate); paid+DMI is captured but
 *                            surfaceEligible=false (clawback-risk feed,
 *                            future).
 *   crossEntitySatisfied   — D2: satisfied iff the OTHER pay entity's
 *                            certified per-scope classifier state for the
 *                            same member-month is paid. Reversed/paired-
 *                            reversal never satisfies. Symmetric.
 *   amount                 — G6: runs on target-scope PAID cells AND on
 *                            cross-entity-satisfied cells. Expected basis
 *                            comes from the existing resolver stack
 *                            (createEstMissingResolver). Resolver failures
 *                            map to indeterminate(reason) — never
 *                            wrong_amount. A wrong-amount satisfying payment
 *                            yields crossEntitySatisfied with
 *                            amountStatus='wrong_amount' (engine routes to
 *                            amount-discrepancy, not chase-close).
 *
 * No prior-balance fact — B2 is a manual operator hold by design.
 */
import type { CellClassification, ClassificationState, PayEntityScope } from '../classifier';
import type { NormalizedRecord } from '../normalize';
import { getDmiSignal, isDmiExpired, type DmiSignal } from './dmiSignal';
import type {
  EstMissingResolution,
  EstMissingInputEvidence,
  UnsupportedReason,
} from './estMissingResolver';

// ----- Per-fact output types ------------------------------------------------

export type PremiumFact =
  | { kind: 'premium_blocked' }       // not_expected_premium_unpaid
  | { kind: 'chase_candidate' }       // unpaid
  | { kind: 'not_applicable' };       // any other certified state

export interface DmiFact {
  active: boolean;
  issueType: string | null;
  verificationEndDate: string | null;
  expired: boolean;
  inProgress: boolean;
  /** MVP surface gate: only unpaid-cohort active-DMI is surfaced in the
   *  chase workflow. Paid+DMI is captured for a future clawback-risk queue. */
  surfaceEligible: boolean;
}

export type AmountStatus =
  | { kind: 'correct' }
  | { kind: 'wrong_amount'; actual: number; expected: number }
  | { kind: 'indeterminate'; reason: AmountIndeterminateReason }
  | { kind: 'not_applicable' };

export type AmountIndeterminateReason =
  | UnsupportedReason
  | 'TBD_AMBIGUOUS_PAYEE'
  | 'NO_EXPECTED_BASIS';

export interface CrossEntitySatisfiedFact {
  satisfied: boolean;
  satisfyingEntity: 'Coverall' | 'Vix' | null;
  actualPaid: number | null;
  expectedBasis: number | null;
  amountStatus: AmountStatus;
}

export type MemberCountFact =
  | { status: 'ok' }
  | { status: 'unresolved' }
  | { status: 'manual_review'; reason: 'member_count_manual_review'; conflicts?: number[] };

export interface BlockerFacts {
  premium: PremiumFact;
  dmi: DmiFact;
  crossEntitySatisfied: CrossEntitySatisfiedFact;
  amount: AmountStatus;
  /** C2b-1 Stage 2 (R-CARR-007). Optional + additive — absent or
   *  `{status:'ok'}` leaves all existing routes unchanged. */
  memberCount?: MemberCountFact;
}

// ----- Inputs --------------------------------------------------------------

/** Other-entity classifier evidence for the same member-month. */
export interface OtherEntityCell {
  payEntity: 'Coverall' | 'Vix';
  state: ClassificationState;
  paid_amount: number;
}

export interface BlockerFactsInputs {
  /** Target pay-entity scope this facts row is for. */
  targetScope: PayEntityScope;
  /** Certified target-scope cell from MT classifier. */
  targetCell: CellClassification;
  /** Picked EDE record for the service month from
   *  buildMonthPickerMapForMember/pickEdeForServiceMonth — MAY be null. */
  pickedEdeForMonth: NormalizedRecord | null;
  /** Today's date 'YYYY-MM-DD' for verificationEndDate expiry. */
  today: string;
  /** The OTHER pay entity's certified per-scope cell for the same
   *  member-month. null when scope is 'All' or no other-entity cell exists. */
  otherEntityCell: OtherEntityCell | null;
  /** EstMissing input evidence — used by the resolver to compute the
   *  expected amount. Optional: caller may pre-resolve and pass
   *  preResolved* instead. */
  evidenceForResolver?: EstMissingInputEvidence;
  /** A bound resolver — usually `createEstMissingResolver(ctx).resolve`.
   *  Optional when preResolvedTarget/preResolvedOther is supplied. */
  resolve?: (args: {
    member_key: string;
    inputEvidence?: EstMissingInputEvidence;
  }) => EstMissingResolution;
  /** Member key for resolver lookups. */
  memberKey: string;
  /** Optional: pre-computed resolver result for the target-scope expected
   *  basis (skips the resolve callback). */
  preResolvedTarget?: EstMissingResolution;
  /** Optional: pre-computed resolver result for the OTHER-entity expected
   *  basis (override-aware via getExpectedCommissionForClearing — Vix flat
   *  override is honoured because that wrapper is what the resolver calls). */
  preResolvedOther?: EstMissingResolution;
}

// ----- premium passthrough --------------------------------------------------

function classifyPremium(state: ClassificationState): PremiumFact {
  if (state === 'not_expected_premium_unpaid') return { kind: 'premium_blocked' };
  if (state === 'unpaid') return { kind: 'chase_candidate' };
  return { kind: 'not_applicable' };
}

// ----- dmi ------------------------------------------------------------------

function buildDmiFact(
  pickedEde: NormalizedRecord | null,
  today: string,
  cohort: 'paid' | 'unpaid' | 'other',
): DmiFact {
  const signal: DmiSignal | null = getDmiSignal(pickedEde as any);
  if (!signal) {
    return {
      active: false,
      issueType: null,
      verificationEndDate: null,
      expired: false,
      inProgress: false,
      surfaceEligible: false,
    };
  }
  return {
    active: true,
    issueType: signal.issueType,
    verificationEndDate: signal.verificationEndDate,
    expired: isDmiExpired(signal, today),
    inProgress: signal.documentUploaded,
    surfaceEligible: cohort === 'unpaid',
  };
}

function cohortFromState(state: ClassificationState): 'paid' | 'unpaid' | 'other' {
  if (state === 'paid') return 'paid';
  if (state === 'unpaid') return 'unpaid';
  return 'other';
}

// ----- amount ---------------------------------------------------------------

function resolutionToExpected(
  res: EstMissingResolution | undefined,
): { expected: number | null; failureReason: AmountIndeterminateReason | null } {
  if (!res) return { expected: null, failureReason: 'NO_EXPECTED_BASIS' };
  if (res.status === 'RESOLVED' || res.status === 'RESOLVED_WITH_OVERRIDE') {
    return { expected: res.amount, failureReason: null };
  }
  if (res.status === 'PARTIAL_CLEARED_REMAINDER') {
    // Treat the remainder as the expected basis for the still-due amount.
    return { expected: res.amount, failureReason: null };
  }
  if (res.status === 'TBD_AMBIGUOUS_PAYEE') {
    return { expected: null, failureReason: 'TBD_AMBIGUOUS_PAYEE' };
  }
  // UNSUPPORTED
  return {
    expected: null,
    failureReason: (res.unsupported_reason as AmountIndeterminateReason) ?? 'NO_EXPECTED_BASIS',
  };
}

function compareAmount(actual: number, expected: number | null): AmountStatus {
  if (expected === null) {
    return { kind: 'indeterminate', reason: 'NO_EXPECTED_BASIS' };
  }
  const a = Math.round(actual * 100);
  const e = Math.round(expected * 100);
  if (a === e) return { kind: 'correct' };
  return { kind: 'wrong_amount', actual, expected };
}

function resolveExpectedForTarget(inputs: BlockerFactsInputs): EstMissingResolution | undefined {
  if (inputs.preResolvedTarget) return inputs.preResolvedTarget;
  if (!inputs.resolve || !inputs.evidenceForResolver) return undefined;
  return inputs.resolve({
    member_key: inputs.memberKey,
    inputEvidence: inputs.evidenceForResolver,
  });
}

function resolveExpectedForOther(inputs: BlockerFactsInputs): EstMissingResolution | undefined {
  if (inputs.preResolvedOther) return inputs.preResolvedOther;
  if (!inputs.resolve || !inputs.evidenceForResolver) return undefined;
  if (!inputs.otherEntityCell) return undefined;
  // The resolver consumes matched_payee on the input evidence — caller is
  // expected to pass evidence whose matched_payee reflects the satisfying
  // (other) entity for an override-aware expected basis (Vix $4.50, etc.).
  const ev: EstMissingInputEvidence = {
    ...inputs.evidenceForResolver,
    matched_payee: inputs.otherEntityCell.payEntity,
  };
  return inputs.resolve({
    member_key: inputs.memberKey,
    inputEvidence: ev,
  });
}

// ----- cross-entity satisfied (D2) ------------------------------------------

function buildCrossEntitySatisfied(
  inputs: BlockerFactsInputs,
): CrossEntitySatisfiedFact {
  const other = inputs.otherEntityCell;
  if (!other) {
    return {
      satisfied: false,
      satisfyingEntity: null,
      actualPaid: null,
      expectedBasis: null,
      amountStatus: { kind: 'not_applicable' },
    };
  }
  // Hard rule: only `paid` satisfies. reversed/paired-reversal/anything
  // else does NOT satisfy.
  if (other.state !== 'paid') {
    return {
      satisfied: false,
      satisfyingEntity: null,
      actualPaid: null,
      expectedBasis: null,
      amountStatus: { kind: 'not_applicable' },
    };
  }
  const otherRes = resolveExpectedForOther(inputs);
  const { expected, failureReason } = resolutionToExpected(otherRes);
  const amountStatus: AmountStatus = failureReason
    ? { kind: 'indeterminate', reason: failureReason }
    : compareAmount(other.paid_amount, expected);
  return {
    satisfied: true,
    satisfyingEntity: other.payEntity,
    actualPaid: other.paid_amount,
    expectedBasis: expected,
    amountStatus,
  };
}

// ----- main -----------------------------------------------------------------

export function buildBlockerFacts(inputs: BlockerFactsInputs): BlockerFacts {
  // Premium passthrough — never recompute.
  const premium = classifyPremium(inputs.targetCell.state);

  // DMI — picked EDE only (no historical scan). Surface gate is unpaid-only.
  const cohort = cohortFromState(inputs.targetCell.state);
  const dmi = buildDmiFact(inputs.pickedEdeForMonth, inputs.today, cohort);

  // Cross-entity satisfied (D2).
  const crossEntitySatisfied = buildCrossEntitySatisfied(inputs);

  // Amount (G6) — runs on target-paid OR cross-entity-satisfied cells.
  let amount: AmountStatus = { kind: 'not_applicable' };
  if (inputs.targetCell.state === 'paid') {
    const targetRes = resolveExpectedForTarget(inputs);
    const { expected, failureReason } = resolutionToExpected(targetRes);
    amount = failureReason
      ? { kind: 'indeterminate', reason: failureReason }
      : compareAmount(inputs.targetCell.paid_amount, expected);
  } else if (crossEntitySatisfied.satisfied) {
    amount = crossEntitySatisfied.amountStatus;
  }

  return { premium, dmi, crossEntitySatisfied, amount };
}
