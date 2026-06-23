/**
 * Phase C1b — Diagnose-and-route engine.
 *
 * Pure routing + a cycle runner that wraps C0 reductions. The router is a
 * total function over (facts, activeDecisions, crFlag). The cycle runner
 * is the four-phase contract:
 *
 *   i.  Build facts + detect signals (over both input populations).
 *  ii.  Apply C0 reductions via applyDecisionReduction (the ONLY writes).
 * iii.  Force-refresh loadOperatorDecisionIndex(true).
 *  iv.  Derive final routes/queues from POST-release decision state.
 *
 * Population 1 = certified MT-approved UNPAID member-months. Only these
 * rows can ever be chase-eligible.
 * Population 2 = certified target-scope PAID member-months. These rows can
 * ONLY produce amount-discrepancy routes (never chase, never satisfied).
 *
 * Writes: this engine ONLY mutates state through applyDecisionReduction
 * (which itself goes through the C0 RPC). It NEVER calls recordDecision
 * and NEVER touches tables directly.
 */
import type { BlockerFacts } from './blockerFacts';
import {
  HOLD_DECISION_TYPES,
  applyDecisionReduction,
  isChaseEligible,
  loadOperatorDecisionIndex,
  memberMonthKey,
  type DecisionType,
  type OperatorDecisionIndex,
  type OperatorDecisionRow,
  type ReducerSignals,
  type TargetScope,
  type DecisionIdentityInput,
} from './operatorDecisions';
import { canonicalCarrier } from '../carrierCanonical';

// ─────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────

export type RouteName =
  | 'satisfied'
  | 'chase_eligible'
  | 'amount_discrepancy'
  | 'premium'
  | 'dmi'
  | 'prior_balance'
  | 'manual_review';

export type FyiTag =
  | 'carrier_recognition'
  | 'dmi_expired'
  | 'amount_indeterminate'
  | 'cross_entity_wrong_amount';

export interface RouteDecision {
  route: RouteName;
  fyi: FyiTag[];
  rationale: string;
}

export interface RouteRowInput {
  /** Stable row identifier (any string unique within the call). */
  rowKey: string;
  /** Identity used for decision lookup. carrier MUST already be canonicalized. */
  carrier: string;
  stableMemberKey: string;
  identity: DecisionIdentityInput;
  serviceMonth: string;
  targetScope: TargetScope;
  facts: BlockerFacts;
  crFlag: boolean;
  /** 1 = unpaid (chase candidate); 2 = paid (amount-discrepancy only). */
  population: 1 | 2;
}

export interface CycleResult {
  routes: Map<string, RouteDecision>;
  queues: Record<Exclude<RouteName, 'chase_eligible' | 'satisfied'>, string[]>;
  chaseEligible: string[];
  satisfied: string[];
  fyi: Map<string, FyiTag[]>;
  /** Decision rows actually released this cycle (persisted via C0). */
  appliedReleases: OperatorDecisionRow[];
  /** Signals C0 deliberately no-oped (wrong-amount, already released, etc.). */
  observedNoopSignals: Array<{
    decisionId: string;
    signals: ReducerSignals;
    reason: 'wrong_amount_wins' | 'sticky_no_signal' | 'inactive' | 'no_release_match';
  }>;
}

// ─────────────────────────────────────────────────────────────────────────
// Router (pure)
// ─────────────────────────────────────────────────────────────────────────

function activeHoldsForRow(
  idx: OperatorDecisionIndex,
  row: { carrier: string; stableMemberKey: string; serviceMonth: string; targetScope: TargetScope },
): OperatorDecisionRow[] {
  const k = memberMonthKey(row.carrier, row.stableMemberKey, row.serviceMonth);
  const list = idx.byMemberMonth.get(k) ?? [];
  return list.filter((d) => {
    if (!HOLD_DECISION_TYPES.has(d.decision_type)) return false;
    return d.target_scope === 'All' || row.targetScope === 'All' || d.target_scope === row.targetScope;
  });
}

