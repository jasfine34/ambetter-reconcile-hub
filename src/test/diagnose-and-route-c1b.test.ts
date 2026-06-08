/**
 * Phase C1b — diagnose-and-route engine + chase lifecycle tests.
 *
 * Synthetic only. Cycle-level tests use a shared in-memory fake for the C0
 * RPCs (record_operator_decision + release_operator_decision) so the
 * four-phase contract is exercised end-to-end: detect signals → apply via
 * applyDecisionReduction → force-refresh index → derive routes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = any;
const db: { rows: Row[] } = { rows: [] };
let idCounter = 1;
const nextId = () => `dec-${String(idCounter++).padStart(6, '0')}`;

function matchGrain(r: Row, p: any): boolean {
  return r.carrier === p.p_carrier
    && r.stable_member_key === p.p_stable_member_key
    && r.policy_identity_key === p.p_policy_identity_key
    && r.service_month === p.p_service_month
    && r.target_scope === p.p_target_scope
    && r.reason_code === p.p_reason_code;
}

let recordRpcCalls = 0;
let releaseRpcCalls = 0;

const rpcImpls: Record<string, (p: any) => { data: any; error: any }> = {
  record_operator_decision(p) {
    recordRpcCalls++;
    const id = nextId();
    for (const r of db.rows) {
      if (r.status === 'active' && matchGrain(r, p)) {
        r.status = 'superseded';
        r.superseded_at = new Date().toISOString();
        r.superseded_by_decision_id = id;
      }
    }
    const row: Row = {
      id,
      carrier: p.p_carrier,
      stable_member_key: p.p_stable_member_key,
      policy_identity_key: p.p_policy_identity_key,
      service_month: p.p_service_month,
      target_scope: p.p_target_scope,
      reason_code: p.p_reason_code,
      decision_type: p.p_decision_type,
      internal_note: null,
      messer_comment: null,
      evidence_snapshot: p.p_evidence_snapshot ?? {},
      release_rule: p.p_release_rule,
      amount_payload: null,
      status: 'active',
      superseded_at: null,
      superseded_by_decision_id: null,
      released_at: null,
      release_trigger: null,
      decided_by: null,
      decided_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    };
    db.rows.push(row);
    return { data: row, error: null };
  },
  release_operator_decision(p) {
    releaseRpcCalls++;
    const row = db.rows.find(r => r.id === p.p_id);
    if (!row) return { data: null, error: null };
    if (row.status === 'active') {
      row.status = 'released';
      row.released_at = new Date().toISOString();
      row.release_trigger = p.p_trigger;
    }
    return { data: row, error: null };
  },
};

function makeFromChain(table: string) {
  if (table !== 'operator_decisions') {
    return { select: () => ({ eq: () => ({ order: () => ({ range: () => Promise.resolve({ data: [], error: null }) }) }) }) };
  }
  const chain: any = {
    _status: null as string | null,
    select() { return chain; },
    eq(c: string, v: string) { if (c === 'status') chain._status = v; return chain; },
    order() { return chain; },
    range(from: number) {
      if (from > 0) return Promise.resolve({ data: [], error: null });
      let rows = db.rows;
      if (chain._status) rows = rows.filter(r => r.status === chain._status);
      return Promise.resolve({ data: rows.map(r => ({ ...r })), error: null });
    },
  };
  return chain;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (t: string) => makeFromChain(t),
    rpc: (name: string, params: any) => {
      const impl = rpcImpls[name];
      if (!impl) return Promise.resolve({ data: null, error: new Error('unknown rpc ' + name) });
      return Promise.resolve(impl(params));
    },
  },
}));

import {
  recordDecision,
  invalidateOperatorDecisionCache,
  loadOperatorDecisionIndex,
  type OperatorDecisionRow,
  type RecordDecisionInput,
} from '@/lib/canonical/operatorDecisions';
import {
  routeMemberMonth,
  detectSignals,
  runDiagnoseCycle,
  projectDiagnoseRoutes,
  type RouteRowInput,
} from '@/lib/canonical/diagnoseAndRoute';
import type { BlockerFacts } from '@/lib/canonical/blockerFacts';
import {
  openChase,
  markSubmitted,
  resolveManual,
  evaluateBackstop,
  resolveFromBackstop,
  ChaseLifecycleError,
  applyCommissionBackstop,
} from '@/lib/canonical/chaseLifecycle';
import type { SubmissionRecord } from '@/lib/canonical/operatorDecisions';

beforeEach(() => {
  db.rows = [];
  idCounter = 1;
  recordRpcCalls = 0;
  releaseRpcCalls = 0;
  invalidateOperatorDecisionCache();
});

// ─────────────────────────────────────────────────────────────────────────
// Fact + row builders
// ─────────────────────────────────────────────────────────────────────────

function facts(overrides: Partial<BlockerFacts> = {}): BlockerFacts {
  return {
    premium: { kind: 'chase_candidate' },
    dmi: { active: false, issueType: null, verificationEndDate: null, expired: false, inProgress: false, surfaceEligible: false },
    crossEntitySatisfied: { satisfied: false, satisfyingEntity: null, actualPaid: null, expectedBasis: null, amountStatus: { kind: 'not_applicable' } },
    amount: { kind: 'not_applicable' },
    ...overrides,
  } as BlockerFacts;
}

function row(rowKey: string, opts: Partial<RouteRowInput> & { facts?: BlockerFacts; population?: 1 | 2 } = {}): RouteRowInput {
  return {
    rowKey,
    carrier: 'ambetter',
    stableMemberKey: 'isid:u99999999',
    identity: { carrier: 'Ambetter', issuer_subscriber_id: 'U99999999' },
    serviceMonth: '2026-02',
    targetScope: 'Coverall',
    facts: opts.facts ?? facts(),
    crFlag: false,
    population: opts.population ?? 1,
    ...opts,
  };
}

const BASE_DECISION: RecordDecisionInput = {
  identity: { carrier: 'Ambetter', issuer_subscriber_id: 'U99999999' },
  service_month: '2026-02',
  target_scope: 'Coverall',
  decision_type: 'hold_dmi',
  reason_code: 'data_mismatch_investigation',
  release_rule: 'sticky_manual',
};

// ─────────────────────────────────────────────────────────────────────────
// Router precedence matrix
// ─────────────────────────────────────────────────────────────────────────

describe('routeMemberMonth — precedence matrix', () => {
  const emptyIdx = { all: [], byId: new Map(), byMemberMonth: new Map(), byGrain: new Map(), fingerprint: 'empty' };

  it('pop1 cross-entity satisfied + correct → satisfied', () => {
    const r = row('r', { facts: facts({ crossEntitySatisfied: { satisfied: true, satisfyingEntity: 'Vix', actualPaid: 10, expectedBasis: 10, amountStatus: { kind: 'correct' } } }) });
    expect(routeMemberMonth({ row: r, activeDecisions: emptyIdx }).route).toBe('satisfied');
  });

  it('pop1 cross-entity satisfied + wrong_amount → amount_discrepancy + fyi', () => {
    const r = row('r', { facts: facts({ crossEntitySatisfied: { satisfied: true, satisfyingEntity: 'Vix', actualPaid: 5, expectedBasis: 10, amountStatus: { kind: 'wrong_amount', actual: 5, expected: 10 } } }) });
    const d = routeMemberMonth({ row: r, activeDecisions: emptyIdx });
    expect(d.route).toBe('amount_discrepancy');
    expect(d.fyi).toContain('cross_entity_wrong_amount');
  });

  it('pop2 target paid wrong_amount → amount_discrepancy', () => {
    const r = row('r', { population: 2, facts: facts({ amount: { kind: 'wrong_amount', actual: 5, expected: 10 } }) });
    expect(routeMemberMonth({ row: r, activeDecisions: emptyIdx }).route).toBe('amount_discrepancy');
  });

  it('pop2 indeterminate → satisfied + FYI only (no queue)', () => {
    const r = row('r', { population: 2, facts: facts({ amount: { kind: 'indeterminate', reason: 'TBD_AMBIGUOUS_PAYEE' } }) });
    const d = routeMemberMonth({ row: r, activeDecisions: emptyIdx });
    expect(d.route).toBe('satisfied');
    expect(d.fyi).toContain('amount_indeterminate');
  });

  it('premium_blocked → premium queue', () => {
    const r = row('r', { facts: facts({ premium: { kind: 'premium_blocked' } }) });
    expect(routeMemberMonth({ row: r, activeDecisions: emptyIdx }).route).toBe('premium');
  });

  it('DMI active + surfaceEligible → dmi queue', () => {
    const r = row('r', { facts: facts({ dmi: { active: true, issueType: 'DMI_CITIZENSHIP', verificationEndDate: '2030-01-01', expired: false, inProgress: false, surfaceEligible: true } }) });
    expect(routeMemberMonth({ row: r, activeDecisions: emptyIdx }).route).toBe('dmi');
  });

  it('DMI expired → manual_review (never auto-write-off)', () => {
    const r = row('r', { facts: facts({ dmi: { active: true, issueType: 'DMI_CITIZENSHIP', verificationEndDate: '2020-01-01', expired: true, inProgress: false, surfaceEligible: true } }) });
    const d = routeMemberMonth({ row: r, activeDecisions: emptyIdx });
    expect(d.route).toBe('manual_review');
    expect(d.fyi).toContain('dmi_expired');
  });

  it('crFlag → chase_eligible + fyi(carrier_recognition)', () => {
    const r = row('r', { crFlag: true });
    const d = routeMemberMonth({ row: r, activeDecisions: emptyIdx });
    expect(d.route).toBe('chase_eligible');
    expect(d.fyi).toContain('carrier_recognition');
  });

  it('default unpaid + no blockers → chase_eligible', () => {
    expect(routeMemberMonth({ row: row('r'), activeDecisions: emptyIdx }).route).toBe('chase_eligible');
  });

  it('active hold_prior_balance → prior_balance queue', async () => {
    await recordDecision({ ...BASE_DECISION, decision_type: 'hold_prior_balance', reason_code: 'prior_balance_owed' });
    const idx = await loadOperatorDecisionIndex(true);
    expect(routeMemberMonth({ row: row('r'), activeDecisions: idx }).route).toBe('prior_balance');
  });

  it('active hold_dmi → dmi queue (even without facts.dmi)', async () => {
    await recordDecision(BASE_DECISION);
    const idx = await loadOperatorDecisionIndex(true);
    expect(routeMemberMonth({ row: row('r'), activeDecisions: idx }).route).toBe('dmi');
  });

  it('active add_to_chase → chase_eligible (with no holds)', async () => {
    await recordDecision({ ...BASE_DECISION, decision_type: 'add_to_chase', reason_code: 'default' });
    const idx = await loadOperatorDecisionIndex(true);
    expect(routeMemberMonth({ row: row('r'), activeDecisions: idx }).route).toBe('chase_eligible');
  });

  it('add_to_chase + active hold → hold wins (add_to_chase never overrides)', async () => {
    await recordDecision({ ...BASE_DECISION, decision_type: 'add_to_chase', reason_code: 'default' });
    await recordDecision(BASE_DECISION); // hold_dmi
    const idx = await loadOperatorDecisionIndex(true);
    expect(routeMemberMonth({ row: row('r'), activeDecisions: idx }).route).toBe('dmi');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Cycle-level (the contract: order matters)
// ─────────────────────────────────────────────────────────────────────────

describe('runDiagnoseCycle — four-phase contract', () => {
  it('target-scope paid wrong_amount via population 2 → amount_discrepancy', async () => {
    const r = row('p2', { population: 2, facts: facts({ amount: { kind: 'wrong_amount', actual: 1, expected: 2 } }) });
    const result = await runDiagnoseCycle({ rows: [r] });
    expect(result.queues.amount_discrepancy).toEqual(['p2']);
    expect(result.chaseEligible).toEqual([]);
  });

  it('hold_dmi + clean later payment → released in phase ii, unblocked in phase iv', async () => {
    await recordDecision(BASE_DECISION); // hold_dmi
    const r = row('clean', {
      facts: facts({ crossEntitySatisfied: { satisfied: true, satisfyingEntity: 'Vix', actualPaid: 10, expectedBasis: 10, amountStatus: { kind: 'correct' } } }),
    });
    const result = await runDiagnoseCycle({ rows: [r] });
    expect(result.appliedReleases).toHaveLength(1);
    expect(result.appliedReleases[0].release_trigger).toBe('commission_file');
    expect(result.routes.get('clean')?.route).toBe('satisfied');
  });

  it('hold_dmi + wrong-amount payment → noop (wrong_amount_wins); route = amount_discrepancy', async () => {
    await recordDecision(BASE_DECISION);
    const r = row('wa', {
      facts: facts({ crossEntitySatisfied: { satisfied: true, satisfyingEntity: 'Vix', actualPaid: 5, expectedBasis: 10, amountStatus: { kind: 'wrong_amount', actual: 5, expected: 10 } } }),
    });
    const result = await runDiagnoseCycle({ rows: [r] });
    expect(result.appliedReleases).toHaveLength(0);
    expect(result.observedNoopSignals).toHaveLength(1);
    expect(result.observedNoopSignals[0].reason).toBe('wrong_amount_wins');
    expect(result.routes.get('wa')?.route).toBe('amount_discrepancy');
  });

  it('premium auto-release: blocked → flips to candidate → release + chase_eligible', async () => {
    await recordDecision({ ...BASE_DECISION, decision_type: 'hold_premium', reason_code: 'awaiting_premium', release_rule: 'auto_premium' });
    const r = row('prem', { facts: facts({ premium: { kind: 'chase_candidate' } }) });
    const result = await runDiagnoseCycle({ rows: [r] });
    expect(result.appliedReleases).toHaveLength(1);
    expect(result.appliedReleases[0].release_trigger).toBe('auto_premium');
    expect(result.routes.get('prem')?.route).toBe('chase_eligible');
  });

  it('idempotent: re-run with unchanged data → identical routes, zero new releases, wrong_amount re-observed', async () => {
    await recordDecision(BASE_DECISION);
    const r = row('wa2', {
      facts: facts({ crossEntitySatisfied: { satisfied: true, satisfyingEntity: 'Vix', actualPaid: 5, expectedBasis: 10, amountStatus: { kind: 'wrong_amount', actual: 5, expected: 10 } } }),
    });
    const r1 = await runDiagnoseCycle({ rows: [r] });
    const r2 = await runDiagnoseCycle({ rows: [r] });
    expect(r1.routes.get('wa2')?.route).toBe(r2.routes.get('wa2')?.route);
    expect(r2.appliedReleases).toHaveLength(0);
    expect(r2.observedNoopSignals[0]?.reason).toBe('wrong_amount_wins');
  });

  it('write boundary: engine never calls record_operator_decision', async () => {
    await recordDecision(BASE_DECISION);
    const recordsBefore = recordRpcCalls;
    const r = row('x', { facts: facts({ crossEntitySatisfied: { satisfied: true, satisfyingEntity: 'Vix', actualPaid: 1, expectedBasis: 1, amountStatus: { kind: 'correct' } } }) });
    await runDiagnoseCycle({ rows: [r] });
    expect(recordRpcCalls).toBe(recordsBefore); // unchanged
    expect(releaseRpcCalls).toBeGreaterThan(0);
  });

  it('detectSignals: hold_premium with row still premium_blocked → no signal', async () => {
    await recordDecision({ ...BASE_DECISION, decision_type: 'hold_premium', reason_code: 'awaiting_premium', release_rule: 'auto_premium' });
    const idx = await loadOperatorDecisionIndex(true);
    const r = row('p', { facts: facts({ premium: { kind: 'premium_blocked' } }) });
    expect(detectSignals([r], idx)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Chase lifecycle
// ─────────────────────────────────────────────────────────────────────────

describe('chase lifecycle', () => {
  const sub: SubmissionRecord = {
    member_grain_rows: [{ stable_member_key: 'isid:u1', policy_identity_key: 'pk', carrier: 'ambetter', target_scope: 'Coverall' }],
    month_range: { from: '2026-02', to: '2026-02' },
    version: 'v1',
  };

  const openArgs = {
    carrier: 'ambetter', stableMemberKey: 'isid:u1', policyIdentityKey: 'pk',
    serviceMonth: '2026-02', scope: 'Coverall' as const,
  };

  it('open → submitted → auto-resolve on backstop', () => {
    let c = openChase(openArgs);
    c = markSubmitted(c, sub);
    expect(c.state).toBe('submitted');
    const f = facts({ crossEntitySatisfied: { satisfied: true, satisfyingEntity: 'Vix', actualPaid: 1, expectedBasis: 1, amountStatus: { kind: 'correct' } } });
    const { record, outcome } = resolveFromBackstop(c, f, 1);
    expect(outcome.kind).toBe('auto_resolve');
    expect(record.state).toBe('resolved');
    expect(record.resolution).toBe('auto');
  });

  it('wrong_amount payment does NOT auto-resolve the chase', () => {
    let c = openChase(openArgs);
    c = markSubmitted(c, sub);
    const f = facts({ crossEntitySatisfied: { satisfied: true, satisfyingEntity: 'Vix', actualPaid: 5, expectedBasis: 10, amountStatus: { kind: 'wrong_amount', actual: 5, expected: 10 } } });
    const { record, outcome } = resolveFromBackstop(c, f, 1);
    expect(outcome.kind).toBe('wrong_amount');
    expect(record.state).toBe('submitted');
  });

  it('reversed/not-satisfied → no_match', () => {
    expect(evaluateBackstop(facts(), 1).kind).toBe('no_match');
  });

  it('manual resolve, then terminal', () => {
    let c = openChase(openArgs);
    c = resolveManual(c, 'carrier_feedback');
    expect(c.state).toBe('resolved');
    expect(c.resolution).toBe('manual');
    const again = resolveManual(c, 'other');
    expect(again).toBe(c); // terminal, no-op returns same ref
  });

  it('cannot submit a resolved chase', () => {
    let c = openChase(openArgs);
    c = resolveManual(c, 'x');
    expect(() => markSubmitted(c, sub)).toThrow(ChaseLifecycleError);
  });

  it('applyCommissionBackstop wrong_amount fires both signals (C0 keeps active)', async () => {
    const dec = await recordDecision(BASE_DECISION);
    const after = await applyCommissionBackstop(dec, { kind: 'wrong_amount' });
    // C0 reducer noops on wrong-amount → status stays 'active'.
    expect(after.status).toBe('active');
  });

  it('applyCommissionBackstop correct → released(commission_file)', async () => {
    const dec = await recordDecision(BASE_DECISION);
    const after = await applyCommissionBackstop(dec, { kind: 'auto_resolve' });
    expect(after.status).toBe('released');
    expect(after.release_trigger).toBe('commission_file');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// C2b-1 Stage 2 — member-count conflict precedence (R-CARR-007)
// ─────────────────────────────────────────────────────────────────────────
describe('routeMemberMonth — memberCount manual_review precedence (R-CARR-007)', () => {
  const emptyIdx = { all: [], byId: new Map(), byMemberMonth: new Map(), byGrain: new Map(), fingerprint: 'empty' } as any;

  it('pop2 paid + memberCount manual_review → manual_review (NOT satisfied, NOT default-to-1)', () => {
    const r = row('r', {
      population: 2,
      facts: facts({
        amount: { kind: 'correct' },
        memberCount: { status: 'manual_review', reason: 'member_count_manual_review', conflicts: [1, 2] },
      }),
    });
    const d = routeMemberMonth({ row: r, activeDecisions: emptyIdx });
    expect(d.route).toBe('manual_review');
    expect(d.rationale).toBe('member_count_manual_review');
  });

  it('pop1 cross-entity-satisfied + memberCount manual_review → manual_review (not satisfied)', () => {
    const r = row('r', {
      facts: facts({
        crossEntitySatisfied: { satisfied: true, satisfyingEntity: 'Vix', actualPaid: 10, expectedBasis: 10, amountStatus: { kind: 'correct' } },
        memberCount: { status: 'manual_review', reason: 'member_count_manual_review', conflicts: [1, 3] },
      }),
    });
    const d = routeMemberMonth({ row: r, activeDecisions: emptyIdx });
    expect(d.route).toBe('manual_review');
    expect(d.rationale).toBe('member_count_manual_review');
  });

  it('pop1 ordinary unpaid + memberCount manual_review (no amount calc) → STAYS in chase', () => {
    const r = row('r', {
      facts: facts({
        memberCount: { status: 'manual_review', reason: 'member_count_manual_review', conflicts: [1, 2] },
      }),
    });
    const d = routeMemberMonth({ row: r, activeDecisions: emptyIdx });
    expect(d.route).toBe('chase_eligible');
  });

  it('memberCount ok / absent leaves existing routes unchanged', () => {
    const okRow = row('ok', {
      population: 2,
      facts: facts({ amount: { kind: 'correct' }, memberCount: { status: 'ok' } }),
    });
    expect(routeMemberMonth({ row: okRow, activeDecisions: emptyIdx }).route).toBe('satisfied');
    const absentRow = row('absent', { population: 2, facts: facts({ amount: { kind: 'correct' } }) });
    expect(routeMemberMonth({ row: absentRow, activeDecisions: emptyIdx }).route).toBe('satisfied');
  });
});


// ─────────────────────────────────────────────────────────────────────────
// C2b-2 Stage 1 — projectDiagnoseRoutes (read-only projection)
// ─────────────────────────────────────────────────────────────────────────
describe('projectDiagnoseRoutes — read-only projection', () => {
  function seededPopulation(): RouteRowInput[] {
    return [
      row('chase', { stableMemberKey: 'isid:u1', identity: { carrier: 'Ambetter', issuer_subscriber_id: 'U1' } }),
      row('sat', {
        stableMemberKey: 'isid:u2',
        identity: { carrier: 'Ambetter', issuer_subscriber_id: 'U2' },
        facts: facts({ crossEntitySatisfied: { satisfied: true, satisfyingEntity: 'Vix', actualPaid: 10, expectedBasis: 10, amountStatus: { kind: 'correct' } } }),
      }),
      row('prem', {
        stableMemberKey: 'isid:u3',
        identity: { carrier: 'Ambetter', issuer_subscriber_id: 'U3' },
        facts: facts({ premium: { kind: 'premium_blocked' } }),
      }),
      row('p2wa', {
        stableMemberKey: 'isid:u4',
        identity: { carrier: 'Ambetter', issuer_subscriber_id: 'U4' },
        population: 2,
        facts: facts({ amount: { kind: 'wrong_amount', actual: 1, expected: 2 } }),
      }),
    ];
  }

  it('PARITY: with no due-for-release decisions, projection === cycle (routes/fyi/buckets)', async () => {
    const rows = seededPopulation();
    const cycle = await runDiagnoseCycle({ rows });
    const proj = await projectDiagnoseRoutes({ rows });

    expect(proj.chaseEligible.sort()).toEqual(cycle.chaseEligible.sort());
    expect(proj.satisfied.sort()).toEqual(cycle.satisfied.sort());
    expect(proj.queues.amount_discrepancy.sort()).toEqual(cycle.queues.amount_discrepancy.sort());
    expect(proj.queues.premium.sort()).toEqual(cycle.queues.premium.sort());
    expect(proj.queues.dmi.sort()).toEqual(cycle.queues.dmi.sort());
    expect(proj.queues.prior_balance.sort()).toEqual(cycle.queues.prior_balance.sort());
    expect(proj.queues.manual_review.sort()).toEqual(cycle.queues.manual_review.sort());

    for (const r of rows) {
      expect(proj.routes.get(r.rowKey)?.route).toBe(cycle.routes.get(r.rowKey)?.route);
      expect(proj.routes.get(r.rowKey)?.rationale).toBe(cycle.routes.get(r.rowKey)?.rationale);
      expect(proj.fyi.get(r.rowKey) ?? []).toEqual(cycle.fyi.get(r.rowKey) ?? []);
    }
  });

  it('NO-WRITE: projection performs zero RPC writes (record + release)', async () => {
    // Seed a hold + a row that WOULD release in a full cycle.
    await recordDecision(BASE_DECISION); // hold_dmi
    const recordsBefore = recordRpcCalls;
    const releasesBefore = releaseRpcCalls;

    const r = row('plain');
    const proj = await projectDiagnoseRoutes({ rows: [r], forceDecisionIndex: true });

    expect(recordRpcCalls).toBe(recordsBefore);
    expect(releaseRpcCalls).toBe(releasesBefore);
    // Pre-release state: hold_dmi still active → routed to dmi queue.
    expect(proj.queues.dmi).toEqual(['plain']);
  });

  it('FORCED LOAD: forceDecisionIndex flag is threaded into loader (true/false/default)', async () => {
    const rows = seededPopulation();
    const loader = vi.fn(async (_force: boolean) => loadOperatorDecisionIndex(_force));

    await projectDiagnoseRoutes({ rows, loadDecisionIndex: loader, forceDecisionIndex: true });
    expect(loader).toHaveBeenLastCalledWith(true);

    await projectDiagnoseRoutes({ rows, loadDecisionIndex: loader, forceDecisionIndex: false });
    expect(loader).toHaveBeenLastCalledWith(false);

    await projectDiagnoseRoutes({ rows, loadDecisionIndex: loader });
    expect(loader).toHaveBeenLastCalledWith(false);
  });
});
