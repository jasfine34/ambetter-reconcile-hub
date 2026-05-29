/**
 * Test 5 — Tooltip Reversal evidence block.
 *
 * Enforces docs/mt-screen-contract.md "Reversal evidence card" section.
 * Mocks the Tooltip primitives to passthrough so TooltipContent renders
 * inline (jsdom + radix portals + hover timing is too flaky for a contract
 * test). Visual structure under test is the JSX inside TooltipContent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import React from 'react';
import {
  applyMTMocks, setMockRows, makeRow, blankCell, renderMTPage, resetMTMockState,
} from './_mt-render';

applyMTMocks(vi);

// Force tooltip content to always render inline so we can assert on its text.
vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: any) => <>{children}</>,
  Tooltip: ({ children }: any) => <>{children}</>,
  TooltipTrigger: ({ children, asChild: _asChild, ...rest }: any) =>
    React.isValidElement(children)
      ? React.cloneElement(children, rest as any)
      : <span {...rest}>{children}</span>,
  TooltipContent: ({ children }: any) => <div data-testid="tt-content">{children}</div>,
}));

const ANCHOR = '2026-01';
const TARGET = '2026-02';
const MONTHS = [ANCHOR, TARGET];

describe('Test 5 — Reversal evidence tooltip block', () => {
  beforeEach(() => { resetMTMockState(); setMockRows([], MONTHS); });

  it('reversed cell tooltip surfaces amount, TXNs, statement months, paid-to-date', async () => {
    setMockRows([
      makeRow({
        cells: {
          [ANCHOR]: blankCell(ANCHOR, { state: 'paid', due: true, paid_amount: 50, in_commission: true }),
          [TARGET]: blankCell(TARGET, {
            state: 'reversed', due: true, in_commission: true,
            reversal_evidence: {
              amount: 48,
              paidToDate: '2026-02-28',
              positiveTransactionId: '8245546',
              negativeTransactionId: '8705401',
              positiveStatementMonth: '2026-02',
              negativeStatementMonth: '2026-04',
            } as any,
          }),
        },
      }),
    ], MONTHS);
    await renderMTPage();
    await waitFor(() => expect(screen.getAllByTestId('tt-content').length).toBeGreaterThan(0));
    const contents = screen.getAllByTestId('tt-content');
    const txt = contents.map(c => c.textContent || '').join(' || ');
    expect(txt).toMatch(/Paid: \$48\.00/);
    expect(txt).toMatch(/TXN 8245546/);
    expect(txt).toMatch(/cycle Feb 26/);
    expect(txt).toMatch(/Reversed: \$48\.00/);
    expect(txt).toMatch(/TXN 8705401/);
    expect(txt).toMatch(/cycle Apr 26/);
    expect(txt).toMatch(/Paid-to-date: 2026-02-28/);
  });
});