function activeOfType(
  idx: OperatorDecisionIndex,
  row: { carrier: string; stableMemberKey: string; serviceMonth: string; targetScope: TargetScope },
  type: DecisionType,
): OperatorDecisionRow[] {
  const k = memberMonthKey(row.carrier, row.stableMemberKey, row.serviceMonth);
  const list = idx.byMemberMonth.get(k) ?? [];
  return list.filter(
    (d) =>
      d.decision_type === type &&
      (d.target_scope === 'All' || row.targetScope === 'All' || d.target_scope === row.targetScope),
  );
}

/**
 * Total routing function. Precedence is the order below — first match wins.
 *
 *   Population 2 (paid):
 *     - amount.wrong_amount        → amount_discrepancy
 *     - amount.indeterminate       → satisfied + fyi(amount_indeterminate)
 *     - otherwise                  → satisfied
 *
 *   Population 1 (unpaid):
 *     1. crossEntitySatisfied.satisfied:
 *          amount=correct  → satisfied
 *          amount=wrong    → amount_discrepancy (+ fyi cross_entity_wrong_amount)
 *          amount=indet.   → satisfied + fyi(amount_indeterminate)
 *     2. premium.premium_blocked → premium queue
 *     3. dmi.active && surfaceEligible:
 *          expired → manual_review
 *          else    → dmi queue
 *     4. active hold_prior_balance → prior_balance queue
 *     5. any other active hold_*  → corresponding queue (premium/dmi/manual_review fallback)
 *     6. active add_to_chase + no holds → chase_eligible (CR FYI if crFlag)
 *     7. crFlag → chase_eligible + fyi(carrier_recognition)
 *     8. default → chase_eligible (the Messer residual)
 */
