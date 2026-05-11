/**
 * Agent Summary unpaid alignment (Phase 1.6).
 *
 * Proves AgentSummaryPage's Unpaid column and Est. Missing column derive
 * from getExpectedPaymentBreakdown(...).unpaidRows — covering Matched +
 * BO Only + EDE Only unpaid — and exclude paid rows and the
 * "BO Active: Non-current EDE" diagnostic. Also asserts:
 *   - the legacy narrow predicate is no longer present in the page source;
 *   - getEligibleCohort is not imported by the page;
 *   - the attribution-scope note renders.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { getExpectedPaymentBreakdown } from '@/lib/canonical';
import type { FilteredEdeResult } from '@/lib/expectedEde';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { vi } from 'vitest';

// -- helper-level fixture ----------------------------------------------------

function buildFixture() {
  // Agent X (NPN 'X1') has:
  //   - 1 Matched unpaid     (in_ede, in_bo, eligible Yes, !in_commission)
  //   - 1 BO Only unpaid     (!in_ede, in_bo, eligible Yes, !in_commission)
  //   - 1 EDE Only unpaid    (in_ede, !in_bo, eligibility blank, !in_commission)
  //   - 1 Matched paid       (in_commission=true)            ← MUST be excluded
  //   - 1 BO Active: Non-current EDE diagnostic              ← MUST be excluded
  //       (!in_ee_universe, in_bo, eligible Yes, raw in_ede=true)
  const reconciled: any[] = [
    { member_key: 'm1', agent_npn: 'X1', in_ede: true,  in_back_office: true,  eligible_for_commission: 'Yes', in_commission: false, estimated_missing_commission: 100, expected_pay_entity: 'Coverall' },
    { member_key: 'm2', agent_npn: 'X1', in_ede: false, in_back_office: true,  eligible_for_commission: 'Yes', in_commission: false, estimated_missing_commission: 200, expected_pay_entity: 'Coverall' },
    { member_key: 'm3', agent_npn: 'X1', in_ede: true,  in_back_office: false, eligible_for_commission: '',    in_commission: false, estimated_missing_commission: 50,  expected_pay_entity: 'Coverall' },
    { member_key: 'm4', agent_npn: 'X1', in_ede: true,  in_back_office: true,  eligible_for_commission: 'Yes', in_commission: true,  estimated_missing_commission: 999, expected_pay_entity: 'Coverall' },
    { member_key: 'm5', agent_npn: 'X1', in_ede: true,  in_back_office: true,  eligible_for_commission: 'Yes', in_commission: false, estimated_missing_commission: 777, expected_pay_entity: 'Coverall' },
  ];
  // Current EE universe: m1, m3, m4 only. m2 -> true BO Only.
  // m5 has raw in_ede=true but is NOT in current EE universe → diagnostic.
  const filteredEde: FilteredEdeResult = {
    uniqueMembers: ['m1', 'm3', 'm4'].map((mk) => ({
      member_key: mk, applicant_name: mk, policy_number: '', exchange_subscriber_id: '', issuer_subscriber_id: '',
      current_policy_aor: '', effective_date: '2026-02-01', policy_status: 'Effectuated',
      covered_member_count: 1, effective_month: '2026-02', active_months: ['2026-02'], in_back_office: false,
    })),
    uniqueKeys: 3, byMonth: { '2026-02': 3 }, inBOCount: 2, notInBOCount: 1, missingFromBO: [],
  };
  return { reconciled, filteredEde };
}

/** Mirrors the page's grouping of canonical unpaid rows by writing-agent NPN. */
function groupUnpaidByNpn(unpaidRows: any[]) {
  const m = new Map<string, { count: number; estMissing: number }>();
  for (const r of unpaidRows) {
    const npn = String(r.agent_npn || '').trim();
    if (!npn) continue;
    const entry = m.get(npn) ?? { count: 0, estMissing: 0 };
    entry.count += 1;
    entry.estMissing += Number(r.estimated_missing_commission) || 0;
    m.set(npn, entry);
  }
  return m;
}

