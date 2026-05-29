/**
 * Test 13 — Reversed cell label including formatMonthLabel output.
 *
 * Enforces docs/mt-screen-contract.md reversed-state rendering:
 *   A `reversed` cell with reversal_evidence.negativeStatementMonth shows
 *   "Reversed {formatMonthLabel(negativeStatementMonth)}" (e.g.
 *   "Reversed Apr 26"). Without negativeStatementMonth, shows "Reversed".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import {
  applyMTMocks, setMockRows, makeRow, blankCell, renderMTPage, resetMTMockState,
} from './_mt-render';
import { formatMonthLabel } from '@/lib/memberTimeline';

applyMTMocks(vi);

const M1 = '2026-01';
const M2 = '2026-02';
const MONTHS = [M1, M2];

describe('Test 13 — Reversed cell label uses formatMonthLabel', () => {
  beforeEach(() => { resetMTMockState(); setMockRows([], MONTHS); });

  it('renders "Reversed {Mon YY}" using formatMonthLabel(negativeStatementMonth)', async () => {
    setMockRows([
      makeRow({
        applicant_name: 'REV LABEL MEMBER',
        cells: {
          [M1]: blankCell(M1, { state: 'paid', due: true, paid_amount: 5, in_commission: true }),
          [M2]: blankCell(M2, {
            state: 'reversed', due: true, in_commission: true,
            reversal_evidence: {
              amount: 200,
              positiveTxnId: 'POS-1',
              negativeTxnId: 'NEG-1',
              paidToDate: 100,
              positiveStatementMonth: '2026-03',
              negativeStatementMonth: '2026-04',
            } as any,
          }),
        },
      }),
    ], MONTHS);
    await renderMTPage();
    await waitFor(() => expect(screen.getByText('REV LABEL MEMBER')).toBeInTheDocument());

    const expected = `Reversed ${formatMonthLabel('2026-04')}`; // "Reversed Apr 26"
    expect(screen.getAllByText(expected).length).toBeGreaterThan(0);
  });

  it('renders bare "Reversed" when reversal_evidence has no negativeStatementMonth', async () => {
    setMockRows([
      makeRow({
        applicant_name: 'REV BARE MEMBER',
        cells: {
          [M1]: blankCell(M1, { state: 'paid', due: true, paid_amount: 5, in_commission: true }),
          [M2]: blankCell(M2, {
            state: 'reversed', due: true, in_commission: true,
            reversal_evidence: {
              amount: 200,
              positiveTxnId: 'POS-1',
              negativeTxnId: 'NEG-1',
              paidToDate: 100,
            } as any,
          }),
        },
      }),
    ], MONTHS);
    await renderMTPage();
    await waitFor(() => expect(screen.getByText('REV BARE MEMBER')).toBeInTheDocument());
    expect(screen.getAllByText('Reversed').length).toBeGreaterThan(0);
  });
});
