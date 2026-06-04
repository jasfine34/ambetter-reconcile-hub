/**
 * Phase C0 — Operator decision foundation.
 *
 * Rebuild-surviving record of operator decisions (chase, hold_*, dismiss,
 * scope_correct, add_to_chase). Decisions are keyed on a stable composite
 * grain that does NOT depend on the volatile reconciled `member_key`, so
 * identity reshuffles and full batch rebuilds do not orphan them.
 *
 * Hard rules (do not soften):
 *   - policy_identity_key is NEVER null. When derivePolicyIdentityKey is
 *     unresolvable, we store a deterministic sentinel and capture the raw
 *     detail in evidence_snapshot. NOT NULL is required because Postgres
 *     treats NULLs as distinct in unique indexes, which would allow two
 *     active decisions at the unresolved grain.
 *   - recordDecision is the ONLY supersession path. It calls the
 *     `record_operator_decision` RPC, which serializes on the full grain
 *     via pg_advisory_xact_lock inside a single transaction. No loose
 *     client-side update-then-insert.
 *   - Release persistence is real: applyDecisionReduction calls the
 *     `release_operator_decision` RPC. The pure reducer alone is not
 *     enough — it returns a desired effect; this module performs it.
 *   - Wrong-amount WINS over paid. If commissionFilePaidWrongAmount is
 *     true, we never auto-close in C0 — the decision stays active and a
 *     later phase routes it to amount-discrepancy.
 *   - Every mutation invalidates the in-memory decision cache immediately.
 *   - C0 does NOT touch the certified classifier / memberTimeline / MCE
 *     selector paths.
 */
import { supabase } from '@/integrations/supabase/client';
import { canonicalCarrier } from '@/lib/carrierCanonical';
import { cleanId, cleanSubscriberId } from '@/lib/normalize';
import { derivePolicyIdentityKey } from '@/lib/canonical/policyIdentityKey';
import { isValidMonthKey } from '@/lib/canonical/monthKey';

// ─────────────────────────────────────────────────────────────────────────
// Vocabularies (TEXT + app-level validation — additions must not require a
// migration). Keep these as the SINGLE source of truth.
// ─────────────────────────────────────────────────────────────────────────

export const DECISION_TYPES = [
  'chase',
  'hold_premium',
  'hold_prior_balance',
  'hold_dmi',
  'hold_amount',
  'dismiss_cr_flag',
  'scope_correct',
  'add_to_chase',
] as const;
export type DecisionType = typeof DECISION_TYPES[number];

export const HOLD_DECISION_TYPES: ReadonlySet<DecisionType> = new Set([
  'hold_premium', 'hold_prior_balance', 'hold_dmi', 'hold_amount',
]);

export const RELEASE_RULES = ['auto_premium', 'sticky_manual'] as const;
export type ReleaseRule = typeof RELEASE_RULES[number];

export const TARGET_SCOPES = ['Coverall', 'Vix', 'All'] as const;
export type TargetScope = typeof TARGET_SCOPES[number];

export const RELEASE_TRIGGERS = ['auto_premium', 'commission_file', 'manual'] as const;
export type ReleaseTrigger = typeof RELEASE_TRIGGERS[number];

/**
 * Reason codes allowed PER decision_type. Adding a new code is a list
 * edit; no migration. Keep deliberately conservative for C0 — later
 * phases extend these.
 */
export const REASON_CODES_BY_TYPE: Record<DecisionType, readonly string[]> = {
  chase: ['default', 'missing_commission', 'cross_batch_unpaid'],
  hold_premium: ['default', 'awaiting_premium'],
  hold_prior_balance: ['default', 'prior_balance_owed'],
  hold_dmi: ['default', 'data_mismatch_investigation'],
  hold_amount: ['default', 'amount_discrepancy'],
  dismiss_cr_flag: ['default', 'cr_flag_invalid'],
  scope_correct: ['default', 'scope_reclassified'],
  add_to_chase: ['default'],
};

export type DecisionStatus = 'active' | 'superseded' | 'released';