describe('Agent Summary canonical unpaid grouping', () => {
  it('Unpaid count equals 3 (Matched + BO Only + EDE Only); paid + diagnostic excluded', () => {
    const { reconciled, filteredEde } = buildFixture();
    const { unpaidRows, universe } = getExpectedPaymentBreakdown(
      reconciled,
      'All',
      filteredEde,
      new Set<string>(),
    );
    const grouped = groupUnpaidByNpn(unpaidRows);
    const entry = grouped.get('X1')!;
    expect(entry).toBeDefined();
    expect(entry.count).toBe(3);
    // Diagnostic bucket separates m5 out, paid m4 lives in paidRows.
    expect(universe.boActiveNonCurrentEdeCount).toBe(1);
    expect(unpaidRows.find((r) => r.member_key === 'm4')).toBeUndefined();
    expect(unpaidRows.find((r) => r.member_key === 'm5')).toBeUndefined();
  });

  it('Includes BO Only unpaid rows (the Becky-style fix)', () => {
    const { reconciled, filteredEde } = buildFixture();
    const { unpaidRows } = getExpectedPaymentBreakdown(reconciled, 'All', filteredEde, new Set());
    expect(unpaidRows.map((r) => r.member_key).sort()).toEqual(['m1', 'm2', 'm3']);
  });

  it('Est. Missing sums ONLY canonical unpaid rows for the agent', () => {
    // m1=100 + m2=200 + m3=50 = 350. The paid m4 (999) and diagnostic m5
    // (777) must NOT contribute, otherwise count and dollars would diverge.
    const { reconciled, filteredEde } = buildFixture();
    const { unpaidRows } = getExpectedPaymentBreakdown(reconciled, 'All', filteredEde, new Set());
    const grouped = groupUnpaidByNpn(unpaidRows);
    expect(grouped.get('X1')!.estMissing).toBe(350);
  });
});

describe('AgentSummaryPage source — legacy predicate removed', () => {
  const src = readFileSync(resolve(__dirname, '../pages/AgentSummaryPage.tsx'), 'utf8');

  it('does not use the legacy narrow unpaid predicate', () => {
    // The exact legacy AND-chain must not appear in the page anymore.
    expect(src).not.toMatch(/r\.in_ede\s*&&\s*r\.in_back_office\s*&&\s*r\.eligible_for_commission\s*===\s*'Yes'\s*&&\s*!r\.in_commission/);
  });

  it('does not import getEligibleCohort', () => {
    expect(src).not.toMatch(/getEligibleCohort/);
  });

  it('imports getExpectedPaymentBreakdown', () => {
    expect(src).toMatch(/getExpectedPaymentBreakdown/);
  });
});

// -- attribution-note render test -------------------------------------------

vi.mock('@/contexts/BatchContext', () => ({
  useBatch: () => ({ reconciled: [], currentBatchId: null, batches: [], resolverIndex: null }),
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
  computeFilteredEde: vi.fn().mockReturnValue({ uniqueMembers: [], uniqueKeys: 0, byMonth: {}, inBOCount: 0, notInBOCount: 0, missingFromBO: [] }),
}));
vi.mock('@/components/BatchSelector', () => ({ BatchSelector: () => null }));

import AgentSummaryPage from '@/pages/AgentSummaryPage';

describe('AgentSummaryPage render — attribution-scope note', () => {
  it('renders the attribution-scope disclosure', () => {
    render(<AgentSummaryPage />);
    const note = screen.getByTestId('agent-summary-attribution-note');
    expect(note).toBeTruthy();
    expect(note.textContent || '').toMatch(/canonical Expected But Unpaid universe/i);
    expect(note.textContent || '').toMatch(/Jason, Erica, Becky/);
  });
});
