/**
 * Test 12 — Debug toggle + PaidDollarsAuditPanel visibility.
 *
 * Enforces docs/mt-screen-contract.md "Debug toggle + CellAttributionPopover
 * + PaidDollarsAuditPanel":
 *   When toggled on, PaidDollarsAuditPanel appears below the table.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import {
  applyMTMocks, setMockRows, makeRow, blankCell, renderMTPage, resetMTMockState,
} from './_mt-render';

applyMTMocks(vi);

const M1 = '2026-01';
const MONTHS = [M1];

describe('Test 12 — Debug toggle', () => {
  beforeEach(() => { resetMTMockState(); setMockRows([], MONTHS); });

  it('shows "Debug" button initially, no audit panel', async () => {
    setMockRows([
      makeRow({
        applicant_name: 'DEBUG MEMBER', cells: {
          [M1]: blankCell(M1, { state: 'paid', due: true, paid_amount: 1, in_commission: true }),
        },
      }),
    ], MONTHS);
    await renderMTPage();
    await waitFor(() => expect(screen.getByText('DEBUG MEMBER')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /^Debug$/ })).toBeInTheDocument();
    expect(screen.queryByText('Paid Dollars Audit')).not.toBeInTheDocument();
  });

  it('toggles to "Debug on" and reveals PaidDollarsAuditPanel when clicked', async () => {
    setMockRows([
      makeRow({
        applicant_name: 'DEBUG TOG MEMBER', cells: {
          [M1]: blankCell(M1, { state: 'paid', due: true, paid_amount: 1, in_commission: true }),
        },
      }),
    ], MONTHS);
    await renderMTPage();
    await waitFor(() => expect(screen.getByText('DEBUG TOG MEMBER')).toBeInTheDocument());

    const btn = screen.getByRole('button', { name: /^Debug$/ });
    fireEvent.click(btn);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Debug on/ })).toBeInTheDocument();
    });
    expect(screen.getByText('Paid Dollars Audit')).toBeInTheDocument();
  });
});
