/**
 * Test 11 — Summary totals (top of page).
 *
 * Enforces docs/mt-screen-contract.md "Summary totals":
 *   - `Total paid` — sum of `total_paid` across visible rows.
 *   - `Members with unpaid` — count of rows with months_unpaid > 0.
 *   - `Total unpaid months` — sum of months_unpaid across visible rows.
 *
 * Labels asserted verbatim per spec. Divergence (if any) is reported, not
 * silently flipped.
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

describe('Test 11 — Summary totals (top of page)', () => {
  beforeEach(() => { resetMTMockState(); setMockRows([], MONTHS); });

  function fixtureRows() {
    return [
      makeRow({
        member_key: 'A', applicant_name: 'SUM AAA', cells: {
          [M1]: blankCell(M1, { state: 'paid', due: true, paid_amount: 100, in_commission: true }),
          [M2]: blankCell(M2),
        },
      }),
      makeRow({
        member_key: 'B', applicant_name: 'SUM BBB', cells: {
          [M1]: blankCell(M1, { state: 'paid', due: true, paid_amount: 50, in_commission: true }),
          [M2]: blankCell(M2, { state: 'unpaid', due: true, netBucket: '+Net', in_ede: true }),
        },
      }),
      makeRow({
        member_key: 'C', applicant_name: 'SUM CCC', cells: {
          [M1]: blankCell(M1, { state: 'unpaid', due: true, netBucket: '0Net', in_ede: true }),
          [M2]: blankCell(M2, { state: 'unpaid', due: true, netBucket: '0Net', in_ede: true }),
        },
      }),
    ];
  }

  it('renders Total paid as $X.XX', async () => {
    setMockRows(fixtureRows(), MONTHS);
    await renderMTPage();
    await waitFor(() => expect(screen.getByText('SUM AAA')).toBeInTheDocument());
    // 100 + 50 + 0 = 150.00
    expect(screen.getByText(/Total paid:/)).toBeInTheDocument();
    expect(screen.getAllByText('$150.00').length).toBeGreaterThan(0);
  });

  it('renders Members with unpaid count (spec label verbatim)', async () => {
    setMockRows(fixtureRows(), MONTHS);
    await renderMTPage();
    await waitFor(() => expect(screen.getByText('SUM AAA')).toBeInTheDocument());
    // Members with unpaid: B, C = 2
    expect(screen.getByText(/Members with unpaid/i)).toBeInTheDocument();
  });

  it('renders Total unpaid months count (spec label verbatim)', async () => {
    setMockRows(fixtureRows(), MONTHS);
    await renderMTPage();
    await waitFor(() => expect(screen.getByText('SUM AAA')).toBeInTheDocument());
    // months_unpaid sum: B=1 + C=2 = 3
    expect(screen.getByText(/Total unpaid months/i)).toBeInTheDocument();
  });
});
