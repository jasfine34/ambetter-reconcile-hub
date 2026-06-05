/**
 * Sweep wiring: commission candidates are deduped BEFORE
 * evaluateCrossBatchAmountClearing. A May row that exact-duplicates an
 * April reversal must not double-count toward `actual_net_amount`.
 *
 * Also documents (with a code-shape assertion) the "limited branch" we took
 * for batch-local consumers: getNormalizedRecords(batchId) is intentionally
 * left raw — a single-batch set cannot see cross-batch duplicates.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { dedupCommissionRows } from '@/lib/canonical/dedupCommissionRows';
import { evaluateCrossBatchAmountClearing } from '@/lib/canonical/crossBatchAmountClearing';

const SWEEP_SRC = fs.readFileSync(
  path.join(process.cwd(), 'src/lib/sweep/crossBatchClearingSweep.ts'),
  'utf-8',
);
const PERSISTENCE_SRC = fs.readFileSync(
  path.join(process.cwd(), 'src/lib/persistence.ts'),
  'utf-8',
);

describe('sweep — commission dedup before amount clearing', () => {
  it('sweep imports dedupCommissionRows and calls it before evaluateCrossBatchAmountClearing', () => {
    expect(SWEEP_SRC).toMatch(/import\s+\{\s*dedupCommissionRows\s*\}\s+from\s+'@\/lib\/canonical\/dedupCommissionRows'/);
    const dedupIdx = SWEEP_SRC.indexOf('dedupCommissionRows(commForDedup');
    const evalIdx = SWEEP_SRC.indexOf('evaluateCrossBatchAmountClearing({');
    expect(dedupIdx).toBeGreaterThan(0);
    expect(evalIdx).toBeGreaterThan(dedupIdx);
  });

  it('end-to-end: duplicated payment row produces deduped clearing outcome', () => {
    // Two carrier candidates, identical TXN — May exact-duplicates April.
    const apr = {
      id: 'r-apr', source_type: 'COMMISSION' as const, batch_id: 'b-apr',
      carrier: 'Ambetter', pay_entity: 'Jason',
      commission_amount: 100, paid_to_date: '2026-01-31', months_paid: 1,
      created_at: '2026-04-01T00:00:00Z',
      raw_json: { 'Transaction ID': 'T-100' },
    };
    const may = { ...apr, id: 'r-may', batch_id: 'b-may', created_at: '2026-05-01T00:00:00Z' };

    const rawNet = [apr, may].reduce((s, r) => s + r.commission_amount, 0);
    expect(rawNet).toBe(200); // bug: double-count

    const deduped = dedupCommissionRows([apr, may] as any, {
      batchMonthByBatchId: { 'b-apr': '2026-04', 'b-may': '2026-05' },
    }).rows;
    expect(deduped).toHaveLength(1);
    expect(deduped[0].id).toBe('r-apr');

    const result = evaluateCrossBatchAmountClearing({
      expected_amount: 100,
      candidates: deduped.map(r => ({
        id: r.id,
        commission_amount: r.commission_amount,
        statement_month: r.batch_id === 'b-apr' ? '2026-04' : '2026-05',
        created_at: r.created_at,
        raw_json: r.raw_json,
        pay_entity: r.pay_entity,
      })),
    });
    // Deduped net is 100 (single $100 payment), not 200.
    expect(result.actual_net_amount).toBe(100);
  });
});

describe('batch-local consumers — documented "limited branch"', () => {
  // We deliberately left getNormalizedRecords(batchId) on raw rows. A single
  // batch can never expose cross-batch duplicates; intra-batch exact dupes
  // are vanishingly rare in practice and will fold into the upcoming
  // secondary-surface alignment. This test guards against accidental
  // protection claims by asserting the loader signature has no dedup ctx.
  it('getNormalizedRecords(batchId) signature stays single-arg (no dedup ctx threaded)', () => {
    const sig = PERSISTENCE_SRC.match(/export async function getNormalizedRecords\([^)]*\)/);
    expect(sig).not.toBeNull();
    expect(sig![0]).not.toMatch(/CommissionDedupContext/);
  });
});
