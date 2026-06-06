/**
 * Shared render helper for MT Screen Contract drift-detection tests.
 *
 * Renders the REAL MemberTimelinePage. Mocks data hooks + assembly so each
 * test can inject canned rows / cells. Renderer JSX is NOT duplicated.
 */
import React from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { render, type RenderResult } from '@testing-library/react';
import type { MemberTimelineRow, MonthCell } from '@/lib/memberTimeline';

export const TEST_BATCH_ID = 'b-test';
export const TEST_STATEMENT_MONTH = '2026-04-01';

/** Default empty MonthCell helper. */
export function blankCell(month: string, over: Partial<MonthCell> = {}): MonthCell {
  return {
    month,
    in_ede: false,
    in_back_office: false,
    in_commission: false,
    paid_amount: 0,
    payment_count: 0,
    due: false,
    ...over,
  };
}

export function makeRow(over: Partial<MemberTimelineRow> & { cells: Record<string, MonthCell> }): MemberTimelineRow {
  const cells = over.cells;
  let months_due = 0, months_paid = 0, months_unpaid = 0;
  for (const c of Object.values(cells)) {
    const due = c.state === 'paid' || c.state === 'unpaid' || c.state === 'reversed'
      || c.state === 'pending' || c.state === 'manual_review' || c.due;
    if (due) months_due++;
    if (c.state === 'paid' || (c.due && c.paid_amount > 0.0001)) months_paid++;
    if (c.state === 'unpaid') months_unpaid++;
  }
  return {
    member_key: 'mk-1',
    applicant_name: 'TEST USER',
    policy_number: 'P1',
    exchange_subscriber_id: '',
    issuer_subscriber_id: '',
    agent_name: '',
    aor_bucket: '',
    current_policy_aor: '',
    ffm_app_ids: [],
    total_paid: Object.values(cells).reduce((s, c) => s + (c.paid_amount || 0), 0),
    months_due,
    months_paid,
    months_unpaid,
    rollup: 'partial' as any,
    needs_manual_review: Object.values(cells).some(c => c.state === 'manual_review'),
    hasUnpaidPlusNet: Object.values(cells).some(c => c.state === 'unpaid' && c.netBucket === '+Net'),
    hasUnpaidZeroNet: Object.values(cells).some(c => c.state === 'unpaid' && c.netBucket === '0Net'),
    ...over,
    cells,
  };
}

export interface MTRenderOpts {
  rows: MemberTimelineRow[];
  monthList?: string[];
}

let _currentRows: MemberTimelineRow[] = [];
let _currentMonthList: string[] = ['2026-01'];
let _resolverIndex: any = null;
let _lookupResolvedFn: (...args: any[]) => any = () => null;
let _mockStatementMonth: string | null = TEST_STATEMENT_MONTH;

export function setMockStatementMonth(statementMonth: string | null) { _mockStatementMonth = statementMonth; }

export function setMockRows(rows: MemberTimelineRow[], monthList?: string[]) {
  _currentRows = rows;
  if (monthList) _currentMonthList = monthList;
}

export function setMockResolverIndex(idx: any) { _resolverIndex = idx; }
export function setMockLookupResolved(fn: (...args: any[]) => any) { _lookupResolvedFn = fn; }
export function resetMTMockState() {
  _currentRows = [];
  _resolverIndex = null;
  _lookupResolvedFn = () => null;
  _mockStatementMonth = TEST_STATEMENT_MONTH;
}

export function getMockRows() { return _currentRows; }
export function getMockMonthList() { return _currentMonthList; }

/** Apply standard mocks. Call this once in each test file BEFORE importing the page. */
export function applyMTMocks(vi: any) {
  vi.mock('@/contexts/BatchContext', () => ({
    useBatch: () => ({
      batches: [{ id: TEST_BATCH_ID, statement_month: _mockStatementMonth }],
      currentBatchId: TEST_BATCH_ID,
      setCurrentBatchId: () => {},
      reconciled: [],
      uploadedFiles: [],
      counts: { uploadedFiles: 0, normalizedRecords: 0, reconciledMembers: 0 },
      debugStats: null,
      resolverIndex: _resolverIndex,
      refreshBatches: async () => {},
      refreshReconciled: async () => {},
      refreshFiles: async () => {},
      refreshAll: async () => {},
      refreshResolverIndex: async () => {},
      loading: false,
      reconciledLoadedForBatchId: TEST_BATCH_ID,
    }),
  }));

  vi.mock('@/components/BatchSelector', () => ({
    BatchSelector: () => null,
  }));

  vi.mock('@/lib/persistence', async (importOrig: any) => {
    const actual = await importOrig();
    return {
      ...actual,
      getNormalizedRecords: vi.fn(async () => []),
      getAllNormalizedRecordsForMemberTimeline: vi.fn(async () => []),
    };
  });

  vi.mock('@/hooks/useBatchDataVersion', () => ({
    useBatchDataVersion: () => 0,
    useAllBatchesDataVersion: () => 0,
  }));

  vi.mock('@/lib/resolvedIdentities', () => ({
    lookupResolved: (...args: any[]) => _lookupResolvedFn(...args),
    loadResolverIndex: async () => null,
  }));

  vi.mock('@/lib/canonical/memberKeyMerge', () => ({
    mergeRecordsToMemberKeys: () => {},
  }));

  // Mock the assembly: return our canned rows. Real renderer + real
  // classifier no-op (empty records → classifiedRows pass-through).
  vi.mock('@/lib/memberTimeline', async (importOrig: any) => {
    const actual = await importOrig();
    return {
      ...actual,
      buildMemberTimeline: () => _currentRows,
      buildMonthList: (s: string, e: string) =>
        _currentMonthList.length > 0 ? _currentMonthList : actual.buildMonthList(s, e),
    };
  });
}

export async function renderMTPage(): Promise<RenderResult> {
  const mod = await import('@/pages/MemberTimelinePage');
  const Page = mod.default;
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<Page />} />
      </Routes>
    </MemoryRouter>,
  );
}
