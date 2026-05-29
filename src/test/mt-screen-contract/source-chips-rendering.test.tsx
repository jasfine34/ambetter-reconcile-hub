/**
 * Test 3 — Source chips (E, B, C) and no-source dash visual rendering.
 *
 * Enforces docs/mt-screen-contract.md "Source chips (E, B, C)" and
 * "No-source dash (—)" sections.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import {
  applyMTMocks, setMockRows, makeRow, blankCell, renderMTPage, resetMTMockState,
} from './_mt-render';

applyMTMocks(vi);

const ANCHOR = '2026-01';
const TARGET = '2026-02';
const MONTHS = [ANCHOR, TARGET];

function rowWithTarget(target: any) {
  return makeRow({
    cells: {
      [ANCHOR]: blankCell(ANCHOR, {
        in_commission: true, paid_amount: 100, payment_count: 1, due: true, state: 'paid',
      }),
      [TARGET]: target,
    },
  });
}

async function findTargetCell() {
  await waitFor(() => expect(screen.queryAllByTestId('mt-cell').length).toBeGreaterThan(0));
  const cells = screen.getAllByTestId('mt-cell');
  const t = cells.find(el => el.getAttribute('data-month') === TARGET);
  if (!t) throw new Error('no target cell');
  return t;
}

describe('Test 3 — Source chips + no-source dash', () => {
  beforeEach(() => { resetMTMockState(); setMockRows([], MONTHS); });

  it('E chip renders when in_ede=true', async () => {
    setMockRows([rowWithTarget(blankCell(TARGET, {
      in_ede: true, due: true, state: 'unpaid',
    }))], MONTHS);
    await renderMTPage();
    const cell = await findTargetCell();
    expect(within(cell).getByText('E')).toBeInTheDocument();
    expect(within(cell).queryByText('B')).not.toBeInTheDocument();
    expect(within(cell).queryByText('C')).not.toBeInTheDocument();
  });

  it('B chip renders when in_back_office=true', async () => {
    setMockRows([rowWithTarget(blankCell(TARGET, {
      in_back_office: true, due: true, state: 'unpaid',
    }))], MONTHS);
    await renderMTPage();
    const cell = await findTargetCell();
    expect(within(cell).getByText('B')).toBeInTheDocument();
  });

  it('C chip renders when in_commission=true', async () => {
    setMockRows([rowWithTarget(blankCell(TARGET, {
      in_commission: true, paid_amount: 10, payment_count: 1, due: true, state: 'paid',
    }))], MONTHS);
    await renderMTPage();
    const cell = await findTargetCell();
    expect(within(cell).getByText('C')).toBeInTheDocument();
  });

  it('all three chips render together when all sources present', async () => {
    setMockRows([rowWithTarget(blankCell(TARGET, {
      in_ede: true, in_back_office: true, in_commission: true,
      paid_amount: 10, payment_count: 1, due: true, state: 'paid',
    }))], MONTHS);
    await renderMTPage();
    const cell = await findTargetCell();
    expect(within(cell).getByText('E')).toBeInTheDocument();
    expect(within(cell).getByText('B')).toBeInTheDocument();
    expect(within(cell).getByText('C')).toBeInTheDocument();
    expect(within(cell).queryByText('—')).not.toBeInTheDocument();
  });

  it('no-source dash renders when no E/B/C and state is not_expected', async () => {
    setMockRows([rowWithTarget(blankCell(TARGET, {
      state: 'not_expected_cancelled',
    }))], MONTHS);
    await renderMTPage();
    const cell = await findTargetCell();
    expect(within(cell).getByText('—')).toBeInTheDocument();
    expect(within(cell).queryByText('E')).not.toBeInTheDocument();
    expect(within(cell).queryByText('B')).not.toBeInTheDocument();
    expect(within(cell).queryByText('C')).not.toBeInTheDocument();
  });
});
