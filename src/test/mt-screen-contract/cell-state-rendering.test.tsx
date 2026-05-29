/**
 * Test 1 — Cell state visual rendering (9 ClassificationState values).
 *
 * Enforces docs/mt-screen-contract.md "Cell states" — each subsection's
 * Visible line. Renders the REAL MemberTimelinePage with mocked data.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { applyMTMocks, setMockRows, makeRow, blankCell, renderMTPage } from './_mt-render';

applyMTMocks(vi);

const TARGET_MONTH = '2026-02';
const ANCHOR_MONTH = '2026-01';
const MONTHS = [ANCHOR_MONTH, TARGET_MONTH];

/** Build a row with a paid anchor at 2026-01 + the target cell at 2026-02. */
function rowWithAnchorAndTarget(target: any) {
  return makeRow({
    member_key: 'mk-target',
    applicant_name: 'TARGET MEMBER',
    cells: {
      [ANCHOR_MONTH]: blankCell(ANCHOR_MONTH, {
        in_commission: true, paid_amount: 100, payment_count: 1, due: true, state: 'paid',
      }),
      [TARGET_MONTH]: target,
    },
  });
}

async function findTargetCell() {
  await waitFor(() =>
    expect(screen.queryAllByTestId('mt-cell').length).toBeGreaterThan(0),
  );
  const cells = screen.getAllByTestId('mt-cell');
  const target = cells.find(el => el.getAttribute('data-month') === TARGET_MONTH);
  if (!target) throw new Error(`No cell rendered for month ${TARGET_MONTH}`);
  return target;
}

describe('Test 1 — Cell state visual rendering', () => {
  beforeEach(() => {
    setMockRows([], MONTHS);
  });

  it('paid → green class + $amount label', async () => {
    setMockRows([
      makeRow({
        cells: {
          [ANCHOR_MONTH]: blankCell(ANCHOR_MONTH, { state: 'paid', due: true, paid_amount: 1, in_commission: true }),
          [TARGET_MONTH]: blankCell(TARGET_MONTH, {
            state: 'paid', due: true, paid_amount: 42.5, in_commission: true, payment_count: 1,
          }),
        },
      }),
    ], MONTHS);
    await renderMTPage();
    const cell = await findTargetCell();
    expect(cell.className).toMatch(/bg-success\/15/);
    expect(within(cell).getByText('$42.50')).toBeInTheDocument();
  });

  it('unpaid → destructive class + literal "unpaid"', async () => {
    setMockRows([
      rowWithAnchorAndTarget(blankCell(TARGET_MONTH, {
        state: 'unpaid', due: true, in_back_office: true,
      })),
    ], MONTHS);
    await renderMTPage();
    const cell = await findTargetCell();
    expect(cell.className).toMatch(/bg-destructive\/15/);
    expect(within(cell).getByText('unpaid')).toBeInTheDocument();
  });

  it('reversed → orange class + "Reversed Apr 26" label', async () => {
    setMockRows([
      rowWithAnchorAndTarget(blankCell(TARGET_MONTH, {
        state: 'reversed', due: true, in_commission: true,
        reversal_evidence: {
          amount: 48,
          paidToDate: '2026-02-28',
          positiveTransactionId: '8245546',
          negativeTransactionId: '8705401',
          positiveStatementMonth: '2026-02',
          negativeStatementMonth: '2026-04',
        } as any,
      })),
    ], MONTHS);
    await renderMTPage();
    const cell = await findTargetCell();
    expect(cell.className).toMatch(/orange/);
    expect(within(cell).getByText('Reversed Apr 26')).toBeInTheDocument();
  });

  it('pending → amber class + literal "pending"', async () => {
    setMockRows([
      rowWithAnchorAndTarget(blankCell(TARGET_MONTH, {
        state: 'pending', due: true, in_back_office: true,
      })),
    ], MONTHS);
    await renderMTPage();
    const cell = await findTargetCell();
    expect(cell.className).toMatch(/amber/);
    expect(within(cell).getByText('pending')).toBeInTheDocument();
  });

  it('manual_review → purple class + literal "review"', async () => {
    setMockRows([
      rowWithAnchorAndTarget(blankCell(TARGET_MONTH, {
        state: 'manual_review', due: true, in_back_office: true,
      })),
    ], MONTHS);
    await renderMTPage();
    const cell = await findTargetCell();
    expect(cell.className).toMatch(/purple/);
    expect(within(cell).getByText('review')).toBeInTheDocument();
  });

  for (const state of [
    'not_expected_premium_unpaid',
    'not_expected_pre_eligibility',
    'not_expected_cancelled',
    'not_expected_not_ours',
  ] as const) {
    it(`${state} (with sources) → muted/dashed class + literal "n/a"`, async () => {
      setMockRows([
        rowWithAnchorAndTarget(blankCell(TARGET_MONTH, {
          state, in_back_office: true,
        })),
      ], MONTHS);
      await renderMTPage();
      const cell = await findTargetCell();
      expect(cell.className).toMatch(/border-dashed/);
      expect(cell.className).toMatch(/bg-muted\/40/);
      expect(within(cell).getByText('n/a')).toBeInTheDocument();
    });
  }
});
