/**
 * MT current-batch range warning — banner rendering + helper unit tests.
 *
 * Enforces the spec-locked banner: shown only when batchScope === 'current'
 * AND there are months in the selected range that fall outside the selected
 * statement batch's month. Suppressed in all-batches scope, when statement
 * month is unknown, or when the range == statement month only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import {
  applyMTMocks,
  setMockRows,
  setMockStatementMonth,
  resetMTMockState,
  makeRow,
  blankCell,
  renderMTPage,
  TEST_STATEMENT_MONTH,
} from './_mt-render';
import { monthsOutsideSelectedStatement } from '@/lib/memberTimeline';

applyMTMocks(vi);

// Statement month for these tests is TEST_STATEMENT_MONTH = '2026-04-01' → key '2026-04', label 'Apr 26'.
const STATEMENT_KEY = '2026-04';
const STATEMENT_LABEL = 'Apr 26';

function rowForMonths(months: string[]) {
  const cells: Record<string, any> = {};
  for (const m of months) cells[m] = blankCell(m);
  return makeRow({ cells });
}

describe('MT current-batch range warning — banner rendering', () => {
  beforeEach(() => {
    resetMTMockState();
    localStorage.removeItem('timeline_batch_scope_filter');
  });
  afterEach(() => {
    resetMTMockState();
    localStorage.removeItem('timeline_batch_scope_filter');
  });

  it('current scope + range spanning outside months → banner visible with statement label + count', async () => {
    const months = ['2026-01', '2026-02', '2026-03', STATEMENT_KEY];
    setMockRows([rowForMonths(months)], months);
    await renderMTPage();
    const banner = await waitFor(() => screen.getByTestId('mt-range-warning'));
    expect(banner.textContent).toContain(STATEMENT_LABEL);
    expect(banner.textContent).toContain('3 of the selected months');
  });

  it('all-batches scope → banner absent', async () => {
    localStorage.setItem('timeline_batch_scope_filter', 'all');
    const months = ['2026-01', '2026-02', '2026-03', STATEMENT_KEY];
    setMockRows([rowForMonths(months)], months);
    await renderMTPage();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('mt-range-warning')).toBeNull();
  });

  it('current scope + range == statement month only → banner absent', async () => {
    const months = [STATEMENT_KEY];
    setMockRows([rowForMonths(months)], months);
    await renderMTPage();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('mt-range-warning')).toBeNull();
  });

  it('current scope + null statement month → banner absent', async () => {
    setMockStatementMonth(null);
    const months = ['2026-01', '2026-02', STATEMENT_KEY];
    setMockRows([rowForMonths(months)], months);
    await renderMTPage();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('mt-range-warning')).toBeNull();
    setMockStatementMonth(TEST_STATEMENT_MONTH);
  });
});

describe('monthsOutsideSelectedStatement — helper units', () => {
  it('normal mix returns only the outside months', () => {
    expect(monthsOutsideSelectedStatement(['2026-01', '2026-02', '2026-04'], '2026-04-01'))
      .toEqual(['2026-01', '2026-02']);
  });
  it('all inside (only statement month) returns []', () => {
    expect(monthsOutsideSelectedStatement(['2026-04'], '2026-04-01')).toEqual([]);
  });
  it('all outside returns the full list', () => {
    expect(monthsOutsideSelectedStatement(['2026-01', '2026-02'], '2026-04-01'))
      .toEqual(['2026-01', '2026-02']);
  });
  it('null statement month returns []', () => {
    expect(monthsOutsideSelectedStatement(['2026-01', '2026-02'], null)).toEqual([]);
  });
  it('empty monthList returns []', () => {
    expect(monthsOutsideSelectedStatement([], '2026-04-01')).toEqual([]);
  });
});
