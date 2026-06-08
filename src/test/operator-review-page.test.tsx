/**
 * C2b-2 Stage 2 — Operator Review page render contract.
 *
 * Locks:
 *  - Actionable rows render by default; satisfied rows are hidden.
 *  - The "Satisfied / FYI" filter reveals satisfied rows.
 *  - Route badge + FYI badges render.
 *  - Name enrichment reads applicant_name from the SAME projection.records
 *    loader (no second loader).
 *  - Page load performs ZERO C0 writes (no recordDecision / no
 *    applyDecisionReduction) and forces a fresh decision-index load.
 *  - runDiagnoseCycle is NOT called on mount (read-only screen).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';

const recordDecisionSpy = vi.fn();
const applyDecisionReductionSpy = vi.fn();
const loadOperatorDecisionIndexSpy = vi.fn(async (_force: boolean) => ({
  all: [], byId: new Map(), byMemberMonth: new Map(), byGrain: new Map(), fingerprint: 'empty',
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: () => ({ select: () => ({ eq: () => ({ order: () => ({ range: () => Promise.resolve({ data: [], error: null }) }) }) }) }), rpc: () => Promise.resolve({ data: null, error: null }) },
}));

vi.mock('@/contexts/BatchContext', () => ({
  useBatch: () => ({
    batches: [{ id: 'b1', statement_month: '2026-02-01' }],
    resolverIndex: null,
  }),
}));

vi.mock('@/hooks/useBatchDataVersion', () => ({
  useAllBatchesDataVersion: () => 1,
}));

vi.mock('@/hooks/useCrossBatchOverlay', () => ({
  useCrossBatchOverlay: () => ({ overlay: new Map(), loading: false, error: null, reload: vi.fn() }),
}));

vi.mock('@/lib/persistence', () => ({
  getAllNormalizedRecordsForMemberTimeline: vi.fn().mockResolvedValue([
    { member_key: 'm1', issuer_subscriber_id: 'U1', applicant_name: 'Alice Actionable', carrier: 'Ambetter' },
    { member_key: 'm2', issuer_subscriber_id: 'U2', applicant_name: 'Sam Satisfied', carrier: 'Ambetter' },
  ]),
}));

vi.mock('@/lib/canonical/mtApprovedMceCache', () => ({
  getMtAllBatchProjection: vi.fn(async (args: any) => ({
    records: await args.loader(),
    fingerprint: 'fp',
  })),
}));

vi.mock('@/lib/canonical/compGridLoader', () => ({
  loadCarrierCompRates: vi.fn().mockResolvedValue([]),
}));

// Stub the heavyweight assembler — its composition is covered by 25 unit
// tests already. The page contract under test is: render + filter + name
// enrichment + zero writes + forced decision-index load.
vi.mock('@/lib/canonical/assembleDiagnoseRouteRows', () => ({
  assembleDiagnoseRouteRows: vi.fn().mockReturnValue({
    rows: [
      {
        rowKey: 'Coverall|isid:u1|2026-02',
        carrier: 'ambetter',
        stableMemberKey: 'isid:u1',
        identity: { carrier: 'Ambetter', issuer_subscriber_id: 'U1' },
        serviceMonth: '2026-02',
        targetScope: 'Coverall',
        population: 1,
        crFlag: true,
        facts: {
          premium: { kind: 'chase_candidate' },
          dmi: { active: false, issueType: null, verificationEndDate: null, expired: false, inProgress: false, surfaceEligible: false },
          crossEntitySatisfied: { satisfied: false, satisfyingEntity: null, actualPaid: null, expectedBasis: null, amountStatus: { kind: 'not_applicable' } },
          amount: { kind: 'not_applicable' },
        },
      },
      {
        rowKey: 'Coverall|isid:u2|2026-02',
        carrier: 'ambetter',
        stableMemberKey: 'isid:u2',
        identity: { carrier: 'Ambetter', issuer_subscriber_id: 'U2' },
        serviceMonth: '2026-02',
        targetScope: 'Coverall',
        population: 1,
        crFlag: false,
        facts: {
          premium: { kind: 'chase_candidate' },
          dmi: { active: false, issueType: null, verificationEndDate: null, expired: false, inProgress: false, surfaceEligible: false },
          crossEntitySatisfied: { satisfied: true, satisfyingEntity: 'Vix', actualPaid: 10, expectedBasis: 10, amountStatus: { kind: 'correct' } },
          amount: { kind: 'not_applicable' },
        },
      },
    ],
    diagnostics: {},
  }),
}));

// Spy the writers + the decision-index loader to assert read-only behavior.
vi.mock('@/lib/canonical/operatorDecisions', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    recordDecision: (...a: any[]) => { recordDecisionSpy(...a); return Promise.resolve({}); },
    applyDecisionReduction: (...a: any[]) => { applyDecisionReductionSpy(...a); return Promise.resolve({}); },
    loadOperatorDecisionIndex: (force: boolean) => loadOperatorDecisionIndexSpy(force),
  };
});

const runDiagnoseCycleSpy = vi.fn();
vi.mock('@/lib/canonical/diagnoseAndRoute', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    runDiagnoseCycle: (...a: any[]) => { runDiagnoseCycleSpy(...a); return actual.runDiagnoseCycle(...a); },
  };
});

import OperatorReviewPage from '@/pages/OperatorReviewPage';

beforeEach(() => {
  recordDecisionSpy.mockClear();
  applyDecisionReductionSpy.mockClear();
  loadOperatorDecisionIndexSpy.mockClear();
  runDiagnoseCycleSpy.mockClear();
});

function renderPage() {
  return render(
    <MemoryRouter>
      <OperatorReviewPage />
    </MemoryRouter>,
  );
}

describe('OperatorReviewPage — read-only render', () => {
  it('renders actionable row (Alice) by default; satisfied row (Sam) hidden', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Alice Actionable')).toBeInTheDocument());
    expect(screen.queryByText('Sam Satisfied')).toBeNull();
    const badges = screen.getAllByTestId('route-badge');
    expect(badges.some((b) => b.textContent === 'chase_eligible')).toBe(true);
  });

  it('toggling "Satisfied / FYI" reveals satisfied rows', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Alice Actionable')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('filter-satisfied'));
    await waitFor(() => expect(screen.getByText('Sam Satisfied')).toBeInTheDocument());
    expect(screen.queryByText('Alice Actionable')).toBeNull();
    const badges = screen.getAllByTestId('route-badge');
    expect(badges.some((b) => b.textContent === 'satisfied')).toBe(true);
  });

  it('renders FYI badge (carrier_recognition) on the chase row', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Alice Actionable')).toBeInTheDocument());
    const row = screen.getByText('Alice Actionable').closest('tr')!;
    expect(within(row).getByTestId('fyi-badge').textContent).toBe('carrier_recognition');
  });

  it('PAGE LOAD performs ZERO C0 writes AND forces a fresh decision-index load; runDiagnoseCycle NOT called', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Alice Actionable')).toBeInTheDocument());
    expect(recordDecisionSpy).not.toHaveBeenCalled();
    expect(applyDecisionReductionSpy).not.toHaveBeenCalled();
    expect(runDiagnoseCycleSpy).not.toHaveBeenCalled();
    expect(loadOperatorDecisionIndexSpy).toHaveBeenCalled();
    expect(loadOperatorDecisionIndexSpy.mock.calls[0][0]).toBe(true);
  });
});