export function routeMemberMonth(args: {
  row: RouteRowInput;
  activeDecisions: OperatorDecisionIndex;
}): RouteDecision {
  const { row, activeDecisions: idx } = args;
  const f = row.facts;
  const fyi: FyiTag[] = [];

  // Population 2: paid → amount-discrepancy detector only.
  if (row.population === 2) {
    // C2b-1 Stage 2 (R-CARR-007): a member-count conflict on a row that
    // computes an expected dollar is undecidable downstream — route it to
    // manual_review BEFORE amount handling so conflicts are not silently
    // collapsed into "satisfied" or default-1 expected basis.
    if (f.memberCount?.status === 'manual_review') {
      return { route: 'manual_review', fyi, rationale: 'member_count_manual_review' };
    }
    if (f.amount.kind === 'wrong_amount') {
      return { route: 'amount_discrepancy', fyi, rationale: 'target_scope_paid_wrong_amount' };
    }
    if (f.amount.kind === 'indeterminate') {
      // PLAN_TIER_UNRECOVERABLE is a visible hold (do NOT default to a tier).
      if (f.amount.reason === 'PLAN_TIER_UNRECOVERABLE') {
        return { route: 'manual_review', fyi, rationale: 'plan_tier_unrecoverable' };
      }
      fyi.push('amount_indeterminate');
      return { route: 'satisfied', fyi, rationale: 'paid_amount_indeterminate_fyi' };
    }
    return { route: 'satisfied', fyi, rationale: 'paid_correct_or_na' };
  }

  // Population 1: unpaid candidates.

  // 1. Cross-entity satisfaction (D2).
  if (f.crossEntitySatisfied.satisfied) {
    // C2b-1 Stage 2 (R-CARR-007): conflict precedence applies here too —
    // a cross-entity-satisfied unpaid row computes an expected dollar.
    if (f.memberCount?.status === 'manual_review') {
      return { route: 'manual_review', fyi, rationale: 'member_count_manual_review' };
    }
    if (f.crossEntitySatisfied.amountStatus.kind === 'wrong_amount') {
      fyi.push('cross_entity_wrong_amount');
      return {
        route: 'amount_discrepancy',
        fyi,
        rationale: 'cross_entity_satisfied_wrong_amount',
      };
    }
    if (f.crossEntitySatisfied.amountStatus.kind === 'indeterminate') {
      fyi.push('amount_indeterminate');
      return { route: 'satisfied', fyi, rationale: 'cross_entity_satisfied_amount_indet_fyi' };
    }
    return { route: 'satisfied', fyi, rationale: 'cross_entity_satisfied_correct' };
  }
  // Ordinary unpaid rows (no amount calc): a memberCount conflict is
  // recorded on the fact but MUST NOT pull the row out of chase.


  // 2. Premium-blocked → premium queue (fact-driven membership; no decision required).
  if (f.premium.kind === 'premium_blocked') {
    return { route: 'premium', fyi, rationale: 'premium_blocked_fact' };
  }

  // 3. DMI surfaceable.
  if (f.dmi.active && f.dmi.surfaceEligible) {
    if (f.dmi.expired) {
      fyi.push('dmi_expired');
      return { route: 'manual_review', fyi, rationale: 'dmi_expired_unreliable_signal' };
    }
    return { route: 'dmi', fyi, rationale: 'dmi_active_unpaid' };
  }

  // 4 + 5. Holds.
  const holds = activeHoldsForRow(idx, row);
  if (holds.length > 0) {
    const pb = holds.find((h) => h.decision_type === 'hold_prior_balance');
    if (pb) return { route: 'prior_balance', fyi, rationale: 'hold_prior_balance_active' };
    const dmiHold = holds.find((h) => h.decision_type === 'hold_dmi');
    if (dmiHold) return { route: 'dmi', fyi, rationale: 'hold_dmi_active' };
    const premHold = holds.find((h) => h.decision_type === 'hold_premium');
    if (premHold) return { route: 'premium', fyi, rationale: 'hold_premium_active' };
    return { route: 'manual_review', fyi, rationale: 'hold_other_active' };
  }

  // 6. add_to_chase grants chase (no holds remain at this point).
  const addToChase = activeOfType(idx, row, 'add_to_chase');
  if (addToChase.length > 0) {
    if (row.crFlag) fyi.push('carrier_recognition');
    return { route: 'chase_eligible', fyi, rationale: 'add_to_chase_grant' };
  }

  // 7 + 8. Default: chase-eligible; CR FYI annotation.
  if (row.crFlag) fyi.push('carrier_recognition');
  // isChaseEligible guards: it MUST be true here (no holds) but assert for paranoia.
  if (
    !isChaseEligible(idx, {
      carrier: row.carrier,
      stable_member_key: row.stableMemberKey,
      service_month: row.serviceMonth,
      scope: row.targetScope,
    })
  ) {
    return { route: 'manual_review', fyi, rationale: 'unexpected_hold_present' };
  }
  return { route: 'chase_eligible', fyi, rationale: 'default_chase' };
}

// ─────────────────────────────────────────────────────────────────────────
// Signal detection (phase i) — one ReducerSignals per active decision row.
// ─────────────────────────────────────────────────────────────────────────

export interface SignalForDecision {
  decision: OperatorDecisionRow;
  signals: ReducerSignals;
  source: 'premium_fact' | 'commission_backstop';
}

/**
 * Pure signal detector. For each ACTIVE decision in `idx` that intersects
 * a row in `rows`, derive a ReducerSignals from current facts. The cycle
 * runner then asks C0 to reduce — wrong-amount stays active (noop), paid
 * releases, etc.
 */
