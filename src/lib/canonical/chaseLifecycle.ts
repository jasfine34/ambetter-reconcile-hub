/**
 * Phase C1b — Chase lifecycle state machine + commission-file backstop.
 *
 * Pure state machine + matcher. No DB tables; submission is a later build
 * and is referenced here via the C0 SubmissionRecord placeholder type. The
 * only persistence path is signal application through C0's
 * applyDecisionReduction (idempotent by construction).
 *
 * Backstop match grain:
 *   carrier | stable_member_key | policy_identity_key | service_month | scope
 * with cross-entity (Coverall ↔ Vix) counting as a match. A REVERSAL is
 * never a match. A wrong-amount payment emits commissionFilePaidWrongAmount
 * (C0 keeps the decision active) and routes the row to amount_discrepancy.
 */
import {
  applyDecisionReduction,
  type OperatorDecisionRow,
  type ReducerSignals,
  type SubmissionRecord,
  type TargetScope,
} from './operatorDecisions';
import type { BlockerFacts } from './blockerFacts';

// ─────────────────────────────────────────────────────────────────────────
// State machine
// ─────────────────────────────────────────────────────────────────────────

export type ChaseState = 'open' | 'submitted' | 'resolved';
export type ChaseResolution = 'auto' | 'manual';

export interface ChaseRecord {
  /** Stable grain for the chased row. */
  carrier: string;
  stableMemberKey: string;
  policyIdentityKey: string;
  serviceMonth: string;
  scope: TargetScope;
  state: ChaseState;
  submissionRef: SubmissionRecord | null;
  resolution: ChaseResolution | null;
  resolutionReason: string | null;
  /** ISO timestamps for audit. */
  openedAt: string;
  submittedAt: string | null;
  resolvedAt: string | null;
}

export function openChase(args: {
  carrier: string;
  stableMemberKey: string;
  policyIdentityKey: string;
  serviceMonth: string;
  scope: TargetScope;
  now?: string;
}): ChaseRecord {
  return {
    carrier: args.carrier,
    stableMemberKey: args.stableMemberKey,
    policyIdentityKey: args.policyIdentityKey,
    serviceMonth: args.serviceMonth,
    scope: args.scope,
    state: 'open',
    submissionRef: null,
    resolution: null,
    resolutionReason: null,
    openedAt: args.now ?? new Date().toISOString(),
    submittedAt: null,
    resolvedAt: null,
  };
}

export class ChaseLifecycleError extends Error {}

export function markSubmitted(rec: ChaseRecord, submissionRef: SubmissionRecord, now?: string): ChaseRecord {
  if (rec.state === 'resolved') throw new ChaseLifecycleError('cannot submit a resolved chase');
  if (rec.state === 'submitted') return rec; // idempotent
  return {
    ...rec,
    state: 'submitted',
    submissionRef,
    submittedAt: now ?? new Date().toISOString(),
  };
}

export function resolveManual(rec: ChaseRecord, reason: string, now?: string): ChaseRecord {
  if (rec.state === 'resolved') return rec; // terminal
  return {
    ...rec,
    state: 'resolved',
    resolution: 'manual',
    resolutionReason: reason,
    resolvedAt: now ?? new Date().toISOString(),
  };
}

export function resolveAuto(rec: ChaseRecord, reason: string, now?: string): ChaseRecord {
  if (rec.state === 'resolved') return rec; // terminal
  return {
    ...rec,
    state: 'resolved',
    resolution: 'auto',
    resolutionReason: reason,
    resolvedAt: now ?? new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Commission-file backstop matcher
// ─────────────────────────────────────────────────────────────────────────

export type BackstopMatchKind =
  | { kind: 'no_match' }
  | { kind: 'auto_resolve' }
  | { kind: 'wrong_amount' };

/**
 * Compute the backstop outcome for a chased grain from current facts. The
 * caller has already mapped (carrier, stable, policy_identity, service_month,
 * scope) → BlockerFacts via the certified per-scope classifier.
 *
 * NOTE: reversed/paired-reversal flow through facts as `crossEntitySatisfied
 * .satisfied = false` (D2 rule). We never treat a reversal as a match here.
 */
export function evaluateBackstop(facts: BlockerFacts, populationOfRow: 1 | 2): BackstopMatchKind {
  // Target-scope itself paid (population 2 entry for the same grain).
  if (populationOfRow === 2) {
    if (facts.amount.kind === 'wrong_amount') return { kind: 'wrong_amount' };
    if (facts.amount.kind === 'correct') return { kind: 'auto_resolve' };
    return { kind: 'no_match' };
  }
  // Population 1 — cross-entity satisfaction.
  const cs = facts.crossEntitySatisfied;
  if (!cs.satisfied) return { kind: 'no_match' };
  if (cs.amountStatus.kind === 'wrong_amount') return { kind: 'wrong_amount' };
  if (cs.amountStatus.kind === 'correct') return { kind: 'auto_resolve' };
  return { kind: 'no_match' }; // indeterminate or n/a
}

// ─────────────────────────────────────────────────────────────────────────
// Signal appliers — wrappers around C0 applyDecisionReduction. Idempotent
// because applyDecisionReduction → reduceDecision is total; already-released
// decisions noop.
// ─────────────────────────────────────────────────────────────────────────

export async function applyPremiumPaidThroughCurrent(
  decision: OperatorDecisionRow,
  evidence?: Record<string, unknown>,
): Promise<OperatorDecisionRow> {
  const signals: ReducerSignals = { premiumPaidThroughCurrent: true };
  return applyDecisionReduction(decision, signals, evidence);
}

export async function applyCommissionBackstop(
  decision: OperatorDecisionRow,
  kind: BackstopMatchKind,
  evidence?: Record<string, unknown>,
): Promise<OperatorDecisionRow> {
  if (kind.kind === 'no_match') return decision;
  const signals: ReducerSignals = kind.kind === 'wrong_amount'
    ? { commissionFilePaid: true, commissionFilePaidWrongAmount: true }
    : { commissionFilePaid: true };
  return applyDecisionReduction(decision, signals, evidence);
}

/**
 * Convenience: given a chase record + current facts, decide whether to
 * auto-resolve the chase (and emit which signals to fire on the underlying
 * decision row if any).
 */
export function resolveFromBackstop(
  rec: ChaseRecord,
  facts: BlockerFacts,
  populationOfRow: 1 | 2,
): { record: ChaseRecord; outcome: BackstopMatchKind } {
  if (rec.state === 'resolved') return { record: rec, outcome: { kind: 'no_match' } };
  const outcome = evaluateBackstop(facts, populationOfRow);
  if (outcome.kind === 'auto_resolve') {
    return { record: resolveAuto(rec, 'commission_file_backstop'), outcome };
  }
  // wrong_amount: chase stays open; caller routes the member-month to
  // amount_discrepancy via the diagnose engine.
  return { record: rec, outcome };
}
