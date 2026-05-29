/**
 * Test 10 — Per-filter-chip count assertion tests for all 8 chips.
 *
 * Enforces docs/mt-screen-contract.md "Status filter chips":
 *   All / Has unpaid / unpaid - + Net / unpaid - 0 Net / Partially paid /
 *   Fully paid / Has pending / Needs review.
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

describe('Test 10 — Filter chip counts (all 8 chips)', () => {
  beforeEach(() => { resetMTMockState(); setMockRows([], MONTHS); });

  it('renders correct counts for every chip given a known row mix', async () => {
    setMockRows([
      // A: Fully paid (paid=1, due=1)
      makeRow({
        member_key: 'A', applicant_name: 'AAA FULLPAID', cells: {
          [M1]: blankCell(M1, { state: 'paid', due: true, paid_amount: 10, in_commission: true }),
          [M2]: blankCell(M2),
        },
      }),
      // B: Unpaid +Net
      makeRow({
        member_key: 'B', applicant_name: 'BBB UNPAID PLUS', cells: {
          [M1]: blankCell(M1, { state: 'unpaid', due: true, netBucket: '+Net', in_ede: true }),
          [M2]: blankCell(M2),
        },
      }),
      // C: Unpaid 0Net
      makeRow({
        member_key: 'C', applicant_name: 'CCC UNPAID ZERO', cells: {
          [M1]: blankCell(M1, { state: 'unpaid', due: true, netBucket: '0Net', in_ede: true }),
          [M2]: blankCell(M2),
        },
      }),
      // D: Partial (paid M1, unpaid +Net M2)
      makeRow({
        member_key: 'D', applicant_name: 'DDD PARTIAL', cells: {
          [M1]: blankCell(M1, { state: 'paid', due: true, paid_amount: 5, in_commission: true }),
          [M2]: blankCell(M2, { state: 'unpaid', due: true, netBucket: '+Net', in_ede: true }),
        },
      }),
      // E: Pending
      makeRow({
        member_key: 'E', applicant_name: 'EEE PENDING', cells: {
          [M1]: blankCell(M1, { state: 'pending', due: true, in_ede: true }),
          [M2]: blankCell(M2),
        },
      }),
      // F: Manual review
      makeRow({
        member_key: 'F', applicant_name: 'FFF REVIEW', cells: {
          [M1]: blankCell(M1, { state: 'manual_review', due: true, in_ede: true }),
          [M2]: blankCell(M2),
        },
      }),
    ], MONTHS);

    await renderMTPage();
    await waitFor(() => expect(screen.getByText('AAA FULLPAID')).toBeInTheDocument());

    // Expected counts:
    //   all = 6 (any due)
    //   unpaid (months_unpaid>0): B, C, D = 3
    //   +Net: B, D = 2
    //   0Net: C = 1
    //   partial: D = 1
    //   paid (months_paid===months_due): A = 1
    //   pending (any pending cell): E = 1
    //   review (needs_manual_review): F = 1
    expect(screen.getByText('All (6)')).toBeInTheDocument();
    expect(screen.getByText('Has unpaid (3)')).toBeInTheDocument();
    expect(screen.getByText('unpaid - + Net (2)')).toBeInTheDocument();
    expect(screen.getByText('unpaid - 0 Net (1)')).toBeInTheDocument();
    expect(screen.getByText('Partially paid (1)')).toBeInTheDocument();
    expect(screen.getByText('Fully paid (1)')).toBeInTheDocument();
    expect(screen.getByText('Has pending (1)')).toBeInTheDocument();
    expect(screen.getByText('Needs review (1)')).toBeInTheDocument();
  });
});