export function detectSignals(
  rows: RouteRowInput[],
  idx: OperatorDecisionIndex,
): SignalForDecision[] {
  const rowsByGrain = new Map<string, RouteRowInput>();
  for (const r of rows) {
    rowsByGrain.set(memberMonthScopeKey(r.carrier, r.stableMemberKey, r.serviceMonth, r.targetScope), r);
  }
  const out: SignalForDecision[] = [];

  for (const d of idx.all) {
    if (d.status !== 'active') continue;
    // Resolve the row(s) at the decision's grain. Scope match honours 'All'.
    const matchingRows: RouteRowInput[] = [];
    for (const scope of expandScope(d.target_scope)) {
      const r = rowsByGrain.get(memberMonthScopeKey(d.carrier, d.stable_member_key, d.service_month, scope));
      if (r) matchingRows.push(r);
    }
    if (matchingRows.length === 0) continue;

    // Signal: premium release for hold_premium when no row at the grain is
    // still premium-blocked AND at least one row is now chase_candidate
    // (the prior-blocked month is now standing on its own).
    if (d.decision_type === 'hold_premium') {
      const anyStillBlocked = matchingRows.some((r) => r.facts.premium.kind === 'premium_blocked');
      const anyNowCandidate = matchingRows.some((r) => r.facts.premium.kind === 'chase_candidate');
      if (!anyStillBlocked && anyNowCandidate) {
        out.push({ decision: d, signals: { premiumPaidThroughCurrent: true }, source: 'premium_fact' });
        continue;
      }
    }

    // Signal: commission-file backstop on ANY hold_* — if the matching row
    // is now satisfied (target paid OR cross-entity paid) we emit the
    // corresponding paid signal. Wrong-amount wins per C0 reducer.
    if (HOLD_DECISION_TYPES.has(d.decision_type)) {
      const evidence = backstopEvidenceForRows(matchingRows);
      if (evidence.kind === 'paid_correct') {
        out.push({ decision: d, signals: { commissionFilePaid: true }, source: 'commission_backstop' });
      } else if (evidence.kind === 'paid_wrong_amount') {
        out.push({
          decision: d,
          signals: { commissionFilePaid: true, commissionFilePaidWrongAmount: true },
          source: 'commission_backstop',
        });
      }
    }
  }
  return out;
}

type BackstopEvidence =
  | { kind: 'none' }
  | { kind: 'paid_correct' }
  | { kind: 'paid_wrong_amount' };

function backstopEvidenceForRows(rows: RouteRowInput[]): BackstopEvidence {
  let saw: BackstopEvidence = { kind: 'none' };
  for (const r of rows) {
    const f = r.facts;
    // Population-2: target cell itself is paid → amount fact carries the verdict.
    if (r.population === 2) {
      if (f.amount.kind === 'wrong_amount') return { kind: 'paid_wrong_amount' };
      if (f.amount.kind === 'correct') saw = { kind: 'paid_correct' };
      continue;
    }
    // Population-1: cross-entity satisfaction.
    if (f.crossEntitySatisfied.satisfied) {
      const a = f.crossEntitySatisfied.amountStatus;
      if (a.kind === 'wrong_amount') return { kind: 'paid_wrong_amount' };
      if (a.kind === 'correct') saw = { kind: 'paid_correct' };
    }
  }
  return saw;
}

function expandScope(s: string): TargetScope[] {
  if (s === 'All') return ['All', 'Coverall', 'Vix'];
  return [s as TargetScope, 'All'];
}

function memberMonthScopeKey(carrier: string, stable: string, month: string, scope: string): string {
  return `${carrier}|${stable}|${month}|${scope}`;
}

// ─────────────────────────────────────────────────────────────────────────
// Cycle runner — the four-phase contract.
// ─────────────────────────────────────────────────────────────────────────

export interface RunDiagnoseCycleArgs {
  /** Pre-assembled population (unions of population 1 + 2). */
  rows: RouteRowInput[];
  /** Optional: override the decision-index loader (tests). */
  loadDecisionIndex?: (force: boolean) => Promise<OperatorDecisionIndex>;
  /** Optional: override the release applier (tests). */
  applyReduction?: (
    d: OperatorDecisionRow,
    signals: ReducerSignals,
    evidence?: Record<string, unknown>,
  ) => Promise<OperatorDecisionRow>;
}

