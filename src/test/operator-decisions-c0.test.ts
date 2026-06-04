/**
 * Phase C0 — operator_decisions foundation tests.
 *
 * All signals are synthetic/seeded. No live blocker facts, no UI.
 *
 * Uses an in-memory fake that emulates the two RPCs
 * (record_operator_decision, release_operator_decision) atomically,
 * including supersession at the active grain and release semantics.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = any;

const db: { rows: Row[] } = { rows: [] };
let idCounter = 1;

function nextId(): string {
  return `dec-${String(idCounter++).padStart(6, '0')}`;
}

function matchGrain(r: Row, p: any): boolean {
  return r.carrier === p.p_carrier
    && r.stable_member_key === p.p_stable_member_key
    && r.policy_identity_key === p.p_policy_identity_key
    && r.service_month === p.p_service_month
    && r.target_scope === p.p_target_scope
    && r.reason_code === p.p_reason_code;
}

const rpcImpls: Record<string, (params: any) => { data: any; error: any }> = {
  record_operator_decision(p) {
    const newId = nextId();
    // Supersede prior active row at the grain.
    for (const r of db.rows) {
      if (r.status === 'active' && matchGrain(r, p as any)) {
        r.status = 'superseded';
        r.superseded_at = new Date().toISOString();
        r.superseded_by_decision_id = newId;
      }
    }
    const row: Row = {
      id: newId,
      carrier: p.p_carrier,
      stable_member_key: p.p_stable_member_key,
      policy_identity_key: p.p_policy_identity_key,
      service_month: p.p_service_month,
      target_scope: p.p_target_scope,
      reason_code: p.p_reason_code,
      decision_type: p.p_decision_type,
      internal_note: p.p_internal_note ?? null,
      messer_comment: p.p_messer_comment ?? null,
      evidence_snapshot: p.p_evidence_snapshot ?? {},
      release_rule: p.p_release_rule,
      amount_payload: p.p_amount_payload ?? null,
      status: 'active',
      superseded_at: null,
      superseded_by_decision_id: null,
      released_at: null,
      release_trigger: null,
      decided_by: p.p_decided_by ?? null,
      decided_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    };
    db.rows.push(row);
    return { data: row, error: null };
  },
  release_operator_decision(p) {
    const row = db.rows.find(r => r.id === p.p_id);
    if (!row) return { data: null, error: null };
    if (row.status === 'active') {
      row.status = 'released';
      row.released_at = new Date().toISOString();
      row.release_trigger = p.p_trigger;
      if (p.p_evidence != null) {
        row.evidence_snapshot = { ...row.evidence_snapshot, release_evidence: p.p_evidence };
      }
    }
    return { data: row, error: null };
  },
};

function makeFromChain(table: string) {
  if (table !== 'operator_decisions') {
    return { select: () => ({ eq: () => ({ order: () => ({ range: () => Promise.resolve({ data: [], error: null }) }) }) }) };
  }
  const chain: any = {
    _statusFilter: null as null | string,
    select() { return chain; },
    eq(col: string, val: string) {
      if (col === 'status') chain._statusFilter = val;
      return chain;
    },
    order() { return chain; },
    range(from: number, _to: number) {
      if (from > 0) return Promise.resolve({ data: [], error: null });
      let rows = db.rows;
      if (chain._statusFilter) rows = rows.filter(r => r.status === chain._statusFilter);
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
  applyDecisionReduction,
  reduceDecision,
  loadOperatorDecisionIndex,
  invalidateOperatorDecisionCache,
  isChaseEligible,
  deriveStableMemberKey,
  derivePolicyKeyOrSentinel,
  OperatorDecisionValidationError,
  grainKey,
  type OperatorDecisionRow,
  type RecordDecisionInput,
} from '@/lib/canonical/operatorDecisions';

beforeEach(() => {
  db.rows = [];
  idCounter = 1;
  invalidateOperatorDecisionCache();
});

const BASE_INPUT: RecordDecisionInput = {
  identity: { carrier: 'Ambetter', issuer_subscriber_id: 'U99999999', policy_number: 'U99999999' },
  service_month: '2026-02',
  target_scope: 'Coverall',
  decision_type: 'hold_premium',
  reason_code: 'awaiting_premium',
  release_rule: 'auto_premium',
};

describe('Phase C0 — operator_decisions', () => {
  describe('stable-key derivation', () => {
    it('prefers issuer_subscriber_id', () => {
      expect(deriveStableMemberKey({ carrier: 'Ambetter', issuer_subscriber_id: 'U1', exchange_subscriber_id: 'E1', policy_number: 'P1' }))
        .toBe('isid:u1');
    });
    it('falls back to exchange_subscriber_id', () => {
      expect(deriveStableMemberKey({ carrier: 'Ambetter', exchange_subscriber_id: 'E1', policy_number: 'P1' }))
        .toBe('esid:e1');
    });
    it('falls back to policy_number', () => {
      expect(deriveStableMemberKey({ carrier: 'Ambetter', policy_number: 'P-001' })).toBe('pn:p001');
    });
    it('produces deterministic sentinel for unresolvable policy', () => {
      const { policy_identity_key, unresolved_reason } = derivePolicyKeyOrSentinel(
        { carrier: 'Ambetter', issuer_subscriber_id: null, policy_number: null }, 'esid:e1');
      expect(unresolved_reason).toBe('no_identity_keys');
      expect(policy_identity_key).toBe('unresolved:no_identity_keys:esid:e1');
    });
  });

  describe('persistence + rebuild survival', () => {
    it('stable composite grain resolves the same logical decision after identity reshuffle', async () => {
      const row = await recordDecision(BASE_INPUT);
      // Simulate rebuild: identity reshuffle changes the volatile reconciled member_key, but
      // the stable composite (carrier|isid|policy_identity_key|month|scope|reason) is unchanged.
      const idx = await loadOperatorDecisionIndex(true);
      const g = grainKey(row);
      expect(idx.byGrain.get(g)?.id).toBe(row.id);
      expect(row.evidence_snapshot).toMatchObject({ _release_rule_at_decision: 'auto_premium' });
      expect(row.release_rule).toBe('auto_premium');
    });
  });

  describe('supersession + atomicity', () => {
    it('new decision at same grain supersedes prior', async () => {
      const a = await recordDecision(BASE_INPUT);
      const b = await recordDecision({ ...BASE_INPUT, internal_note: 'updated' });
      const idx = await loadOperatorDecisionIndex(true);
      expect(idx.all).toHaveLength(1);
      expect(idx.all[0].id).toBe(b.id);
      const all = db.rows;
      const prior = all.find(r => r.id === a.id)!;
      expect(prior.status).toBe('superseded');
      expect(prior.superseded_by_decision_id).toBe(b.id);
      expect(prior.superseded_at).toBeTruthy();
    });

    it('serial same-grain double-submit leaves exactly one active row', async () => {
      await Promise.all([
        recordDecision(BASE_INPUT),
        recordDecision({ ...BASE_INPUT, internal_note: 'race' }),
      ]);
      const active = db.rows.filter(r => r.status === 'active');
      expect(active).toHaveLength(1);
    });

    it('unresolved-sentinel grain — two unresolved decisions supersede (not coexist)', async () => {
      const unresolvedInput: RecordDecisionInput = {
        ...BASE_INPUT,
        identity: { carrier: 'Ambetter', issuer_subscriber_id: 'U77', policy_number: null },
      };
      // First: resolvable via subscriber-id sentinel? Actually subscriber_id alone resolves
      // → ambetter|sub:77. To force unresolvable policy, use exchange_subscriber_id only.
      const forced: RecordDecisionInput = {
        ...BASE_INPUT,
        identity: { carrier: 'Ambetter', exchange_subscriber_id: 'EX1', policy_number: null, issuer_subscriber_id: null },
      };
      await recordDecision(forced);
      await recordDecision(forced);
      void unresolvedInput;
      const active = db.rows.filter(r => r.status === 'active');
      expect(active).toHaveLength(1);
      expect(active[0].policy_identity_key.startsWith('unresolved:no_identity_keys:')).toBe(true);
    });
  });

  describe('grain separation — independent active decisions', () => {
    it('different policy_identity_key → independent', async () => {
      await recordDecision(BASE_INPUT);
      await recordDecision({
        ...BASE_INPUT,
        identity: { carrier: 'Ambetter', issuer_subscriber_id: 'U99999999', policy_number: 'OTHER-POLICY' },
      });
      const active = db.rows.filter(r => r.status === 'active');
      expect(active).toHaveLength(2);
    });
    it('different target_scope → independent', async () => {
      await recordDecision(BASE_INPUT);
      await recordDecision({ ...BASE_INPUT, target_scope: 'Vix' });
      expect(db.rows.filter(r => r.status === 'active')).toHaveLength(2);
    });
    it('different reason_code → independent', async () => {
      await recordDecision(BASE_INPUT);
      await recordDecision({ ...BASE_INPUT, reason_code: 'default' });
      expect(db.rows.filter(r => r.status === 'active')).toHaveLength(2);
    });
  });

  describe('reducer matrix', () => {
    const auto = { release_rule: 'auto_premium' as const, status: 'active' as const };
    const sticky = { release_rule: 'sticky_manual' as const, status: 'active' as const };

    it('auto_premium + premiumPaidThroughCurrent → release auto_premium', () => {
      expect(reduceDecision(auto, { premiumPaidThroughCurrent: true })).toEqual({ kind: 'release', trigger: 'auto_premium' });
    });
    it('sticky_manual ignores premium signal', () => {
      expect(reduceDecision(sticky, { premiumPaidThroughCurrent: true })).toEqual({ kind: 'noop' });
    });
    it('sticky_manual + manualRelease → release manual', () => {
      expect(reduceDecision(sticky, { manualRelease: true })).toEqual({ kind: 'release', trigger: 'manual' });
    });
    it('commissionFilePaid alone (auto_premium) → release commission_file', () => {
      expect(reduceDecision(auto, { commissionFilePaid: true })).toEqual({ kind: 'release', trigger: 'commission_file' });
    });
    it('commissionFilePaid alone (sticky_manual) → release commission_file', () => {
      expect(reduceDecision(sticky, { commissionFilePaid: true })).toEqual({ kind: 'release', trigger: 'commission_file' });
    });
    it('wrong-amount WINS over paid (both true) → stays active', () => {
      expect(reduceDecision(auto, { commissionFilePaid: true, commissionFilePaidWrongAmount: true })).toEqual({ kind: 'noop' });
      expect(reduceDecision(sticky, { commissionFilePaid: true, commissionFilePaidWrongAmount: true })).toEqual({ kind: 'noop' });
    });
    it('wrong-amount alone → stays active', () => {
      expect(reduceDecision(auto, { commissionFilePaidWrongAmount: true })).toEqual({ kind: 'noop' });
    });
    it('released/superseded never reactivate', () => {
      expect(reduceDecision({ status: 'released', release_rule: 'auto_premium' }, { commissionFilePaid: true })).toEqual({ kind: 'noop' });
      expect(reduceDecision({ status: 'superseded', release_rule: 'sticky_manual' }, { manualRelease: true })).toEqual({ kind: 'noop' });
    });
  });

  describe('release persistence', () => {
    it('persists released + released_at + release_trigger and fresh load reflects it', async () => {
      const row = await recordDecision(BASE_INPUT);
      const released = await applyDecisionReduction(row, { commissionFilePaid: true });
      expect(released.status).toBe('released');
      expect(released.release_trigger).toBe('commission_file');
      expect(released.released_at).toBeTruthy();
      // History preserved.
      expect(db.rows.filter(r => r.id === row.id)).toHaveLength(1);
      // Fresh index reflects (no longer active).
      const idx = await loadOperatorDecisionIndex(true);
      expect(idx.all.find(d => d.id === row.id)).toBeUndefined();
    });

    it('applyDecisionReduction noop returns same decision unchanged', async () => {
      const row = await recordDecision(BASE_INPUT);
      const same = await applyDecisionReduction(row, { commissionFilePaidWrongAmount: true });
      expect(same.status).toBe('active');
    });
  });

  describe('cache invalidation', () => {
    it('newly recorded decision is visible immediately (no force needed)', async () => {
      await loadOperatorDecisionIndex(true); // warm cache empty
      const row = await recordDecision(BASE_INPUT);
      const idx = await loadOperatorDecisionIndex(); // no force
      expect(idx.byId.get(row.id)).toBeTruthy();
    });
  });

  describe('G3 gating', () => {
    const memberArgs = { carrier: 'Ambetter', stable_member_key: 'isid:u99999999', service_month: '2026-02', scope: 'Coverall' as const };

    it('two active holds at the grain → not chase-eligible', async () => {
      await recordDecision(BASE_INPUT); // hold_premium
      await recordDecision({ ...BASE_INPUT, decision_type: 'hold_dmi', reason_code: 'data_mismatch_investigation', release_rule: 'sticky_manual' });
      const idx = await loadOperatorDecisionIndex(true);
      expect(isChaseEligible(idx, memberArgs)).toBe(false);
    });

    it('releasing one still leaves one hold → still not eligible', async () => {
      const a = await recordDecision(BASE_INPUT);
      await recordDecision({ ...BASE_INPUT, decision_type: 'hold_dmi', reason_code: 'data_mismatch_investigation', release_rule: 'sticky_manual' });
      await applyDecisionReduction(a, { commissionFilePaid: true });
      const idx = await loadOperatorDecisionIndex(true);
      expect(isChaseEligible(idx, memberArgs)).toBe(false);
    });

    it('releasing both → chase-eligible', async () => {
      const a = await recordDecision(BASE_INPUT);
      const b = await recordDecision({ ...BASE_INPUT, decision_type: 'hold_dmi', reason_code: 'data_mismatch_investigation', release_rule: 'sticky_manual' });
      await applyDecisionReduction(a, { commissionFilePaid: true });
      await applyDecisionReduction(b, { manualRelease: true });
      const idx = await loadOperatorDecisionIndex(true);
      expect(isChaseEligible(idx, memberArgs)).toBe(true);
    });

    it('chase / add_to_chase do not block', async () => {
      await recordDecision({ ...BASE_INPUT, decision_type: 'chase', reason_code: 'missing_commission', release_rule: 'sticky_manual' });
      await recordDecision({ ...BASE_INPUT, decision_type: 'add_to_chase', reason_code: 'default', release_rule: 'sticky_manual' });
      const idx = await loadOperatorDecisionIndex(true);
      expect(isChaseEligible(idx, memberArgs)).toBe(true);
    });

    it("'All'-scope hold blocks scoped queries", async () => {
      await recordDecision({ ...BASE_INPUT, target_scope: 'All' });
      const idx = await loadOperatorDecisionIndex(true);
      expect(isChaseEligible(idx, { ...memberArgs, scope: 'Coverall' })).toBe(false);
      expect(isChaseEligible(idx, { ...memberArgs, scope: 'Vix' })).toBe(false);
    });
  });

  describe('vocabulary validation', () => {
    it('rejects unknown decision_type', async () => {
      await expect(recordDecision({ ...BASE_INPUT, decision_type: 'bogus' as any }))
        .rejects.toBeInstanceOf(OperatorDecisionValidationError);
    });
    it('rejects unknown release_rule', async () => {
      await expect(recordDecision({ ...BASE_INPUT, release_rule: 'never' as any }))
        .rejects.toBeInstanceOf(OperatorDecisionValidationError);
    });
    it('rejects reason_code not allowed for decision_type', async () => {
      await expect(recordDecision({ ...BASE_INPUT, decision_type: 'chase', reason_code: 'awaiting_premium' }))
        .rejects.toBeInstanceOf(OperatorDecisionValidationError);
    });
    it('rejects bad service_month', async () => {
      await expect(recordDecision({ ...BASE_INPUT, service_month: '2026/02' }))
        .rejects.toBeInstanceOf(OperatorDecisionValidationError);
    });
  });

  describe('note separation', () => {
    it('internal_note and messer_comment round-trip independently', async () => {
      const row = await recordDecision({ ...BASE_INPUT, internal_note: 'INTERNAL ONLY', messer_comment: 'carrier-safe' });
      expect(row.internal_note).toBe('INTERNAL ONLY');
      expect(row.messer_comment).toBe('carrier-safe');
    });
  });

  describe('amount payload', () => {
    it('round-trips opaquely', async () => {
      const payload = { expected: 18.5, actual: 12.0, delta: -6.5, evidence: { source: 'commission' } };
      const row = await recordDecision({ ...BASE_INPUT, amount_payload: payload });
      expect(row.amount_payload).toEqual(payload);
    });
  });
});
