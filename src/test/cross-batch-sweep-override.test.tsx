/**
 * Bundle 13d — sweep override-flow integration tests.
 * Uses the REAL wrapper (no mock) against a synthetic comp-rate fixture.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fromMock = vi.fn();
const rpcMock = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: (...a: any[]) => fromMock(...a), rpc: (...a: any[]) => rpcMock(...a) },
}));

// Real wrapper but synthetic comp rates: Ambetter SC/FL $34 PMPM.
vi.mock('@/lib/canonical/compGridLoader', () => ({
  loadCarrierCompRates: async () => ([
    { id: 'amb-sc', rate_key: 'amb-sc', carrier_key: 'ambetter', carrier_display: 'Ambetter', state_code: 'SC', plan_variant: null, comp_basis: 'pmpm', calculation_basis: 'per_member_pmpm', rate_value: 34, rate_unit: 'pmpm', member_min: null, member_max: null, member_cap: null, effective_year: 2026, support_status: 'supported', unsupported_reason: null },
    { id: 'amb-fl', rate_key: 'amb-fl', carrier_key: 'ambetter', carrier_display: 'Ambetter', state_code: 'FL', plan_variant: null, comp_basis: 'pmpm', calculation_basis: 'per_member_pmpm', rate_value: 34, rate_unit: 'pmpm', member_min: null, member_max: null, member_cap: null, effective_year: 2026, support_status: 'supported', unsupported_reason: null },
  ]),
}));

import { runCrossBatchClearingSweep } from '@/lib/sweep/crossBatchClearingSweep';

const ambetter = 'AMBETTER';
const EF = 'Erica Fine (21277051)';
const JF = 'Jason Fine (21055210)';

type Batch = { id: string; statement_month: string; created_at: string };
type RM = any;
type NR = any;

function batch(id: string, sm: string): Batch { return { id, statement_month: sm, created_at: sm }; }

function rm(id: string, batch_id: string, opts: Partial<RM> = {}): RM {
  return {
    id, batch_id, in_commission: false,
    expected_ede_effective_month: '2026-02', carrier: ambetter,
    policy_number: 'p1', issuer_subscriber_id: 'p1',
    current_policy_aor: EF,
    actual_pay_entity: null,
    expected_pay_entity: null,
    agent_npn: '21277051',
    ...opts,
  };
}

function ede(id: string, batch_id: string, pn: string, state = 'SC'): NR {
  return {
    id, batch_id, source_type: 'EDE', carrier: ambetter,
    policy_number: pn, issuer_subscriber_id: pn,
    effective_date: '2026-02-01', client_state_full: state,
    raw_json: { coveredMemberCount: 1 },
  };
}

function comm(id: string, batch_id: string, pn: string, amt: number, pay_entity: string | null = null): NR {
  return {
    id, batch_id, source_type: 'COMMISSION', carrier: ambetter,
    policy_number: pn, issuer_subscriber_id: pn,
    commission_amount: amt, created_at: '2026-03-15',
    paid_to_date: '2026-02-28', months_paid: 1,
    pay_entity,
    raw_json: {},
  };
}

interface Fix { batches: Batch[]; reconciled?: RM[]; boEde?: NR[]; commission?: NR[]; }

function setup(fx: Fix) {
  fromMock.mockImplementation((table: string) => {
    if (table === 'upload_batches') return { select: () => Promise.resolve({ data: fx.batches, error: null }) };
    if (table === 'reconciled_members') {
      const chain: any = {
        _b: null,
        select() { return chain; },
        eq(_c: string, v: string) { chain._b = v; return chain; },
        range(from: number) {
          if (from > 0) return Promise.resolve({ data: [], error: null });
          return Promise.resolve({ data: (fx.reconciled ?? []).filter(r => r.batch_id === chain._b), error: null });
        },
      };
      return chain;
    }
    if (table === 'normalized_records') {
      const chain: any = {
        _src: null, _col: null, _vals: [] as string[], _gt: false,
        select() { return chain; },
        eq(c: string, _v: string) { if (c === 'source_type') chain._src = 'COMMISSION'; return chain; },
        is() { return chain; },
        in(c: string, v: string[]) {
          if (c === 'source_type') chain._src = 'BO_EDE';
          else { chain._col = c; chain._vals = v; }
          return chain;
        },
        order() { return chain; },
        limit() { return chain; },
        gt() { chain._gt = true; return chain; },
        then(resolve: any) {
          if (chain._gt) return resolve({ data: [], error: null });
          let rows: NR[] = chain._src === 'COMMISSION' ? (fx.commission ?? []) : (fx.boEde ?? []);
          if (chain._src === 'BO_EDE') rows = rows.filter(r => r.source_type === 'BACK_OFFICE' || r.source_type === 'EDE');
          else rows = rows.filter(r => r.source_type === 'COMMISSION');
          if (chain._col) {
            const col = chain._col; const set = new Set(chain._vals);
            rows = rows.filter((r: any) => set.has(r[col]));
          }
          resolve({ data: rows, error: null });
        },
      };
      return chain;
    }
    return { select: () => Promise.resolve({ data: [], error: null }) };
  });
}

function rows(): any[] {
  return rpcMock.mock.calls.filter(c => c[0] === 'insert_clearing_rows').flatMap(c => c[1].p_rows);
}

beforeEach(() => {
  fromMock.mockReset();
  rpcMock.mockReset();
  rpcMock.mockImplementation((name: string, args: any) => {
    if (name === 'supersede_active_clearings_batch') return Promise.resolve({ data: 0, error: null });
    if (name === 'insert_clearing_rows') return Promise.resolve({ data: args.p_rows.length, error: null });
    return Promise.resolve({ data: null, error: null });
  });
});

describe('sweep — AOR-tier override (Bundle 13d)', () => {
  it('Patty-style: Erica + Coverall candidate $0.50 → fully_cleared @ $0.50', async () => {
    setup({
      batches: [batch('B1', '2026-02-01'), batch('B2', '2026-03-01')],
      reconciled: [rm('M1', 'B1')],
      boEde: [ede('E1', 'B1', 'p1', 'SC')],
      commission: [comm('C1', 'B2', 'p1', 0.50, 'Coverall')],
    });
    await runCrossBatchClearingSweep({ generationId: 1, shouldContinue: () => true });
    const r = rows()[0];
    expect(r.clearing_state).toBe('fully_cleared');
    expect(r.expected_amount).toBe(0.50);
    expect(r.actual_net_amount).toBe(0.50);
    expect(r.remainder_owed).toBe(0);
    expect(r.pay_entity).toBe('Coverall');
  });

  it('Alicia-style: Erica + Vix candidate $4.50 FL → fully_cleared @ $4.50', async () => {
    setup({
      batches: [batch('B1', '2026-02-01'), batch('B2', '2026-03-01')],
      reconciled: [rm('M1', 'B1')],
      boEde: [ede('E1', 'B1', 'p1', 'FL')],
      commission: [comm('C1', 'B2', 'p1', 4.50, 'Vix')],
    });
    await runCrossBatchClearingSweep({ generationId: 1, shouldContinue: () => true });
    const r = rows()[0];
    expect(r.clearing_state).toBe('fully_cleared');
    expect(r.expected_amount).toBe(4.50);
    expect(r.pay_entity).toBe('Vix');
  });

  it('Erica + member payee Vix + no candidates → not_cleared @ $4.50', async () => {
    setup({
      batches: [batch('B1', '2026-02-01')],
      reconciled: [rm('M1', 'B1', { actual_pay_entity: 'Vix' })],
      boEde: [ede('E1', 'B1', 'p1', 'FL')],
    });
    await runCrossBatchClearingSweep({ generationId: 1, shouldContinue: () => true });
    const r = rows()[0];
    expect(r.clearing_state).toBe('not_cleared');
    expect(r.expected_amount).toBe(4.50);
  });

  it('Erica + null payee + no candidates → not_cleared @ carrier $34', async () => {
    setup({
      batches: [batch('B1', '2026-02-01')],
      reconciled: [rm('M1', 'B1')],
      boEde: [ede('E1', 'B1', 'p1', 'SC')],
    });
    await runCrossBatchClearingSweep({ generationId: 1, shouldContinue: () => true });
    const r = rows()[0];
    expect(r.clearing_state).toBe('not_cleared');
    expect(r.expected_amount).toBe(34);
  });

  it('Mixed Coverall + Vix candidates → conflicting_override_payee', async () => {
    setup({
      batches: [batch('B1', '2026-02-01'), batch('B2', '2026-03-01')],
      reconciled: [rm('M1', 'B1')],
      boEde: [ede('E1', 'B1', 'p1', 'SC')],
      commission: [comm('C1', 'B2', 'p1', 0.50, 'Coverall'), comm('C2', 'B2', 'p1', 4.50, 'Vix')],
    });
    await runCrossBatchClearingSweep({ generationId: 1, shouldContinue: () => true });
    const r = rows()[0];
    expect(r.clearing_state).toBe('manual_review_required');
    expect(r.manual_review_reason).toBe('conflicting_override_payee');
  });

  it('Member payee Coverall but candidate Vix → conflicting_override_payee', async () => {
    setup({
      batches: [batch('B1', '2026-02-01'), batch('B2', '2026-03-01')],
      reconciled: [rm('M1', 'B1', { actual_pay_entity: 'Coverall' })],
      boEde: [ede('E1', 'B1', 'p1', 'SC')],
      commission: [comm('C1', 'B2', 'p1', 4.50, 'Vix')],
    });
    await runCrossBatchClearingSweep({ generationId: 1, shouldContinue: () => true });
    const r = rows()[0];
    expect(r.manual_review_reason).toBe('conflicting_override_payee');
  });

  it('Jason AOR + Coverall payment → comp grid $34 (not override)', async () => {
    setup({
      batches: [batch('B1', '2026-02-01'), batch('B2', '2026-03-01')],
      reconciled: [rm('M1', 'B1', { current_policy_aor: JF, agent_npn: '21055210' })],
      boEde: [ede('E1', 'B1', 'p1', 'SC')],
      commission: [comm('C1', 'B2', 'p1', 34, 'Coverall')],
    });
    await runCrossBatchClearingSweep({ generationId: 1, shouldContinue: () => true });
    const r = rows()[0];
    expect(r.expected_amount).toBe(34);
  });

  it('Owner from current_policy_aor not agent_npn', async () => {
    setup({
      batches: [batch('B1', '2026-02-01'), batch('B2', '2026-03-01')],
      reconciled: [rm('M1', 'B1', { agent_npn: '99999999' })], // EF AOR but unrelated agent_npn
      boEde: [ede('E1', 'B1', 'p1', 'SC')],
      commission: [comm('C1', 'B2', 'p1', 0.50, 'Coverall')],
    });
    await runCrossBatchClearingSweep({ generationId: 1, shouldContinue: () => true });
    const r = rows()[0];
    expect(r.expected_amount).toBe(0.50);
  });
});
