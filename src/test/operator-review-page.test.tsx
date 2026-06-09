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

vi.mock('@/lib/canonical/assembleDiagnoseRouteRows', () => ({
  // Default rows are injected via beforeEach below; factory must be hoist-safe.
  assembleDiagnoseRouteRows: vi.fn().mockReturnValue({ rows: [], diagnostics: {} }),
}));

// Test fixtures (referenced from beforeEach, NOT from any vi.mock factory).
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

function renderPage(props: any = {}) {
  return render(
    <MemoryRouter>
      <OperatorReviewPage {...props} />
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
    // Same-member group now collapses by default — first row (Coverall sorts before Vix) renders;
    // expand the group via the +N toggle to reveal Vix.
    await waitFor(() => expect(screen.getAllByTestId('op-row').length).toBe(1));
    fireEvent.click(screen.getByTestId('member-toggle'));
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

  it('OR3: reason-code SELECT is bound to REASON_CODES_BY_TYPE (no free-text reason); default is in the allowed list', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Alice Actionable')).toBeInTheDocument());
    const row = screen.getByText('Alice Actionable').closest('tr')!;
    fireEvent.click(within(row).getByTestId('action-hold_premium'));
    await waitFor(() => expect(screen.getByTestId('hold-prompt')).toBeInTheDocument());

    // The trigger displays the CURRENT reason_code (a valid REASON_CODES_BY_TYPE entry).
    const trigger = screen.getByTestId('hold-reason-select');
    expect(trigger.textContent).toMatch(/awaiting_premium/);
    expect(REASON_CODES_BY_TYPE.hold_premium).toContain('awaiting_premium');
    // The internal-note textarea is the ONLY free-text input; it is separate from reason_code.
    expect(screen.getByTestId('hold-internal-note').tagName).toBe('TEXTAREA');

    // Submitting goes through with the allowed default.
    fireEvent.click(screen.getByTestId('hold-submit'));
    await waitFor(() => expect(recordDecisionSpy).toHaveBeenCalledTimes(1));
    expect(recordDecisionSpy.mock.calls[0][0].reason_code).toBe('awaiting_premium');
    expect(REASON_CODES_BY_TYPE.hold_premium).toContain(
      recordDecisionSpy.mock.calls[0][0].reason_code,
    );
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

// ─────────────────────────────────────────────────────────────────────────
// C2c — chip filter / DMI work-surface / evidence drawer tests.
// ─────────────────────────────────────────────────────────────────────────

function mkRow(over: Partial<any> & { rowKey: string; targetScope: 'Coverall' | 'Vix' }): any {
  return {
    rowKey: over.rowKey,
    carrier: 'ambetter',
    stableMemberKey: over.stableMemberKey ?? over.rowKey.split('|')[1],
    identity: { carrier: 'Ambetter', issuer_subscriber_id: over.stableMemberKey ?? 'X' },
    serviceMonth: over.serviceMonth ?? '2026-02',
    targetScope: over.targetScope,
    population: over.population ?? 1,
    crFlag: over.crFlag ?? false,
    facts: over.facts ?? {
      premium: { kind: 'chase_candidate' },
      dmi: { active: false, issueType: null, verificationEndDate: null, expired: false, inProgress: false, surfaceEligible: false },
      crossEntitySatisfied: { satisfied: false, satisfyingEntity: null, actualPaid: null, expectedBasis: null, amountStatus: { kind: 'not_applicable' } },
      amount: { kind: 'not_applicable' },
    },
  };
}

const chaseRow = mkRow({ rowKey: 'Coverall|isid:c1|2026-02', targetScope: 'Coverall' });
const premiumRow = mkRow({
  rowKey: 'Coverall|isid:p1|2026-02',
  targetScope: 'Coverall',
  facts: {
    premium: { kind: 'premium_blocked' },
    dmi: { active: false, issueType: null, verificationEndDate: null, expired: false, inProgress: false, surfaceEligible: false },
    crossEntitySatisfied: { satisfied: false, satisfyingEntity: null, actualPaid: null, expectedBasis: null, amountStatus: { kind: 'not_applicable' } },
    amount: { kind: 'not_applicable' },
  },
});
const amountRow = mkRow({
  rowKey: 'Coverall|isid:a1|2026-02',
  targetScope: 'Coverall',
  population: 2,
  facts: {
    premium: { kind: 'chase_candidate' },
    dmi: { active: false, issueType: null, verificationEndDate: null, expired: false, inProgress: false, surfaceEligible: false },
    crossEntitySatisfied: { satisfied: false, satisfyingEntity: null, actualPaid: null, expectedBasis: null, amountStatus: { kind: 'not_applicable' } },
    amount: { kind: 'wrong_amount', actual: 10, expected: 25 },
  },
});
const manualReviewRow = mkRow({
  rowKey: 'Coverall|isid:mr1|2026-02',
  targetScope: 'Coverall',
  population: 2,
  facts: {
    premium: { kind: 'chase_candidate' },
    dmi: { active: false, issueType: null, verificationEndDate: null, expired: false, inProgress: false, surfaceEligible: false },
    crossEntitySatisfied: { satisfied: false, satisfyingEntity: null, actualPaid: null, expectedBasis: null, amountStatus: { kind: 'not_applicable' } },
    amount: { kind: 'correct' },
    memberCount: { status: 'manual_review', conflicts: [1, 3], reason: 'member_count_manual_review' },
  },
});
// DMI open with multi-token issueType (tokenizes to NONESCMEC + ANNUAL_INCOME).
const dmiOpenRow = mkRow({
  rowKey: 'Coverall|isid:d1|2026-02',
  targetScope: 'Coverall',
  facts: {
    premium: { kind: 'chase_candidate' },
    dmi: {
      active: true,
      surfaceEligible: true,
      expired: false,
      inProgress: false,
      issueType: 'NONESCMEC | ANNUAL_INCOME',
      verificationEndDate: '2026-05-15',
    },
    crossEntitySatisfied: { satisfied: false, satisfyingEntity: null, actualPaid: null, expectedBasis: null, amountStatus: { kind: 'not_applicable' } },
    amount: { kind: 'not_applicable' },
  },
});
// DMI expired → manual_review + fyi dmi_expired (router emits the fyi).
const dmiExpiredRow = mkRow({
  rowKey: 'Coverall|isid:d2|2026-02',
  targetScope: 'Coverall',
  facts: {
    premium: { kind: 'chase_candidate' },
    dmi: {
      active: true,
      surfaceEligible: true,
      expired: true,
      inProgress: false,
      issueType: 'CITIZENSHIP',
      verificationEndDate: '2026-01-15',
    },
    crossEntitySatisfied: { satisfied: false, satisfyingEntity: null, actualPaid: null, expectedBasis: null, amountStatus: { kind: 'not_applicable' } },
    amount: { kind: 'not_applicable' },
  },
});
// DMI in-progress with EARLIER deadline (to verify sort order).
const dmiInProgressRow = mkRow({
  rowKey: 'Coverall|isid:d3|2026-02',
  targetScope: 'Coverall',
  facts: {
    premium: { kind: 'chase_candidate' },
    dmi: {
      active: true,
      surfaceEligible: true,
      expired: false,
      inProgress: true,
      issueType: 'SSN',
      verificationEndDate: '2026-03-10',
    },
    crossEntitySatisfied: { satisfied: false, satisfyingEntity: null, actualPaid: null, expectedBasis: null, amountStatus: { kind: 'not_applicable' } },
    amount: { kind: 'not_applicable' },
  },
});
// Paid + DMI (surfaceEligible=false because cohort='paid') → satisfied, NOT in DMI bucket.
const paidDmiRow = mkRow({
  rowKey: 'Coverall|isid:d4|2026-02',
  targetScope: 'Coverall',
  population: 2,
  facts: {
    premium: { kind: 'chase_candidate' },
    dmi: {
      active: true,
      surfaceEligible: false,
      expired: false,
      inProgress: false,
      issueType: 'CITIZENSHIP',
      verificationEndDate: '2026-05-15',
    },
    crossEntitySatisfied: { satisfied: false, satisfyingEntity: null, actualPaid: null, expectedBasis: null, amountStatus: { kind: 'not_applicable' } },
    amount: { kind: 'correct' },
  },
});

function evidenceMapsFor(rows: any[]) {
  const bindings = new Map();
  const scopes = new Map();
  const picker = new Map();
  for (const r of rows) {
    bindings.set(r.rowKey, {
      rowKey: r.rowKey,
      memberKey: `MK-${r.stableMemberKey}`,
      serviceMonth: r.serviceMonth,
      targetScope: r.targetScope,
    });
    picker.set(`MK-${r.stableMemberKey}`, new Map());
    if (!scopes.has(r.targetScope)) {
      scopes.set(r.targetScope, {
        scopedRecordsByMemberKey: new Map(),
        baseClassifierContext: { tag: `base-${r.targetScope}` },
        mtRowsByMember: new Map(),
        classificationByMember: new Map(),
      });
    }
    scopes.get(r.targetScope).scopedRecordsByMemberKey.set(
      `MK-${r.stableMemberKey}`,
      [{ source_type: 'BACK_OFFICE', batch_id: 'b1', member_key: `MK-${r.stableMemberKey}` }],
    );
    scopes.get(r.targetScope).classificationByMember.set(`MK-${r.stableMemberKey}`, {});
  }
  return { evidenceBindingsByRowKey: bindings, pickerMapsByMemberKey: picker, traceContextByScope: scopes };
}

describe('OperatorReviewPage — C2c chip filter (disjoint counts)', () => {
  it('chips compute disjoint bucket counts and selection filters visibleRows; satisfied chip retains legacy testid', async () => {
    const allRows = [
      chaseRow, premiumRow, amountRow, manualReviewRow,
      dmiOpenRow, dmiExpiredRow, paidDmiRow, samCoverall,
    ];
    (assembleDiagnoseRouteRows as any).mockReturnValue({
      rows: allRows,
      diagnostics: {},
      ...evidenceMapsFor(allRows),
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('filter-chips')).toBeInTheDocument());

    const countOf = (testid: string) =>
      Number(screen.getByTestId(testid).getAttribute('data-count'));

    // Disjoint counts.
    expect(countOf('filter-chase')).toBe(1);
    expect(countOf('filter-premium')).toBe(1);
    expect(countOf('filter-amount')).toBe(1);
    expect(countOf('filter-prior_balance')).toBe(0);
    // DMI = queues.dmi (dmiOpenRow) + (manual_review ∩ dmi_expired) (dmiExpiredRow) = 2.
    expect(countOf('filter-dmi')).toBe(2);
    // Manual review = manual_review minus dmi_expired = manualReviewRow only.
    expect(countOf('filter-manual_review')).toBe(1);
    // All actionable = disjoint union (no double-count of dmi_expired).
    const allActionable = countOf('filter-all_actionable');
    expect(allActionable).toBe(
      countOf('filter-chase')
      + countOf('filter-premium')
      + countOf('filter-amount')
      + countOf('filter-prior_balance')
      + countOf('filter-dmi')
      + countOf('filter-manual_review'),
    );
    expect(allActionable).toBe(6);
    // Satisfied = sam + paidDmi = 2.
    expect(countOf('filter-satisfied')).toBe(2);

    // Default chip = all_actionable → 6 rows visible.
    expect(screen.getAllByTestId('op-row').length).toBe(6);
    // Clicking Satisfied (legacy testid) → 2 rows.
    fireEvent.click(screen.getByTestId('filter-satisfied'));
    await waitFor(() => expect(screen.getAllByTestId('op-row').length).toBe(2));
    // Clicking DMI → 2 rows (dmiOpen + dmiExpired).
    fireEvent.click(screen.getByTestId('filter-dmi'));
    await waitFor(() => expect(screen.getAllByTestId('op-row').length).toBe(2));

    // Selection wrote nothing.
    expect(recordDecisionSpy).not.toHaveBeenCalled();
    expect(applyDecisionReductionSpy).not.toHaveBeenCalled();
  });
});

describe('OperatorReviewPage — C2c DMI work-surface', () => {
  it('DMI view composition: includes route=dmi AND manual_review+dmi_expired; excludes paid+DMI (surfaceEligible=false)', async () => {
    const allRows = [chaseRow, dmiOpenRow, dmiExpiredRow, paidDmiRow];
    (assembleDiagnoseRouteRows as any).mockReturnValue({
      rows: allRows, diagnostics: {}, ...evidenceMapsFor(allRows),
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('filter-dmi')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('filter-dmi'));
    await waitFor(() => {
      const keys = screen.getAllByTestId('op-row').map((tr) => tr.getAttribute('data-row-key'));
      expect(keys.sort()).toEqual([dmiOpenRow.rowKey, dmiExpiredRow.rowKey].sort());
      expect(keys).not.toContain(paidDmiRow.rowKey);
      expect(keys).not.toContain(chaseRow.rowKey);
    });
  });

  it('DMI tokenization: piped issueType renders multiple chips; raw preserved; Other fallback; no empty chip', async () => {
    const otherRow = mkRow({
      rowKey: 'Coverall|isid:other|2026-02',
      targetScope: 'Coverall',
      facts: {
        premium: { kind: 'chase_candidate' },
        dmi: { active: true, surfaceEligible: true, expired: false, inProgress: false, issueType: 'MYSTERY_ISSUE', verificationEndDate: '2026-04-01' },
        crossEntitySatisfied: { satisfied: false, satisfyingEntity: null, actualPaid: null, expectedBasis: null, amountStatus: { kind: 'not_applicable' } },
        amount: { kind: 'not_applicable' },
      },
    });
    const allRows = [dmiOpenRow, otherRow];
    (assembleDiagnoseRouteRows as any).mockReturnValue({
      rows: allRows, diagnostics: {}, ...evidenceMapsFor(allRows),
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('filter-dmi')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('filter-dmi'));
    await waitFor(() => expect(screen.getAllByTestId('op-row').length).toBe(2));

    // dmiOpenRow ("NONESCMEC | ANNUAL_INCOME") → two chips in its DMI cell;
    // raw preserved via title attribute on the cell wrapper.
    const dmiRowEl = screen
      .getAllByTestId('op-row')
      .find((tr) => tr.getAttribute('data-row-key') === dmiOpenRow.rowKey)!;
    const chips = within(dmiRowEl).getAllByTestId('dmi-issue-chip');
    const labels = chips.map((c) => c.textContent);
    expect(labels.sort()).toEqual(['ANNUAL_INCOME', 'NONESCMEC'].sort());
    for (const c of chips) expect(c.textContent && c.textContent.length > 0).toBe(true);
    // Raw preserved on the surrounding span title.
    const titled = within(dmiRowEl).getByTitle('NONESCMEC | ANNUAL_INCOME');
    expect(titled).toBeInTheDocument();

    // otherRow → "Other" group chip from the controls bar.
    expect(screen.getByTestId('dmi-group-Other')).toBeInTheDocument();
  });

  it('DMI deadline sort: expired first; ascending by verificationEndDate; missing date last', async () => {
    const noDateRow = mkRow({
      rowKey: 'Coverall|isid:nd|2026-02',
      targetScope: 'Coverall',
      facts: {
        premium: { kind: 'chase_candidate' },
        dmi: { active: true, surfaceEligible: true, expired: false, inProgress: false, issueType: 'SSN', verificationEndDate: null },
        crossEntitySatisfied: { satisfied: false, satisfyingEntity: null, actualPaid: null, expectedBasis: null, amountStatus: { kind: 'not_applicable' } },
        amount: { kind: 'not_applicable' },
      },
    });
    // dmiExpiredRow date 2026-01-15 (expired); dmiInProgressRow 2026-03-10;
    // dmiOpenRow 2026-05-15; noDateRow null. Expected order:
    //   expired, 03-10, 05-15, null.
    const allRows = [dmiOpenRow, dmiInProgressRow, dmiExpiredRow, noDateRow];
    (assembleDiagnoseRouteRows as any).mockReturnValue({
      rows: allRows, diagnostics: {}, ...evidenceMapsFor(allRows),
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('filter-dmi')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('filter-dmi'));
    await waitFor(() => expect(screen.getAllByTestId('op-row').length).toBe(4));
    fireEvent.click(screen.getByTestId('dmi-sort-deadline'));
    await waitFor(() => {
      const keys = screen.getAllByTestId('op-row').map((tr) => tr.getAttribute('data-row-key'));
      expect(keys).toEqual([
        dmiExpiredRow.rowKey,
        dmiInProgressRow.rowKey,
        dmiOpenRow.rowKey,
        noDateRow.rowKey,
      ]);
    });
  });
});

describe('OperatorReviewPage — C2c evidence drawer', () => {
  it('opens drawer; calls explainCellFn with binding memberKey + scope + scope-keyed context (NOT minimal); shows trace + facts + rationale/FYI; writes nothing; no second loader fetch', async () => {
    const allRows = [chaseRow];
    (assembleDiagnoseRouteRows as any).mockReturnValue({
      rows: allRows, diagnostics: {}, ...evidenceMapsFor(allRows),
    });
    const explainCellFn = vi.fn().mockResolvedValue({
      member: { memberKey: 'MK-isid:c1', policyNumber: 'POL', name: 'Alice' },
      cell: { month: '2026-02', scope: 'Coverall' },
      final: {
        state: 'unpaid',
        reason: 'no_commission_yet',
        chips: { in_ede: true, in_back_office: true, in_commission: false, paid_amount: 0 },
        badges: {},
      },
      helpers: [{ name: 'h1', output: 1 }],
      guards: [],
      firingRule: { name: 'RULE_UNPAID', reason: 'no_commission' },
      scopedRows: [{ source_type: 'EDE' }],
    });

    // Track loader calls to assert no SECOND all-batch fetch on drawer open.
    const loaderModule = await import('@/lib/persistence');
    const loaderSpy = loaderModule.getAllNormalizedRecordsForMemberTimeline as any;

    renderPage({ explainCellFn });
    await waitFor(() => expect(screen.getAllByTestId('op-row').length).toBe(1));
    const loaderCallsBefore = loaderSpy.mock.calls.length;

    fireEvent.click(screen.getByTestId('open-evidence'));
    await waitFor(() => expect(explainCellFn).toHaveBeenCalledTimes(1));
    const arg = explainCellFn.mock.calls[0][0];
    // Exact-grain bindings (no reverse-derivation, no minimal context).
    expect(arg.memberKey).toBe('MK-isid:c1');
    expect(arg.monthKey).toBe('2026-02');
    expect(arg.scope).toBe('Coverall');
    expect(arg.preloadedRecords).toBeDefined();
    expect(Array.isArray(arg.preloadedRecords)).toBe(true);
    expect(arg.preloadedContext).toBeDefined();
    // Scope-keyed base context (NOT a minimal classifier context).
    expect(arg.preloadedContext.tag).toBe('base-Coverall');
    // EDE picker overlay layered for that member.
    expect(arg.preloadedContext.pickerEdeByMonth).toBeDefined();

    await waitFor(() => expect(screen.getByTestId('evidence-drawer')).toBeInTheDocument());
    // Trace + route facts + rationale visible.
    expect(screen.getByTestId('drawer-firing-rule').textContent).toMatch(/RULE_UNPAID/);
    expect(screen.getByTestId('drawer-facts').textContent).toMatch(/premium/);
    expect(screen.getByTestId('drawer-route').textContent).toMatch(/chase_eligible|default_chase/);

    // Opening the drawer wrote nothing AND triggered no new loader fetch.
    expect(recordDecisionSpy).not.toHaveBeenCalled();
    expect(applyDecisionReductionSpy).not.toHaveBeenCalled();
    expect(loaderSpy.mock.calls.length).toBe(loaderCallsBefore);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// C2c slice 1 — member search + grouping + expand + bucket tooltips.
// ─────────────────────────────────────────────────────────────────────────

describe('OperatorReviewPage — C2c slice 1 member search + grouping', () => {
  // Two distinct members, each with two months (so each gets a +N toggle).
  const aliceFeb = mkRow({
    rowKey: 'Coverall|isid:u1|2026-02',
    targetScope: 'Coverall',
    stableMemberKey: 'isid:u1',
  });
  aliceFeb.identity = { carrier: 'Ambetter', issuer_subscriber_id: 'U1', policy_number: 'POL-A' };
  aliceFeb.serviceMonth = '2026-02';
  const aliceMar = mkRow({
    rowKey: 'Coverall|isid:u1|2026-03',
    targetScope: 'Coverall',
    stableMemberKey: 'isid:u1',
  });
  aliceMar.identity = { carrier: 'Ambetter', issuer_subscriber_id: 'U1', policy_number: 'POL-A' };
  aliceMar.serviceMonth = '2026-03';
  const bobFeb = mkRow({
    rowKey: 'Coverall|isid:u9|2026-02',
    targetScope: 'Coverall',
    stableMemberKey: 'isid:u9',
  });
  bobFeb.identity = { carrier: 'Ambetter', issuer_subscriber_id: 'U9', policy_number: 'POL-B' };
  bobFeb.serviceMonth = '2026-02';
  const bobMar = mkRow({
    rowKey: 'Coverall|isid:u9|2026-03',
    targetScope: 'Coverall',
    stableMemberKey: 'isid:u9',
  });
  bobMar.identity = { carrier: 'Ambetter', issuer_subscriber_id: 'U9', policy_number: 'POL-B' };
  bobMar.serviceMonth = '2026-03';
  // Single-row member (no toggle expected).
  const carolFeb = mkRow({
    rowKey: 'Coverall|isid:u5|2026-02',
    targetScope: 'Coverall',
    stableMemberKey: 'isid:u5',
  });
  carolFeb.identity = { carrier: 'Ambetter', issuer_subscriber_id: 'U5', policy_number: 'POL-C' };

  async function mountAll() {
    // Interleave member rows in the input to verify first-appearance grouping.
    const all = [aliceFeb, bobFeb, aliceMar, bobMar, carolFeb];
    // Provide a name map: applicant_name comes via the persistence loader mock.
    const records = [
      { issuer_subscriber_id: 'U1', applicant_name: 'Alice Actionable', carrier: 'Ambetter' },
      { issuer_subscriber_id: 'U9', applicant_name: 'Bob Bench', carrier: 'Ambetter' },
      { issuer_subscriber_id: 'U5', applicant_name: 'Carol Calm', carrier: 'Ambetter' },
    ];
    const loader = await import('@/lib/persistence');
    (loader.getAllNormalizedRecordsForMemberTimeline as any).mockResolvedValueOnce(records);
    (assembleDiagnoseRouteRows as any).mockReturnValue({
      rows: all, diagnostics: {}, ...evidenceMapsFor(all),
    });
    return all;
  }

  it('groups same-member months contiguously; default collapsed; +N toggle on multi-row members only', async () => {
    mountAll();
    renderPage();
    // 3 members → 3 first rows by default (Alice, Bob, Carol).
    await waitFor(() => expect(screen.getAllByTestId('op-row').length).toBe(3));
    const keys = screen.getAllByTestId('op-row').map((tr) => tr.getAttribute('data-row-key'));
    // Members appear in first-appearance order (alice → bob → carol).
    expect(keys).toEqual([
      aliceFeb.rowKey, // Alice first appearance
      bobFeb.rowKey,   // Bob first appearance
      carolFeb.rowKey, // Carol first appearance
    ]);
    // Two member-toggles (alice + bob); carol has none.
    const toggles = screen.getAllByTestId('member-toggle');
    expect(toggles.length).toBe(2);
    expect(toggles.map((t) => t.getAttribute('data-member-key')).sort()).toEqual(['isid:u1', 'isid:u9'].sort());

    // Expand alice → her March row appears immediately below Feb.
    const aliceToggle = toggles.find((t) => t.getAttribute('data-member-key') === 'isid:u1')!;
    fireEvent.click(aliceToggle);
    await waitFor(() => expect(screen.getAllByTestId('op-row').length).toBe(4));
    const keysAfter = screen.getAllByTestId('op-row').map((tr) => tr.getAttribute('data-row-key'));
    expect(keysAfter).toEqual([
      aliceFeb.rowKey,
      aliceMar.rowKey, // contiguous under alice
      bobFeb.rowKey,
      carolFeb.rowKey,
    ]);
    // No writes from grouping / toggling.
    expect(recordDecisionSpy).not.toHaveBeenCalled();
    expect(applyDecisionReductionSpy).not.toHaveBeenCalled();
    expect(runDiagnoseCycleSpy).not.toHaveBeenCalled();
  });

  it('search by name narrows rows + auto-expands matching groups; clearing restores manual expand state and writes nothing', async () => {
    mountAll();
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId('op-row').length).toBe(3));
    const allActionableCountBefore = screen.getByTestId('filter-all_actionable').getAttribute('data-count');

    // Search for "alice" — only her group remains; auto-expanded → 2 rows visible.
    fireEvent.change(screen.getByTestId('member-search'), { target: { value: 'alice' } });
    await waitFor(() => {
      const keys = screen.getAllByTestId('op-row').map((tr) => tr.getAttribute('data-row-key'));
      expect(keys).toEqual([aliceFeb.rowKey, aliceMar.rowKey]);
    });
    // Manual expand state was NOT mutated by typing: clearing returns to collapsed.
    fireEvent.click(screen.getByTestId('member-search-clear'));
    await waitFor(() => expect(screen.getAllByTestId('op-row').length).toBe(3));
    // Chip counts unaffected by search/grouping.
    expect(screen.getByTestId('filter-all_actionable').getAttribute('data-count'))
      .toBe(allActionableCountBefore);

    expect(recordDecisionSpy).not.toHaveBeenCalled();
    expect(applyDecisionReductionSpy).not.toHaveBeenCalled();
    expect(runDiagnoseCycleSpy).not.toHaveBeenCalled();
  });

  it('search matches subscriber id and policy number; empty search returns full set', async () => {
    mountAll();
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId('op-row').length).toBe(3));

    // Subscriber id (case-insensitive).
    fireEvent.change(screen.getByTestId('member-search'), { target: { value: 'u9' } });
    await waitFor(() => {
      const keys = screen.getAllByTestId('op-row').map((tr) => tr.getAttribute('data-row-key'));
      expect(keys).toEqual([bobFeb.rowKey, bobMar.rowKey]);
    });

    // Policy number.
    fireEvent.change(screen.getByTestId('member-search'), { target: { value: 'pol-c' } });
    await waitFor(() => {
      const keys = screen.getAllByTestId('op-row').map((tr) => tr.getAttribute('data-row-key'));
      expect(keys).toEqual([carolFeb.rowKey]);
    });

    // Empty search → full set.
    fireEvent.change(screen.getByTestId('member-search'), { target: { value: '' } });
    await waitFor(() => expect(screen.getAllByTestId('op-row').length).toBe(3));
  });

  it('expanded row binds by data-row-key: hold action targets the expanded row exactly', async () => {
    mountAll();
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId('op-row').length).toBe(3));
    // Expand alice; pick the SECOND (March) row.
    const aliceToggle = screen.getAllByTestId('member-toggle')
      .find((t) => t.getAttribute('data-member-key') === 'isid:u1')!;
    fireEvent.click(aliceToggle);
    await waitFor(() => expect(screen.getAllByTestId('op-row').length).toBe(4));
    const marRow = screen.getAllByTestId('op-row')
      .find((tr) => tr.getAttribute('data-row-key') === aliceMar.rowKey)!;
    fireEvent.click(within(marRow).getByTestId('action-hold_premium'));
    await waitFor(() => expect(screen.getByTestId('hold-prompt')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('hold-submit'));
    await waitFor(() => expect(recordDecisionSpy).toHaveBeenCalledTimes(1));
    expect(recordDecisionSpy.mock.calls[0][0].service_month).toBe('2026-03');
  });

  it('expanded row Evidence button binds by data-row-key', async () => {
    mountAll();
    const explainCellFn = vi.fn().mockResolvedValue({
      member: {}, cell: {}, final: { state: 'unpaid', chips: { in_ede: false, in_back_office: false, in_commission: false, paid_amount: 0 }, badges: {} },
      helpers: [], guards: [], firingRule: null, scopedRows: [],
    });
    renderPage({ explainCellFn });
    await waitFor(() => expect(screen.getAllByTestId('op-row').length).toBe(3));
    const aliceToggle = screen.getAllByTestId('member-toggle')
      .find((t) => t.getAttribute('data-member-key') === 'isid:u1')!;
    fireEvent.click(aliceToggle);
    await waitFor(() => expect(screen.getAllByTestId('op-row').length).toBe(4));
    const marRow = screen.getAllByTestId('op-row')
      .find((tr) => tr.getAttribute('data-row-key') === aliceMar.rowKey)!;
    fireEvent.click(within(marRow).getByTestId('open-evidence'));
    await waitFor(() => expect(explainCellFn).toHaveBeenCalledTimes(1));
    expect(explainCellFn.mock.calls[0][0].monthKey).toBe('2026-03');
    expect(explainCellFn.mock.calls[0][0].memberKey).toBe('MK-isid:u1');
  });

  it('bucket chips expose info affordances with the exact tooltip copy', async () => {
    mountAll();
    renderPage();
    await waitFor(() => expect(screen.getByTestId('filter-chips')).toBeInTheDocument());
    // Every chip has a sibling chip-info button.
    for (const k of [
      'all_actionable', 'chase', 'premium', 'amount', 'prior_balance',
      'dmi', 'manual_review', 'satisfied',
    ]) {
      expect(screen.getByTestId(`chip-info-${k}`)).toBeInTheDocument();
    }
  });
});


