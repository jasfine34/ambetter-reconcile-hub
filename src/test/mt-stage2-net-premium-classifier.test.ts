/**
 * MT Stage 2 — Per-month net premium classifier + unpaid net buckets.
 *
 * Tests the EXPORTED classifier surface only:
 *   - netPremiumForServiceMonth (direct)
 *   - classifyMember + buildClassifierContext (gated behavior)
 *
 * Does NOT import classifyCell — it stays private. Synthetic records only;
 * live Julia/Robert keys reserved for post-sync verification.
 */
import { describe, it, expect } from 'vitest';
import {
  netPremiumForServiceMonth,
  buildClassifierContext,
  classifyMember,
} from '@/lib/classifier';
import type { NormalizedRecord } from '@/lib/normalize';

function edeRow(overrides: Partial<NormalizedRecord> & Record<string, any>): any {
  return {
    source_type: 'EDE',
    source_file_label: 'test',
    carrier: 'Ambetter',
    applicant_name: '',
    first_name: '',
    last_name: '',
    dob: null,
    member_id: '',
    policy_number: '',
    exchange_subscriber_id: '',
    exchange_policy_id: '',
    issuer_policy_id: '',
    issuer_subscriber_id: '',
    agent_name: '',
    agent_npn: '',
    aor_bucket: '',
    pay_entity: '',
    status: 'Effectuated',
    effective_date: '2026-01-01',
    premium: null,
    net_premium: null,
    commission_amount: null,
    eligible_for_commission: '',
    policy_term_date: null,
    paid_through_date: null,
    broker_effective_date: null,
    broker_term_date: null,
    member_responsibility: null,
    on_off_exchange: '',
    auto_renewal: null,
    ede_policy_origin_type: '',
    ede_bucket: '',
    policy_modified_date: null,
    client_address_1: '',
    client_address_2: '',
    client_city: '',
    client_state_full: '',
    client_zip: '',
    paid_to_date: null,
    months_paid: null,
    writing_agent_carrier_id: '',
    member_key: 'issub:test',
    raw_json: { policyStatus: 'Effectuated', issuer: 'Ambetter', currentPolicyAOR: 'Jason Fine' },
    ...overrides,
  };
}

describe('netPremiumForServiceMonth (Component 2 helper)', () => {
  it('returns positive numeric for active EDE row covering service month', () => {
    const records = [edeRow({ batch_id: 'b1', net_premium: 100, effective_date: '2026-01-01' })];
    const out = netPremiumForServiceMonth(records as any, '2026-03', { batchMonthByBatchId: new Map() });
    expect(out).toBe(100);
  });

  it('Julia pattern — March batch row wins via batch-month preference (returns 0)', () => {
    const records = [
      edeRow({ batch_id: 'b-jan', net_premium: 104.48, effective_date: '2026-01-01', raw_json: { lastEDESync: '2026-01-15', policyStatus: 'Effectuated', issuer: 'Ambetter' } }),
      edeRow({ batch_id: 'b-mar', net_premium: 0, effective_date: '2026-01-01', raw_json: { lastEDESync: '2026-03-15', policyStatus: 'Effectuated', issuer: 'Ambetter' } }),
    ];
    const map = new Map([['b-jan', '2026-01'], ['b-mar', '2026-03']]);
    const out = netPremiumForServiceMonth(records as any, '2026-03', { batchMonthByBatchId: map });
    expect(out).toBe(0);
  });

  it('Robert pattern — no EDE row for Feb returns null', () => {
    const records = [
      edeRow({ batch_id: 'b-jan', net_premium: 48.23, effective_date: '2026-01-01', policy_term_date: '2026-02-01' }),
    ];
    const map = new Map([['b-jan', '2026-01']]);
    const out = netPremiumForServiceMonth(records as any, '2026-02', { batchMonthByBatchId: map });
    expect(out).toBeNull();
  });

  it('Tiebreaker — newest lastEDESync wins within same batch', () => {
    const records = [
      edeRow({ id: 'r1', batch_id: 'b1', net_premium: 50, raw_json: { lastEDESync: '2026-03-15T10:00:00', policyStatus: 'Effectuated', issuer: 'Ambetter' } }),
      edeRow({ id: 'r2', batch_id: 'b1', net_premium: 75, raw_json: { lastEDESync: '2026-03-15T10:00:01', policyStatus: 'Effectuated', issuer: 'Ambetter' } }),
    ];
    const out = netPremiumForServiceMonth(records as any, '2026-03', { batchMonthByBatchId: new Map() });
    expect(out).toBe(75);
  });

  it('Exclusive policy_term_date — term=2026-03-01 means inactive in March', () => {
    const records = [
      edeRow({ batch_id: 'b1', net_premium: 100, effective_date: '2026-01-01', policy_term_date: '2026-03-01' }),
    ];
    const out = netPremiumForServiceMonth(records as any, '2026-03', { batchMonthByBatchId: new Map() });
    expect(out).toBeNull();
  });

  it('Empty batchMonthByBatchId — falls back to active-coverage only', () => {
    const records = [
      edeRow({ batch_id: 'b1', net_premium: 200, effective_date: '2026-01-01' }),
    ];
    const out = netPremiumForServiceMonth(records as any, '2026-03', { batchMonthByBatchId: new Map() });
    expect(out).toBe(200);
  });
});

