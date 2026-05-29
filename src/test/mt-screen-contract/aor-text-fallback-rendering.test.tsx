/**
 * Test 7 — Member AOR text fallback order.
 *
 * Enforces docs/mt-screen-contract.md "Member AOR text" line:
 *   Displays `current_policy_aor || aor_bucket || '—'` (U+2014 EM DASH).
 *
 * Spec amended in Batch C triage to match production rendering (em dash).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import {
  applyMTMocks, setMockRows, makeRow, blankCell, renderMTPage, resetMTMockState,
} from './_mt-render';

applyMTMocks(vi);

const M1 = '2026-01';
const MONTHS = [M1];

function baseCells() {
  return { [M1]: blankCell(M1, { state: 'paid', due: true, paid_amount: 10, in_commission: true }) };
}

describe('Test 7 — Member AOR text fallback order', () => {
  beforeEach(() => { resetMTMockState(); setMockRows([], MONTHS); });

  it('prefers current_policy_aor when present', async () => {
    setMockRows([
      makeRow({
        applicant_name: 'AOR PREF MEMBER',
        current_policy_aor: 'JASON FINE',
        aor_bucket: 'BECKY SHUTA',
        cells: baseCells(),
      }),
    ], MONTHS);
    await renderMTPage();
    await waitFor(() => expect(screen.getByText('AOR PREF MEMBER')).toBeInTheDocument());
    expect(screen.getAllByText('JASON FINE').length).toBeGreaterThan(0);
  });

  it('falls back to aor_bucket when current_policy_aor is empty', async () => {
    setMockRows([
      makeRow({
        applicant_name: 'AOR FALLBACK MEMBER',
        current_policy_aor: '',
        aor_bucket: 'BECKY SHUTA',
        cells: baseCells(),
      }),
    ], MONTHS);
    await renderMTPage();
    await waitFor(() => expect(screen.getByText('AOR FALLBACK MEMBER')).toBeInTheDocument());
    expect(screen.getAllByText('BECKY SHUTA').length).toBeGreaterThan(0);
  });

  it("falls back to '—' em dash when neither is present (spec literal U+2014)", async () => {
    setMockRows([
      makeRow({
        applicant_name: 'AOR DASH MEMBER',
        current_policy_aor: '',
        aor_bucket: '',
        cells: baseCells(),
      }),
    ], MONTHS);
    await renderMTPage();
    await waitFor(() => expect(screen.getByText('AOR DASH MEMBER')).toBeInTheDocument());
    // Spec verbatim (post Batch B triage): '—' (U+2014 EM DASH).
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });
});
