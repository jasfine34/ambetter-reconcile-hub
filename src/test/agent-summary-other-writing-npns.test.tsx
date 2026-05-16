/**
 * Bundle 7 (replaces Bundle 1 Item 5): Agent Summary "Other AORs" aggregate.
 *
 * Locks:
 *   1. The aggregate row renders in the table when otherUnpaidCount > 0
 *      and is labeled by AOR ownership ("Other AORs"), not writing NPN.
 *   2. The row's unpaid_count equals the attribution-scope note's number.
 *   3. Regression guard — the page reuses the SAME canonicalUnpaidRows
 *      filter the note uses (one classifier:
 *      classifyPolicyOwnerFromCurrentAor), no parallel reclassifier.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import React from 'react';

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
  // Synthetic fixture: two AOR-bucketed unpaid rows (JF + EF) + three rows
  // whose current_policy_aor classifies as "Other" (downstream / unknown).
  const fakeUnpaid = [
    { member_key: 'a', current_policy_aor: 'Jason Fine (21055210)', estimated_missing_commission: 100 },
    { member_key: 'b', current_policy_aor: 'Erica Fine (21277051)', estimated_missing_commission: 200 },
    { member_key: 'c', current_policy_aor: 'Some Downline (99999991)', estimated_missing_commission: 50 },
    { member_key: 'd', current_policy_aor: '', estimated_missing_commission: 25 },
    { member_key: 'e', current_policy_aor: 'Allen Ford (21077804)', estimated_missing_commission: 0 },
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
      unpaidPremiumSplit: { zeroNetPremium: 0, hasPremium: 0 },
    }),
  };
});
vi.mock('@/components/BatchSelector', () => ({ BatchSelector: () => null }));
vi.mock('@/hooks/useCrossBatchOverlay', () => ({
  useCrossBatchOverlay: () => ({
    overlay: { byGrain: new Map(), lastEvaluatedAt: null, totalActiveCount: 0 },
    loading: false,
    error: null,
    reload: vi.fn(),
  }),
}));

import AgentSummaryPage from '@/pages/AgentSummaryPage';

describe('Agent Summary — Other AORs aggregate row (Bundle 7)', () => {
  it('renders aggregate row labeled "Other AORs" with unpaid_count matching the note', () => {
    render(<AgentSummaryPage />);
    const note = screen.getByTestId('agent-summary-attribution-note');
    expect(note.textContent).toMatch(/\b3\b/);

    const aggregateCell = screen.getByText(/Other AORs \(Aggregate\)/i);
    expect(aggregateCell).toBeTruthy();
    const row = aggregateCell.closest('tr');
    expect(row).toBeTruthy();
    expect(within(row as HTMLElement).getAllByText('3').length).toBeGreaterThanOrEqual(1);
  });
});

describe('Agent Summary — regression guard against re-classification (Bundle 7)', () => {
  const src = readFileSync(resolve(__dirname, '../pages/AgentSummaryPage.tsx'), 'utf8');

  it('reuses canonicalUnpaidRows + classifyPolicyOwnerFromCurrentAor for Other AORs', () => {
    expect(src).toMatch(/otherUnpaidRows\s*=\s*useMemo/);
    expect(src).toMatch(/canonicalUnpaidRows\.filter[\s\S]*?classifyPolicyOwnerFromCurrentAor[\s\S]*?===\s*'Other'/);
  });

  it('does NOT introduce a second classifier or fall back to writing-agent NPN bucketing', () => {
    expect(src).not.toMatch(/!displayedNpns\.has/);
    expect(src).not.toMatch(/function\s+classifyOther/i);
    expect(src).not.toMatch(/Other\s*Writing\s*NPN[s]?\s*Classifier/i);
    // Aggregate label is AOR-based now.
    expect(src).not.toMatch(/Other Writing NPNs \(Aggregate\)/);
    expect(src).toMatch(/Other AORs \(Aggregate\)/);
  });

  it('does not add a new helper file under src/lib/canonical/ for this aggregation', () => {
    expect(src).not.toMatch(/from\s+['"]@\/lib\/canonical\/otherWriting/i);
  });
});