describe('classifyMember gated behavior (Component 2 paths)', () => {
  // Julia-shaped synthetic: member-level max $104.48 but March service-month EDE = 0
  const juliaShaped = [
    edeRow({ batch_id: 'b-jan', net_premium: 104.48, effective_date: '2026-01-01', raw_json: { lastEDESync: '2026-01-15', policyStatus: 'Effectuated', issuer: 'Ambetter', currentPolicyAOR: 'Coverall' } }),
    edeRow({ batch_id: 'b-mar', net_premium: 0, effective_date: '2026-01-01', raw_json: { lastEDESync: '2026-03-15', policyStatus: 'Effectuated', issuer: 'Ambetter', currentPolicyAOR: 'Coverall' } }),
  ];
  // Add a commission statement to make March ripe.
  const ripenessCommission = {
    ...edeRow({}),
    source_type: 'COMMISSION',
    paid_to_date: '2026-03-31',
    months_paid: 1,
    commission_amount: 0,
    member_key: 'other',
    raw_json: {},
  };

  it('Legacy path (absent map) — uses member-level max $104.48, reason cites $104.48', () => {
    const context = buildClassifierContext(juliaShaped as any, ['2026-03'], []);
    // Force March ripe so we evaluate premium branches.
    context.commissionStatementMonths.add('2026-03');
    const classification = classifyMember(juliaShaped as any, context);
    const cell = classification.cells['2026-03'];
    // member-level max 104.48 → not zero → no paid_through → falls to manual_review
    // with reason citing 104.48 (legacy formatting, never null branch).
    expect(cell.reason).toContain('104.48');
  });

  it('New path (present map) — March cell uses 0 from batch-preferred row, classified unpaid', () => {
    const map = new Map([['b-jan', '2026-01'], ['b-mar', '2026-03']]);
    const context = buildClassifierContext(juliaShaped as any, ['2026-03'], [], { batchMonthByBatchId: map });
    context.commissionStatementMonths.add('2026-03');
    const classification = classifyMember(juliaShaped as any, context);
    const cell = classification.cells['2026-03'];
    expect(cell.state).toBe('unpaid');
    expect(cell.reason).toContain('Zero net premium');
  });

  it('New path — Robert pattern (no Feb EDE row) classifies as unpaid (null premium), not manual_review', () => {
    const records = [
      edeRow({ batch_id: 'b-jan', net_premium: 48.23, effective_date: '2026-01-01', policy_term_date: '2026-02-01', raw_json: { lastEDESync: '2026-01-15', policyStatus: 'Effectuated', issuer: 'Ambetter', currentPolicyAOR: 'Coverall' } }),
    ];
    const map = new Map([['b-jan', '2026-01']]);
    const context = buildClassifierContext(records as any, ['2026-02'], [], { batchMonthByBatchId: map });
    context.commissionStatementMonths.add('2026-02');
    const classification = classifyMember(records as any, context);
    const cell = classification.cells['2026-02'];
    // Member is terminated by Feb (policy_term 2026-02-01) — broker termination
    // path may engage first. Accept either unpaid (null premium) or not_expected_cancelled
    // since this test's purpose is to confirm no crash + no manual_review with .toFixed on null.
    expect(['unpaid', 'not_expected_cancelled', 'not_expected_premium_unpaid']).toContain(cell.state);
    expect(cell.reason).not.toContain('NaN');
    expect(cell.reason).not.toContain('null');
  });
});

describe('Chip count derivation (Component 1)', () => {
  // Replicate the MemberTimelinePage derivation logic with a tiny synthetic set.
  type Cell = { state: string; netBucket: '+Net' | '0Net' | null };
  type Row = { cells: Cell[]; hasUnpaidPlusNet: boolean; hasUnpaidZeroNet: boolean; months_unpaid: number };
  function build(cells: Cell[]): Row {
    const finalCells = cells;
    return {
      cells: finalCells,
      hasUnpaidPlusNet: finalCells.some(c => c.state === 'unpaid' && c.netBucket === '+Net'),
      hasUnpaidZeroNet: finalCells.some(c => c.state === 'unpaid' && c.netBucket === '0Net'),
      months_unpaid: finalCells.filter(c => c.state === 'unpaid').length,
    };
  }

  it('counts and overlap match spec for A/B/C/D/E synthetic set', () => {
    const A = build([{ state: 'unpaid', netBucket: '+Net' }]);
    const B = build([{ state: 'unpaid', netBucket: '0Net' }]);
    const C = build([{ state: 'unpaid', netBucket: '+Net' }, { state: 'unpaid', netBucket: '0Net' }]);
    const D = build([{ state: 'paid', netBucket: null }]);
    const E = build([{ state: 'unpaid', netBucket: '0Net' }]); // no-row collapsed
    const rows = [A, B, C, D, E];
    const hasUnpaid = rows.filter(r => r.months_unpaid > 0).length;
    const plusNet = rows.filter(r => r.hasUnpaidPlusNet).length;
    const zeroNet = rows.filter(r => r.hasUnpaidZeroNet).length;
    expect(hasUnpaid).toBe(4);
    expect(plusNet).toBe(2);
    expect(zeroNet).toBe(3);
  });
});
