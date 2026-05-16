/**
 * Bundle 13c slice — Agent Summary cross-batch overlay wiring.
 *
 * Static guards (S1–S4) + behavior tests (B1–B8). Mirrors the
 * Dashboard wire pattern. See directive.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import React from 'react';
import {
  buildClearingOverlayMap,
  EMPTY_CLEARING_OVERLAY_MAP,
  type ClearingOverlayMap,
} from '@/lib/canonical/crossBatchOverlay';

// ---------------------------------------------------------------------------
// Static grep guards (S1–S4) — run regardless of render mocks.
// ---------------------------------------------------------------------------
const SRC = readFileSync(resolve(__dirname, '../pages/AgentSummaryPage.tsx'), 'utf8');

describe('AgentSummaryPage — static wiring guards (Bundle 13c)', () => {
  it('S1: imports the overlay hook + helpers + isReviewWorthyAdjustment from MCE', () => {
    expect(SRC).toMatch(/from\s+['"]@\/hooks\/useCrossBatchOverlay['"]/);
    expect(SRC).toMatch(/partitionUnpaidRowsByOverlay/);
    expect(SRC).toMatch(/sumEffectiveEstMissing|effectiveEstMissing/);
    expect(SRC).toMatch(/import\s+\{\s*isReviewWorthyAdjustment\s*\}\s+from\s+['"]@\/pages\/MissingCommissionExportPage['"]/);
  });

  it('S2: does NOT re-implement isReviewWorthyAdjustment inline', () => {
    expect(SRC).not.toMatch(/(?:function|const|let|var)\s+isReviewWorthyAdjustment/);
  });

  it('S3: unpaidByOwnerBucket iterates adjustedPartition.regular', () => {
    expect(SRC).toMatch(/unpaidByOwnerBucket[\s\S]*adjustedPartition\.regular/);
  });

  it('S4: legacy Number((r as any).estimated_missing_commission) sum is not used inside unpaidByOwnerBucket', () => {
    const block = SRC.match(/unpaidByOwnerBucket\s*=\s*useMemo[\s\S]*?\}\, \[adjustedPartition\]\)/);
    expect(block).toBeTruthy();
    expect(block?.[0]).not.toContain('entry.estMissing += Number((r as any).estimated_missing_commission)');
  });
});

// ---------------------------------------------------------------------------
// Behavior tests (B1–B8) — render AgentSummaryPage with synthetic fixtures.
// ---------------------------------------------------------------------------

// Synthetic unpaid rows — mutated per test via setFixture().
let FIXTURE_UNPAID: any[] = [];
let FIXTURE_OVERLAY: ClearingOverlayMap = EMPTY_CLEARING_OVERLAY_MAP;

function setFixture(unpaid: any[], overlay: ClearingOverlayMap) {
  FIXTURE_UNPAID = unpaid;
  FIXTURE_OVERLAY = overlay;
}

vi.mock('@/contexts/BatchContext', () => ({
  useBatch: () => ({
    reconciled: [],
    currentBatchId: 'b1',
    batches: [{ id: 'b1', statement_month: '2026-01-01' }],
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
  return {
    ...actual,
    filterCommissionRowsByScope: vi.fn().mockReturnValue([]),
    getExpectedPaymentBreakdown: vi.fn(() => ({
      universe: { matched: [], boOnly: [], edeOnly: [], rows: [], total: 0, matchedCount: 0, boOnlyCount: 0, edeOnlyCount: 0, boActiveNonCurrentEde: [], boIneligible: [], boActiveNonCurrentEdeCount: 0, boIneligibleCount: 0 },
      paidRows: [],
      unpaidRows: FIXTURE_UNPAID,
      paidCount: 0,
      unpaidCount: FIXTURE_UNPAID.length,
      paidSplit: { matched: 0, boOnly: 0, edeOnly: 0 },
      unpaidSplit: { matched: 0, boOnly: 0, edeOnly: 0 },
      unpaidPremiumSplit: { zeroNetPremium: 0, hasPremium: 0 },
    })),
  };
});
vi.mock('@/components/BatchSelector', () => ({ BatchSelector: () => null }));
vi.mock('@/components/CrossBatchOverlayLoadErrorBanner', () => ({
  CrossBatchOverlayLoadErrorBanner: () => null,
}));
vi.mock('@/hooks/useCrossBatchOverlay', () => ({
  useCrossBatchOverlay: () => ({
    overlay: FIXTURE_OVERLAY,
    loading: false,
    error: null,
    reload: vi.fn(),
  }),
}));

import AgentSummaryPage from '@/pages/AgentSummaryPage';

// Find the table row (within a <table>) whose first cell text matches `agentName`.
function findAgentRow(agentName: string): HTMLElement {
  const matches = screen.getAllByText(agentName);
  for (const el of matches) {
    const tr = el.closest('tr');
    if (tr) return tr as HTMLElement;
  }
  throw new Error(`No table row for ${agentName}`);
}

function cellTexts(row: HTMLElement): string[] {
  return Array.from(row.querySelectorAll('td')).map((td) => td.textContent ?? '');
}

const ERICA_AOR = 'Erica Fine (21277051)';

function ericaRow(policy: string, monthKey: string, estMissing: number) {
  return {
    carrier: 'Ambetter',
    policy_number: policy,
    issuer_subscriber_id: policy,
    expected_ede_effective_month: monthKey,
    current_policy_aor: ERICA_AOR,
    estimated_missing_commission: estMissing,
  };
}

function makeOverlay(rows: any[]): ClearingOverlayMap {
  return buildClearingOverlayMap(
    rows.map((r) => ({
      policy_identity_key: r.policy_identity_key,
      target_service_month: r.target_service_month,
      clearing_state: r.clearing_state,
      expected_amount: r.expected_amount ?? null,
      actual_net_amount: r.actual_net_amount ?? null,
      actual_positive_amount: r.actual_positive_amount ?? null,
      actual_reversal_amount: r.actual_reversal_amount ?? null,
      remainder_owed: r.remainder_owed ?? null,
      unpaid_batch_ids: r.unpaid_batch_ids ?? [],
      payment_batch_ids: r.payment_batch_ids ?? [],
      evaluated_at: r.evaluated_at ?? '2026-05-16T18:52:15Z',
      run_id: r.run_id ?? 'test-run',
      manual_review_reason: r.manual_review_reason ?? null,
    })),
  );
}

beforeEach(() => {
  FIXTURE_UNPAID = [];
  FIXTURE_OVERLAY = EMPTY_CLEARING_OVERLAY_MAP;
});

describe('AgentSummaryPage — overlay behavior (Bundle 13c)', () => {
  it('B1: fully_cleared excluded from per-agent unpaid count', () => {
    const r = ericaRow('u70225950', '2026-01', 31.61);
    setFixture(
      [r],
      makeOverlay([{
        policy_identity_key: 'ambetter|u70225950',
        target_service_month: '2026-01',
        clearing_state: 'fully_cleared',
        expected_amount: 0.5,
        actual_net_amount: 0.5,
        remainder_owed: 0,
      }]),
    );
    render(<AgentSummaryPage />);
    const row = findAgentRow('Erica Fine');
    const cells = cellTexts(row);
    // Columns: Agent, NPN, Expected (AOR), Written by, Back Office, Eligible, Paid, Unpaid, Needs Review, Total Commission, Est. Missing
    expect(cells[7]).toBe('0'); // Unpaid
    expect(cells[10]).toContain('0'); // Est. Missing
  });

  it('B2: partial_cleared contributes only remainder to Est. Missing', () => {
    const r = ericaRow('p123', '2026-01', 34);
    setFixture(
      [r],
      makeOverlay([{
        policy_identity_key: 'ambetter|p123',
        target_service_month: '2026-01',
        clearing_state: 'partially_cleared',
        expected_amount: 34,
        actual_net_amount: 33.5,
        remainder_owed: 0.5,
      }]),
    );
    render(<AgentSummaryPage />);
    const row = findAgentRow('Erica Fine');
    const cells = cellTexts(row);
    expect(cells[7]).toBe('1'); // Unpaid still counted
    expect(cells[10]).toContain('0.5'); // remainder only
    expect(cells[10]).not.toContain('34');
  });

  it('B3: cleared_then_reversed excluded from regular bucket', () => {
    const r = ericaRow('p456', '2026-01', 20);
    setFixture(
      [r],
      makeOverlay([{
        policy_identity_key: 'ambetter|p456',
        target_service_month: '2026-01',
        clearing_state: 'cleared_then_reversed',
        expected_amount: 20,
        actual_net_amount: 0,
        remainder_owed: 20,
      }]),
    );
    render(<AgentSummaryPage />);
    const row = findAgentRow('Erica Fine');
    const cells = cellTexts(row);
    expect(cells[7]).toBe('0');
  });

  it('B4: Needs Review count = manual_review_required rows', () => {
    const r = ericaRow('p789', '2026-01', 10);
    setFixture(
      [r],
      makeOverlay([{
        policy_identity_key: 'ambetter|p789',
        target_service_month: '2026-01',
        clearing_state: 'manual_review_required',
        expected_amount: 10,
        actual_net_amount: 0,
        remainder_owed: 10,
      }]),
    );
    render(<AgentSummaryPage />);
    const row = findAgentRow('Erica Fine');
    const cells = cellTexts(row);
    expect(cells[7]).toBe('1'); // still in regular
    expect(cells[8]).toBe('1'); // Needs Review
  });

  it('B5: partial_amount_unavailable counts as needs review and stays in regular', () => {
    const r = ericaRow('p999', '2026-01', 15);
    setFixture(
      [r],
      makeOverlay([{
        policy_identity_key: 'ambetter|p999',
        target_service_month: '2026-01',
        clearing_state: 'partially_cleared',
        expected_amount: null,
        actual_net_amount: null,
        remainder_owed: null,
      }]),
    );
    render(<AgentSummaryPage />);
    const row = findAgentRow('Erica Fine');
    const cells = cellTexts(row);
    expect(cells[7]).toBe('1');
    expect(cells[8]).toBe('1');
  });

  it('B6: Other AORs aggregate uses adjusted rows (fully_cleared excluded)', () => {
    const r = {
      carrier: 'Ambetter',
      policy_number: 'oth1',
      issuer_subscriber_id: 'oth1',
      expected_ede_effective_month: '2026-01',
      current_policy_aor: 'Some Downline (99999991)',
      estimated_missing_commission: 50,
    };
    setFixture(
      [r],
      makeOverlay([{
        policy_identity_key: 'ambetter|oth1',
        target_service_month: '2026-01',
        clearing_state: 'fully_cleared',
        expected_amount: 50,
        actual_net_amount: 50,
        remainder_owed: 0,
      }]),
    );
    render(<AgentSummaryPage />);
    // Aggregate row should not render at all since otherUnpaidCount === 0
    expect(screen.queryByText(/Other AORs \(Aggregate\)/i)).toBeNull();
  });

  it('B7: Bundle 13d override propagates — remainder=0 reduces EF dollars', () => {
    const r = ericaRow('p13d', '2026-01', 34); // legacy estimate $34
    setFixture(
      [r],
      makeOverlay([{
        policy_identity_key: 'ambetter|p13d',
        target_service_month: '2026-01',
        clearing_state: 'fully_cleared',
        expected_amount: 0.5,
        actual_net_amount: 0.5,
        remainder_owed: 0,
      }]),
    );
    render(<AgentSummaryPage />);
    const row = findAgentRow('Erica Fine');
    const cells = cellTexts(row);
    expect(cells[7]).toBe('0');
    expect(cells[10]).toContain('0');
    expect(cells[10]).not.toContain('34');
  });

  it('B8: empty overlay → rows fall through to regular with legacy dollars', () => {
    const r = ericaRow('pNone', '2026-01', 12.34);
    setFixture([r], EMPTY_CLEARING_OVERLAY_MAP);
    render(<AgentSummaryPage />);
    const row = findAgentRow('Erica Fine');
    const cells = cellTexts(row);
    expect(cells[7]).toBe('1');
    expect(cells[10]).toContain('12.34');
  });
});
