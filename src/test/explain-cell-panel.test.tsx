/**
 * Stage 2 — Source-to-Screen Lineage debug panel UI tests.
 *
 * Coverage (per directive):
 *  1) Open on cell click
 *  2) Close via X button
 *  3) Close via Escape
 *  4) Close via click-outside (overlay)
 *  5) Close via navigation
 *  6) Update on next cell click (same panel instance)
 *  7) Binding contract — member-scoped records + per-member context
 *  8) Independence from debugOpen (panel opens with debugOpen=false)
 *  9) Display override divergence
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, Link } from 'react-router-dom';
import { useState } from 'react';
import {
  CellLineagePanel,
  useCellLineagePanel,
  type OpenLineageArgs,
} from '@/components/CellLineagePanel';
import type { CellTrace } from '@/lib/explainCellTypes';
import type { MonthCell } from '@/lib/memberTimeline';
import type { NormalizedRecord } from '@/lib/normalize';
import type { ClassifierContext } from '@/lib/classifier';

// ───────────────────────── fixtures ─────────────────────────

function makeMonthCell(overrides: Partial<MonthCell> = {}): MonthCell {
  return {
    month: '2026-01',
    in_ede: true,
    in_back_office: true,
    in_commission: false,
    paid_amount: 0,
    payment_count: 0,
    due: true,
    state: 'unpaid',
    state_reason: 'no commission row',
    ...overrides,
  };
}

function makeTrace(overrides: Partial<CellTrace> = {}): CellTrace {
  return {
    member: { memberKey: 'issub:u123', policyNumber: 'P123', name: 'TEST USER' },
    cell: { month: '2026-01', scope: 'All' },
    final: {
      state: 'unpaid',
      reason: 'no commission',
      chips: { in_ede: true, in_back_office: true, in_commission: false, paid_amount: 0 },
      badges: {},
    },
    helpers: [
      { name: 'hasReversalPairForMonth', output: { matched: false } },
    ],
    guards: [],
    firingRule: { name: 'R-UNPAID-001', reason: 'eligible, no commission row found' },
    scopedRows: [],
    ...overrides,
  };
}

// Small harness that drives openPanel via a button so tests can simulate
// "click a cell" without rendering the full MT page.
function Harness({
  filteredRecords,
  baseClassifierContext,
  pickerMapsByMemberKey,
  explainCellFn,
  cellA = { memberKey: 'issub:uA', monthKey: '2026-01', scope: 'All', monthCell: makeMonthCell() },
  cellB,
}: {
  filteredRecords: NormalizedRecord[];
  baseClassifierContext: ClassifierContext;
  pickerMapsByMemberKey: Map<string, Map<string, NormalizedRecord | null>>;
  explainCellFn: any;
  cellA?: OpenLineageArgs;
  cellB?: OpenLineageArgs;
}) {
  const { openPanel, panelProps } = useCellLineagePanel({
    filteredRecords,
    baseClassifierContext,
    pickerMapsByMemberKey,
    explainCellFn,
  });
  return (
    <div>
      <button data-testid="cell-A" onClick={() => openPanel(cellA)}>cell A</button>
      {cellB && (
        <button data-testid="cell-B" onClick={() => openPanel(cellB)}>cell B</button>
      )}
      <Link to="/elsewhere" data-testid="nav-link">go</Link>
      <CellLineagePanel {...panelProps} />
    </div>
  );
}

function renderWithRouter(ui: React.ReactNode) {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={ui} />
        <Route path="/elsewhere" element={<div>other page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

// ───────────────────────── tests ─────────────────────────

describe('CellLineagePanel — Stage 2 UI', () => {
  const ctx = {} as ClassifierContext;
  const pickerMap = new Map<string, Map<string, NormalizedRecord | null>>();

  it('1) opens on cell click', async () => {
    const explainCellFn = vi.fn().mockResolvedValue(makeTrace());
    renderWithRouter(
      <Harness filteredRecords={[]} baseClassifierContext={ctx} pickerMapsByMemberKey={pickerMap} explainCellFn={explainCellFn} />,
    );
    expect(screen.queryByTestId('cell-lineage-panel')).toBeNull();
    fireEvent.click(screen.getByTestId('cell-A'));
    await waitFor(() => expect(screen.getByTestId('cell-lineage-panel')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('R-UNPAID-001')).toBeInTheDocument());
  });

  it('2) closes via X button', async () => {
    const explainCellFn = vi.fn().mockResolvedValue(makeTrace());
    renderWithRouter(<Harness filteredRecords={[]} baseClassifierContext={ctx} pickerMapsByMemberKey={pickerMap} explainCellFn={explainCellFn} />);
    fireEvent.click(screen.getByTestId('cell-A'));
    await waitFor(() => screen.getByTestId('cell-lineage-panel'));
    // Radix Sheet renders the X with sr-only "Close" text.
    const closeBtn = screen.getByRole('button', { name: /close/i });
    fireEvent.click(closeBtn);
    await waitFor(() => expect(screen.queryByTestId('cell-lineage-panel')).toBeNull());
  });

  it('3) closes via Escape', async () => {
    const explainCellFn = vi.fn().mockResolvedValue(makeTrace());
    renderWithRouter(<Harness filteredRecords={[]} baseClassifierContext={ctx} pickerMapsByMemberKey={pickerMap} explainCellFn={explainCellFn} />);
    fireEvent.click(screen.getByTestId('cell-A'));
    await waitFor(() => screen.getByTestId('cell-lineage-panel'));
    fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('cell-lineage-panel')).toBeNull());
  });

  it('4) closes via click-outside (overlay)', async () => {
    const explainCellFn = vi.fn().mockResolvedValue(makeTrace());
    renderWithRouter(<Harness filteredRecords={[]} baseClassifierContext={ctx} pickerMapsByMemberKey={pickerMap} explainCellFn={explainCellFn} />);
    fireEvent.click(screen.getByTestId('cell-A'));
    await waitFor(() => screen.getByTestId('cell-lineage-panel'));
    // Radix dialog: pointerDown on the overlay dismisses.
    const overlay = document.querySelector('[data-radix-dialog-overlay], [data-state="open"].fixed.inset-0') as HTMLElement
      ?? document.querySelector('.fixed.inset-0') as HTMLElement;
    expect(overlay).toBeTruthy();
    fireEvent.pointerDown(overlay, { button: 0 });
    fireEvent.pointerUp(overlay, { button: 0 });
    fireEvent.click(overlay);
    await waitFor(() => expect(screen.queryByTestId('cell-lineage-panel')).toBeNull());
  });

  it('5) closes via navigation', async () => {
    const explainCellFn = vi.fn().mockResolvedValue(makeTrace());
    const App = () => (
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={
            <Harness filteredRecords={[]} baseClassifierContext={ctx} pickerMapsByMemberKey={pickerMap} explainCellFn={explainCellFn} />
          } />
          <Route path="/elsewhere" element={<div>other page</div>} />
        </Routes>
      </MemoryRouter>
    );
    render(<App />);
    fireEvent.click(screen.getByTestId('cell-A'));
    await waitFor(() => screen.getByTestId('cell-lineage-panel'));
    fireEvent.click(screen.getByTestId('nav-link'));
    await waitFor(() => expect(screen.queryByTestId('cell-lineage-panel')).toBeNull());
  });

  it('6) updates on next cell click (same panel instance)', async () => {
    const traceA = makeTrace({ firingRule: { name: 'RULE_A', reason: 'a' } });
    const traceB = makeTrace({ firingRule: { name: 'RULE_B', reason: 'b' } });
    const explainCellFn = vi.fn()
      .mockResolvedValueOnce(traceA)
      .mockResolvedValueOnce(traceB);
    renderWithRouter(
      <Harness
        filteredRecords={[]}
        baseClassifierContext={ctx}
        pickerMapsByMemberKey={pickerMap}
        explainCellFn={explainCellFn}
        cellB={{ memberKey: 'issub:uB', monthKey: '2026-02', scope: 'All', monthCell: makeMonthCell({ month: '2026-02' }) }}
      />,
    );
    fireEvent.click(screen.getByTestId('cell-A'));
    await waitFor(() => expect(screen.getByText('RULE_A')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('cell-B'));
    await waitFor(() => expect(screen.getByText('RULE_B')).toBeInTheDocument());
    expect(screen.queryByText('RULE_A')).toBeNull();
    // Single panel instance still present.
    expect(screen.getAllByTestId('cell-lineage-panel')).toHaveLength(1);
  });

  it('7) binding contract — member-scoped records + per-member pickerEdeByMonth', async () => {
    const explainCellFn = vi.fn().mockResolvedValue(makeTrace());
    const rec = (member_key: string): any => ({ id: member_key + '-r', member_key, source_type: 'BACK_OFFICE' });
    const filteredRecords = [rec('issub:uA'), rec('issub:uB'), rec('issub:uA')];
    const pickerA = new Map<string, NormalizedRecord | null>([['2026-01', { id: 'edeA' } as any]]);
    const pickerB = new Map<string, NormalizedRecord | null>([['2026-01', { id: 'edeB' } as any]]);
    const pickerMap = new Map<string, Map<string, NormalizedRecord | null>>([
      ['issub:uA', pickerA],
      ['issub:uB', pickerB],
    ]);
    const baseCtx = { foo: 'bar' } as any as ClassifierContext;

    renderWithRouter(
      <Harness
        filteredRecords={filteredRecords}
        baseClassifierContext={baseCtx}
        pickerMapsByMemberKey={pickerMap}
        explainCellFn={explainCellFn}
        cellA={{ memberKey: 'issub:uA', monthKey: '2026-01', scope: 'All', monthCell: makeMonthCell() }}
      />,
    );
    fireEvent.click(screen.getByTestId('cell-A'));
    await waitFor(() => expect(explainCellFn).toHaveBeenCalledTimes(1));

    const callArg = explainCellFn.mock.calls[0][0];
    expect(callArg.memberKey).toBe('issub:uA');
    // (a) Records filtered to clicked member only.
    expect(callArg.preloadedRecords).toHaveLength(2);
    for (const r of callArg.preloadedRecords) {
      expect(r.member_key).toBe('issub:uA');
    }
    // (b) Context carries the clicked member's pickerEdeByMonth entry.
    expect(callArg.preloadedContext.pickerEdeByMonth).toBe(pickerA);
    expect((callArg.preloadedContext as any).foo).toBe('bar');
  });

  it('8) opens regardless of debugOpen (independence)', async () => {
    // Harness has no debugOpen concept — panel opens purely from the click.
    // This proves the panel does not gate on any external debug flag.
    const explainCellFn = vi.fn().mockResolvedValue(makeTrace());
    renderWithRouter(
      <Harness filteredRecords={[]} baseClassifierContext={ctx} pickerMapsByMemberKey={pickerMap} explainCellFn={explainCellFn} />,
    );
    fireEvent.click(screen.getByTestId('cell-A'));
    await waitFor(() => expect(screen.getByTestId('cell-lineage-panel')).toBeInTheDocument());
  });

  it('9) display override divergence — top-line vs classifier section', async () => {
    const monthCell = makeMonthCell({
      state: 'not_expected_cancelled',
      state_reason: 'no current source',
    });
    const trace = makeTrace({
      final: {
        state: 'unpaid',
        reason: 'no commission',
        chips: { in_ede: false, in_back_office: false, in_commission: false, paid_amount: 0 },
        badges: {},
      },
      firingRule: { name: 'R-UNPAID-001', reason: 'eligible, no commission' },
    });
    const explainCellFn = vi.fn().mockResolvedValue(trace);
    renderWithRouter(
      <Harness
        filteredRecords={[]}
        baseClassifierContext={ctx}
        pickerMapsByMemberKey={pickerMap}
        explainCellFn={explainCellFn}
        cellA={{ memberKey: 'issub:uA', monthKey: '2026-01', scope: 'All', monthCell }}
      />,
    );
    fireEvent.click(screen.getByTestId('cell-A'));
    await waitFor(() => screen.getByTestId('cell-lineage-panel'));

    // Top-line shows MonthCell.state.
    expect(screen.getByText('not expected cancelled')).toBeInTheDocument();
    // Classifier output section shows the trace's pre-display state.
    const classifierSection = screen.getByText(/Classifier output \(pre-display\)/i).parentElement!;
    expect(classifierSection.textContent).toContain('unpaid');
    // Display override note present and names the override fn.
    const note = screen.getByTestId('display-override-note');
    expect(note.textContent).toMatch(/applyNoSourceInvariantToMonthCell/);
    expect(note.textContent).toMatch(/unpaid/);
    expect(note.textContent).toMatch(/not_expected_cancelled/);
  });
});
