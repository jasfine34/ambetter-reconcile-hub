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
vi.mock('@/lib/persistence', () => ({
  getAllNormalizedRecords: (...a: any[]) => mockGetAll(...a),
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
vi.mock('@/lib/canonical/metrics', () => ({
  getEligibleCohort: (...a: any[]) => mockGetEligible(...a),
}));

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
  mockGetEligible.mockReset();
  mockGetAll.mockResolvedValue([]);
  mockGetEligible.mockReturnValue([]);
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
    let releaseRun: () => void = () => {};
    mockGetEligible.mockImplementation(() => {
      // Synchronous, but we delay the runner via a deferred promise on a different layer:
      // since computeFilteredEde is mocked sync, the runner itself is async (await runner()).
      // To pause we make getAllNormalizedRecords resolve, then use a microtask gap.
      return [];
    });
    // Block the inner runner by making an awaited dep slow: switch getEligibleCohort to throw a pause.
    let releaseEligible: (v: any[]) => void = () => {};
    const eligiblePromise = new Promise<any[]>((res) => { releaseEligible = res; });
    mockGetEligible.mockImplementation(() => {
      // Synchronously return [] — but we need an async pause inside the runner.
      // Easiest: hook into computeFilteredEde re-mock per-test.
      return [];
    });

    const { computeFilteredEde } = await import('@/lib/expectedEde');
    (computeFilteredEde as any).mockImplementationOnce(async () => {
      await eligiblePromise;
      return { uniqueMembers: [] };
    });

    render(<MissingCommissionExportPage />);
    await waitFor(() => expect(screen.getByTestId('initial-state')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('run-report'));
    // Loading state should appear
    await waitFor(() => expect(screen.getByTestId('loading-state')).toBeInTheDocument());
    expect(screen.getByTestId('loading-state')).toHaveTextContent(/Running report/i);

    await act(async () => { releaseEligible([]); });
    // After release, transitions to empty (no missing members)
    await waitFor(() => expect(screen.queryByTestId('loading-state')).not.toBeInTheDocument());
  });

  it('empty state: shows explicit "No records found" when query returns zero rows', async () => {
    mockGetEligible.mockReturnValue([]); // no eligible → no missing
    render(<MissingCommissionExportPage />);
    await waitFor(() => expect(screen.getByTestId('initial-state')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('run-report'));
    await waitFor(() => expect(screen.getByTestId('empty-state')).toBeInTheDocument());
    expect(screen.getByText(/No records found/i)).toBeInTheDocument();
    expect(screen.queryByTestId('results-table')).not.toBeInTheDocument();
  });

  it('error state: shows error UI on simulated failure, never blank', async () => {
    mockGetEligible.mockImplementation(() => {
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
    mockGetEligible.mockReturnValue([makeMissingMember('m-1'), makeMissingMember('m-2')]);
    render(<MissingCommissionExportPage />);
    await waitFor(() => expect(screen.getByTestId('initial-state')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('run-report'));
    await waitFor(() => expect(screen.getByTestId('results-table')).toBeInTheDocument());
    expect(screen.getByTestId('report-count')).toHaveTextContent(/2 members/);
    expect(screen.queryByTestId('stale-banner')).not.toBeInTheDocument();
  });

  it('stale-filter state: changing filters after a run shows stale banner; old rows remain visible', async () => {
    mockGetEligible.mockReturnValue([makeMissingMember('m-1')]);
    // Render once to capture props, then we'll re-render with a mutated currentBatchId.
    setBatchContext({ currentBatchId: BATCH_JAN.id });
    const { rerender } = render(<MissingCommissionExportPage />);
    await waitFor(() => expect(screen.getByTestId('initial-state')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('run-report'));
    await waitFor(() => expect(screen.getByTestId('results-table')).toBeInTheDocument());

    // Change filters — flip currentBatchId via the context mock and re-render
    setBatchContext({ currentBatchId: BATCH_FEB.id });
    rerender(<MissingCommissionExportPage />);

    await waitFor(() => expect(screen.getByTestId('stale-banner')).toBeInTheDocument());
    // Old results still visible
    expect(screen.getByTestId('results-table')).toBeInTheDocument();
    expect(screen.getByTestId('run-report')).toHaveTextContent(/Re-run Report/i);
  });

  it('download uses last-run snapshot, not current edited filters', async () => {
    mockGetEligible.mockReturnValue([makeMissingMember('m-1')]);
    setBatchContext({ currentBatchId: BATCH_JAN.id });
    const { rerender } = render(<MissingCommissionExportPage />);
    await waitFor(() => expect(screen.getByTestId('initial-state')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('run-report'));
    await waitFor(() => expect(screen.getByTestId('results-table')).toBeInTheDocument());

    // Change filters to FEB after the run
    setBatchContext({ currentBatchId: BATCH_FEB.id });
    rerender(<MissingCommissionExportPage />);
    await waitFor(() => expect(screen.getByTestId('stale-banner')).toBeInTheDocument());

    // Capture filename via download anchor click
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
    // jsdom lacks URL.createObjectURL
    (URL as any).createObjectURL = vi.fn(() => 'blob://x');
    (URL as any).revokeObjectURL = vi.fn();

    fireEvent.click(screen.getByTestId('messer-download'));
    spy.mockRestore();

    // Filename embeds the SNAPSHOT batch month (2026_01), not the current FEB selection.
    expect(downloadName).toMatch(/2026_01/);
    expect(downloadName).not.toMatch(/2026_02/);
  });
});
