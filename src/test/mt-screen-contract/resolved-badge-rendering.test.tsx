/**
 * Test 6 — ResolvedBadge rendering.
 *
 * Enforces docs/mt-screen-contract.md "ResolvedBadge" line under the Member
 * identity row section. Badge appears ONLY when displayed value is the
 * issuer_subscriber_id AND resolver confirms a matching winning value.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import {
  applyMTMocks, setMockRows, makeRow, blankCell, renderMTPage,
  resetMTMockState, setMockResolverIndex, setMockLookupResolved,
} from './_mt-render';

applyMTMocks(vi);

const M1 = '2026-01';
const MONTHS = [M1];

function baseCells() {
  return {
    [M1]: blankCell(M1, { state: 'paid', due: true, paid_amount: 10, in_commission: true }),
  };
}

describe('Test 6 — ResolvedBadge rendering', () => {
  beforeEach(() => { resetMTMockState(); setMockRows([], MONTHS); });

  it('renders ResolvedBadge when ISID is shown and resolver confirms', async () => {
    setMockResolverIndex({ totalRows: 1 });
    setMockLookupResolved(() => ({
      resolved_issuer_subscriber_id: 'ISID-X',
      source_kind: 'ede',
      source_batch_month: '2026-01',
    }));
    setMockRows([
      makeRow({
        applicant_name: 'RESOLVED MEMBER',
        policy_number: '',
        issuer_subscriber_id: 'ISID-X',
        exchange_subscriber_id: 'EXID-X',
        cells: baseCells(),
      }),
    ], MONTHS);
    await renderMTPage();
    await waitFor(() => expect(screen.getByText('RESOLVED MEMBER')).toBeInTheDocument());
    const icon = document.querySelector('[aria-label="Resolved identity"]');
    expect(icon).not.toBeNull();
  });

  it('does NOT render ResolvedBadge when policy_number is displayed', async () => {
    setMockResolverIndex({ totalRows: 1 });
    setMockLookupResolved(() => ({
      resolved_issuer_subscriber_id: 'ISID-X',
      source_kind: 'ede',
      source_batch_month: '2026-01',
    }));
    setMockRows([
      makeRow({
        applicant_name: 'POLICY MEMBER',
        policy_number: 'P-1',
        issuer_subscriber_id: 'ISID-X',
        cells: baseCells(),
      }),
    ], MONTHS);
    await renderMTPage();
    await waitFor(() => expect(screen.getByText('POLICY MEMBER')).toBeInTheDocument());
    expect(document.querySelector('[aria-label="Resolved identity"]')).toBeNull();
  });

  it('does NOT render ResolvedBadge when resolver returns no hit', async () => {
    setMockResolverIndex({ totalRows: 1 });
    setMockLookupResolved(() => null);
    setMockRows([
      makeRow({
        applicant_name: 'UNRESOLVED MEMBER',
        policy_number: '',
        issuer_subscriber_id: 'ISID-Y',
        cells: baseCells(),
      }),
    ], MONTHS);
    await renderMTPage();
    await waitFor(() => expect(screen.getByText('UNRESOLVED MEMBER')).toBeInTheDocument());
    expect(document.querySelector('[aria-label="Resolved identity"]')).toBeNull();
  });
});
