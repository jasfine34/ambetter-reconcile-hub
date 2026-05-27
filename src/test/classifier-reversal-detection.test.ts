/**
 * R-PAY-012 — hasReversalPairForMonth helper unit tests.
 *
 * Validates Dannielle-exact-shape paid-then-reversed detection on the
 * COMMISSION row pair grain.
 */
import { describe, it, expect } from 'vitest';
import { hasReversalPairForMonth } from '@/lib/classifier';
import type { NormalizedRecord } from '@/lib/normalize';

function comm(overrides: Partial<NormalizedRecord> & { txn?: string; batch?: string } = {}): NormalizedRecord {
  const { txn, batch, ...rest } = overrides;
  return {
    id: Math.random().toString(36).slice(2),
    source_type: 'COMMISSION',
    staging_status: 'active',
    commission_amount: 0,
    paid_to_date: '2026-01-31',
    months_paid: 1,
    batch_id: batch ?? 'batch-feb',
    raw_json: txn ? { 'Transaction ID': txn } : {},
  } as any;
}

const SM = '2026-01';
const batchMonths = new Map<string, string>([
  ['batch-feb', '2026-02'],
  ['batch-may', '2026-05'],
]);

describe('hasReversalPairForMonth', () => {
  it('matches Dannielle canary positive pair with full evidence', () => {
    const records = [
      comm({ commission_amount: 48, txn: '8245546', batch: 'batch-feb' }),
      comm({ commission_amount: -48, txn: '8705401', batch: 'batch-may' }),
    ];
    const result = hasReversalPairForMonth(records, SM, batchMonths);
    expect(result.matched).toBe(true);
    expect(result.evidence).toEqual({
      positiveTransactionId: '8245546',
      negativeTransactionId: '8705401',
      positiveStatementMonth: '2026-02',
      negativeStatementMonth: '2026-05',
      amount: 48,
      paidToDate: '2026-01-31',
    });
  });

  it('mismatched paid_to_date → no match', () => {
    const records = [
      comm({ commission_amount: 48, paid_to_date: '2026-01-31' }),
      comm({ commission_amount: -48, paid_to_date: '2026-02-28' }),
    ];
    expect(hasReversalPairForMonth(records, SM, batchMonths).matched).toBe(false);
  });

  it('mismatched amount → no match', () => {
    const records = [
      comm({ commission_amount: 48 }),
      comm({ commission_amount: -24 }),
    ];
    expect(hasReversalPairForMonth(records, SM, batchMonths).matched).toBe(false);
  });

  it('mismatched months_paid → no match', () => {
    const records = [
      comm({ commission_amount: 48, months_paid: 1 }),
      comm({ commission_amount: -48, months_paid: 2 }),
    ];
    expect(hasReversalPairForMonth(records, SM, batchMonths).matched).toBe(false);
  });

  it('excludes staged rows', () => {
    const staged = comm({ commission_amount: -48 });
    (staged as any).staging_status = 'staged';
    const records = [comm({ commission_amount: 48 }), staged];
    expect(hasReversalPairForMonth(records, SM, batchMonths).matched).toBe(false);
  });


  it('multi-positive / multi-negative → any valid pair triggers', () => {
    const records = [
      comm({ commission_amount: 48 }),
      comm({ commission_amount: 50 }),
      comm({ commission_amount: -48 }),
      comm({ commission_amount: -50 }),
    ];
    expect(hasReversalPairForMonth(records, SM, batchMonths).matched).toBe(true);
  });

  it('no commission rows → no match', () => {
    const records = [{ ...comm({ commission_amount: 48 }), source_type: 'EDE' } as any];
    expect(hasReversalPairForMonth(records, SM, batchMonths).matched).toBe(false);
  });

  it('single positive no negative → no match', () => {
    expect(hasReversalPairForMonth([comm({ commission_amount: 48 })], SM, batchMonths).matched).toBe(false);
  });

  it('exact-zero within tolerance', () => {
    const records = [
      comm({ commission_amount: 48.005 }),
      comm({ commission_amount: -48.005 }),
    ];
    expect(hasReversalPairForMonth(records, SM, batchMonths).matched).toBe(true);
  });

  it('missing paid_to_date → no match', () => {
    const records = [
      comm({ commission_amount: 48, paid_to_date: null as any }),
      comm({ commission_amount: -48 }),
    ];
    expect(hasReversalPairForMonth(records, SM, batchMonths).matched).toBe(false);
  });

  it('without batchMonthByBatchId → statement-month fields null', () => {
    const records = [
      comm({ commission_amount: 48, txn: 'A' }),
      comm({ commission_amount: -48, txn: 'B' }),
    ];
    const result = hasReversalPairForMonth(records, SM);
    expect(result.matched).toBe(true);
    expect(result.evidence?.positiveStatementMonth).toBeNull();
    expect(result.evidence?.negativeStatementMonth).toBeNull();
  });

  it('missing Transaction ID → evidence carries null TXN fields', () => {
    const records = [
      comm({ commission_amount: 48 }),
      comm({ commission_amount: -48 }),
    ];
    const result = hasReversalPairForMonth(records, SM, batchMonths);
    expect(result.matched).toBe(true);
    expect(result.evidence?.positiveTransactionId).toBeNull();
    expect(result.evidence?.negativeTransactionId).toBeNull();
  });
});
