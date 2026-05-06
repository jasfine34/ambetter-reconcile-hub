/**
 * #125 — DashboardPage Run Invariants UI feedback (page-render coverage).
 *
 * Companion to invariants-runner-feedback.test.ts (which pins the runner
 * contract). This file pins the operator-visible behavior in the page:
 *
 *   1. Click "Run Invariants" → button shows "Running…" and is disabled.
 *   2. Completion → timestamp + aggregate summary render; button returns
 *      to its normal "Run Invariants" label.
 *   3. Re-run with same results → timestamp updates so the operator can
 *      tell the click executed again.
 *   4. Double-click while running → second click does not start an
 *      overlapping run (single-flight).
 *   5. A per-invariant runtime error renders distinctly from a logical
 *      fail (warning icon + "error" pill + message).
 *
 * Heavy compute / data dependencies are mocked so the page mounts
 * deterministically without DB or canonical math.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';

// ---- Mocks ----------------------------------------------------------------

const mockUseBatch = vi.fn();
vi.mock('@/contexts/BatchContext', () => ({
  useBatch: () => mockUseBatch(),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock('@/lib/persistence', () => ({
  getNormalizedRecords: vi.fn().mockResolvedValue([]),
  saveReconciledMembers: vi.fn().mockResolvedValue(undefined),
  saveAndVerifyReconciled: vi.fn().mockResolvedValue({ rowCount: 0 }),
}));

vi.mock('@/lib/reconcile', () => ({
  reconcile: vi.fn().mockReturnValue({ members: [] }),
}));

vi.mock('@/lib/expectedEde', () => ({
  computeFilteredEde: vi.fn().mockReturnValue({
    uniqueMembers: [],
    missingFromBO: [],
    byMonth: {},
    rowsByMonth: {},
    rowCount: 0,
  }),
}));

vi.mock('@/lib/weakMatch', () => ({
  findWeakMatches: vi.fn().mockReturnValue([]),
  loadWeakMatchOverrides: vi.fn().mockResolvedValue(new Map()),
  applyOverrides: vi.fn().mockReturnValue({
    confirmedKeys: new Set(),
    rejectedKeys: new Set(),
    pending: [],
  }),
  pickStableKey: vi.fn().mockReturnValue(''),
}));

vi.mock('@/lib/resolvedIdentities', () => ({
  runIdentityResolution: vi.fn().mockResolvedValue({}),
  invalidateResolverCache: vi.fn(),
  loadResolverIndex: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/rebuild', () => ({
  RECONCILE_LOGIC_VERSION: 'test-v1',
}));

vi.mock('@/lib/dateRange', () => ({
  getCoveredMonths: () => [],
  monthKeyToFirstOfMonth: (m: string) => `${m}-01`,
  fallbackReconcileMonth: () => '2026-01',
}));

vi.mock('@/lib/agents', () => ({
  isCoverallAORByName: () => false,
  isCoverallAORByNPN: () => false,
  COVERALL_NPN_SET: new Set<string>(),
}));

vi.mock('@/hooks/usePayEntityScope', () => ({
  usePayEntityScope: () => ['Coverall', vi.fn()],
  PAY_ENTITY_STORAGE_KEY: 'test-pay-entity',
}));

// Mock the runner so we control what each click resolves to. Mock the
// `invariants` source module — DashboardPage imports `runInvariants` via the
// `@/lib/canonical` barrel, which re-exports from this path.
const mockRunInvariants = vi.fn();
vi.mock('@/lib/canonical/invariants', () => ({
  runInvariants: (...args: any[]) => mockRunInvariants(...args),
}));

// Stub heavy child components that pull their own context.
vi.mock('@/components/BatchSelector', () => ({ BatchSelector: () => <div data-testid="batch-selector" /> }));
vi.mock('@/components/RebuildBatchButton', () => ({ RebuildBatchButton: () => <div /> }));
vi.mock('@/components/RebuildAllBatchesButton', () => ({ RebuildAllBatchesButton: () => <div /> }));
vi.mock('@/components/SourceFunnelCard', () => ({ SourceFunnelCard: () => <div /> }));
vi.mock('@/components/CollapsibleDebugCard', () => ({ CollapsibleDebugCard: () => <div /> }));
vi.mock('@/components/MetricCard', () => ({ MetricCard: ({ title }: any) => <div data-testid="metric-card">{title}</div> }));
vi.mock('@/components/DataTable', () => ({ DataTable: () => <div /> }));
vi.mock('@/components/ResolvedBadge', () => ({ ResolvedBadge: () => <div /> }));

// Stub tooltips so children always render.
vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: any) => <>{children}</>,
  Tooltip: ({ children }: any) => <>{children}</>,
  TooltipTrigger: ({ children }: any) => <>{children}</>,
  TooltipContent: ({ children }: any) => <>{children}</>,
}));

// Render Dialog children inline regardless of `open`.
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: any) => <div>{children}</div>,
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <div>{children}</div>,
  DialogDescription: ({ children }: any) => <div>{children}</div>,
  DialogFooter: ({ children }: any) => <div>{children}</div>,
}));

import DashboardPage from '@/pages/DashboardPage';

// ---- Helpers --------------------------------------------------------------

const BATCH = { id: 'b-1', label: '2026-01', statement_month: '2026-01-01', carrier: 'Ambetter' };

function setBatchContext(overrides: Partial<any> = {}) {
  mockUseBatch.mockReturnValue({
    batches: [BATCH],
    currentBatchId: BATCH.id,
    setCurrentBatchId: vi.fn(),
    reconciled: [
      // One row so the "Run Invariants" button is enabled.
      { member_key: 'm1', in_back_office: true, in_commission: true, eligible_for_commission: 'Yes' },
    ],
    uploadedFiles: [],
    counts: { uploadedFiles: 0, normalizedRecords: 0, reconciledMembers: 1 },
    debugStats: null,
    resolverIndex: null,
    refreshAll: vi.fn().mockResolvedValue(undefined),
    refreshBatches: vi.fn().mockResolvedValue(undefined),
    refreshReconciled: vi.fn().mockResolvedValue(undefined),
    refreshFiles: vi.fn().mockResolvedValue(undefined),
    refreshResolverIndex: vi.fn().mockResolvedValue(undefined),
    loading: false,
    ...overrides,
  });
}

const PASS_ROW = (id = 'inv-1') => ({
  id,
  label: `Invariant ${id}`,
  scope: 'Coverall' as const,
  status: 'pass' as const,
  detail: 'All good.',
});

const FAIL_ROW = (id = 'inv-fail') => ({
  id,
  label: `Invariant ${id}`,
  scope: 'Coverall' as const,
  status: 'fail' as const,
  detail: 'Numbers disagree.',
  expected: 10,
  actual: 8,
  delta: -2,
});

const ERROR_ROW = (id = 'inv-err') => ({
  id,
  label: `Invariant ${id}`,
  scope: 'Coverall' as const,
  status: 'error' as const,
  detail: 'Runtime error while evaluating invariant: kaboom',
});

beforeEach(() => {
  mockUseBatch.mockReset();
  mockRunInvariants.mockReset();
  setBatchContext();
});

function getRunInvariantsButton() {
  // The header has a Run Invariants button; the modal also has a Re-run
  // button. Find the header one by exact text match (or "Running…" while
  // executing). Prefer the first match (header).
  const candidates = screen
    .queryAllByRole('button')
    .filter((b) => /Run Invariants|Running…/.test(b.textContent || ''));
  return candidates[0];
}

// ---- Tests ----------------------------------------------------------------

describe('DashboardPage — #125 Run Invariants UI feedback', () => {
  it('click → button shows "Running…" and is disabled while in flight', async () => {
    mockRunInvariants.mockReturnValue([PASS_ROW('a'), PASS_ROW('b')]);
    render(<DashboardPage />);

    const btn = getRunInvariantsButton()!;
    expect(btn).toBeTruthy();
    expect(btn.textContent).toMatch(/Run Invariants/);
    expect(btn).not.toBeDisabled();

    // Click — executeInvariants flips invariantsRunning synchronously and
    // schedules the runner via setTimeout(0). Before timers advance, the
    // button must reflect the running state.
    act(() => {
      fireEvent.click(btn);
    });

    const runningBtn = getRunInvariantsButton()!;
    expect(runningBtn.textContent).toMatch(/Running…/);
    expect(runningBtn).toBeDisabled();

    // Advance the deferred runner.
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const afterBtn = getRunInvariantsButton()!;
    expect(afterBtn.textContent).toMatch(/Run Invariants/);
    expect(afterBtn).not.toBeDisabled();
  });

  it('completion → renders aggregate summary and timestamp', async () => {
    mockRunInvariants.mockReturnValue([PASS_ROW('a'), PASS_ROW('b'), PASS_ROW('c')]);
    render(<DashboardPage />);

    fireEvent.click(getRunInvariantsButton()!);
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const summary = await screen.findByTestId('invariants-summary');
    expect(summary.textContent).toMatch(/All 3 invariants passed/);
    expect(summary.textContent).toMatch(/Last run:/);
  });

  it('re-run with identical results updates the Last-run timestamp', async () => {
    mockRunInvariants.mockReturnValue([PASS_ROW('a')]);
    render(<DashboardPage />);

    fireEvent.click(getRunInvariantsButton()!);
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const firstSummary = screen.getByTestId('invariants-summary');
    const firstTs = firstSummary.querySelector('[title]')?.getAttribute('title');
    expect(firstTs).toBeTruthy();

    // Advance wall clock so the next `new Date()` is strictly later, then
    // re-click. Same results — only the timestamp should change.
    await act(async () => {
      vi.setSystemTime(new Date(Date.now() + 60_000));
    });

    fireEvent.click(getRunInvariantsButton()!);
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const secondTs = screen.getByTestId('invariants-summary').querySelector('[title]')?.getAttribute('title');
    expect(secondTs).toBeTruthy();
    expect(secondTs).not.toBe(firstTs);
    // Runner was invoked twice (no caching of "same result" suppression).
    expect(mockRunInvariants).toHaveBeenCalledTimes(2);
  });

  it('double-click while running does not start a second overlapping run', async () => {
    mockRunInvariants.mockReturnValue([PASS_ROW('a')]);
    render(<DashboardPage />);

    const btn = getRunInvariantsButton()!;
    // First click flips running=true; subsequent clicks must be ignored
    // (button is also disabled, but executeInvariants has its own guard).
    act(() => {
      fireEvent.click(btn);
      // Even if we forced a click on the (now disabled) node, the
      // executeInvariants single-flight guard should prevent re-entry.
      fireEvent.click(btn);
      fireEvent.click(btn);
    });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(mockRunInvariants).toHaveBeenCalledTimes(1);
  });

  it('per-invariant runtime error renders distinctly from a logical fail', async () => {
    mockRunInvariants.mockReturnValue([
      PASS_ROW('ok'),
      FAIL_ROW('logical-fail'),
      ERROR_ROW('runtime-err'),
    ]);
    render(<DashboardPage />);

    fireEvent.click(getRunInvariantsButton()!);
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // Aggregate summary partitions into pass/fail/error.
    const summary = await screen.findByTestId('invariants-summary');
    expect(summary.textContent).toMatch(/1 of 3 passed/);
    expect(summary.textContent).toMatch(/1 failed/);
    expect(summary.textContent).toMatch(/1 errored/);

    // Error row carries an "error" pill — fail row does NOT.
    const errRow = screen.getByTestId('invariant-runtime-err');
    expect(errRow.textContent).toMatch(/error/i);
    expect(errRow.textContent).toMatch(/Runtime error while evaluating invariant: kaboom/);

    const failRow = screen.getByTestId('invariant-logical-fail');
    // The pill text 'error' (uppercase 'ERROR' via CSS) should not appear in
    // the fail row's accessible text content as a standalone token.
    const failHasErrorPill = /\berror\b/i.test(failRow.textContent || '') &&
      !/Runtime error/.test(failRow.textContent || '');
    expect(failHasErrorPill).toBe(false);
    // Fail row still shows expected/actual/delta diagnostics.
    expect(failRow.textContent).toMatch(/expected:/);
    expect(failRow.textContent).toMatch(/actual:/);
    expect(failRow.textContent).toMatch(/delta:/);
  });
});
