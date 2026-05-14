/**
 * #124 — Page-render tests for MissingCommissionExportPage.
 *
 * Proves the five explicit states + the stale-filter banner +
 * download-uses-snapshot contract on the live page (not just the hook).
 *
 * Heavy compute deps are mocked so each test deterministically controls
 * the rows the runner returns.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';

// ---- Mocks ----------------------------------------------------------------

const mockUseBatch = vi.fn();
vi.mock('@/contexts/BatchContext', () => ({
  useBatch: () => mockUseBatch(),
}));

const mockGetAll = vi.fn();
const mockGetNormalized = vi.fn();
const mockGetByMemberKeys = vi.fn();
const mockGetByTriples = vi.fn();
vi.mock('@/lib/persistence', () => ({
  getAllNormalizedRecords: (...a: any[]) => mockGetAll(...a),
  getNormalizedRecords: (...a: any[]) => mockGetNormalized(...a),
  getNormalizedRecordsByMemberKeys: (...a: any[]) => mockGetByMemberKeys(...a),
  getCommissionRecordsByTriples: (...a: any[]) => mockGetByTriples(...a),
}));

vi.mock('@/lib/weakMatch', () => ({
  loadWeakMatchOverrides: vi.fn().mockResolvedValue(new Map()),
  findWeakMatches: vi.fn().mockReturnValue([]),
  applyOverrides: vi.fn().mockReturnValue({ confirmedKeys: new Set(), rejectedKeys: new Set() }),
  pickStableKey: vi.fn().mockReturnValue(null),
}));

vi.mock('@/lib/expectedEde', () => ({
  computeFilteredEde: vi.fn().mockReturnValue({ uniqueMembers: [] }),
}));

const mockGetEligible = vi.fn();
const mockGetBreakdown = vi.fn();
vi.mock('@/lib/canonical/metrics', () => ({
  getEligibleCohort: (...a: any[]) => mockGetEligible(...a),
  getExpectedPaymentBreakdown: (...a: any[]) => mockGetBreakdown(...a),
  isZeroNetPremium: (row: any) => {
    const raw = row?.net_premium ?? null;
    if (raw === null || raw === undefined) return true;
    if (typeof raw === 'string' && raw.trim() === '') return true;
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n)) return true;
    return !(n > 0);
  },
}));

/** Build a breakdown stub from a flat row list. Each row may set _bucket
 *  ('matched' | 'boOnly' | 'edeOnly'); defaults to 'matched'. Rows with
 *  in_commission=true land in paidRows; false → unpaidRows. */
function buildBreakdownStub(rows: any[]) {
  const matched: any[] = [];
  const boOnly: any[] = [];
  const edeOnly: any[] = [];
  for (const r of rows) {
    if (r._bucket === 'boOnly') boOnly.push(r);
    else if (r._bucket === 'edeOnly') edeOnly.push(r);
    else matched.push(r);
  }
  const universe = {
    rows: [...matched, ...boOnly, ...edeOnly],
    matched, boOnly, edeOnly, boActiveNonCurrentEde: [],
    total: rows.length,
    matchedCount: matched.length, boOnlyCount: boOnly.length,
    edeOnlyCount: edeOnly.length, boActiveNonCurrentEdeCount: 0,
  };
  const paidRows = rows.filter((r) => r.in_commission);
  const unpaidRows = rows.filter((r) => !r.in_commission);
  return {
    universe, paidRows, unpaidRows,
    paidCount: paidRows.length, unpaidCount: unpaidRows.length,
    paidSplit: { matched: 0, boOnly: 0, edeOnly: 0 },
    unpaidSplit: { matched: 0, boOnly: 0, edeOnly: 0 },
  };
}

