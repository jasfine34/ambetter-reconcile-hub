/**
 * Pure tests for buildMemberTimelineExportRows — the helper extracted from
 * MemberTimelinePage.handleExport. Verifies FFM ID is the first CSV column
 * and existing schema is preserved.
 */
import { describe, it, expect } from 'vitest';
import { buildMemberTimelineExportRows, type MemberTimelineRow, type MonthCell } from '@/lib/memberTimeline';

function cell(month: string, overrides: Partial<MonthCell> = {}): MonthCell {
  return {
    month,
    in_ede: false,
    in_back_office: false,
    in_commission: false,
    paid_amount: 0,
    payment_count: 0,
    due: false,
    ...overrides,
  };
}

function row(overrides: Partial<MemberTimelineRow> = {}): MemberTimelineRow {
  return {
    member_key: 'm1',
    applicant_name: 'Jane Doe',
    policy_number: 'P-1',
    exchange_subscriber_id: 'X-1',
    issuer_subscriber_id: 'I-1',
    agent_name: 'Agent A',
    aor_bucket: 'Coverall',
    current_policy_aor: 'Coverall',
    ffm_app_ids: [],
    cells: { '2026-01': cell('2026-01', { in_ede: true, due: true }) },
    total_paid: 0,
    months_due: 1,
    months_paid: 0,
    months_unpaid: 1,
    ...overrides,
  };
}

describe('buildMemberTimelineExportRows', () => {
  it('places ffm_app_id as the first column', () => {
    const out = buildMemberTimelineExportRows([row({ ffm_app_ids: ['FFM-1'] })], ['2026-01']);
    expect(Object.keys(out[0])[0]).toBe('ffm_app_id');
    expect(out[0].ffm_app_id).toBe('FFM-1');
  });

  it('joins multiple FFM IDs with "; "', () => {
    const out = buildMemberTimelineExportRows([row({ ffm_app_ids: ['A1', 'A2'] })], ['2026-01']);
    expect(out[0].ffm_app_id).toBe('A1; A2');
  });

  it('exports blank when no FFM IDs (empty array or undefined)', () => {
    const out1 = buildMemberTimelineExportRows([row({ ffm_app_ids: [] })], ['2026-01']);
    expect(out1[0].ffm_app_id).toBe('');
    const out2 = buildMemberTimelineExportRows([row({ ffm_app_ids: undefined as any })], ['2026-01']);
    expect(out2[0].ffm_app_id).toBe('');
  });

  it('preserves all prior keys and per-month columns', () => {
    const monthList = ['2026-01', '2026-02'];
    const r = row({
      ffm_app_ids: ['FFM-X'],
      cells: {
        '2026-01': cell('2026-01', { in_ede: true, in_back_office: true, due: true, paid_amount: 12.5 }),
        '2026-02': cell('2026-02', { in_ede: true, due: true }),
      },
      total_paid: 12.5,
    });
    const out = buildMemberTimelineExportRows([r], monthList);
    const keys = Object.keys(out[0]);
    for (const k of [
      'ffm_app_id', 'member', 'policy_number', 'exchange_subscriber_id',
      'issuer_subscriber_id', 'agent_name', 'aor_bucket', 'months_due',
      'months_paid', 'months_unpaid', 'total_paid',
      '2026-01_status', '2026-01_paid', '2026-01_sources',
      '2026-02_status', '2026-02_paid', '2026-02_sources',
    ]) {
      expect(keys).toContain(k);
    }
    expect(out[0]['2026-01_status']).toBe('PAID');
    expect(out[0]['2026-01_sources']).toBe('EDE+BO');
    expect(out[0]['2026-02_status']).toBe('UNPAID');
    expect(out[0].total_paid).toBe('12.50');
  });
});
