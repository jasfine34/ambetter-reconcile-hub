import { describe, it, expect } from 'vitest';
import { dedupCommissionRows, type DedupInputRow } from '@/lib/canonical/dedupCommissionRows';
import type { NormalizedRecord } from '@/lib/normalize';

function commRow(partial: Partial<DedupInputRow> & {
  id: string;
  batch_id: string;
  transaction_id: string;
  amount: number;
  ptd: string;
  months_paid?: number;
  created_at?: string;
}): DedupInputRow {
  const base: NormalizedRecord = {
    source_type: 'COMMISSION',
    source_file_label: '',
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
    issuer_subscriber_id: 'u96332808',
    agent_name: '',
    agent_npn: '',
    aor_bucket: '',
    pay_entity: 'Jason',
    status: '',
    effective_date: null,
    premium: null,
    net_premium: null,
    commission_amount: partial.amount,
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
    paid_to_date: partial.ptd,
    months_paid: partial.months_paid ?? 1,
    writing_agent_carrier_id: '',
    member_key: 'issub:u96332808',
    raw_json: { 'Transaction ID': partial.transaction_id },
  };
  return {
    ...base,
    id: partial.id,
    batch_id: partial.batch_id,
    created_at: partial.created_at ?? '2026-01-01T00:00:00Z',
    ...partial,
  } as DedupInputRow;
}

const monthMap = {
  'b-jan': '2026-01',
  'b-apr': '2026-04',
  'b-may': '2026-05',
};

