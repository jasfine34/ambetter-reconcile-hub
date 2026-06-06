import { describe, it, expect } from 'vitest';
import {
  filterLatestBoTerminatedOwedRows,
  latestAuthoritativeBoTermDates,
  makeBoRecency,
} from '../latestAuthoritativeBo';

const CARRIER = 'ambetter';
const BATCH = 'B1';
const STMT_START = '2026-02-01';

const boRows: any[] = [
  {
    id: 'bo1',
    batch_id: BATCH,
    source_type: 'BACK_OFFICE',
    carrier: CARRIER,
    policy_number: 'PTERM001',
    issuer_subscriber_id: 'STERM001',
    policy_term_date: '2026-01-15', // terminated before Feb start
    broker_term_date: null,
  },
  {
    id: 'bo2',
    batch_id: BATCH,
    source_type: 'BACK_OFFICE',
    carrier: CARRIER,
    policy_number: 'PLIVE002',
    issuer_subscriber_id: 'SLIVE002',
    policy_term_date: null,
    broker_term_date: null,
  },
];

const batchMonthByBatchId = new Map<string, string>([[BATCH, '2026-02']]);
const overlay = latestAuthoritativeBoTermDates(boRows, makeBoRecency({ batchMonthByBatchId }));

const termedUnpaid = {
  carrier: CARRIER, policy_number: 'PTERM001', issuer_subscriber_id: 'STERM001', in_commission: false,
};
const termedPaid = {
  carrier: CARRIER, policy_number: 'PTERM001', issuer_subscriber_id: 'STERM001', in_commission: true,
};
const liveUnpaid = {
  carrier: CARRIER, policy_number: 'PLIVE002', issuer_subscriber_id: 'SLIVE002', in_commission: false,
};
const liveNullCommission = {
  carrier: CARRIER, policy_number: 'PLIVE002', issuer_subscriber_id: 'SLIVE002', in_commission: null as any,
};

describe('filterLatestBoTerminatedOwedRows', () => {
  it('suppresses terminated-policy unpaid row', () => {
    expect(filterLatestBoTerminatedOwedRows([termedUnpaid], overlay, STMT_START)).toEqual([]);
  });
  it('preserves terminated-policy PAID row (commission evidence)', () => {
    expect(filterLatestBoTerminatedOwedRows([termedPaid], overlay, STMT_START)).toEqual([termedPaid]);
  });
  it('preserves non-terminated unpaid row', () => {
    expect(filterLatestBoTerminatedOwedRows([liveUnpaid], overlay, STMT_START)).toEqual([liveUnpaid]);
  });
  it('returns empty for empty input', () => {
    expect(filterLatestBoTerminatedOwedRows([], overlay, STMT_START)).toEqual([]);
  });
  it('preserves non-terminated row with null/undefined in_commission', () => {
    expect(filterLatestBoTerminatedOwedRows([liveNullCommission], overlay, STMT_START)).toEqual([liveNullCommission]);
  });
});
