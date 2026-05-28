/**
 * Phase A item 3 — Stage 1 trace infrastructure regression test.
 *
 * Asserts the trace mechanism produces correct output end-to-end for the
 * Dannielle Coe Jan 2026 reversed canary. If this test ever fails, the
 * lineage tool has silently rotted.
 *
 * Dannielle is slot 1 in docs/named-canary-ledger.md.
 * Policy: u96332808, Jan 2026, All scope, expected state: reversed.
 * TXN +8245546, TXN -8705401, amount 48, paid_to_date 2026-01-31.
 *
 * Runs against mocked normalized records (no live Supabase) so it executes
 * in `npm test` by default.
 */
import { describe, it, expect } from 'vitest';
import { explainCell } from '@/lib/explainCell';
import type { NormalizedRecord } from '@/lib/normalize';

function commRow(overrides: Partial<NormalizedRecord> & { txn?: string }): NormalizedRecord {
  const { txn, ...rest } = overrides as any;
  return {
    id: Math.random().toString(36).slice(2),
    source_type: 'COMMISSION',
    staging_status: 'active',
    member_key: 'issub:u96332808',
    applicant_name: 'DANNIELLE COE',
    policy_number: 'U96332808-AR',
    carrier: 'ambetter',
    pay_entity: 'Coverall',
    paid_to_date: '2026-01-31',
    months_paid: 1,
    commission_amount: 0,
    batch_id: 'batch-feb',
    raw_json: txn ? { 'Transaction ID': txn } : {},
    ...rest,
  } as any;
}

describe('explainCell — Dannielle Coe Jan 2026 reversed trace', () => {
  it('returns the reversed state with full trace evidence', async () => {
    const preloadedRecords: NormalizedRecord[] = [
      commRow({ commission_amount: 48, txn: '8245546', batch_id: 'batch-feb' } as any),
      commRow({ commission_amount: -48, txn: '8705401', batch_id: 'batch-may' } as any),
    ];

    const trace = await explainCell({
      memberKey: 'issub:u96332808',
      monthKey: '2026-01',
      scope: 'All',
      preloadedRecords,
    });

    expect(trace.final.state).toBe('reversed');
    expect(trace.firingRule?.name).toMatch(/reversed|R-PAY-012/i);

    const reversalHelper = trace.helpers.find(h => h.name === 'hasReversalPairForMonth');
    expect(reversalHelper).toBeDefined();
    const helperOutput = reversalHelper!.output as {
      matched: boolean;
      evidence?: {
        positiveTransactionId?: string | null;
        negativeTransactionId?: string | null;
        amount?: number;
      };
    };
    expect(helperOutput.matched).toBe(true);
    expect(helperOutput.evidence?.positiveTransactionId).toBe('8245546');
    expect(helperOutput.evidence?.negativeTransactionId).toBe('8705401');
    expect(helperOutput.evidence?.amount).toBe(48);

    expect(trace.final.badges.reversal_evidence).toBeDefined();
    expect(trace.scopedRows.length).toBe(2);
    expect(trace.cell.month).toBe('2026-01');
    expect(trace.cell.scope).toBe('All');
  });
});
