/**
 * Coverage / wiring assertions for the canonical commission dedup layer in
 * persistence.ts. Verifies the three loaders flow through dedupCommissionRows
 * when a CommissionDedupContext is supplied, and pass rows through unchanged
 * when no context is supplied (back-compat).
 *
 *   - getAllNormalizedRecordsForMemberTimeline (all-batch / MT+MCE+diagnose)
 *   - getNormalizedRecordsByMemberKeys         (MCE enrichment)
 *   - getCommissionRecordsByTriples            (MCE commission fallback)
 *
 * NOT IN SCOPE: getNormalizedRecords(batchId) (batch-local) — left untouched
 * for now per the staged delivery plan.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

type Row = Record<string, any>;
let allRows: Row[] = [];

function makeBuilder() {
  const filters: Record<string, any> = {};
  const inFilters: Record<string, any[]> = {};
  let gtId: string | null = null;
  let limitN: number | null = null;
  const builder: any = {
    select: (_c: string) => builder,
    eq: (col: string, val: any) => { filters[`eq:${col}`] = val; return builder; },
    is: (col: string, val: any) => { filters[`is:${col}`] = val; return builder; },
    in: (col: string, vals: any[]) => { inFilters[col] = vals; return builder; },
    gt: (col: string, val: any) => { if (col === 'id') gtId = val; return builder; },
    order: () => builder,
    limit: (n: number) => { limitN = n; return builder; },
    then: (resolve: any) => {
      let rows = allRows.slice();
      if ('eq:staging_status' in filters) rows = rows.filter(r => r.staging_status === filters['eq:staging_status']);
      if ('is:superseded_at' in filters) rows = rows.filter(r => r.superseded_at === null);
      if ('eq:source_type' in filters) rows = rows.filter(r => r.source_type === filters['eq:source_type']);
      for (const col of Object.keys(inFilters)) {
        rows = rows.filter(r => inFilters[col].includes(r[col]));
      }
      rows.sort((a, b) => a.id.localeCompare(b.id));
      if (gtId !== null) rows = rows.filter(r => r.id > gtId!);
      if (limitN !== null) rows = rows.slice(0, limitN);
      resolve({ data: rows, error: null });
    },
  };
  return builder;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: (_t: string) => makeBuilder() },
}));

import {
  getAllNormalizedRecordsForMemberTimeline,
  getNormalizedRecordsByMemberKeys,
  getCommissionRecordsByTriples,
  type CommissionDedupContext,
} from '@/lib/persistence';

function commRow(over: Partial<Row> & { id: string; batch_id: string; txn: string; amount: number; created_at?: string }): Row {
  return {
    id: over.id,
    batch_id: over.batch_id,
    staging_status: 'active',
    superseded_at: null,
    source_type: 'COMMISSION',
    carrier: 'Ambetter',
    pay_entity: 'Jason',
    agent_npn: '12345',
    writing_agent_carrier_id: 'WAC-1',
    member_key: 'mk-1',
    commission_amount: over.amount,
    paid_to_date: '2026-01-15',
    raw_json: { 'Transaction ID': over.txn, 'Months Paid': 1 },
    created_at: over.created_at ?? '2026-04-01T00:00:00Z',
    raw_months_paid: 1,
    raw_transaction_id: over.txn,
    ...over,
  };
}

const batchMonthByBatchId = { 'batch-apr': '2026-04', 'batch-may': '2026-05' };

beforeEach(() => {
  // Dannielle fixture: April reversal duplicated in May.
  allRows = [
    commRow({ id: 'id-001', batch_id: 'batch-apr', txn: 'TXN-8705401', amount: -48, created_at: '2026-04-01T00:00:00Z' }),
    commRow({ id: 'id-002', batch_id: 'batch-may', txn: 'TXN-8705401', amount: -48, created_at: '2026-05-01T00:00:00Z' }),
  ];
});

describe('persistence dedup wiring', () => {
  describe('getAllNormalizedRecordsForMemberTimeline', () => {
    it('passes rows through untouched when no dedup context', async () => {
      const rows = await getAllNormalizedRecordsForMemberTimeline();
      expect(rows).toHaveLength(2);
    });
    it('applies dedup when context is provided (April survives May duplicate)', async () => {
      let diag: any = null;
      const ctx: CommissionDedupContext = {
        batchMonthByBatchId,
        onDiagnostic: (i) => { diag = i; },
      };
      const rows = await getAllNormalizedRecordsForMemberTimeline(ctx);
      expect(rows).toHaveLength(1);
      expect(rows[0].batch_id).toBe('batch-apr');
      expect(diag.droppedCount).toBe(1);
      expect(diag.groupCount).toBe(1);
    });
  });

  describe('getNormalizedRecordsByMemberKeys', () => {
    it('passes rows through untouched when no dedup context', async () => {
      const rows = await getNormalizedRecordsByMemberKeys(['mk-1']);
      expect(rows).toHaveLength(2);
    });
    it('applies dedup when context is provided', async () => {
      const ctx: CommissionDedupContext = { batchMonthByBatchId };
      const rows = await getNormalizedRecordsByMemberKeys(['mk-1'], ctx);
      expect(rows).toHaveLength(1);
      expect(rows[0].batch_id).toBe('batch-apr');
    });
  });

  describe('getCommissionRecordsByTriples', () => {
    const triples = [{ carrier: 'Ambetter', payEntity: 'Jason', agentNpn: '12345' }];
    it('passes rows through untouched when no dedup context', async () => {
      const rows = await getCommissionRecordsByTriples(triples);
      expect(rows).toHaveLength(2);
    });
    it('applies dedup when context is provided', async () => {
      const ctx: CommissionDedupContext = { batchMonthByBatchId };
      const rows = await getCommissionRecordsByTriples(triples, ctx);
      expect(rows).toHaveLength(1);
      expect(rows[0].batch_id).toBe('batch-apr');
    });
  });
});