export async function runDiagnoseCycle(args: RunDiagnoseCycleArgs): Promise<CycleResult> {
  const load = args.loadDecisionIndex ?? loadOperatorDecisionIndex;
  const apply = args.applyReduction ?? applyDecisionReduction;

  // Phase i — load active decisions; detect signals over the populations.
  const pre = await load(false);
  const signals = detectSignals(args.rows, pre);

  // Phase ii — apply reductions through C0. Track applied vs. observed-noop.
  const appliedReleases: OperatorDecisionRow[] = [];
  const observedNoopSignals: CycleResult['observedNoopSignals'] = [];

  for (const s of signals) {
    const before = s.decision;
    const after = await apply(before, s.signals, { source: s.source });
    const released = after.status === 'released' && before.status === 'active';
    if (released) {
      appliedReleases.push(after);
    } else {
      let reason: CycleResult['observedNoopSignals'][number]['reason'] = 'no_release_match';
      if (s.signals.commissionFilePaidWrongAmount) reason = 'wrong_amount_wins';
      else if (before.release_rule === 'sticky_manual' && !s.signals.manualRelease && !s.signals.commissionFilePaid) reason = 'sticky_no_signal';
      else if (before.status !== 'active') reason = 'inactive';
      observedNoopSignals.push({ decisionId: before.id, signals: s.signals, reason });
    }
  }

  // Phase iii — force-refresh the decision index to reflect releases.
  const post = await load(true);

  // Phase iv — derive routes from POST state.
  const { routes, fyi: fyiMap, chaseEligible, satisfied, queues } = bucketRoutes(args.rows, post);

  return { routes, queues, chaseEligible, satisfied, fyi: fyiMap, appliedReleases, observedNoopSignals };
}

// ─────────────────────────────────────────────────────────────────────────
// Shared Phase-iv bucketing (used by runDiagnoseCycle + projectDiagnoseRoutes)
// ─────────────────────────────────────────────────────────────────────────

function bucketRoutes(
  rows: RouteRowInput[],
  idx: OperatorDecisionIndex,
): {
  routes: Map<string, RouteDecision>;
  fyi: Map<string, FyiTag[]>;
  chaseEligible: string[];
  satisfied: string[];
  queues: CycleResult['queues'];
} {
  const routes = new Map<string, RouteDecision>();
  const fyi = new Map<string, FyiTag[]>();
  const chaseEligible: string[] = [];
  const satisfied: string[] = [];
  const queues: CycleResult['queues'] = {
    amount_discrepancy: [],
    premium: [],
    dmi: [],
    prior_balance: [],
    manual_review: [],
  };
  for (const r of rows) {
    const d = routeMemberMonth({ row: r, activeDecisions: idx });
    routes.set(r.rowKey, d);
    if (d.fyi.length > 0) fyi.set(r.rowKey, d.fyi);
    if (d.route === 'chase_eligible') chaseEligible.push(r.rowKey);
    else if (d.route === 'satisfied') satisfied.push(r.rowKey);
    else queues[d.route].push(r.rowKey);
  }
  return { routes, fyi, chaseEligible, satisfied, queues };
}

// ─────────────────────────────────────────────────────────────────────────
// Read-only projection — derives routes/queues WITHOUT phase ii/iii writes.
// Used by the operator review screen (C2b-2). Persists NOTHING.
// ─────────────────────────────────────────────────────────────────────────

export interface ProjectDiagnoseRoutesArgs {
  rows: RouteRowInput[];
  loadDecisionIndex?: (force: boolean) => Promise<OperatorDecisionIndex>;
  forceDecisionIndex?: boolean;
}

export type DiagnoseRoutesProjection = Omit<CycleResult, 'appliedReleases' | 'observedNoopSignals'>;

export async function projectDiagnoseRoutes(
  args: ProjectDiagnoseRoutesArgs,
): Promise<DiagnoseRoutesProjection> {
  const load = args.loadDecisionIndex ?? loadOperatorDecisionIndex;
  const idx = await load(args.forceDecisionIndex ?? false);
  const { routes, fyi, chaseEligible, satisfied, queues } = bucketRoutes(args.rows, idx);
  return { routes, queues, chaseEligible, satisfied, fyi };
}

// Helper exported for callers that want to canonicalize a carrier upfront.
export function canonicalizeCarrierOrThrow(c: string | null | undefined): string {
  const cc = canonicalCarrier(c);
  if (!cc) throw new Error(`carrier did not canonicalize: ${c}`);
  return cc;
}
