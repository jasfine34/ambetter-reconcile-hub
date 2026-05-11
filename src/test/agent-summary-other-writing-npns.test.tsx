/**
 * Bundle 1 — Item 5: Agent Summary "Other Writing NPNs" aggregate row.
 *
 * Locks:
 *   1. The aggregate row renders in the table when otherUnpaidCount > 0.
 *   2. The row's unpaid_count equals the attribution-scope note's number.
 *   3. Regression guard — the page reuses the SAME canonicalUnpaidRows
 *      filter the note uses and does NOT introduce a second
 *      classification helper / inline reducer that re-derives "Other
 *      Writing NPNs" from scratch.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import React from 'react';

// Synthetic fixture: two displayed-NPN unpaid rows + three "Other" unpaid
// rows (NPNs not in NPN_MAP). We expect the aggregate row to show 3.
const FAKE_UNPAID = [
  { member_key: 'a', agent_npn: '21055210', estimated_missing_commission: 100 }, // Jason
  { member_key: 'b', agent_npn: '21277051', estimated_missing_commission: 200 }, // Erica
  { member_key: 'c', agent_npn: '99999991', estimated_missing_commission: 50 },
  { member_key: 'd', agent_npn: '99999992', estimated_missing_commission: 25 },
  { member_key: 'e', agent_npn: '99999993', estimated_missing_commission: 0 },
];

vi.mock('@/contexts/BatchContext', () => ({
  useBatch: () => ({
    reconciled: [],
    currentBatchId: 'b1',
    batches: [{ id: 'b1', statement_month: '2026-02-01' }],
    resolverIndex: null,
  }),
}));
vi.mock('@/lib/persistence', () => ({
  getNormalizedRecords: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/lib/weakMatch', () => ({
  loadWeakMatchOverrides: vi.fn().mockResolvedValue(new Map()),
  findWeakMatches: vi.fn().mockReturnValue([]),
  applyOverrides: vi.fn().mockReturnValue({ confirmedKeys: new Set(), rejectedKeys: new Set() }),
  pickStableKey: vi.fn().mockReturnValue(null),
}));
vi.mock('@/lib/expectedEde', () => ({
  computeFilteredEde: vi.fn().mockReturnValue({
    uniqueMembers: [], uniqueKeys: 0, byMonth: {}, inBOCount: 0, notInBOCount: 0, missingFromBO: [],
  }),
}));
vi.mock('@/lib/canonical', async (importOriginal) => {
  const actual: any = await importOriginal();
  // Synthetic fixture: two displayed-NPN unpaid rows + three "Other" unpaid
  // rows (NPNs not in NPN_MAP). We expect the aggregate row to show 3.
  const fakeUnpaid = [
    { member_key: 'a', agent_npn: '21055210', estimated_missing_commission: 100 },
    { member_key: 'b', agent_npn: '21277051', estimated_missing_commission: 200 },
    { member_key: 'c', agent_npn: '99999991', estimated_missing_commission: 50 },
    { member_key: 'd', agent_npn: '99999992', estimated_missing_commission: 25 },
    { member_key: 'e', agent_npn: '99999993', estimated_missing_commission: 0 },
  ];
  return {
    ...actual,
    filterCommissionRowsByScope: vi.fn().mockReturnValue([]),
    getExpectedPaymentBreakdown: vi.fn().mockReturnValue({
      universe: { matched: [], boOnly: [], edeOnly: [], rows: [], total: 0, matchedCount: 0, boOnlyCount: 0, edeOnlyCount: 0, boActiveNonCurrentEde: [], boIneligible: [], boActiveNonCurrentEdeCount: 0, boIneligibleCount: 0 },
      paidRows: [],
      unpaidRows: fakeUnpaid,
      paidCount: 0,
      unpaidCount: fakeUnpaid.length,
      paidSplit: { matched: 0, boOnly: 0, edeOnly: 0 },
      unpaidSplit: { matched: 0, boOnly: 0, edeOnly: 0 },
    }),
  };
});
vi.mock('@/components/BatchSelector', () => ({ BatchSelector: () => null }));

import AgentSummaryPage from '@/pages/AgentSummaryPage';

describe('Agent Summary — Other Writing NPNs aggregate row', () => {
  it('renders an aggregate row with unpaid_count matching the attribution-note count', () => {
    render(<AgentSummaryPage />);
    // Note shows the count.
    const note = screen.getByTestId('agent-summary-attribution-note');
    expect(note.textContent).toMatch(/\b3\b/);

    // Table contains the aggregate row.
    const aggregateCell = screen.getByText(/Other Writing NPNs \(Aggregate\)/i);
    expect(aggregateCell).toBeTruthy();
    const row = aggregateCell.closest('tr');
    expect(row).toBeTruthy();
    // The unpaid_count cell in that row should read "3" (matches the note).
    expect(within(row as HTMLElement).getByText('3')).toBeTruthy();
  });
});

describe('Agent Summary — regression guard against re-classification', () => {
  const src = readFileSync(resolve(__dirname, '../pages/AgentSummaryPage.tsx'), 'utf8');

  it('reuses canonicalUnpaidRows (no parallel data source) for Other Writing NPNs', () => {
    // The "other" rows must derive from canonicalUnpaidRows filtered by
    // !displayedNpns.has(...). Lock that single source.
    expect(src).toMatch(/otherUnpaidRows\s*=\s*useMemo/);
    expect(src).toMatch(/canonicalUnpaidRows\.filter[\s\S]*?!displayedNpns\.has/);
  });

  it('does NOT introduce a second classifier (e.g. re-iterating filteredEde / reconciled to derive "Other")', () => {
    // Crude but effective regression guard: no second `.filter(... !displayedNpns ...)`
    // over a different source, and no helper named *OtherNpn* invented inside
    // this page.
    const matches = src.match(/!displayedNpns\.has/g) || [];
    // One reference: inside otherUnpaidRows useMemo.
    expect(matches.length).toBe(1);
    expect(src).not.toMatch(/function\s+classifyOther/i);
    expect(src).not.toMatch(/Other\s*Writing\s*NPN[s]?\s*Classifier/i);
  });

  it('does not add a new helper file under src/lib/canonical/ for this aggregation', () => {
    // Just affirm the page does NOT import a new "otherWritingNpn" canonical helper.
    expect(src).not.toMatch(/from\s+['"]@\/lib\/canonical\/otherWriting/i);
  });
});