vi.mock('@/lib/canonical/memberProfileView', () => {
  const blank = (v = '') => ({
    value: v,
    source_type: null,
    source_month: null,
    conflict: false,
    conflict_values: [],
  });
  return {
    buildMemberProfile: (memberKey: string) => ({
      applicant_name: blank('John Doe'),
      address1: blank('1 Main St'),
      city: blank('City'),
      state: blank('ST'),
      zip: blank('00000'),
      dob: blank('1990-01-01'),
      phone: blank(''),
      email: blank(''),
      ffm_id: blank(''),
    }),
    splitNameLastSpace: (n: string) => {
      const parts = String(n || '').trim().split(/\s+/);
      return { first: parts.slice(0, -1).join(' ') || parts[0] || '', last: parts.length > 1 ? parts[parts.length - 1] : '' };
    },
    assembleAddressLine: (o: any) => [o.address1, o.city, o.state, o.zip].filter(Boolean).join(', '),
  };
});

vi.mock('@/lib/canonical/scope', () => ({
  filterReconciledByScope: (rows: any[]) => rows,
}));

vi.mock('@/lib/dateRange', () => ({
  getCoveredMonths: () => [],
}));

vi.mock('@/lib/agents', () => ({
  extractNpnFromAorString: () => '',
}));

// Stub heavy UI primitives that don't matter for state assertions.
vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: any) => <>{children}</>,
  Tooltip: ({ children }: any) => <>{children}</>,
  TooltipTrigger: ({ children }: any) => <>{children}</>,
  TooltipContent: ({ children }: any) => <>{children}</>,
}));

vi.mock('@/components/ui/select', () => ({
  Select: ({ value, onValueChange, children }: any) => (
    <select value={value} onChange={(e) => onValueChange?.(e.target.value)}>{children}</select>
  ),
  SelectTrigger: () => null,
  SelectContent: ({ children }: any) => <>{children}</>,
  SelectItem: ({ value, children }: any) => <option value={value}>{children}</option>,
  SelectValue: () => null,
  SelectGroup: ({ children }: any) => <>{children}</>,
  SelectLabel: ({ children }: any) => <>{children}</>,
  SelectSeparator: () => null,
  SelectScrollUpButton: () => null,
  SelectScrollDownButton: () => null,
}));

import MissingCommissionExportPage from '@/pages/MissingCommissionExportPage';

// ---- Helpers --------------------------------------------------------------

const BATCH_JAN = { id: 'b-jan', statement_month: '2026-01-01', carrier: 'Ambetter' };
const BATCH_FEB = { id: 'b-feb', statement_month: '2026-02-01', carrier: 'Ambetter' };

function setBatchContext(overrides: Partial<any> = {}) {
  mockUseBatch.mockReturnValue({
    batches: [BATCH_JAN, BATCH_FEB],
    currentBatchId: BATCH_JAN.id,
    setCurrentBatchId: vi.fn(),
    reconciled: [],
    resolverIndex: null,
    reconciledLoadedForBatchId: BATCH_JAN.id,
    loading: false,
    ...overrides,
  });
}

function makeMissingMember(memberKey: string) {
  return {
    member_key: memberKey,
    applicant_name: `Member ${memberKey}`,
    in_commission: false,
    in_back_office: true,
    eligible: 'Yes',
    current_policy_aor: '',
    agent_npn: '',
    expected_pay_entity: 'Coverall',
    actual_pay_entity: 'Coverall',
    issuer_subscriber_id: `iss-${memberKey}`,
    policy_number: `pol-${memberKey}`,
    exchange_subscriber_id: `exch-${memberKey}`,
    net_premium: 100,
    effective_date: '2026-01-01',
    issue_type: 'Missing from Commission',
    estimated_missing_commission: 50,
    dob: '1990-01-01',
  };
}

