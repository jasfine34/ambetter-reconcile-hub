/**
 * Test 9 — Total $ column rendering.
 *
 * Enforces docs/mt-screen-contract.md "Total paid (`$` column)":
 *   `Total $` table column per row equals row.total_paid formatted with
 *   commas + 2 decimals.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import {
  applyMTMocks, setMockRows, makeRow, blankCell, renderMTPage, resetMTMockState,
} from './_mt-render';

applyMTMocks(vi);

const M1 = '2026-01';
const M2 = '2026-02';
const MONTHS = [M1, M2];

describe('Test 9 — Total $ column', () => {
  beforeEach(() => { resetMTMockState(); setMockRows([], MONTHS); });

  it('renders row.total_paid as $X,XXX.XX (sum across paid cells)', async () => {
    setMockRows([
      makeRow({
        member_key: 'mk-tp1',
        applicant_name: 'TOTAL PAID MEMBER',
        cells: {
          [M1]: blankCell(M1, { state: 'paid', due: true, paid_amount: 100, in_commission: true }),
          [M2]: blankCell(M2, { state: 'paid', due: true, paid_amount: 50.25, in_commission: true }),
        },
      }),
    ], MONTHS);
    await renderMTPage();
    await waitFor(() => expect(screen.getByText('TOTAL PAID MEMBER')).toBeInTheDocument());
    // Row total $: 100 + 50.25 = 150.25 → "$150.25"
    expect(screen.getAllByText('$150.25').length).toBeGreaterThan(0);
  });

  it('renders Total $ column header', async () => {
    setMockRows([
      makeRow({
        applicant_name: 'HDR MEMBER',
        cells: { [M1]: blankCell(M1, { state: 'paid', due: true, paid_amount: 1, in_commission: true }) },
      }),
    ], MONTHS);
    await renderMTPage();
    await waitFor(() => expect(screen.getByText('HDR MEMBER')).toBeInTheDocument());
    expect(screen.getByText('Total $')).toBeInTheDocument();
  });

  it('formats with thousands separators for large amounts', async () => {
    setMockRows([
      makeRow({
        applicant_name: 'BIG MEMBER',
        cells: {
          [M1]: blankCell(M1, { state: 'paid', due: true, paid_amount: 1234.56, in_commission: true }),
        },
      }),
    ], MONTHS);
    await renderMTPage();
    await waitFor(() => expect(screen.getByText('BIG MEMBER')).toBeInTheDocument());
    expect(screen.getAllByText('$1,234.56').length).toBeGreaterThan(0);
  });
});
