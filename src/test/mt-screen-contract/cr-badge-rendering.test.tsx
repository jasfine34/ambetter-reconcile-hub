/**
 * Test 4 — CR cell badge + row-level CR×{N} badge.
 *
 * Enforces docs/mt-screen-contract.md "Carrier-recognition (CR) cell badge"
 * and "Row CR count badge (CR×{N})" sections.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import {
  applyMTMocks, setMockRows, makeRow, blankCell, renderMTPage, resetMTMockState,
} from './_mt-render';

applyMTMocks(vi);

const M1 = '2026-01';
const M2 = '2026-02';
const M3 = '2026-03';
const MONTHS = [M1, M2, M3];

describe('Test 4 — CR badge + CR×{N} row badge', () => {
  beforeEach(() => { resetMTMockState(); setMockRows([], MONTHS); });

  it('CR cell badge renders when carrier_recognition=true', async () => {
    setMockRows([
      makeRow({
        cells: {
          [M1]: blankCell(M1, { state: 'paid', due: true, paid_amount: 10, in_commission: true }),
          [M2]: blankCell(M2, {
            state: 'unpaid', due: true, in_back_office: true,
            carrier_recognition: true, carrier_recognition_premium: 480,
          }),
          [M3]: blankCell(M3),
        },
      }),
    ], MONTHS);
    await renderMTPage();
    await waitFor(() => expect(screen.queryAllByTestId('mt-cell').length).toBeGreaterThan(0));
    const cells = screen.getAllByTestId('mt-cell');
    const target = cells.find(el => el.getAttribute('data-month') === M2)!;
    expect(within(target).getByText('CR')).toBeInTheDocument();
    const otherCell = cells.find(el => el.getAttribute('data-month') === M1)!;
    expect(within(otherCell).queryByText('CR')).not.toBeInTheDocument();
  });

  it('row CR×{N} badge uses U+00D7 multiplication sign with correct count', async () => {
    setMockRows([
      makeRow({
        member_key: 'mk-cr3',
        applicant_name: 'CR THREE MEMBER',
        cells: {
          [M1]: blankCell(M1, { state: 'unpaid', due: true, in_back_office: true, carrier_recognition: true }),
          [M2]: blankCell(M2, { state: 'unpaid', due: true, in_back_office: true, carrier_recognition: true }),
          [M3]: blankCell(M3, { state: 'unpaid', due: true, in_back_office: true, carrier_recognition: true }),
        },
      }),
    ], MONTHS);
    await renderMTPage();
    await waitFor(() => expect(screen.queryByText(/CR.3/)).toBeInTheDocument());
    // Exact string with U+00D7 multiplication sign
    const badge = screen.getByText('CR\u00D73');
    expect(badge).toBeInTheDocument();
    expect(badge.textContent).toBe('CR\u00D73');
    // Sanity — must NOT use ASCII 'x'
    expect(screen.queryByText('CRx3')).not.toBeInTheDocument();
  });

  it('row CR×{N} badge omitted when zero CR cells', async () => {
    setMockRows([
      makeRow({
        applicant_name: 'NO CR MEMBER',
        cells: {
          [M1]: blankCell(M1, { state: 'paid', due: true, paid_amount: 10, in_commission: true }),
          [M2]: blankCell(M2),
          [M3]: blankCell(M3),
        },
      }),
    ], MONTHS);
    await renderMTPage();
    await waitFor(() => expect(screen.getByText('NO CR MEMBER')).toBeInTheDocument());
    expect(screen.queryByText(/^CR\u00D7/)).not.toBeInTheDocument();
  });
});