describe('dedupCommissionRows', () => {
  it('Dannielle fixture: May duplicate of April reversal is dropped, April survives', () => {
    const jan = commRow({ id: 'r1', batch_id: 'b-jan', transaction_id: '8245546', amount: 48, ptd: '2026-01-31' });
    const apr = commRow({ id: 'r2', batch_id: 'b-apr', transaction_id: '8705401', amount: -48, ptd: '2026-01-31' });
    const may = commRow({ id: 'r3', batch_id: 'b-may', transaction_id: '8705401', amount: -48, ptd: '2026-01-31' });

    // Guard: without dedup the net would be -48 (the bug).
    const rawNet = [jan, apr, may].reduce((s, r) => s + (r.commission_amount ?? 0), 0);
    expect(rawNet).toBe(-48);

    const result = dedupCommissionRows([jan, apr, may], { batchMonthByBatchId: monthMap });
    expect(result.rows.map(r => r.id).sort()).toEqual(['r1', 'r2']);
    const dedupedNet = result.rows.reduce((s, r) => s + (r.commission_amount ?? 0), 0);
    expect(dedupedNet).toBe(0);
    expect(result.droppedCount).toBe(1);
    expect(result.dropped[0].dropped_id).toBe('r3');
    expect(result.dropped[0].survivor_id).toBe('r2');
  });

  it('legitimate pay→reverse→re-pay (new TXN) is NOT deduped', () => {
    const jan = commRow({ id: 'r1', batch_id: 'b-jan', transaction_id: 'A', amount: 48, ptd: '2026-01-31' });
    const apr = commRow({ id: 'r2', batch_id: 'b-apr', transaction_id: 'B', amount: -48, ptd: '2026-01-31' });
    const may = commRow({ id: 'r3', batch_id: 'b-may', transaction_id: 'C', amount: 48, ptd: '2026-01-31' });
    const result = dedupCommissionRows([jan, apr, may], { batchMonthByBatchId: monthMap });
    expect(result.rows).toHaveLength(3);
    expect(result.droppedCount).toBe(0);
    const net = result.rows.reduce((s, r) => s + (r.commission_amount ?? 0), 0);
    expect(net).toBe(48);
  });

  it('survivor: earlier batch month wins (Apr beats May)', () => {
    const apr = commRow({ id: 'apr', batch_id: 'b-apr', transaction_id: 'T1', amount: 10, ptd: '2026-01-31' });
    const may = commRow({ id: 'may', batch_id: 'b-may', transaction_id: 'T1', amount: 10, ptd: '2026-01-31' });
    const result = dedupCommissionRows([may, apr], { batchMonthByBatchId: monthMap });
    expect(result.rows.map(r => r.id)).toEqual(['apr']);
  });

  it('survivor: same month → earlier created_at wins', () => {
    const a = commRow({ id: 'a', batch_id: 'b-apr', transaction_id: 'T2', amount: 5, ptd: '2026-01-31', created_at: '2026-04-10T00:00:00Z' });
    const b = commRow({ id: 'b', batch_id: 'b-apr', transaction_id: 'T2', amount: 5, ptd: '2026-01-31', created_at: '2026-04-02T00:00:00Z' });
    const result = dedupCommissionRows([a, b], { batchMonthByBatchId: monthMap });
    expect(result.rows.map(r => r.id)).toEqual(['b']);
  });

  it('survivor: full tie → stable row id wins', () => {
    const a = commRow({ id: 'zzz', batch_id: 'b-apr', transaction_id: 'T3', amount: 5, ptd: '2026-01-31', created_at: '2026-04-02T00:00:00Z' });
    const b = commRow({ id: 'aaa', batch_id: 'b-apr', transaction_id: 'T3', amount: 5, ptd: '2026-01-31', created_at: '2026-04-02T00:00:00Z' });
    const result = dedupCommissionRows([a, b], { batchMonthByBatchId: monthMap });
    expect(result.rows.map(r => r.id)).toEqual(['aaa']);
  });

  it('unresolvable batch month → group passes through untouched, diagnostic surfaced', () => {
    const x = commRow({ id: 'x', batch_id: 'b-unknown', transaction_id: 'T4', amount: 5, ptd: '2026-01-31' });
    const y = commRow({ id: 'y', batch_id: 'b-apr', transaction_id: 'T4', amount: 5, ptd: '2026-01-31' });
    const result = dedupCommissionRows([x, y], { batchMonthByBatchId: monthMap });
    expect(result.rows).toHaveLength(2);
    expect(result.droppedCount).toBe(0);
    expect(result.unresolvedBatchMonthIds).toContain('b-unknown');
  });

  it('same TXN id + different amount → NOT deduped', () => {
    const a = commRow({ id: 'a', batch_id: 'b-apr', transaction_id: 'T5', amount: 10, ptd: '2026-01-31' });
    const b = commRow({ id: 'b', batch_id: 'b-may', transaction_id: 'T5', amount: 12, ptd: '2026-01-31' });
    const result = dedupCommissionRows([a, b], { batchMonthByBatchId: monthMap });
    expect(result.rows).toHaveLength(2);
  });

  it('same TXN id + different paid_to_date → NOT deduped', () => {
    const a = commRow({ id: 'a', batch_id: 'b-apr', transaction_id: 'T6', amount: 10, ptd: '2026-01-31' });
    const b = commRow({ id: 'b', batch_id: 'b-may', transaction_id: 'T6', amount: 10, ptd: '2026-02-28' });
    const result = dedupCommissionRows([a, b], { batchMonthByBatchId: monthMap });
    expect(result.rows).toHaveLength(2);
  });

  it('exact intra-batch duplicates → deduped', () => {
    const a = commRow({ id: 'a', batch_id: 'b-apr', transaction_id: 'T7', amount: 10, ptd: '2026-01-31', created_at: '2026-04-01T00:00:00Z' });
    const b = commRow({ id: 'b', batch_id: 'b-apr', transaction_id: 'T7', amount: 10, ptd: '2026-01-31', created_at: '2026-04-02T00:00:00Z' });
    const result = dedupCommissionRows([a, b], { batchMonthByBatchId: monthMap });
    expect(result.rows.map(r => r.id)).toEqual(['a']);
  });

  it('rows without Transaction ID are never deduped', () => {
    const a = commRow({ id: 'a', batch_id: 'b-apr', transaction_id: '', amount: 10, ptd: '2026-01-31' });
    const b = commRow({ id: 'b', batch_id: 'b-may', transaction_id: '', amount: 10, ptd: '2026-01-31' });
    const result = dedupCommissionRows([a, b], { batchMonthByBatchId: monthMap });
    expect(result.rows).toHaveLength(2);
    expect(result.droppedCount).toBe(0);
  });

  it('non-commission rows pass through untouched', () => {
    const ede: DedupInputRow = {
      ...commRow({ id: 'e1', batch_id: 'b-apr', transaction_id: 'T8', amount: 0, ptd: '' }),
      source_type: 'EDE',
    };
    const c1 = commRow({ id: 'c1', batch_id: 'b-apr', transaction_id: 'T9', amount: 10, ptd: '2026-01-31' });
    const c2 = commRow({ id: 'c2', batch_id: 'b-may', transaction_id: 'T9', amount: 10, ptd: '2026-01-31' });
    const result = dedupCommissionRows([ede, c1, c2], { batchMonthByBatchId: monthMap });
    expect(result.rows.map(r => r.id)).toEqual(['e1', 'c1']);
  });

  it('purity: raw rows are not mutated (byte-identity spot check)', () => {
    const jan = commRow({ id: 'r1', batch_id: 'b-jan', transaction_id: '8245546', amount: 48, ptd: '2026-01-31' });
    const apr = commRow({ id: 'r2', batch_id: 'b-apr', transaction_id: '8705401', amount: -48, ptd: '2026-01-31' });
    const may = commRow({ id: 'r3', batch_id: 'b-may', transaction_id: '8705401', amount: -48, ptd: '2026-01-31' });
    const input = [jan, apr, may];
    const before = JSON.stringify(input);
    const result = dedupCommissionRows(input, { batchMonthByBatchId: monthMap });
    expect(JSON.stringify(input)).toBe(before);
    // Survivor is the same referential object.
    expect(result.rows.find(r => r.id === 'r2')).toBe(apr);
  });
});
