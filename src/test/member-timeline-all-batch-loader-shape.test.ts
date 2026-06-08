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
import { assembleDiagnoseRouteRows } from '@/lib/canonical/assembleDiagnoseRouteRows';
import type { CarrierCompRateRow } from '@/lib/canonical/compGrid';

function makeRow(n: number, overrides: Partial<ProjectedRow> = {}): ProjectedRow {
  return {
    id: `id-${String(n).padStart(6, '0')}`,
    batch_id: 'batch-A',
    staging_status: 'active',
    superseded_at: null,
    source_type: 'EDE',
    member_key: `mk-${n}`,
    // C2b-1 corrective — client_state_full is now a typed projected column
    // (not a raw_json subkey), so it arrives on the loader row as-is.
    client_state_full: 'FL',
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
    // C2b-1 member-count corrective — four member-count aliases.
    raw_number_of_members: '1',
    raw_covered_member_count: null,
    raw_covered_member_count_cap: null,
    raw_covered_member_count_snake: null,
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

  it('projects the 12 raw_json subkeys via stable aliases (no ?column? defaults)', async () => {
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
    // Phase C1a — DMI subkeys.
    expect(cols).toContain('raw_verification_issue_type:raw_json->>verificationIssueType');
    expect(cols).toContain('raw_verification_end_date:raw_json->>verificationEndDate');
    expect(cols).toContain('raw_document_uploaded_for_svi_dmi:raw_json->>documentUploadedForSviDmi');
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
      verificationIssueType: 'DMI_CITIZENSHIP',
      verificationEndDate: '2026-03-15',
      documentUploadedForSviDmi: 'N',
    });
    // The aliased fields are stripped (no leakage).
    expect(row.raw_ffm_app_id).toBeUndefined();
    expect(row.raw_months_paid).toBeUndefined();
    expect(row.raw_broker_name_title).toBeUndefined();
    expect(row.raw_transaction_id).toBeUndefined();
    expect(row.raw_verification_issue_type).toBeUndefined();
    expect(row.raw_verification_end_date).toBeUndefined();
    expect(row.raw_document_uploaded_for_svi_dmi).toBeUndefined();
  });

  it('omits missing raw keys cleanly (null projected values do not show up as keys)', async () => {
    allRows = [makeRow(1, {
      raw_ffm_app_id: null,
      raw_last_ede_sync: null,
      raw_broker_name: null,
      raw_verification_issue_type: null,
      raw_verification_end_date: null,
      raw_document_uploaded_for_svi_dmi: null,
    })];
    const [row] = await getAllNormalizedRecordsForMemberTimeline();
    expect(row.raw_json).not.toHaveProperty('ffmAppId');
    expect(row.raw_json).not.toHaveProperty('lastEDESync');
    expect(row.raw_json).not.toHaveProperty('broker_name');
    expect(row.raw_json).not.toHaveProperty('verificationIssueType');
    expect(row.raw_json).not.toHaveProperty('verificationEndDate');
    expect(row.raw_json).not.toHaveProperty('documentUploadedForSviDmi');
    expect(row.raw_json.currentPolicyAOR).toBe('Agent 1');
  });

  // ── C2b-1 corrective ────────────────────────────────────────────────
  it('C2b-1: MEMBER_TIMELINE_ALL_BATCH_COLUMNS contains client_state_full as a plain typed column', async () => {
    allRows = [makeRow(1, { client_state_full: 'FL' })];
    await getAllNormalizedRecordsForMemberTimeline();
    const colsArr = MEMBER_TIMELINE_ALL_BATCH_COLUMNS.split(',').map(s => s.trim());
    expect(colsArr).toContain('client_state_full');
    // Plain typed column, not a raw_json subkey alias.
    expect(MEMBER_TIMELINE_ALL_BATCH_COLUMNS).not.toMatch(/client_state_full:raw_json/);
    // Runtime select uses the exported constant.
    expect(queryLog[0].selectCols).toBe(MEMBER_TIMELINE_ALL_BATCH_COLUMNS);
  });

  it('C2b-1: loader preserves row.client_state_full while raw_json alias stripping still works', async () => {
    allRows = [makeRow(1, { client_state_full: 'FL' })];
    const [row] = await getAllNormalizedRecordsForMemberTimeline();
    expect(row.client_state_full).toBe('FL');
    // raw_json reconstruction still works and aliases are still stripped.
    expect(row.raw_json.currentPolicyAOR).toBe('Agent 1');
    expect(row.raw_ffm_app_id).toBeUndefined();
    expect(row.raw_broker_name_title).toBeUndefined();
  });

  it('C2b-1: paid row whose state arrives via projection resolves amount fact (NOT MISSING_STATE)', async () => {
    // Mirror the production path: projection-shaped rows (no field pre-seeded
    // on a hand-built fixture) flow through the loader, then into the headless
    // assembler. Before the corrective, client_state_full was dropped by
    // MEMBER_TIMELINE_TYPED_COLUMNS, starving the resolver of state.
    const STMT_MONTH = '2026-03';
    const lastDay = '2026-03-31';
    const projected = [
      makeRow(1, {
        id: 'id-000001',
        batch_id: 'B-2026-03',
        source_type: 'BACK_OFFICE',
        member_key: 'mkPAID',
        issuer_subscriber_id: 'ISIDPAID',
        policy_number: 'POLPAID',
        carrier: 'Ambetter',
        applicant_name: 'Loader Paid',
        agent_npn: '21055210',
        agent_name: 'Jason Fine',
        eligible_for_commission: 'Yes',
        net_premium: 100,
        paid_through_date: '2026-04-30',
        effective_date: '2025-12-01',
        client_state_full: 'FL',
        raw_broker_name_title: 'Jason Fine',
        raw_issuer: 'Ambetter',
        raw_current_policy_aor: 'Jason Fine (21055210)',
      }),
      makeRow(2, {
        id: 'id-000002',
        batch_id: 'B-2026-03',
        source_type: 'EDE',
        member_key: 'mkPAID',
        issuer_subscriber_id: 'ISIDPAID',
        policy_number: 'POLPAID',
        carrier: 'Ambetter',
        applicant_name: 'Loader Paid',
        agent_npn: '21055210',
        status: 'effectuated',
        effective_date: '2025-12-01',
        client_state_full: 'FL',
        raw_current_policy_aor: 'Jason Fine (21055210)',
        raw_policy_status: 'effectuated',
        raw_issuer: 'Ambetter',
      }),
      makeRow(3, {
        id: 'id-000003',
        batch_id: 'B-2026-03',
        source_type: 'COMMISSION',
        member_key: 'mkPAID',
        issuer_subscriber_id: 'ISIDPAID',
        policy_number: 'POLPAID',
        carrier: 'Ambetter',
        applicant_name: 'Loader Paid',
        pay_entity: 'Coverall',
        agent_npn: '21055210',
        commission_amount: 50,
        paid_to_date: lastDay,
        months_paid: 1,
        effective_date: '2025-12-01',
        client_state_full: 'FL',
      }),
    ];
    allRows = projected;
    const loaded = await getAllNormalizedRecordsForMemberTimeline();
    // Sanity: state survives projection (the actual bug under test).
    for (const r of loaded) expect(r.client_state_full).toBe('FL');

    const rate: CarrierCompRateRow = {
      id: 'rate-fl-pmpm-2026',
      rate_key: 'ambetter|FL|standard|2026',
      carrier_key: 'ambetter',
      carrier_display: 'Ambetter',
      state_code: 'FL',
      plan_variant: 'standard',
      comp_basis: 'pmpm',
      calculation_basis: 'per_member_pmpm',
      rate_value: 25,
      rate_unit: 'USD',
      member_min: null,
      member_max: null,
      member_cap: null,
      effective_year: 2026,
      support_status: 'supported',
      unsupported_reason: null,
    };

    const { rows } = assembleDiagnoseRouteRows({
      allBatchRecords: loaded as any,
      monthList: ['2026-01', '2026-02', '2026-03', '2026-04'],
      serviceMonths: [STMT_MONTH],
      targetScopes: ['Coverall'],
      batchMonthByBatchId: { 'B-2026-03': STMT_MONTH },
      today: '2026-04-10',
      rateRows: [rate],
    } as any);

    const paid = rows.find(
      (r) => r.targetScope === 'Coverall' && r.serviceMonth === STMT_MONTH && r.stableMemberKey === 'isid:isidpaid',
    );
    expect(paid).toBeDefined();
    expect(paid!.population).toBe(2);
    // The corrective's contract: amount fact must NOT report MISSING_STATE.
    // (MISSING_MEMBER_COUNT is the documented next-blocker and out of scope.)
    if (paid!.facts.amount.kind === 'indeterminate') {
      expect(paid!.facts.amount.reason).not.toBe('MISSING_STATE');
    }
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
