/**
 * Test 8 — Due/Paid ratio column rendering.
 *
 * Enforces docs/mt-screen-contract.md "Due/Paid ratio" section: the column
 * renders `months_paid/months_due` for each row.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import {
  applyMTMocks, setMockRows, makeRow, blankCell, renderMTPage, resetMTMockState,
} from './_mt-render';

applyMTMocks(vi);

const M1 = '2026-01';
const M2 = '2026-02';
const M3 = '2026-03';
const MONTHS = [M1, M2, M3];

describe('Test 8 — Due/Paid ratio column', () => {
  beforeEach(() => { resetMTMockState(); setMockRows([], MONTHS); });

  it('renders "2/3" when 2 of 3 due months are paid', async () => {
    setMockRows([
      makeRow({
        applicant_name: 'TWO OF THREE',
        cells: {
          [M1]: blankCell(M1, { state: 'paid', due: true, paid_amount: 10, in_commission: true }),
          [M2]: blankCell(M2, { state: 'paid', due: true, paid_amount: 10, in_commission: true }),
          [M3]: blankCell(M3, { state: 'unpaid', due: true, in_back_office: true }),
        },
      }),
    ], MONTHS);
    await renderMTPage();
    await waitFor(() => expect(screen.getByText('TWO OF THREE')).toBeInTheDocument());
    const row = screen.getByText('TWO OF THREE').closest('tr')!;
    // numerator + slash + denominator are adjacent <span>s in the Due/Paid td
    expect(row.textContent).toMatch(/2\/3/);
  });

  it('renders "0/2" for fully unpaid member', async () => {
    setMockRows([
      makeRow({
        applicant_name: 'ZERO OF TWO',
        cells: {
          [M1]: blankCell(M1, { state: 'unpaid', due: true, in_back_office: true }),
          [M2]: blankCell(M2, { state: 'unpaid', due: true, in_back_office: true }),
          [M3]: blankCell(M3),
        },
      }),
    ], MONTHS);
    await renderMTPage();
    await waitFor(() => expect(screen.getByText('ZERO OF TWO')).toBeInTheDocument());
    const row = screen.getByText('ZERO OF TWO').closest('tr')!;
    expect(row.textContent).toMatch(/0\/2/);
  });

  it('renders "3/3" for fully paid member', async () => {
    setMockRows([
      makeRow({
        applicant_name: 'THREE OF THREE',
        cells: {
          [M1]: blankCell(M1, { state: 'paid', due: true, paid_amount: 10, in_commission: true }),
          [M2]: blankCell(M2, { state: 'paid', due: true, paid_amount: 10, in_commission: true }),
          [M3]: blankCell(M3, { state: 'paid', due: true, paid_amount: 10, in_commission: true }),
        },
      }),
    ], MONTHS);
    await renderMTPage();
    await waitFor(() => expect(screen.getByText('THREE OF THREE')).toBeInTheDocument());
    const row = screen.getByText('THREE OF THREE').closest('tr')!;
    expect(row.textContent).toMatch(/3\/3/);
  });
});