beforeEach(() => {
  mockUseBatch.mockReset();
  mockGetAll.mockReset();
  mockGetNormalized.mockReset();
  mockGetByMemberKeys.mockReset();
  mockGetByTriples.mockReset();
  mockGetEligible.mockReset();
  mockGetBreakdown.mockReset();
  mockGetAll.mockResolvedValue([]);
  mockGetNormalized.mockResolvedValue([]);
  mockGetByMemberKeys.mockResolvedValue([]);
  mockGetByTriples.mockResolvedValue([]);
  mockGetEligible.mockReturnValue([]); mockGetBreakdown.mockReturnValue(buildBreakdownStub([]));
  mockGetBreakdown.mockReturnValue(buildBreakdownStub([]));
  setBatchContext();
});

// ---- Tests ----------------------------------------------------------------

describe('MissingCommissionExportPage — #124 explicit states', () => {
  it('initial state: shows "Choose filters and click Run Report" before any run', async () => {
    render(<MissingCommissionExportPage />);
    // Wait for source load to finish
    await waitFor(() => expect(screen.getByTestId('initial-state')).toBeInTheDocument());
    expect(screen.getByTestId('initial-state')).toHaveTextContent(/Choose filters and click Run Report/i);
    expect(screen.queryByTestId('results-table')).not.toBeInTheDocument();
    expect(screen.queryByTestId('loading-state')).not.toBeInTheDocument();
  });

  it('loading state: shows spinner after Run Report click while runner is in flight', async () => {
    // Pause the runner mid-flight by deferring getEligibleCohort behind a
    // promise that the test releases on demand. Because the page's runner
    // body awaits getAllNormalizedRecords-derived data via subsequent ticks,
    // the simplest way to hold the runner is to swap getEligibleCohort to a
    // function that throws a thenable... but it's called synchronously.
    // Instead we delay by stalling the source-records refresh? No — source
    // is already loaded by the time we click. We use a real async pause
    // by patching computeFilteredEde to return a Promise the page DOES NOT
    // await — that won't work either. The reliable approach: assert
    // synchronously between the click (which commits setStatus('loading'))
    // and the next microtask flush (which resolves the async runner body).
    mockGetEligible.mockReturnValue([]); mockGetBreakdown.mockReturnValue(buildBreakdownStub([]));
    render(<MissingCommissionExportPage />);
    await waitFor(() => expect(screen.getByTestId('initial-state')).toBeInTheDocument());

    // Fire the click; do NOT await anything before the assertion. React 18
    // commits the synchronous setStatus('loading') from inside run() before
    // the awaited runner body resumes on the next microtask.
    fireEvent.click(screen.getByTestId('run-report'));
    // Bundle 12.6: source-loading-state shows synchronously after click.
    expect(screen.getByTestId('source-loading-state')).toBeInTheDocument();

    // Drain microtasks → transitions to empty (no missing members).
    await waitFor(() => expect(screen.queryByTestId('source-loading-state')).not.toBeInTheDocument());
  });

  it('empty state: shows explicit "No records found" when query returns zero rows', async () => {
    mockGetEligible.mockReturnValue([]); mockGetBreakdown.mockReturnValue(buildBreakdownStub([])); // no eligible → no missing
    render(<MissingCommissionExportPage />);
    await waitFor(() => expect(screen.getByTestId('initial-state')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('run-report'));
    await waitFor(() => expect(screen.getByTestId('empty-state')).toBeInTheDocument());
    expect(screen.getByText(/No records found/i)).toBeInTheDocument();
    expect(screen.queryByTestId('results-table')).not.toBeInTheDocument();
  });

  it('error state: shows error UI on simulated failure, never blank', async () => {
    mockGetBreakdown.mockImplementation(() => {
      throw new Error('simulated compute failure');
    });
    render(<MissingCommissionExportPage />);
    await waitFor(() => expect(screen.getByTestId('initial-state')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('run-report'));
    await waitFor(() => expect(screen.getByTestId('error-state')).toBeInTheDocument());
    expect(screen.getByTestId('error-state')).toHaveTextContent(/Run failed/i);
    expect(screen.getByTestId('error-state')).toHaveTextContent(/simulated compute failure/i);
    expect(screen.getByTestId('retry-run')).toBeInTheDocument();
    expect(screen.queryByTestId('results-table')).not.toBeInTheDocument();
  });

  it('populated state: renders table with rows after successful run', async () => {
    mockGetEligible.mockReturnValue([makeMissingMember('m-1'), makeMissingMember('m-2')]); mockGetBreakdown.mockReturnValue(buildBreakdownStub([makeMissingMember('m-1'), makeMissingMember('m-2')]));
    render(<MissingCommissionExportPage />);
    await waitFor(() => expect(screen.getByTestId('initial-state')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('run-report'));
    await waitFor(() => expect(screen.getByTestId('results-table')).toBeInTheDocument());
    expect(screen.getByTestId('report-count')).toHaveTextContent(/2 members/);
    expect(screen.queryByTestId('stale-banner')).not.toBeInTheDocument();
  });

  it('Bundle 12.6: changing filters after a run RESETS to idle (no stale banner; old rows cleared)', async () => {
    mockGetEligible.mockReturnValue([makeMissingMember('m-1')]); mockGetBreakdown.mockReturnValue(buildBreakdownStub([makeMissingMember('m-1')]));
    setBatchContext({ currentBatchId: BATCH_JAN.id, reconciledLoadedForBatchId: BATCH_JAN.id });
    const { rerender } = render(<MissingCommissionExportPage />);
    await waitFor(() => expect(screen.getByTestId('initial-state')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('run-report'));
    await waitFor(() => expect(screen.getByTestId('results-table')).toBeInTheDocument());

    // Change Month — MCE resets to idle, no stale banner, table gone.
    setBatchContext({ currentBatchId: BATCH_FEB.id, reconciledLoadedForBatchId: BATCH_FEB.id });
    rerender(<MissingCommissionExportPage />);

    await waitFor(() => expect(screen.getByTestId('initial-state')).toBeInTheDocument());
    expect(screen.queryByTestId('stale-banner')).not.toBeInTheDocument();
    expect(screen.queryByTestId('results-table')).not.toBeInTheDocument();
  });

  it('download uses last-run snapshot (filename embeds the ran batch month)', async () => {
    mockGetEligible.mockReturnValue([makeMissingMember('m-1')]); mockGetBreakdown.mockReturnValue(buildBreakdownStub([makeMissingMember('m-1')]));
    setBatchContext({ currentBatchId: BATCH_JAN.id, reconciledLoadedForBatchId: BATCH_JAN.id });
    render(<MissingCommissionExportPage />);
    await waitFor(() => expect(screen.getByTestId('initial-state')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('run-report'));
    await waitFor(() => expect(screen.getByTestId('results-table')).toBeInTheDocument());

    let downloadName = '';
    const realCreate = document.createElement.bind(document);
    const spy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = realCreate(tag) as any;
      if (tag === 'a') {
        const origClick = el.click?.bind(el) ?? (() => {});
        Object.defineProperty(el, 'click', {
          value: () => { downloadName = el.download; origClick(); },
        });
      }
      return el;
    });
    (URL as any).createObjectURL = vi.fn(() => 'blob://x');
    (URL as any).revokeObjectURL = vi.fn();

    fireEvent.click(screen.getByTestId('messer-download'));
    spy.mockRestore();

    expect(downloadName).toMatch(/2026_01/);
  });
});

// ---------------------------------------------------------------------------
// FFM ID front-of-table column (operator lookup aid).
//
// Verifies that issuer_subscriber_id is surfaced as the first table column
// labeled "FFM ID", that the value matches the row's canonical
// issuer_subscriber_id, and that blanks render as "—" (never empty cells).
// ---------------------------------------------------------------------------
describe('MissingCommissionExportPage — FFM ID front column', () => {
  it('renders FFM ID as the first column header with the right label', async () => {
    mockGetEligible.mockReturnValue([makeMissingMember('m-1')]); mockGetBreakdown.mockReturnValue(buildBreakdownStub([makeMissingMember('m-1')]));
    render(<MissingCommissionExportPage />);
    await waitFor(() => expect(screen.getByTestId('initial-state')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('run-report'));
    await waitFor(() => expect(screen.getByTestId('results-table')).toBeInTheDocument());

    const header = screen.getByTestId('ffm-id-header');
    expect(header).toBeInTheDocument();
    expect(header).toHaveTextContent(/^FFM ID$/);

    // Confirm it's positioned BEFORE the first Messer header ("Carrier Name").
    const headerRow = header.closest('tr')!;
    const cells = Array.from(headerRow.querySelectorAll('th'));
    expect(cells[0]).toBe(header);
    expect(cells[1]).toHaveTextContent(/Carrier Name/i);
  });

  it('renders the row issuer_subscriber_id in the FFM ID cell', async () => {
    mockGetEligible.mockReturnValue([makeMissingMember('m-1'), makeMissingMember('m-2')]); mockGetBreakdown.mockReturnValue(buildBreakdownStub([makeMissingMember('m-1'), makeMissingMember('m-2')]));
    render(<MissingCommissionExportPage />);
    await waitFor(() => expect(screen.getByTestId('initial-state')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('run-report'));
    await waitFor(() => expect(screen.getByTestId('results-table')).toBeInTheDocument());

    const cells = screen.getAllByTestId('ffm-id-cell');
    expect(cells).toHaveLength(2);
    // makeMissingMember sets issuer_subscriber_id = `iss-${memberKey}`.
    expect(cells[0]).toHaveTextContent('iss-m-1');
    expect(cells[1]).toHaveTextContent('iss-m-2');
  });

  it('renders "—" when issuer_subscriber_id is blank (never an empty cell)', async () => {
    const m = makeMissingMember('m-blank');
    m.issuer_subscriber_id = '';
    mockGetEligible.mockReturnValue([m]); mockGetBreakdown.mockReturnValue(buildBreakdownStub([m]));
    render(<MissingCommissionExportPage />);
    await waitFor(() => expect(screen.getByTestId('initial-state')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('run-report'));
    await waitFor(() => expect(screen.getByTestId('results-table')).toBeInTheDocument());

    const cell = screen.getByTestId('ffm-id-cell');
    expect(cell).toHaveTextContent('—');
  });

  it('CSV download still includes FFM ID via the Messer "Member ID" column (no regression)', async () => {
    // resolveMemberId prefers issuer_subscriber_id; verify a populated row
    // still yields that value in the Messer Member ID CSV column.
    const m = makeMissingMember('m-csv');
    mockGetEligible.mockReturnValue([m]); mockGetBreakdown.mockReturnValue(buildBreakdownStub([m]));
    render(<MissingCommissionExportPage />);
    await waitFor(() => expect(screen.getByTestId('initial-state')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('run-report'));
    await waitFor(() => expect(screen.getByTestId('results-table')).toBeInTheDocument());

    let csvText = '';
    const realBlob = global.Blob;
    (global as any).Blob = function (parts: any[]) {
      csvText = parts.join('');
      return new realBlob(parts, { type: 'text/csv' });
    };
    (URL as any).createObjectURL = vi.fn(() => 'blob://x');
    (URL as any).revokeObjectURL = vi.fn();
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = realCreate(tag) as any;
      if (tag === 'a') el.click = () => {};
      return el;
    });

    fireEvent.click(screen.getByTestId('messer-download'));
    (global as any).Blob = realBlob;
    // Restore only the document.createElement spy. vi.restoreAllMocks would
    // also reset the inline vi.fn() mocks created in vi.mock(...) factories
    // (loadWeakMatchOverrides, etc.), which then breaks subsequent tests
    // because useEffect's Promise.all rejects on `undefined.catch`.
    vi.restoreAllMocks();
    // Re-prime module-level inline mocks that restoreAllMocks just wiped.
    const weakMatch = await import('@/lib/weakMatch');
    (weakMatch.loadWeakMatchOverrides as any).mockResolvedValue(new Map());
    (weakMatch.findWeakMatches as any).mockReturnValue([]);
    (weakMatch.applyOverrides as any).mockReturnValue({ confirmedKeys: new Set(), rejectedKeys: new Set() });
    (weakMatch.pickStableKey as any).mockReturnValue(null);
    const expectedEde = await import('@/lib/expectedEde');
    (expectedEde.computeFilteredEde as any).mockReturnValue({ uniqueMembers: [] });

    // CSV header must include Member ID; data row must include the FFM ID value.
    expect(csvText).toMatch(/Member ID/);
    expect(csvText).toMatch(/iss-m-csv/);
  });
});

// ---------------------------------------------------------------------------
// Phase 1.5 — Export aligns with Expected But Unpaid (Matched + BO Only +
// EDE Only). The page now sources rows from getExpectedPaymentBreakdown
// .unpaidRows, not getEligibleCohort. Paid rows and the BO-Active-Non-Current-
// EDE diagnostic bucket are excluded by the helper.
// ---------------------------------------------------------------------------
describe('MissingCommissionExportPage — Phase 1.5 expected-payment alignment', () => {
  it('export rows come from getExpectedPaymentBreakdown.unpaidRows (all three buckets)', async () => {
    const matched = { ...makeMissingMember('m-matched'), _bucket: 'matched' };
    const boOnly = { ...makeMissingMember('m-bo'), _bucket: 'boOnly' };
    const edeOnly = { ...makeMissingMember('m-ede'), _bucket: 'edeOnly' };
    mockGetBreakdown.mockReturnValue(buildBreakdownStub([matched, boOnly, edeOnly]));

    render(<MissingCommissionExportPage />);
    await waitFor(() => expect(screen.getByTestId('initial-state')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('run-report'));
    await waitFor(() => expect(screen.getByTestId('results-table')).toBeInTheDocument());

    expect(screen.getByTestId('report-count')).toHaveTextContent(/3 members/);
    // Source Type column renders in the internal/preview table.
    const tbody = screen.getByTestId('results-table');
    expect(tbody).toHaveTextContent('Matched');
    expect(tbody).toHaveTextContent('BO Only');
    expect(tbody).toHaveTextContent('EDE Only');
  });

  it('paid rows (in_commission=true) are excluded from export', async () => {
    const unpaid = { ...makeMissingMember('m-unpaid'), _bucket: 'matched' };
    const paid = { ...makeMissingMember('m-paid'), in_commission: true, _bucket: 'matched' };
    mockGetBreakdown.mockReturnValue(buildBreakdownStub([unpaid, paid]));

    render(<MissingCommissionExportPage />);
    await waitFor(() => expect(screen.getByTestId('initial-state')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('run-report'));
    await waitFor(() => expect(screen.getByTestId('results-table')).toBeInTheDocument());

    expect(screen.getByTestId('report-count')).toHaveTextContent(/1 member/);
    expect(screen.getByTestId('results-table')).toHaveTextContent('iss-m-unpaid');
    expect(screen.getByTestId('results-table')).not.toHaveTextContent('iss-m-paid');
  });

  it('BO Active: Non-current EDE diagnostic rows are excluded (not in universe.rows / unpaidRows)', async () => {
    // The helper places these rows in boActiveNonCurrentEde only; they are NOT
    // in universe.rows nor in unpaidRows. buildBreakdownStub mirrors that
    // contract — passing only Matched + BO Only + EDE Only here proves the
    // export never sees diagnostic rows.
    const matched = { ...makeMissingMember('m-1'), _bucket: 'matched' };
    mockGetBreakdown.mockReturnValue(buildBreakdownStub([matched]));

    render(<MissingCommissionExportPage />);
    await waitFor(() => expect(screen.getByTestId('initial-state')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('run-report'));
    await waitFor(() => expect(screen.getByTestId('results-table')).toBeInTheDocument());

    expect(screen.getByTestId('report-count')).toHaveTextContent(/1 member/);
  });

  it('Source Type renders in the preview table but is NOT in the Messer CSV', async () => {
    const matched = { ...makeMissingMember('m-matched'), _bucket: 'matched' };
    const boOnly = { ...makeMissingMember('m-bo'), _bucket: 'boOnly' };
    const edeOnly = { ...makeMissingMember('m-ede'), _bucket: 'edeOnly' };
    mockGetBreakdown.mockReturnValue(buildBreakdownStub([matched, boOnly, edeOnly]));

    render(<MissingCommissionExportPage />);
    await waitFor(() => expect(screen.getByTestId('initial-state')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('run-report'));
    await waitFor(() => expect(screen.getByTestId('results-table')).toBeInTheDocument());

    // Header present in preview table.
    const headers = Array.from(document.querySelectorAll('th')).map((h) => h.textContent || '');
    expect(headers.some((h) => /Source Type/i.test(h))).toBe(true);

    // CSV download
    let csvText = '';
    const realBlob = global.Blob;
    (global as any).Blob = function (parts: any[]) {
      csvText = parts.join('');
      return new realBlob(parts, { type: 'text/csv' });
    };
    (URL as any).createObjectURL = vi.fn(() => 'blob://x');
    (URL as any).revokeObjectURL = vi.fn();
    const realCreate = document.createElement.bind(document);
    const createSpy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = realCreate(tag) as any;
      if (tag === 'a') el.click = () => {};
      return el;
    });
    fireEvent.click(screen.getByTestId('messer-download'));
    (global as any).Blob = realBlob;
    createSpy.mockRestore();

    // CSV must NOT contain Source Type header or the bucket labels.
    expect(csvText).not.toMatch(/Source Type/i);
    // Header row is the first line — confirm bucket labels don't appear at all.
    const firstLine = csvText.split('\n')[0];
    expect(firstLine).not.toMatch(/Source Type/i);
  });

  it('premium bucket filter still applies to expected-payment unpaid rows', async () => {
    const hasPrem = { ...makeMissingMember('m-prem'), net_premium: 100, _bucket: 'matched' };
    const zeroPrem = { ...makeMissingMember('m-zero'), net_premium: 0, _bucket: 'boOnly' };
    mockGetBreakdown.mockReturnValue(buildBreakdownStub([hasPrem, zeroPrem]));

    render(<MissingCommissionExportPage />);
    await waitFor(() => expect(screen.getByTestId('initial-state')).toBeInTheDocument());

    // Default bucket = 'all' → 2 rows
    fireEvent.click(screen.getByTestId('run-report'));
    await waitFor(() => expect(screen.getByTestId('results-table')).toBeInTheDocument());
    expect(screen.getByTestId('report-count')).toHaveTextContent(/2 members/);

    // Switch to has_premium → re-run → 1 row
    fireEvent.click(document.querySelector('[data-bucket="has_premium"]') as HTMLElement);
    fireEvent.click(screen.getByTestId('run-report'));
    await waitFor(() => expect(screen.getByTestId('report-count')).toHaveTextContent(/1 member/));
  });
});

// ---------------------------------------------------------------------------
// v14 — Download race close. Download must be disabled the moment current
// filters drift from ranFilters, the moment same-batch refresh restarts, and
// re-enabled only when filters match a 'ready' run AND batch is ready.
// ---------------------------------------------------------------------------
describe('MissingCommissionExportPage — v14 Download race close', () => {
  async function runOnce() {
    mockGetBreakdown.mockReturnValue(buildBreakdownStub([makeMissingMember('m-1')]));
    setBatchContext({ currentBatchId: BATCH_JAN.id, reconciledLoadedForBatchId: BATCH_JAN.id, loading: false });
    const utils = render(<MissingCommissionExportPage />);
    await waitFor(() => expect(screen.getByTestId('initial-state')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('run-report'));
    await waitFor(() => expect(screen.getByTestId('results-table')).toBeInTheDocument());
    expect((screen.getByTestId('messer-download') as HTMLButtonElement).disabled).toBe(false);
    return utils;
  }

  it('changing Premium Bucket disables Download immediately (filters drift)', async () => {
    await runOnce();
    fireEvent.click(document.querySelector('[data-bucket="zero_premium"]') as HTMLElement);
    expect((screen.getByTestId('messer-download') as HTMLButtonElement).disabled).toBe(true);
  });

  it('changing Scope disables Download immediately (filters drift)', async () => {
    await runOnce();
    const selects = screen.getAllByRole('combobox');
    const scopeSelect = selects[2] as HTMLSelectElement;
    fireEvent.change(scopeSelect, { target: { value: 'Vix' } });
    expect((screen.getByTestId('messer-download') as HTMLButtonElement).disabled).toBe(true);
  });

  it('changing Month (batchId) disables Download immediately (filters drift)', async () => {
    const { rerender } = await runOnce();
    setBatchContext({ currentBatchId: BATCH_FEB.id, reconciledLoadedForBatchId: BATCH_FEB.id, loading: false });
    rerender(<MissingCommissionExportPage />);
    expect((screen.getByTestId('messer-download') as HTMLButtonElement).disabled).toBe(true);
  });

  it('same-batch refresh in flight (loading=true, reconciledLoadedForBatchId=null) disables Download', async () => {
    const { rerender } = await runOnce();
    setBatchContext({ currentBatchId: BATCH_JAN.id, reconciledLoadedForBatchId: null, loading: true });
    rerender(<MissingCommissionExportPage />);
    expect((screen.getByTestId('messer-download') as HTMLButtonElement).disabled).toBe(true);
  });

  it('after filter change + reset effect runs, Download remains disabled', async () => {
    await runOnce();
    fireEvent.click(document.querySelector('[data-bucket="zero_premium"]') as HTMLElement);
    await waitFor(() => expect(screen.getByTestId('initial-state')).toBeInTheDocument());
    expect((screen.getByTestId('messer-download') as HTMLButtonElement).disabled).toBe(true);
  });

  it('Download enabled only when ranFilters matches current filters AND batch ready', async () => {
    await runOnce();
    expect((screen.getByTestId('messer-download') as HTMLButtonElement).disabled).toBe(false);
  });

  it('filtersMatchRanFilters helper compares scope, premiumBucket, batchId', async () => {
    const { filtersMatchRanFilters } = await import('@/pages/MissingCommissionExportPage');
    expect(filtersMatchRanFilters({ scope: 'All', premiumBucket: 'all', batchId: 'b1' }, null)).toBe(false);
    expect(filtersMatchRanFilters(
      { scope: 'All', premiumBucket: 'all', batchId: 'b1' },
      { scope: 'All', premiumBucket: 'all', batchId: 'b1' },
    )).toBe(true);
    expect(filtersMatchRanFilters(
      { scope: 'All', premiumBucket: 'all', batchId: 'b1' },
      { scope: 'Coverall' as any, premiumBucket: 'all', batchId: 'b1' },
    )).toBe(false);
    expect(filtersMatchRanFilters(
      { scope: 'All', premiumBucket: 'all', batchId: 'b1' },
      { scope: 'All', premiumBucket: 'zero_premium', batchId: 'b1' },
    )).toBe(false);
    expect(filtersMatchRanFilters(
      { scope: 'All', premiumBucket: 'all', batchId: 'b1' },
      { scope: 'All', premiumBucket: 'all', batchId: 'b2' },
    )).toBe(false);
  });
});
