/**
 * R-PAY-012 — MT reversed cell state end-to-end behavior.
 *
 * Verifies that the classifier emits 'reversed' for the Dannielle-exact-shape
 * canary, that the cell does not become 'unpaid', that CSV export labels it
 * 'REVERSED', and that the structured evidence flows through.
 */
import { describe, it, expect } from 'vitest';
import { classifyMember, hasReversalPairForMonth } from '@/lib/classifier';
import {
  buildMemberTimelineExportRows,
  exportStatusForMonthCell,
  type MonthCell,
  type MemberTimelineRow,
} from '@/lib/memberTimeline';
import type { NormalizedRecord } from '@/lib/normalize';

function comm(amount: number, txn: string, batch: string): NormalizedRecord {
  return {
    id: txn,
    source_type: 'COMMISSION',
    staging_status: 'active',
    commission_amount: amount,
    paid_to_date: '2026-01-31',
    months_paid: 1,
    batch_id: batch,
    member_key: 'm1',
    applicant_name: 'Dannielle Coe',
    agent_npn: '00000',
    aor_bucket: 'Coverall',
    raw_json: { 'Transaction ID': txn },
  } as any;
}

function bo(): NormalizedRecord {
  return {
    id: 'bo1',
    source_type: 'BACK_OFFICE',
    staging_status: 'active',
    member_key: 'm1',
    applicant_name: 'Dannielle Coe',
    agent_npn: '20104450',
    agent_name: 'Coverall',
    aor_bucket: 'Coverall',
    effective_date: '2025-12-01',
    broker_effective_date: '2025-12-01',
    policy_term_date: null,
    paid_through_date: '2026-02-28',
    member_responsibility: 48,
    raw_json: { broker_name: 'Coverall' },
  } as any;
}

describe('R-PAY-012 reversed cell state', () => {
  const SM = '2026-01';
  const batchMonths = new Map<string, string>([
    ['batch-feb', '2026-02'],
    ['batch-may', '2026-05'],
  ]);

  it('classifyMember emits reversed (not unpaid) for paid+reversal pair', () => {
    const records = [
      bo(),
      comm(48, '8245546', 'batch-feb'),
      comm(-48, '8705401', 'batch-may'),
    ];
    const result = classifyMember(records, {
      months: [SM],
      commissionStatementMonths: new Set([SM]),
      boSnapshotDates: [],
      batchMonthByBatchId: batchMonths,
    });
    const cell = result.cells[SM];
    expect(cell.state).toBe('reversed');
    expect((cell as any).reversal_evidence).toBeDefined();
    expect((cell as any).reversal_evidence.negativeStatementMonth).toBe('2026-05');
    expect((cell as any).reversal_evidence.positiveTransactionId).toBe('8245546');
    expect((cell as any).reversal_evidence.negativeTransactionId).toBe('8705401');
  });

  it('partial-paid cell (net positive after one reversal) stays paid, not reversed', () => {
    const records = [
      bo(),
      comm(48, 'A', 'batch-feb'),
      comm(30, 'B', 'batch-feb'),
      comm(-48, 'C', 'batch-may'),
    ];
    const result = classifyMember(records, {
      months: [SM],
      commissionStatementMonths: new Set([SM]),
      boSnapshotDates: [],
      batchMonthByBatchId: batchMonths,
    });
    expect(result.cells[SM].state).toBe('paid');
  });

  it('exportStatusForMonthCell returns REVERSED for reversed cells', () => {
    const cell: MonthCell = {
      month: SM,
      in_ede: false,
      in_back_office: true,
      in_commission: true,
      paid_amount: 0,
      payment_count: 2,
      due: true,
      state: 'reversed',
    };
    expect(exportStatusForMonthCell(cell)).toBe('REVERSED');
  });

  it('buildMemberTimelineExportRows surfaces REVERSED in CSV column', () => {
    const cell: MonthCell = {
      month: SM,
      in_ede: false,
      in_back_office: true,
      in_commission: true,
      paid_amount: 0,
      payment_count: 2,
      due: true,
      state: 'reversed',
    };
    const row: MemberTimelineRow = {
      member_key: 'm1',
      applicant_name: 'Dannielle Coe',
      policy_number: 'P',
      exchange_subscriber_id: 'X',
      issuer_subscriber_id: 'I',
      agent_name: 'Coverall',
      aor_bucket: 'Coverall',
      current_policy_aor: 'Coverall',
      ffm_app_ids: [],
      cells: { [SM]: cell },
      total_paid: 0,
      months_due: 1,
      months_paid: 0,
      months_unpaid: 0,
    };
    const out = buildMemberTimelineExportRows([row], [SM]);
    expect(out[0][`${SM}_status`]).toBe('REVERSED');
  });

  it('hasReversalPairForMonth matched evidence flows to classifier output', () => {
    const records = [
      comm(48, 'P', 'batch-feb'),
      comm(-48, 'N', 'batch-may'),
    ];
    const check = hasReversalPairForMonth(records, SM, batchMonths);
    expect(check.matched).toBe(true);
    expect(check.evidence?.amount).toBe(48);
    expect(check.evidence?.paidToDate).toBe('2026-01-31');
  });
});
