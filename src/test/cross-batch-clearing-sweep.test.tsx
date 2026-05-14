/**
 * Bundle 13b — sweep tests (v11).
 * Uses explicit getExpectedCommission mock for deterministic compGrid output.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fromMock = vi.fn();
const rpcMock = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: (...a: any[]) => fromMock(...a), rpc: (...a: any[]) => rpcMock(...a) },
}));
vi.mock('@/lib/canonical/compGridLoader', () => ({
  loadCarrierCompRates: async () => [],
}));

const getExpectedCommissionMock = vi.fn();
vi.mock('@/lib/canonical/compGrid', () => ({
  getExpectedCommission: (...args: any[]) => getExpectedCommissionMock(...args),
}));

import { runCrossBatchClearingSweep } from '@/lib/sweep/crossBatchClearingSweep';

type Batch = { id: string; statement_month: string; created_at: string };
type RM = {
  id: string; batch_id: string; in_commission: boolean;
  expected_ede_effective_month: string | null; carrier: string | null;
  policy_number?: string | null; issuer_subscriber_id?: string | null;
  expected_pay_entity?: string | null; actual_pay_entity?: string | null; agent_npn?: string | null;
};
type NR = {
  id: string; batch_id: string; source_type: 'BACK_OFFICE' | 'EDE' | 'COMMISSION';
  carrier?: string | null; policy_number?: string | null; issuer_subscriber_id?: string | null;
  effective_date?: string | null; broker_effective_date?: string | null;
  client_state_full?: string | null; commission_amount?: number | null;
  paid_to_date?: string | null; months_paid?: number | null;
  raw_json?: any; created_at?: string;
};

interface Fixture {
  batches: Batch[];
  reconciled?: RM[];
  boEde?: NR[];
  commission?: NR[];
}

interface Counters { commissionFromCalls: number; }

function setupFixture(fx: Fixture): Counters {
  const counters: Counters = { commissionFromCalls: 0 };
  fromMock.mockImplementation((table: string) => {
    if (table === 'upload_batches') {
      return { select: () => Promise.resolve({ data: fx.batches, error: null }) };
    }
    if (table === 'reconciled_members') {
      const chain: any = {
        _batch: null,
        select() { return chain; },
        eq(_c: string, v: string) { chain._batch = v; return chain; },
        range(from: number) {
          if (from > 0) return Promise.resolve({ data: [], error: null });
          const rows = (fx.reconciled ?? []).filter(r => r.batch_id === chain._batch);
          return Promise.resolve({ data: rows, error: null });
        },
      };
      return chain;
    }
    if (table === 'normalized_records') {
      const chain: any = {
        _src: null as null | 'COMMISSION' | 'BO_EDE',
        _inCol: null as null | string,
        _inVals: [] as string[],
        _gt: false,
        select() { return chain; },
        eq(c: string, v: string) {
          if (c === 'source_type') { chain._src = 'COMMISSION'; counters.commissionFromCalls++; }
          return chain;
        },
        is() { return chain; },
        in(c: string, v: string[]) {
          if (c === 'source_type') chain._src = 'BO_EDE';
          else { chain._inCol = c; chain._inVals = v; }
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
          if (chain._inCol) {
            const col = chain._inCol; const vals = new Set(chain._inVals);
            rows = rows.filter((r: any) => vals.has(r[col]));
          }
          resolve({ data: rows, error: null });
        },
      };
      return chain;
    }
    return { select: () => Promise.resolve({ data: [], error: null }) };
  });
  return counters;
}

beforeEach(() => {
  fromMock.mockReset();
  rpcMock.mockReset();
  getExpectedCommissionMock.mockReset();
  getExpectedCommissionMock.mockReturnValue({
    supportStatus: 'supported', expectedAmount: 100, rateRecordId: 'rate-100', evidence: {},
  });
  rpcMock.mockResolvedValue({ error: null });
});

const ambetter = 'AMBETTER';
const baseBatch = (id: string, sm: string): Batch => ({ id, statement_month: sm, created_at: '2026-02-01' });

function makeUnpaidRM(id: string, batch_id: string, opts: Partial<RM> = {}): RM {
  return {
    id, batch_id, in_commission: false,
    expected_ede_effective_month: '2026-02', carrier: ambetter,
    policy_number: 'p1', issuer_subscriber_id: null, ...opts,
  };
}

function ambetterBoEde(id: string, batch_id: string, pn: string, state = 'FL'): NR {
  return {
    id, batch_id, source_type: 'EDE', carrier: ambetter,
    policy_number: pn, issuer_subscriber_id: pn,
    effective_date: '2026-02-01', client_state_full: state,
    raw_json: { coveredMemberCount: 1 },
  };
}

function commissionRow(id: string, batch_id: string, pn: string, amt: number, opts: Partial<NR> = {}): NR {
  return {
    id, batch_id, source_type: 'COMMISSION', carrier: ambetter,
    policy_number: pn, issuer_subscriber_id: pn,
    commission_amount: amt, created_at: '2026-03-15',
    paid_to_date: '2026-02-28', months_paid: 1,
    raw_json: {}, ...opts,
  };
}

// ---------- Group: safety guards ----------
describe('crossBatchClearingSweep — safety guards', () => {
  it('aborts with stale_generation when shouldContinue is false', async () => {
    const r = await runCrossBatchClearingSweep({ generationId: 1, shouldContinue: () => false });
    expect(r.aborted).toBe(true);
    expect(r.abortReason).toBe('stale_generation');
  });

  it('aborts with no_upload_batches when zero rows', async () => {
    setupFixture({ batches: [] });
    const r = await runCrossBatchClearingSweep({ generationId: 1, shouldContinue: () => true });
    expect(r.aborted).toBe(true);
    expect(r.abortReason).toBe('no_upload_batches');
    expect(rpcMock).not.toHaveBeenCalled();
    expect(r.clearingRowsWritten).toBe(0);
  });

  it('aborts with upload_batches_load_failed on error', async () => {
    fromMock.mockReturnValueOnce({ select: () => Promise.resolve({ data: null, error: new Error('boom') }) });
    const r = await runCrossBatchClearingSweep({ generationId: 1, shouldContinue: () => true });
    expect(r.aborted).toBe(true);
    expect(r.abortReason).toBe('upload_batches_load_failed');
    expect(rpcMock).not.toHaveBeenCalled();
    expect(r.clearingRowsWritten).toBe(0);
  });

  it('aborts with no_valid_batch_months when no valid statement_month', async () => {
    setupFixture({ batches: [{ id: 'B1', statement_month: 'garbage', created_at: '2026-01-01' }] });
    const r = await runCrossBatchClearingSweep({ generationId: 1, shouldContinue: () => true });
    expect(r.aborted).toBe(true);
    expect(r.abortReason).toBe('no_valid_batch_months');
    expect(rpcMock).not.toHaveBeenCalled();
    expect(r.clearingRowsWritten).toBe(0);
  });

  it('rejects on RPC failure', async () => {
    setupFixture({ batches: [baseBatch('B1', '2026-02-01')] });
    rpcMock.mockReset();
    rpcMock.mockResolvedValueOnce({ error: new Error('rpc fail') });
    await expect(runCrossBatchClearingSweep({ generationId: 1, shouldContinue: () => true }))
      .rejects.toThrow();
  });
});

// ---------- Group: pre-grain inputErrors ----------
describe('crossBatchClearingSweep — pre-grain inputErrors', () => {
  it('records target_service_month_unresolved', async () => {
    setupFixture({
      batches: [baseBatch('B1', '2026-02-01')],
      reconciled: [makeUnpaidRM('M1', 'B1', { expected_ede_effective_month: 'BAD' })],
    });
    const r = await runCrossBatchClearingSweep({ generationId: 1, shouldContinue: () => true });
    expect(r.aborted).toBe(false);
    expect(r.inputErrors[0].reason).toBe('target_service_month_unresolved');
  });

  it('records no_carrier', async () => {
    setupFixture({
      batches: [baseBatch('B1', '2026-02-01')],
      reconciled: [makeUnpaidRM('M1', 'B1', { carrier: 'WeirdCo' })],
    });
    const r = await runCrossBatchClearingSweep({ generationId: 1, shouldContinue: () => true });
    expect(r.inputErrors.find(e => e.reason === 'no_carrier')).toBeTruthy();
  });

  it('records no_identity_keys', async () => {
    setupFixture({
      batches: [baseBatch('B1', '2026-02-01')],
      reconciled: [makeUnpaidRM('M1', 'B1', { policy_number: null, issuer_subscriber_id: null })],
    });
    const r = await runCrossBatchClearingSweep({ generationId: 1, shouldContinue: () => true });
    expect(r.inputErrors.find(e => e.reason === 'no_identity_keys')).toBeTruthy();
  });

  it('inputErrors do not produce clearing rows', async () => {
    setupFixture({
      batches: [baseBatch('B1', '2026-02-01')],
      reconciled: [makeUnpaidRM('M1', 'B1', { carrier: 'WeirdCo' })],
    });
    await runCrossBatchClearingSweep({ generationId: 1, shouldContinue: () => true });
    const rpcArgs = rpcMock.mock.calls[0][1];
    expect(rpcArgs.p_rows).toEqual([]);
  });
});

// ---------- Group: clearing-row composition ----------
describe('crossBatchClearingSweep — clearing rows', () => {
  it('produces clearing row for one unpaid grain + matching payment', async () => {
    setupFixture({
      batches: [baseBatch('B1', '2026-02-01'), baseBatch('B2', '2026-03-01')],
      reconciled: [makeUnpaidRM('M1', 'B1')],
      boEde: [ambetterBoEde('E1', 'B1', 'p1')],
      commission: [commissionRow('C1', 'B2', 'p1', 100)],
    });
    const r = await runCrossBatchClearingSweep({ generationId: 1, shouldContinue: () => true });
    expect(r.clearingRowsWritten).toBe(1);
    const rows = rpcMock.mock.calls[0][1].p_rows;
    expect(rows[0].clearing_state).toBe('fully_cleared');
    expect(rpcMock).toHaveBeenCalledWith(
      'replace_cross_batch_clearings_for_run',
      expect.objectContaining({ p_scope: 'global_full_rebuild' }),
    );
  });

  it('composed row exposes expected fields', async () => {
    setupFixture({
      batches: [baseBatch('B1', '2026-02-01'), baseBatch('B2', '2026-03-01')],
      reconciled: [makeUnpaidRM('M1', 'B1')],
      boEde: [ambetterBoEde('E1', 'B1', 'p1')],
      commission: [commissionRow('C1', 'B2', 'p1', 100)],
    });
    await runCrossBatchClearingSweep({ generationId: 1, shouldContinue: () => true });
    const row = rpcMock.mock.calls[0][1].p_rows[0];
    expect(row.policy_identity_key).toBe('ambetter|p1');
    expect(row.target_service_month).toBe('2026-02');
    expect(row.unpaid_batch_id).toBe('B1');
    expect(row.unpaid_batch_ids).toEqual(['B1']);
    expect(row.payment_batch_ids).toEqual(['B2']);
    expect(row.expected_amount).toBe(100);
    expect(row.threshold_amount).toBe(70);
    expect(row.actual_positive_amount).toBe(100);
    expect(row.actual_net_amount).toBe(100);
    expect(row.comp_rate_id).toBe('rate-100');
    expect(row.matched_paid_record_ids).toEqual(['C1']);
    expect(row.run_id).toBeTruthy();
    expect(row.logic_version).toBe('bundle-13b-v1');
  });

  it('partial payment below threshold → partially_cleared', async () => {
    setupFixture({
      batches: [baseBatch('B1', '2026-02-01'), baseBatch('B2', '2026-03-01')],
      reconciled: [makeUnpaidRM('M1', 'B1')],
      boEde: [ambetterBoEde('E1', 'B1', 'p1')],
      commission: [commissionRow('C1', 'B2', 'p1', 50)],
    });
    await runCrossBatchClearingSweep({ generationId: 1, shouldContinue: () => true });
    const row = rpcMock.mock.calls[0][1].p_rows[0];
    expect(row.clearing_state).toBe('partially_cleared');
    expect(row.remainder_owed).toBe(50);
  });

  it('zero expected → zero_expected_no_payment_required', async () => {
    getExpectedCommissionMock.mockReturnValue({
      supportStatus: 'supported', expectedAmount: 0, rateRecordId: 'rate-zero', evidence: {},
    });
    setupFixture({
      batches: [baseBatch('B1', '2026-02-01')],
      reconciled: [makeUnpaidRM('M1', 'B1')],
      boEde: [ambetterBoEde('E1', 'B1', 'p1')],
    });
    await runCrossBatchClearingSweep({ generationId: 1, shouldContinue: () => true });
    const row = rpcMock.mock.calls[0][1].p_rows[0];
    expect(row.clearing_state).toBe('zero_expected_no_payment_required');
  });
});

// ---------- Group: Q22 cleared_then_reversed ----------
describe('crossBatchClearingSweep — Q22 cleared_then_reversed', () => {
  it('Feb +$100 + Mar -$100 → cleared_then_reversed', async () => {
    setupFixture({
      batches: [
        baseBatch('B1', '2026-01-01'),
        baseBatch('B2', '2026-02-01'),
        baseBatch('B3', '2026-03-01'),
      ],
      reconciled: [makeUnpaidRM('M1', 'B1')],
      boEde: [{ ...ambetterBoEde('E1', 'B1', 'p1'), effective_date: '2026-01-15' }],
      commission: [
        commissionRow('C1', 'B2', 'p1', 100),
        commissionRow('C2', 'B3', 'p1', -100),
      ],
    });
    await runCrossBatchClearingSweep({ generationId: 1, shouldContinue: () => true });
    const row = rpcMock.mock.calls[0][1].p_rows[0];
    expect(row.clearing_state).toBe('cleared_then_reversed');
    expect(row.first_full_clear_statement_month).toBe('2026-02');
    expect(row.reversed_at_statement_month).toBe('2026-03');
  });

  it('plus April +$100 → still cleared_then_reversed', async () => {
    setupFixture({
      batches: [
        baseBatch('B1', '2026-01-01'),
        baseBatch('B2', '2026-02-01'),
        baseBatch('B3', '2026-03-01'),
        baseBatch('B4', '2026-04-01'),
      ],
      reconciled: [makeUnpaidRM('M1', 'B1')],
      boEde: [{ ...ambetterBoEde('E1', 'B1', 'p1'), effective_date: '2026-01-15' }],
      commission: [
        commissionRow('C1', 'B2', 'p1', 100),
        commissionRow('C2', 'B3', 'p1', -100),
        commissionRow('C3', 'B4', 'p1', 100),
      ],
    });
    await runCrossBatchClearingSweep({ generationId: 1, shouldContinue: () => true });
    const row = rpcMock.mock.calls[0][1].p_rows[0];
    expect(row.clearing_state).toBe('cleared_then_reversed');
    expect(row.matched_paid_record_ids).toEqual(expect.arrayContaining(['C1', 'C3']));
  });
});

// ---------- Group: alias-aware lookup ----------
describe('crossBatchClearingSweep — alias-aware resolver lookup', () => {
  it('Ambetter EDE row with only subscriber_id resolves via alias', async () => {
    setupFixture({
      batches: [baseBatch('B1', '2026-02-01'), baseBatch('B2', '2026-03-01')],
      // Ambetter unpaid populates both pn and sid (aliased path) so both
      // policy_number and issuer_subscriber_id queries fetch BO/EDE rows.
      reconciled: [makeUnpaidRM('M1', 'B1', { policy_number: 'u123', issuer_subscriber_id: 'u123' })],
      boEde: [{
        id: 'E1', batch_id: 'B1', source_type: 'EDE', carrier: ambetter,
        policy_number: null, issuer_subscriber_id: 'u123',
        effective_date: '2026-02-01', client_state_full: 'FL',
        raw_json: { coveredMemberCount: 1 },
      }],
      commission: [commissionRow('C1', 'B2', 'u123', 100)],
    });
    const r = await runCrossBatchClearingSweep({ generationId: 1, shouldContinue: () => true });
    expect(r.clearingRowsWritten).toBe(1);
    const row = rpcMock.mock.calls[0][1].p_rows[0];
    expect(row.clearing_state).toBe('fully_cleared');
  });

  it('Non-Ambetter (BCBS) does not alias subscriber_id → state_unresolved', async () => {
    setupFixture({
      batches: [baseBatch('B1', '2026-02-01')],
      reconciled: [makeUnpaidRM('M1', 'B1', { carrier: 'BCBS', policy_number: 'abc', issuer_subscriber_id: null })],
      boEde: [{
        id: 'E1', batch_id: 'B1', source_type: 'EDE', carrier: 'BCBS',
        policy_number: null, issuer_subscriber_id: 'abc',
        effective_date: '2026-02-01', client_state_full: 'FL',
        raw_json: { coveredMemberCount: 1 },
      }],
    });
    await runCrossBatchClearingSweep({ generationId: 1, shouldContinue: () => true });
    const row = rpcMock.mock.calls[0][1].p_rows[0];
    expect(row.clearing_state).toBe('manual_review_required');
    expect(row.manual_review_reason).toBe('state_unresolved');
  });
});

// ---------- Group: post-grain manual review ----------
describe('crossBatchClearingSweep — post-grain manual review', () => {
  it('not_found from compGrid → carrier_state_not_in_grid', async () => {
    getExpectedCommissionMock.mockReturnValue({ supportStatus: 'not_found', evidence: {} });
    setupFixture({
      batches: [baseBatch('B1', '2026-02-01')],
      reconciled: [makeUnpaidRM('M1', 'B1')],
      boEde: [ambetterBoEde('E1', 'B1', 'p1')],
    });
    await runCrossBatchClearingSweep({ generationId: 1, shouldContinue: () => true });
    const row = rpcMock.mock.calls[0][1].p_rows[0];
    expect(row.clearing_state).toBe('manual_review_required');
    expect(row.manual_review_reason).toBe('carrier_state_not_in_grid');
  });

  it('unsupported_v1 surfaces unsupportedReason', async () => {
    getExpectedCommissionMock.mockReturnValue({
      supportStatus: 'unsupported_v1', unsupportedReason: 'percent_of_premium_not_implemented', evidence: {},
    });
    setupFixture({
      batches: [baseBatch('B1', '2026-02-01')],
      reconciled: [makeUnpaidRM('M1', 'B1')],
      boEde: [ambetterBoEde('E1', 'B1', 'p1')],
    });
    await runCrossBatchClearingSweep({ generationId: 1, shouldContinue: () => true });
    const row = rpcMock.mock.calls[0][1].p_rows[0];
    expect(row.manual_review_reason).toBe('percent_of_premium_not_implemented');
  });

  it('missing state evidence → state_unresolved', async () => {
    setupFixture({
      batches: [baseBatch('B1', '2026-02-01')],
      reconciled: [makeUnpaidRM('M1', 'B1')],
      boEde: [], // no EDE rows → state resolver unresolved
    });
    await runCrossBatchClearingSweep({ generationId: 1, shouldContinue: () => true });
    const row = rpcMock.mock.calls[0][1].p_rows[0];
    expect(row.clearing_state).toBe('manual_review_required');
    expect(row.manual_review_reason).toBe('state_unresolved');
  });
});

// ---------- Group: payment_batch_ids dedupe ----------
describe('crossBatchClearingSweep — payment_batch_ids', () => {
  it('dedupes payment_batch_ids across multiple matching commissions', async () => {
    setupFixture({
      batches: [
        baseBatch('B1', '2026-01-01'),
        baseBatch('B2', '2026-02-01'),
        baseBatch('B3', '2026-03-01'),
      ],
      reconciled: [makeUnpaidRM('M1', 'B1')],
      boEde: [{ ...ambetterBoEde('E1', 'B1', 'p1'), effective_date: '2026-01-15' }],
      commission: [
        commissionRow('C1', 'B2', 'p1', 60),
        commissionRow('C2', 'B3', 'p1', 60),
      ],
    });
    await runCrossBatchClearingSweep({ generationId: 1, shouldContinue: () => true });
    const row = rpcMock.mock.calls[0][1].p_rows[0];
    expect(new Set(row.payment_batch_ids)).toEqual(new Set(['B2', 'B3']));
  });
});

// ---------- Group: performance shape ----------
describe('crossBatchClearingSweep — performance shape', () => {
  it('with 250 unpaid grains, COMMISSION load happens in bulk (≤ chunk count)', async () => {
    const reconciled: RM[] = [];
    const boEde: NR[] = [];
    const commission: NR[] = [];
    for (let i = 0; i < 250; i++) {
      const pn = `p${i}`;
      reconciled.push(makeUnpaidRM(`M${i}`, 'B1', { policy_number: pn }));
      boEde.push(ambetterBoEde(`E${i}`, 'B1', pn));
      commission.push(commissionRow(`C${i}`, 'B2', pn, 100));
    }
    const counters = setupFixture({
      batches: [baseBatch('B1', '2026-02-01'), baseBatch('B2', '2026-03-01')],
      reconciled, boEde, commission,
    });
    const r = await runCrossBatchClearingSweep({ generationId: 1, shouldContinue: () => true });
    expect(r.clearingRowsWritten).toBe(250);
    // Bulk loads: 1 by policy_number + 1 by issuer_subscriber_id = 2 calls (per chunk).
    // 250 grains < IN_CHUNK (500), so a single chunk each → ≤ 2 commission .from() calls.
    expect(counters.commissionFromCalls).toBeLessThanOrEqual(2);
  });

  it('250 grains: total DB calls bounded by O(batches + chunks), not O(grains)', async () => {
    const reconciled: RM[] = [];
    for (let i = 0; i < 250; i++) {
      reconciled.push(makeUnpaidRM(`M${i}`, 'B1', { policy_number: `p${i}` }));
    }
    setupFixture({ batches: [baseBatch('B1', '2026-02-01')], reconciled });
    fromMock.mockClear();
    await runCrossBatchClearingSweep({ generationId: 1, shouldContinue: () => true });
    // Calls: upload_batches (1) + reconciled_members (1) + BO/EDE (≤2 lookups) + COMMISSION (≤2)
    expect(fromMock.mock.calls.length).toBeLessThan(20);
  });
});

// ---------- Group: empty-grain edge cases ----------
describe('crossBatchClearingSweep — additional edge cases', () => {
  it('no unpaid rows → success with zero clearing rows', async () => {
    setupFixture({ batches: [baseBatch('B1', '2026-02-01')], reconciled: [] });
    const r = await runCrossBatchClearingSweep({ generationId: 1, shouldContinue: () => true });
    expect(r.aborted).toBe(false);
    expect(r.clearingRowsWritten).toBe(0);
    expect(rpcMock).toHaveBeenCalled();
  });

  it('in_commission rows are skipped', async () => {
    setupFixture({
      batches: [baseBatch('B1', '2026-02-01')],
      reconciled: [{ ...makeUnpaidRM('M1', 'B1'), in_commission: true }],
    });
    const r = await runCrossBatchClearingSweep({ generationId: 1, shouldContinue: () => true });
    expect(r.clearingRowsWritten).toBe(0);
  });

  it('id-matched but no service month overlap → not_cleared', async () => {
    setupFixture({
      batches: [baseBatch('B1', '2026-02-01'), baseBatch('B2', '2026-03-01')],
      reconciled: [makeUnpaidRM('M1', 'B1')],
      boEde: [ambetterBoEde('E1', 'B1', 'p1')],
      commission: [{
        ...commissionRow('C1', 'B2', 'p1', 100),
        paid_to_date: '2025-12-31', months_paid: 1, // covers Dec 2025, not Feb 2026
      }],
    });
    await runCrossBatchClearingSweep({ generationId: 1, shouldContinue: () => true });
    const row = rpcMock.mock.calls[0][1].p_rows[0];
    expect(row.clearing_state).toBe('not_cleared');
  });
});

// ---------- Group: post-grain branch coverage (v12) ----------
describe('crossBatchClearingSweep — v12 branch coverage', () => {
  it('Test A — conflicting EDE state values within window → state_manual_review', async () => {
    setupFixture({
      batches: [baseBatch('B1', '2026-02-01')],
      reconciled: [makeUnpaidRM('M1', 'B1')],
      boEde: [
        {
          id: 'E1', batch_id: 'B1', source_type: 'EDE', carrier: ambetter,
          policy_number: 'p1', issuer_subscriber_id: 'p1',
          effective_date: '2026-02-01', client_state_full: 'FL',
          raw_json: { coveredMemberCount: 1 },
        },
        {
          id: 'E2', batch_id: 'B1', source_type: 'EDE', carrier: ambetter,
          policy_number: 'p1', issuer_subscriber_id: 'p1',
          effective_date: '2026-02-01', client_state_full: 'TX',
          raw_json: { coveredMemberCount: 1 },
        },
      ],
    });
    await runCrossBatchClearingSweep({ generationId: 1, shouldContinue: () => true });
    const rows = rpcMock.mock.calls[0][1].p_rows;
    expect(rows.length).toBe(1);
    expect(rows[0].clearing_state).toBe('manual_review_required');
    expect(rows[0].manual_review_reason).toBe('state_manual_review');
    expect(rows[0].state_resolution_evidence.state.status).toBe('manual_review');
    expect(getExpectedCommissionMock).not.toHaveBeenCalled();
  });

  it('Test B — state resolves but no member count → member_count_unresolved', async () => {
    setupFixture({
      batches: [baseBatch('B1', '2026-02-01')],
      reconciled: [makeUnpaidRM('M1', 'B1')],
      boEde: [{
        id: 'E1', batch_id: 'B1', source_type: 'EDE', carrier: ambetter,
        policy_number: 'p1', issuer_subscriber_id: 'p1',
        effective_date: '2026-02-01', client_state_full: 'FL',
        raw_json: {},
      }],
    });
    await runCrossBatchClearingSweep({ generationId: 1, shouldContinue: () => true });
    const row = rpcMock.mock.calls[0][1].p_rows[0];
    expect(row.clearing_state).toBe('manual_review_required');
    expect(row.manual_review_reason).toBe('member_count_unresolved');
    expect(row.state_resolution_evidence.memberCount.status).toBe('unresolved');
    expect(getExpectedCommissionMock).not.toHaveBeenCalled();
  });

  it('Test C — reconciled row in batch with unresolvable statement_month → batch_statement_month_unresolved', async () => {
    // Custom mock: include a stray reconciled row whose batch_id maps to an
    // upload_batch with an unparseable statement_month, so it never enters
    // batchMonthById and trips the per-row sm guard.
    const validBatch: Batch = baseBatch('B_VALID', '2026-02-01');
    const invalidBatch: Batch = { id: 'B_INVALID', statement_month: 'not-a-date', created_at: '2026-02-01' };
    fromMock.mockImplementation((table: string) => {
      if (table === 'upload_batches') {
        return { select: () => Promise.resolve({ data: [validBatch, invalidBatch], error: null }) };
      }
      if (table === 'reconciled_members') {
        const chain: any = {
          _batch: null,
          select() { return chain; },
          eq(_c: string, v: string) { chain._batch = v; return chain; },
          range(from: number) {
            if (from > 0) return Promise.resolve({ data: [], error: null });
            // Only B_VALID is queried (sweep iterates valid months only).
            // Return one row matching plus one stray row with batch_id=B_INVALID.
            const rows: RM[] = [
              makeUnpaidRM('M_VALID', 'B_VALID'),
              makeUnpaidRM('M_STRAY', 'B_INVALID', { policy_number: 'pStray' }),
            ];
            return Promise.resolve({ data: rows, error: null });
          },
        };
        return chain;
      }
      if (table === 'normalized_records') {
        const chain: any = {
          select() { return chain; }, eq() { return chain; }, is() { return chain; },
          in() { return chain; }, order() { return chain; }, limit() { return chain; },
          gt() { return chain; },
          then(resolve: any) { resolve({ data: [], error: null }); },
        };
        return chain;
      }
      return { select: () => Promise.resolve({ data: [], error: null }) };
    });
    const r = await runCrossBatchClearingSweep({ generationId: 1, shouldContinue: () => true });
    const stray = r.inputErrors.find(e => e.reconciled_member_id === 'M_STRAY');
    expect(stray).toBeTruthy();
    expect(stray!.reason).toBe('batch_statement_month_unresolved');
    expect(stray!.batch_id).toBe('B_INVALID');
    const pRows = rpcMock.mock.calls[0][1].p_rows;
    // No clearing row for the stray member.
    expect(pRows.find((row: any) => row.unpaid_batch_id === 'B_INVALID')).toBeFalsy();
  });

  it('Test D — two unpaid rows collapse to same identity key with conflicting subscriber IDs → ambiguous_policy_identity_key_before_grain', async () => {
    setupFixture({
      batches: [baseBatch('B1', '2026-02-01')],
      reconciled: [
        makeUnpaidRM('M1', 'B1', { policy_number: 'p1', issuer_subscriber_id: 'sid-a' }),
        makeUnpaidRM('M2', 'B1', { policy_number: 'p1', issuer_subscriber_id: 'sid-b' }),
      ],
    });
    const r = await runCrossBatchClearingSweep({ generationId: 1, shouldContinue: () => true });
    const ambig = r.inputErrors.filter(e => e.reason === 'ambiguous_policy_identity_key_before_grain');
    expect(ambig.map(e => e.reconciled_member_id).sort()).toEqual(['M1', 'M2']);
    const pRows = rpcMock.mock.calls[0][1].p_rows;
    const collision = pRows.find((row: any) =>
      row.policy_identity_key === 'ambetter|p1' && row.target_service_month === '2026-02'
    );
    expect(collision).toBeFalsy();
  });
});
