/**
 * Phase 2.3 — Member Timeline all-batch loader query shape & raw-key preservation.
 *
 * Asserts that getAllNormalizedRecordsForMemberTimeline():
 *   - does NOT select('*')
 *   - does NOT include the full raw_json column
 *   - preserves the active predicate and keyset pagination
 *   - projects the 8 raw_json subkeys via stable aliases
 *   - reconstructs row.raw_json with original key names so existing helpers
 *     (aorPicker, classifier, memberTimeline, paidDollarsAudit) keep working
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

type ProjectedRow = Record<string, any>;

let allRows: ProjectedRow[] = [];
let queryLog: Array<{
  selectCols: string;
  filters: Record<string, any>;
  gtId: string | null;
  limit: number | null;
}> = [];

function makeBuilder() {
  let selectCols = '';
  const filters: Record<string, any> = {};
  let gtId: string | null = null;
  let limitN: number | null = null;
  let order: { col: string; asc: boolean } | null = null;

  const builder: any = {
    select: (cols: string) => { selectCols = cols; return builder; },
    eq: (col: string, val: any) => { filters[`eq:${col}`] = val; return builder; },
    is: (col: string, val: any) => { filters[`is:${col}`] = val; return builder; },
    gt: (col: string, val: any) => { if (col === 'id') gtId = val; return builder; },
    order: (col: string, opts: any) => { order = { col, asc: !!opts?.ascending }; return builder; },
    limit: (n: number) => { limitN = n; return builder; },
    then: (resolve: any, reject: any) => {
      try {
        queryLog.push({ selectCols, filters: { ...filters }, gtId, limit: limitN });
        let rows = allRows.slice();
        if ('eq:staging_status' in filters) rows = rows.filter(r => r.staging_status === filters['eq:staging_status']);
        if ('is:superseded_at' in filters && filters['is:superseded_at'] === null) rows = rows.filter(r => r.superseded_at === null);
        if (order && order.col === 'id') rows.sort((a, b) => order!.asc ? a.id.localeCompare(b.id) : b.id.localeCompare(a.id));
        if (gtId !== null) rows = rows.filter(r => r.id > gtId!);
        if (limitN !== null) rows = rows.slice(0, limitN);
        resolve({ data: rows, error: null });
      } catch (err) {
        if (reject) reject(err); else resolve({ data: null, error: err });
      }
    },
  };
  return builder;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: (_table: string) => makeBuilder() },
}));

import {
  getAllNormalizedRecordsForMemberTimeline,
  MEMBER_TIMELINE_ALL_BATCH_COLUMNS,
} from '@/lib/persistence';
import { buildMemberTimeline } from '@/lib/memberTimeline';

function makeRow(n: number, overrides: Partial<ProjectedRow> = {}): ProjectedRow {
  return {
    id: `id-${String(n).padStart(6, '0')}`,
    batch_id: 'batch-A',
    staging_status: 'active',
    superseded_at: null,
    source_type: 'EDE',
    member_key: `mk-${n}`,
    raw_ffm_app_id: `FFM-${n}`,
    raw_current_policy_aor: `Agent ${n}`,
    raw_policy_status: 'PENDING',
    raw_issuer: 'AMBETTER',
    raw_last_ede_sync: '2026-01-01',
    raw_months_paid: '3',
    raw_broker_name_title: `Broker ${n}`,
    raw_broker_name: `broker_${n}`,
    raw_transaction_id: `TXN-${n}`,
    raw_verification_issue_type: 'DMI_CITIZENSHIP',
    raw_verification_end_date: '2026-03-15',
    raw_document_uploaded_for_svi_dmi: 'N',
    ...overrides,
  };
}


beforeEach(() => { allRows = []; queryLog = []; });

describe('getAllNormalizedRecordsForMemberTimeline — query shape', () => {
  it('does NOT use select(*) and does NOT include the full raw_json column', async () => {
    allRows = [makeRow(1)];
    await getAllNormalizedRecordsForMemberTimeline();
    expect(queryLog.length).toBeGreaterThan(0);
    for (const q of queryLog) {
      expect(q.selectCols).not.toBe('*');
      expect(q.selectCols.split(',').map(s => s.trim())).not.toContain('raw_json');
    }
  });

  it('projects the 9 raw_json subkeys via stable aliases (no ?column? defaults)', async () => {
    allRows = [makeRow(1)];
    await getAllNormalizedRecordsForMemberTimeline();
    const cols = MEMBER_TIMELINE_ALL_BATCH_COLUMNS;
    expect(cols).toContain('raw_ffm_app_id:raw_json->>ffmAppId');
    expect(cols).toContain('raw_current_policy_aor:raw_json->>currentPolicyAOR');
    expect(cols).toContain('raw_policy_status:raw_json->>policyStatus');
    expect(cols).toContain('raw_issuer:raw_json->>issuer');
    expect(cols).toContain('raw_last_ede_sync:raw_json->>lastEDESync');
    expect(cols).toContain('raw_months_paid:raw_json->>"Months Paid"');
    expect(cols).toContain('raw_broker_name_title:raw_json->>"Broker Name"');
    expect(cols).toContain('raw_broker_name:raw_json->>broker_name');
    expect(cols).toContain('raw_transaction_id:raw_json->>"Transaction ID"');
    // The select string used at runtime must match the exported constant.
    expect(queryLog[0].selectCols).toBe(cols);
  });


  it('preserves active predicate and keyset pagination', async () => {
    allRows = Array.from({ length: 600 }, (_, i) => makeRow(i + 1));
    await getAllNormalizedRecordsForMemberTimeline();
    // 3 full pages of 200 + 1 empty sentinel page (NORMALIZED_PAGE_SIZE = 200).
    // Exact-multiple totals require one extra empty fetch to terminate the loop.
    expect(queryLog.length).toBe(4);
    for (const q of queryLog) {
      expect(q.filters['eq:staging_status']).toBe('active');
      expect(q.filters['is:superseded_at']).toBeNull();
      expect(q.limit).toBe(200);
      expect(q.filters).not.toHaveProperty('eq:batch_id');
    }
    expect(queryLog[0].gtId).toBeNull();
    expect(queryLog[1].gtId).toBe('id-000200');
    expect(queryLog[2].gtId).toBe('id-000400');
    expect(queryLog[3].gtId).toBe('id-000600');
  });

  it('reconstructs row.raw_json with the original key names downstream helpers expect', async () => {
    allRows = [makeRow(1)];
    const [row] = await getAllNormalizedRecordsForMemberTimeline();
    expect(row.raw_json).toEqual({
      ffmAppId: 'FFM-1',
      currentPolicyAOR: 'Agent 1',
      policyStatus: 'PENDING',
      issuer: 'AMBETTER',
      lastEDESync: '2026-01-01',
      'Months Paid': '3',
      'Broker Name': 'Broker 1',
      broker_name: 'broker_1',
      'Transaction ID': 'TXN-1',
    });
    // The aliased fields are stripped (no leakage).
    expect(row.raw_ffm_app_id).toBeUndefined();
    expect(row.raw_months_paid).toBeUndefined();
    expect(row.raw_broker_name_title).toBeUndefined();
    expect(row.raw_transaction_id).toBeUndefined();

  });

  it('omits missing raw keys cleanly (null projected values do not show up as keys)', async () => {
    allRows = [makeRow(1, {
      raw_ffm_app_id: null,
      raw_last_ede_sync: null,
      raw_broker_name: null,
    })];
    const [row] = await getAllNormalizedRecordsForMemberTimeline();
    expect(row.raw_json).not.toHaveProperty('ffmAppId');
    expect(row.raw_json).not.toHaveProperty('lastEDESync');
    expect(row.raw_json).not.toHaveProperty('broker_name');
    expect(row.raw_json.currentPolicyAOR).toBe('Agent 1');
  });

  it('buildMemberTimeline still surfaces fallback FFM IDs from loader output (Class-A pattern)', async () => {
    // Two EDE rows for the same member: BO/Commission absent, FFM ID present
    // in raw_json — mirrors the Diedric/Lisa/Frederick/Erica canary pattern.
    allRows = [
      makeRow(1, {
        member_key: 'mk-canary',
        source_type: 'EDE',
        raw_ffm_app_id: 'FFM-CANARY-001',
        raw_current_policy_aor: 'Coverall',
      }),
      makeRow(2, {
        member_key: 'mk-canary',
        source_type: 'EDE',
        raw_ffm_app_id: 'FFM-CANARY-001',
        raw_current_policy_aor: 'Coverall',
      }),
    ];
    const rows = await getAllNormalizedRecordsForMemberTimeline();
    // Every row carries the FFM id through to the helpers.
    for (const r of rows) {
      expect(r.raw_json.ffmAppId).toBe('FFM-CANARY-001');
    }
    // Smoke: buildMemberTimeline can consume the projected rows without throwing.
    expect(() => buildMemberTimeline(rows as any, ['2026-01'])).not.toThrow();
  });
});
