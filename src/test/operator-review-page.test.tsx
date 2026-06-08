/**
 * C2b-2 — Operator Review page contract.
 *
 * Stage 2 locks:
 *  - Actionable rows render by default; satisfied rows are hidden.
 *  - The "Satisfied / FYI" filter reveals satisfied rows.
 *  - Route badge + FYI badges render.
 *  - Name enrichment reads applicant_name from projection.records.
 *  - Page load performs ZERO C0 writes and forces a fresh
 *    decision-index load.
 *  - runDiagnoseCycle is NOT called on mount.
 *
 * Stage 3 locks (this batch):
 *  - Hold action writes RecordDecisionInput on the CLICKED row's keys
 *    (OR1 right-row guard — a Coverall hold must NOT also write Vix).
 *  - Reason-code SELECT exposes ONLY REASON_CODES_BY_TYPE entries
 *    (OR3 reason-code guard); validation throws surface as failed writes.
 *  - Action + run-cycle buttons disable while a write/cycle is pending
 *    (OR4 in-flight guard).
 *  - Deferred actions (add_to_chase / dismiss_cr_flag / scope_correct)
 *    are NOT rendered.
 *  - Run-cycle button calls runDiagnoseCycle (the ONLY persisting path)
 *    and surfaces appliedReleases.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';

const recordDecisionSpy = vi.fn();
const applyDecisionReductionSpy = vi.fn();
const invalidateCacheSpy = vi.fn();
const loadOperatorDecisionIndexSpy = vi.fn(async (_force: boolean) => ({
  all: [], byId: new Map(), byMemberMonth: new Map(), byGrain: new Map(), fingerprint: 'empty',
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: () => ({ select: () => ({ eq: () => ({ order: () => ({ range: () => Promise.resolve({ data: [], error: null }) }) }) }) }), rpc: () => Promise.resolve({ data: null, error: null }) },
}));

const __batches = [{ id: 'b1', statement_month: '2026-02-01' }];
vi.mock('@/contexts/BatchContext', () => ({
  useBatch: () => ({ batches: __batches, resolverIndex: null }),
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

// Default assembler output (Stage 2 baseline). Tests can override per-case.
const aliceCoverall = {
  rowKey: 'Coverall|isid:u1|2026-02',
  carrier: 'ambetter',
  stableMemberKey: 'isid:u1',
  identity: { carrier: 'Ambetter', issuer_subscriber_id: 'U1' },
  serviceMonth: '2026-02',
  targetScope: 'Coverall' as const,
  population: 1 as const,
  crFlag: true,
  facts: {
    premium: { kind: 'chase_candidate' },
    dmi: { active: false, issueType: null, verificationEndDate: null, expired: false, inProgress: false, surfaceEligible: false },
    crossEntitySatisfied: { satisfied: false, satisfyingEntity: null, actualPaid: null, expectedBasis: null, amountStatus: { kind: 'not_applicable' } },
    amount: { kind: 'not_applicable' },
  },
};
const samCoverall = {
  rowKey: 'Coverall|isid:u2|2026-02',
  carrier: 'ambetter',
  stableMemberKey: 'isid:u2',
  identity: { carrier: 'Ambetter', issuer_subscriber_id: 'U2' },
  serviceMonth: '2026-02',
  targetScope: 'Coverall' as const,
  population: 1 as const,
  crFlag: false,
  facts: {
    premium: { kind: 'chase_candidate' },
    dmi: { active: false, issueType: null, verificationEndDate: null, expired: false, inProgress: false, surfaceEligible: false },
    crossEntitySatisfied: { satisfied: true, satisfyingEntity: 'Vix', actualPaid: 10, expectedBasis: 10, amountStatus: { kind: 'correct' } },
    amount: { kind: 'not_applicable' },
  },
};
const aliceVix = {
  rowKey: 'Vix|isid:u1|2026-02',
  carrier: 'ambetter',
  stableMemberKey: 'isid:u1',
  identity: { carrier: 'Ambetter', issuer_subscriber_id: 'U1' },
  serviceMonth: '2026-02',
  targetScope: 'Vix' as const,
  population: 1 as const,
  crFlag: true,
  facts: {
    premium: { kind: 'chase_candidate' },
    dmi: { active: false, issueType: null, verificationEndDate: null, expired: false, inProgress: false, surfaceEligible: false },
    crossEntitySatisfied: { satisfied: false, satisfyingEntity: null, actualPaid: null, expectedBasis: null, amountStatus: { kind: 'not_applicable' } },
    amount: { kind: 'not_applicable' },
  },
};

vi.mock('@/lib/canonical/assembleDiagnoseRouteRows', () => ({
  assembleDiagnoseRouteRows: vi.fn().mockReturnValue({
    rows: [aliceCoverall, samCoverall],
    diagnostics: {},
  }),
}));

vi.mock('@/lib/canonical/operatorDecisions', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    recordDecision: (...a: any[]) => recordDecisionSpy(...a),
    applyDecisionReduction: (...a: any[]) => { applyDecisionReductionSpy(...a); return Promise.resolve({}); },
    loadOperatorDecisionIndex: (force: boolean) => loadOperatorDecisionIndexSpy(force),
    invalidateOperatorDecisionCache: () => invalidateCacheSpy(),
  };
});

const runDiagnoseCycleSpy = vi.fn();
vi.mock('@/lib/canonical/diagnoseAndRoute', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    runDiagnoseCycle: (...a: any[]) => runDiagnoseCycleSpy(...a),
  };
});

import OperatorReviewPage from '@/pages/OperatorReviewPage';
import { assembleDiagnoseRouteRows } from '@/lib/canonical/assembleDiagnoseRouteRows';
import {
  REASON_CODES_BY_TYPE,
  OperatorDecisionValidationError,
} from '@/lib/canonical/operatorDecisions';

beforeEach(() => {
  recordDecisionSpy.mockReset();
  recordDecisionSpy.mockResolvedValue({});
  applyDecisionReductionSpy.mockClear();
  invalidateCacheSpy.mockClear();
  loadOperatorDecisionIndexSpy.mockClear();
  runDiagnoseCycleSpy.mockReset();
  runDiagnoseCycleSpy.mockResolvedValue({
    routes: new Map(), queues: {}, chaseEligible: [], satisfied: [], fyi: new Map(),
    appliedReleases: [], observedNoopSignals: [],
  });
  (assembleDiagnoseRouteRows as any).mockReturnValue({
    rows: [aliceCoverall, samCoverall],
    diagnostics: {},
  });
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

describe('OperatorReviewPage — Stage 3 hold actions + run-cycle', () => {
  it('hold-premium on chase row writes correct RecordDecisionInput; row reflects hold after refresh', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Alice Actionable')).toBeInTheDocument());
    const row = screen.getByText('Alice Actionable').closest('tr')!;
    fireEvent.click(within(row).getByTestId('action-hold_premium'));
    // Prompt opens
    await waitFor(() => expect(screen.getByTestId('hold-prompt')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('hold-submit'));

    await waitFor(() => expect(recordDecisionSpy).toHaveBeenCalledTimes(1));
    const arg = recordDecisionSpy.mock.calls[0][0];
    expect(arg.decision_type).toBe('hold_premium');
    expect(arg.reason_code).toBe('awaiting_premium');
    expect(arg.release_rule).toBe('auto_premium');
    expect(arg.service_month).toBe('2026-02');
    expect(arg.target_scope).toBe('Coverall');
    expect(arg.identity.issuer_subscriber_id).toBe('U1');

    // Cache invalidated + reproject called.
    await waitFor(() => expect(invalidateCacheSpy).toHaveBeenCalled());
    // Decision index re-loaded with force=true after the write.
    await waitFor(() =>
      expect(loadOperatorDecisionIndexSpy.mock.calls.some((c) => c[0] === true)).toBe(true),
    );
  });

  it('OR1: hold on the CLICKED Coverall row does NOT also write the Vix row', async () => {
    (assembleDiagnoseRouteRows as any).mockReturnValue({
      rows: [aliceCoverall, aliceVix],
      diagnostics: {},
    });
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId('op-row').length).toBe(2));
    const coverallRow = screen
      .getAllByTestId('op-row')
      .find((tr) => tr.getAttribute('data-row-key') === 'Coverall|isid:u1|2026-02')!;
    fireEvent.click(within(coverallRow).getByTestId('action-hold_premium'));
    await waitFor(() => expect(screen.getByTestId('hold-prompt')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('hold-submit'));

    await waitFor(() => expect(recordDecisionSpy).toHaveBeenCalledTimes(1));
    const arg = recordDecisionSpy.mock.calls[0][0];
    expect(arg.target_scope).toBe('Coverall');
    expect(arg.identity.issuer_subscriber_id).toBe('U1');
    // No second write targeting the Vix scope.
    expect(
      recordDecisionSpy.mock.calls.some((c) => c[0].target_scope === 'Vix'),
    ).toBe(false);
  });

  it('OR3: reason-code select offers ONLY REASON_CODES_BY_TYPE[hold_premium] entries', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Alice Actionable')).toBeInTheDocument());
    const row = screen.getByText('Alice Actionable').closest('tr')!;
    fireEvent.click(within(row).getByTestId('action-hold_premium'));
    await waitFor(() => expect(screen.getByTestId('hold-prompt')).toBeInTheDocument());
    // Open the select (Radix renders options on open).
    fireEvent.pointerDown(
      screen.getByTestId('hold-reason-select'),
      new (window as any).PointerEvent('pointerdown', { bubbles: true, button: 0, ctrlKey: false }),
    );
    fireEvent.click(screen.getByTestId('hold-reason-select'));
    await waitFor(() => {
      for (const code of REASON_CODES_BY_TYPE.hold_premium) {
        expect(screen.queryByTestId(`reason-${code}`)).not.toBeNull();
      }
    });
    // An out-of-list code is not offered.
    expect(screen.queryByTestId('reason-prior_balance_owed')).toBeNull();
  });

  it('OR3: a thrown validation error from recordDecision surfaces as a FAILED write (prompt stays open, no spurious success)', async () => {
    recordDecisionSpy.mockRejectedValueOnce(
      new OperatorDecisionValidationError('reason_code "x" not allowed for decision_type "hold_premium"'),
    );
    renderPage();
    await waitFor(() => expect(screen.getByText('Alice Actionable')).toBeInTheDocument());
    const row = screen.getByText('Alice Actionable').closest('tr')!;
    fireEvent.click(within(row).getByTestId('action-hold_premium'));
    await waitFor(() => expect(screen.getByTestId('hold-prompt')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('hold-submit'));
    await waitFor(() => expect(recordDecisionSpy).toHaveBeenCalledTimes(1));
    // Prompt remains open after failure; no cache invalidation occurred.
    await waitFor(() => expect(screen.getByTestId('hold-prompt')).toBeInTheDocument());
    expect(invalidateCacheSpy).not.toHaveBeenCalled();
  });

  it('OR4: action + run-cycle buttons disable while a hold write is in-flight', async () => {
    let resolveWrite: (v: unknown) => void = () => {};
    recordDecisionSpy.mockImplementationOnce(
      () => new Promise((res) => { resolveWrite = res; }),
    );
    renderPage();
    await waitFor(() => expect(screen.getByText('Alice Actionable')).toBeInTheDocument());
    const row = screen.getByText('Alice Actionable').closest('tr')!;
    fireEvent.click(within(row).getByTestId('action-hold_premium'));
    await waitFor(() => expect(screen.getByTestId('hold-prompt')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('hold-submit'));

    // While pending, action + run-cycle disabled.
    await waitFor(() => {
      expect((within(row).getByTestId('action-hold_premium') as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByTestId('run-cycle') as HTMLButtonElement).disabled).toBe(true);
    });
    await act(async () => { resolveWrite({}); });
  });

  it('deferred actions (add_to_chase / dismiss_cr_flag / scope_correct) are NOT rendered', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Alice Actionable')).toBeInTheDocument());
    expect(screen.queryByTestId('action-add_to_chase')).toBeNull();
    expect(screen.queryByTestId('action-dismiss_cr_flag')).toBeNull();
    expect(screen.queryByTestId('action-scope_correct')).toBeNull();
  });

  it('run-cycle button calls runDiagnoseCycle and surfaces appliedReleases summary', async () => {
    runDiagnoseCycleSpy.mockResolvedValueOnce({
      routes: new Map(), queues: {}, chaseEligible: [], satisfied: [], fyi: new Map(),
      appliedReleases: [{ id: 'dec-1' } as any, { id: 'dec-2' } as any],
      observedNoopSignals: [{ decisionId: 'dec-3', signals: {}, reason: 'sticky_no_signal' }],
    });
    renderPage();
    await waitFor(() => expect(screen.getByText('Alice Actionable')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('run-cycle'));
    await waitFor(() => expect(runDiagnoseCycleSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      const s = screen.getByTestId('cycle-summary');
      expect(s.textContent).toMatch(/applied 2 release/);
      expect(s.textContent).toMatch(/dec-1/);
      expect(s.textContent).toMatch(/dec-2/);
      expect(s.textContent).toMatch(/1 no-op/);
    });
    // The READ path still wrote nothing on its own.
    expect(recordDecisionSpy).not.toHaveBeenCalled();
    expect(applyDecisionReductionSpy).not.toHaveBeenCalled();
  });
});
