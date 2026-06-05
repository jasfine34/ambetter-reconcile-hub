/**
 * Dannielle Coe fixture — January classifies REVERSED (R-PAY-012) after
 * canonical dedup drops the May re-listing of the April reversal.
 *
 * Raw rows (3): Jan +$48 (TXN 8245546), Apr -$48 (TXN 8705401),
 *               May -$48 (TXN 8705401 — exact duplicate of April).
 * Without dedup: January nets -$48 and misclassifies unpaid.
 * With dedup: May is dropped, the (Jan-positive, April-negative) pair fires
 * R-PAY-012 with evidence month = April (the negative side).
 */
import { describe, it, expect } from 'vitest';
import { dedupCommissionRows, type DedupInputRow } from '@/lib/canonical/dedupCommissionRows';
import { hasReversalPairForMonth } from '@/lib/classifier';
import type { NormalizedRecord } from '@/lib/normalize';

function comm(over: {
  id: string; batch_id: string; txn: string; amount: number; created_at?: string;
}): DedupInputRow & { staging_status: string } {
  const base: NormalizedRecord = {
    source_type: 'COMMISSION', source_file_label: '', carrier: 'Ambetter',
    applicant_name: '', first_name: '', last_name: '', dob: null,
    member_id: '', policy_number: '', exchange_subscriber_id: '',
    exchange_policy_id: '', issuer_policy_id: '',
    issuer_subscriber_id: 'u96332808', agent_name: '', agent_npn: '',
    aor_bucket: '', pay_entity: 'Jason', status: '', effective_date: null,
    premium: null, net_premium: null, commission_amount: over.amount,
    eligible_for_commission: '', policy_term_date: null,
    paid_through_date: null, broker_effective_date: null,
    broker_term_date: null, member_responsibility: null,
    on_off_exchange: '', auto_renewal: null, ede_policy_origin_type: '',
    ede_bucket: '', policy_modified_date: null, client_address_1: '',
    client_address_2: '', client_city: '', client_state_full: '',
    client_zip: '', paid_to_date: '2026-01-31', months_paid: 1,
    writing_agent_carrier_id: '', member_key: 'issub:u96332808',
    raw_json: { 'Transaction ID': over.txn, 'Months Paid': 1 },
  };
  return {
    ...base, id: over.id, batch_id: over.batch_id,
    created_at: over.created_at ?? '2026-01-01T00:00:00Z',
    staging_status: 'active',
  } as any;
}

describe('Dannielle Coe — January classifies REVERSED after dedup', () => {
  const monthMap = { 'b-jan': '2026-01', 'b-apr': '2026-04', 'b-may': '2026-05' };
  const jan = comm({ id: 'r1', batch_id: 'b-jan', txn: '8245546', amount: 48, created_at: '2026-01-10T00:00:00Z' });
  const apr = comm({ id: 'r2', batch_id: 'b-apr', txn: '8705401', amount: -48, created_at: '2026-04-10T00:00:00Z' });
  const may = comm({ id: 'r3', batch_id: 'b-may', txn: '8705401', amount: -48, created_at: '2026-05-10T00:00:00Z' });

  it('without dedup, raw net for January is -$48 (the bug)', () => {
    const net = [jan, apr, may].reduce((s, r) => s + (r.commission_amount ?? 0), 0);
    expect(net).toBe(-48);
  });

  it('after dedup, January fires R-PAY-012 with evidence months Jan + April', () => {
    const deduped = dedupCommissionRows([jan, apr, may], { batchMonthByBatchId: monthMap }).rows;
    expect(deduped.map(r => r.id).sort()).toEqual(['r1', 'r2']);

    const batchMonthByBatchId = new Map(Object.entries(monthMap));
    const res = hasReversalPairForMonth(deduped as any, '2026-01', batchMonthByBatchId);
    expect(res.matched).toBe(true);
    expect(res.evidence?.positiveTransactionId).toBe('8245546');
    expect(res.evidence?.negativeTransactionId).toBe('8705401');
    expect(res.evidence?.positiveStatementMonth).toBe('2026-01');
    expect(res.evidence?.negativeStatementMonth).toBe('2026-04');
    expect(res.evidence?.amount).toBe(48);
  });
});