export interface OperatorDecisionRow {
  id: string;
  carrier: string;
  stable_member_key: string;
  policy_identity_key: string;
  service_month: string;
  target_scope: TargetScope;
  reason_code: string;
  decision_type: DecisionType;
  internal_note: string | null;
  messer_comment: string | null;
  evidence_snapshot: Record<string, unknown>;
  release_rule: ReleaseRule;
  amount_payload: Record<string, unknown> | null;
  status: DecisionStatus;
  superseded_at: string | null;
  superseded_by_decision_id: string | null;
  released_at: string | null;
  release_trigger: ReleaseTrigger | null;
  decided_by: string | null;
  decided_at: string;
  created_at: string;
}

/**
 * Types-only placeholder for the eventual Messer submission record.
 * No table, no writes, no consumers in C0 — exists so downstream code
 * can reference a shape today.
 */
export interface SubmissionRecord {
  member_grain_rows: Array<{
    stable_member_key: string;
    policy_identity_key: string;
    carrier: string;
    target_scope: TargetScope;
  }>;
  month_range: { from: string; to: string };
  version: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Stable identity helpers
// ─────────────────────────────────────────────────────────────────────────

export interface DecisionIdentityInput {
  carrier: string | null | undefined;
  issuer_subscriber_id?: string | null;
  exchange_subscriber_id?: string | null;
  policy_number?: string | null;
}

/**
 * Identity-level stable member key.
 *   priority: issuer_subscriber_id > exchange_subscriber_id > cleaned policy_number
 * NEVER the volatile reconciled `member_key` (it shifts on identity resolution).
 */
export function deriveStableMemberKey(input: DecisionIdentityInput): string {
  const isid = cleanSubscriberId(input.issuer_subscriber_id);
  if (isid) return `isid:${isid}`;
  const esid = cleanSubscriberId(input.exchange_subscriber_id);
  if (esid) return `esid:${esid}`;
  const pn = cleanId(input.policy_number);
  if (pn) return `pn:${pn}`;
  return '';
}

/**
 * Derive the (policy_identity_key, unresolved_detail) pair. When the
 * canonical key is unresolvable, returns a deterministic sentinel so the
 * NOT NULL + unique-active-grain index can still distinguish rows.
 */
export function derivePolicyKeyOrSentinel(
  input: DecisionIdentityInput,
  stableMemberKey: string,
): { policy_identity_key: string; unresolved_reason: string | null } {
  const r = derivePolicyIdentityKey({
    carrier: input.carrier,
    policy_number: input.policy_number ?? null,
    issuer_subscriber_id: input.issuer_subscriber_id ?? null,
  });
  if (r.status === 'resolved') return { policy_identity_key: r.key, unresolved_reason: null };
  const sentinel = `unresolved:${r.reason}:${stableMemberKey || 'empty'}`;
  return { policy_identity_key: sentinel, unresolved_reason: r.reason };
}

// ─────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────

export class OperatorDecisionValidationError extends Error {}

export interface RecordDecisionInput {
  identity: DecisionIdentityInput;
  service_month: string;
  target_scope: TargetScope;
  decision_type: DecisionType;
  reason_code: string;
  release_rule: ReleaseRule;
  evidence_snapshot?: Record<string, unknown>;
  internal_note?: string | null;
  messer_comment?: string | null;
  amount_payload?: Record<string, unknown> | null;
  decided_by?: string | null;
}

export function validateDecisionInput(input: RecordDecisionInput): void {
  if (!(DECISION_TYPES as readonly string[]).includes(input.decision_type)) {
    throw new OperatorDecisionValidationError(`unknown decision_type: ${input.decision_type}`);
  }
  if (!(RELEASE_RULES as readonly string[]).includes(input.release_rule)) {
    throw new OperatorDecisionValidationError(`unknown release_rule: ${input.release_rule}`);
  }
  if (!(TARGET_SCOPES as readonly string[]).includes(input.target_scope)) {
    throw new OperatorDecisionValidationError(`unknown target_scope: ${input.target_scope}`);
  }
  if (!isValidMonthKey(input.service_month)) {
    throw new OperatorDecisionValidationError(`bad service_month: ${input.service_month}`);
  }
  const allowed = REASON_CODES_BY_TYPE[input.decision_type];
  if (!allowed.includes(input.reason_code)) {
    throw new OperatorDecisionValidationError(
      `reason_code "${input.reason_code}" not allowed for decision_type "${input.decision_type}"`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Cache (mirrors loadResolverIndex pattern)
// ─────────────────────────────────────────────────────────────────────────

export interface OperatorDecisionIndex {
  all: OperatorDecisionRow[];
  byId: Map<string, OperatorDecisionRow>;
  /** key: `${carrier}|${stable_member_key}|${service_month}` */
  byMemberMonth: Map<string, OperatorDecisionRow[]>;
  /** key: full grain */
  byGrain: Map<string, OperatorDecisionRow>;
  fingerprint: string;
}

const EMPTY_INDEX: OperatorDecisionIndex = {
  all: [], byId: new Map(), byMemberMonth: new Map(), byGrain: new Map(),
  fingerprint: 'empty',
};

let _cached: OperatorDecisionIndex | null = null;
let _cachedAt = 0;
const CACHE_TTL_MS = 60_000;

export function invalidateOperatorDecisionCache(): void {
  _cached = null;
  _cachedAt = 0;
}

export function grainKey(d: {
  carrier: string; stable_member_key: string; policy_identity_key: string;
  service_month: string; target_scope: string; reason_code: string;
}): string {
  return [d.carrier, d.stable_member_key, d.policy_identity_key,
    d.service_month, d.target_scope, d.reason_code].join('|');
}

export function memberMonthKey(carrier: string, stable: string, month: string): string {
  return `${carrier}|${stable}|${month}`;
}

export function operatorDecisionFingerprint(idx: OperatorDecisionIndex): string {
  if (!idx || idx.all.length === 0) return 'empty';
  const projected = idx.all
    .map(d => [
      d.id, d.carrier, d.stable_member_key, d.policy_identity_key,
      d.service_month, d.target_scope, d.reason_code, d.decision_type,
      d.release_rule, d.decided_at,
      d.amount_payload ? JSON.stringify(d.amount_payload) : '',
    ].join('~'))
    .sort();
  return `n=${idx.all.length};${projected.join(';')}`;
}

export async function loadOperatorDecisionIndex(force = false): Promise<OperatorDecisionIndex> {
  if (!force && _cached && Date.now() - _cachedAt < CACHE_TTL_MS) return _cached;
  const all: any[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await (supabase as any)
      .from('operator_decisions')
      .select('*')
      .eq('status', 'active')
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) return EMPTY_INDEX;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  const idx: OperatorDecisionIndex = {
    all: all as OperatorDecisionRow[],
    byId: new Map(),
    byMemberMonth: new Map(),
    byGrain: new Map(),
    fingerprint: 'empty',
  };
  for (const d of idx.all) {
    idx.byId.set(d.id, d);
    idx.byGrain.set(grainKey(d), d);
    const k = memberMonthKey(d.carrier, d.stable_member_key, d.service_month);
    const list = idx.byMemberMonth.get(k) ?? [];
    list.push(d);
    idx.byMemberMonth.set(k, list);
  }
  idx.fingerprint = operatorDecisionFingerprint(idx);
  _cached = idx;
  _cachedAt = Date.now();
  return idx;
}

// ─────────────────────────────────────────────────────────────────────────
// Mutating APIs — every one invalidates the cache.
// ─────────────────────────────────────────────────────────────────────────

export async function recordDecision(input: RecordDecisionInput): Promise<OperatorDecisionRow> {
  validateDecisionInput(input);

  const carrier = canonicalCarrier(input.identity.carrier);
  if (!carrier) {
    throw new OperatorDecisionValidationError('carrier did not canonicalize');
  }
  const stable = deriveStableMemberKey(input.identity);
  if (!stable) {
    throw new OperatorDecisionValidationError('no stable_member_key identity fields');
  }
  const { policy_identity_key, unresolved_reason } = derivePolicyKeyOrSentinel(input.identity, stable);

  const evidence: Record<string, unknown> = {
    ...(input.evidence_snapshot ?? {}),
    _identity: {
      carrier_raw: input.identity.carrier ?? null,
      issuer_subscriber_id: input.identity.issuer_subscriber_id ?? null,
      exchange_subscriber_id: input.identity.exchange_subscriber_id ?? null,
      policy_number: input.identity.policy_number ?? null,
    },
    _release_rule_at_decision: input.release_rule,
    _logic_version: 'phase-c0-v1',
  };
  if (unresolved_reason) evidence._policy_identity_unresolved = unresolved_reason;

  const { data, error } = await (supabase as any).rpc('record_operator_decision', {
    p_carrier: carrier,
    p_stable_member_key: stable,
    p_policy_identity_key: policy_identity_key,
    p_service_month: input.service_month,
    p_target_scope: input.target_scope,
    p_reason_code: input.reason_code,
    p_decision_type: input.decision_type,
    p_release_rule: input.release_rule,
    p_evidence_snapshot: evidence,
    p_internal_note: input.internal_note ?? null,
    p_messer_comment: input.messer_comment ?? null,
    p_amount_payload: input.amount_payload ?? null,
    p_decided_by: input.decided_by ?? null,
  });
  if (error) throw error;
  invalidateOperatorDecisionCache();
  // Supabase rpc returning a row-type returns either the row or an array of one.
  const row = Array.isArray(data) ? data[0] : data;
  return row as OperatorDecisionRow;
}

// ─────────────────────────────────────────────────────────────────────────
// Pure reducer + persistence wrapper
// ─────────────────────────────────────────────────────────────────────────

export interface ReducerSignals {
  premiumPaidThroughCurrent?: boolean;
  commissionFilePaid?: boolean;
  commissionFilePaidWrongAmount?: boolean;
  manualRelease?: boolean;
}

export type ReductionEffect =
  | { kind: 'noop' }
  | { kind: 'release'; trigger: ReleaseTrigger };

/**
 * Pure reducer. Precedence:
 *   1. If decision is already released/superseded → noop (never reactivate).
 *   2. commissionFilePaidWrongAmount WINS over commissionFilePaid:
 *      if both true → noop (stays active; later phase routes to amount).
 *   3. commissionFilePaid alone (any release_rule) → release(commission_file).
 *   4. auto_premium + premiumPaidThroughCurrent → release(auto_premium).
 *   5. sticky_manual ignores premium; manualRelease → release(manual).
 *   6. auto_premium + manualRelease → release(manual). (manual still works)
 */
export function reduceDecision(
  decision: Pick<OperatorDecisionRow, 'status' | 'release_rule'>,
  signals: ReducerSignals,
): ReductionEffect {
  if (decision.status !== 'active') return { kind: 'noop' };

  if (signals.commissionFilePaidWrongAmount) return { kind: 'noop' };
  if (signals.commissionFilePaid) return { kind: 'release', trigger: 'commission_file' };

  if (signals.manualRelease) return { kind: 'release', trigger: 'manual' };

  if (decision.release_rule === 'auto_premium' && signals.premiumPaidThroughCurrent) {
    return { kind: 'release', trigger: 'auto_premium' };
  }
  return { kind: 'noop' };
}

export async function applyDecisionReduction(
  decision: OperatorDecisionRow,
  signals: ReducerSignals,
  evidence?: Record<string, unknown>,
): Promise<OperatorDecisionRow> {
  const effect = reduceDecision(decision, signals);
  if (effect.kind === 'noop') return decision;
  const { data, error } = await (supabase as any).rpc('release_operator_decision', {
    p_id: decision.id,
    p_trigger: effect.trigger,
    p_evidence: evidence ?? { signals },
  });
  if (error) throw error;
  invalidateOperatorDecisionCache();
  const row = Array.isArray(data) ? data[0] : data;
  return row as OperatorDecisionRow;
}

// ─────────────────────────────────────────────────────────────────────────
// G3 gating
// ─────────────────────────────────────────────────────────────────────────

/**
 * Chase-eligible iff NO active hold_* decisions remain at the member-month
 * + scope. chase / add_to_chase / dismiss_cr_flag / scope_correct do NOT
 * block. An 'All' hold blocks any scope; a Coverall/Vix hold blocks only
 * the matching scope (plus 'All' queries).
 */
export function isChaseEligible(
  idx: OperatorDecisionIndex,
  args: { carrier: string; stable_member_key: string; service_month: string; scope: TargetScope },
): boolean {
  const cc = canonicalCarrier(args.carrier);
  if (!cc || !args.stable_member_key) return true;
  const decisions = idx.byMemberMonth.get(memberMonthKey(cc, args.stable_member_key, args.service_month)) ?? [];
  for (const d of decisions) {
    if (!HOLD_DECISION_TYPES.has(d.decision_type)) continue;
    if (d.target_scope === 'All' || args.scope === 'All' || d.target_scope === args.scope) {
      return false;
    }
  }
  return true;
}
