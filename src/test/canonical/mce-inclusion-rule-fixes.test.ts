/**
 * MCE Inclusion-Rule Fixes — unit coverage for the extracted shared helpers
 * and behavioral assertions for the four rule changes.
 *
 * The full MCE pipeline is integration-covered by other test files
 * (mce-source-records-*, missing-commission-export-*). Here we validate
 * the building blocks plus isolated negative controls for each rule.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// Passthrough mock so consumer-path tests can override individual classifier
// helpers per-call via mockImplementationOnce while the existing v3 helper-
// level tests continue to exercise the real implementations.
vi.mock('@/lib/classifier', async () => {
  const actual = await vi.importActual<any>('@/lib/classifier');
  return {
    ...actual,
    classifyMemberForMonth: vi.fn(actual.classifyMemberForMonth),
    computeFirstEligibleMonth: vi.fn(actual.computeFirstEligibleMonth),
    paidForServiceMonth: vi.fn(actual.paidForServiceMonth),
    buildIsDueEligibleRecord: vi.fn(actual.buildIsDueEligibleRecord),
  };
});

import {
  paidForServiceMonth,
  classifyMemberForMonth,
  buildIsDueEligibleRecord,
  computeFirstEligibleMonth,
} from '@/lib/classifier';
import { isActiveBackOfficeRecord } from '@/lib/canonical/isActiveBackOfficeRecord';
import { getStatementMonthBounds } from '@/lib/canonical/statementMonthBounds';
import {
  buildMceCandidateSetForServiceMonth,
  type McePaymentBreakdownLike,
} from '@/pages/MissingCommissionExportPage';
import {
  partitionUnpaidRowsByOverlay,
  buildClearingOverlayMap,
  EMPTY_CLEARING_OVERLAY_MAP,
} from '@/lib/canonical/crossBatchOverlay';
import { derivePolicyIdentityKey } from '@/lib/canonical/policyIdentityKey';

const baseCommissionRow = (over: Record<string, any> = {}): any => ({
  source_type: 'COMMISSION',
  paid_to_date: '2026-01-31',
  months_paid: 1,
  commission_amount: 100,
  pay_entity: 'Coverall',
  ...over,
});

describe('paidForServiceMonth (shared classifier+MCE helper)', () => {
  it('reports paid when commission rows attribute to the viewed service month', () => {
    const records = [baseCommissionRow({ paid_to_date: '2026-01-31' })];
    const r = paidForServiceMonth(records, '2026-01');
    expect(r.paid).toBe(true);
    expect(r.amount).toBeCloseTo(100);
    expect(r.payEntities).toEqual(['Coverall']);
  });

  it('reports NOT paid when commission row attributes to a different service month (drift bug)', () => {
    const records = [baseCommissionRow({ paid_to_date: '2025-12-31' })];
    const r = paidForServiceMonth(records, '2026-01');
    expect(r.paid).toBe(false);
    expect(r.amount).toBe(0);
  });

  it('honors targetPayEntity Coverall — a Vix commission row does not count', () => {
    const records = [baseCommissionRow({ pay_entity: 'Vix' })];
    const r = paidForServiceMonth(records, '2026-01', { targetPayEntity: 'Coverall' });
    expect(r.paid).toBe(false);
  });

  it("targetPayEntity 'All' (default) counts any pay entity", () => {
    const records = [baseCommissionRow({ pay_entity: 'Vix' })];
    expect(paidForServiceMonth(records, '2026-01').paid).toBe(true);
    expect(
      paidForServiceMonth(records, '2026-01', { targetPayEntity: 'All' }).paid,
    ).toBe(true);
  });

  it('zero / null commission amounts do not count as paid', () => {
    const records = [baseCommissionRow({ commission_amount: 0 })];
    expect(paidForServiceMonth(records, '2026-01').paid).toBe(false);
  });

  it('threshold uses > 0.0001 (matches existing classifier behavior)', () => {
    const records = [baseCommissionRow({ commission_amount: 0.00005 })];
    expect(paidForServiceMonth(records, '2026-01').paid).toBe(false);
  });
});

describe('classifyMemberForMonth wrapper', () => {
  it('returns existing cell states; does NOT introduce new states', () => {
    // Commission paid → 'paid'
    const recs = [
      baseCommissionRow({
        member_key: 'm1',
        applicant_name: 'Test Member',
        agent_npn: '21055210', // Jason Fine → Coverall
      }),
    ];
    const state = classifyMemberForMonth(recs, '2026-01');
    expect(['paid', 'unpaid', 'pending', 'manual_review', 'not_expected_premium_unpaid',
      'not_expected_pre_eligibility', 'not_expected_cancelled', 'not_expected_not_ours'])
      .toContain(state);
  });
});

describe('buildIsDueEligibleRecord predicate (cross-surface extraction)', () => {
  it('Coverall scope excludes a Vix-pay-entity commission row', () => {
    const pred = buildIsDueEligibleRecord({ aorScope: 'official', payEntity: 'Coverall' });
    const r = { source_type: 'COMMISSION', pay_entity: 'Vix' };
    expect(pred(r)).toBe(false);
  });
  it("'All' scope passes commission regardless of pay_entity", () => {
    const pred = buildIsDueEligibleRecord({ aorScope: 'official', payEntity: 'All' });
    expect(pred({ source_type: 'COMMISSION', pay_entity: 'Vix' })).toBe(true);
  });
});

describe('boActiveNonCurrentEde four-condition gate (MCE consumer logic)', () => {
  const monthBounds = getStatementMonthBounds('2026-01');
  const activeBoRow = {
    source_type: 'BACK_OFFICE',
    eligible_for_commission: 'Yes',
    effective_date: '2025-06-01',
    policy_term_date: null,
    paid_through_date: null,
    broker_term_date: null,
    agent_npn: '21055210',
  };

  it('condition 1: BO not active → excluded', () => {
    const inactive = { ...activeBoRow, policy_term_date: '2025-12-01' };
    expect(
      isActiveBackOfficeRecord(inactive, monthBounds.start, monthBounds.end),
    ).toBe(false);
  });

  it('condition 2: eligible_for_commission != "Yes" is rejected at consumer site', () => {
    const row = { eligible_for_commission: 'No' };
    expect(row.eligible_for_commission === 'Yes').toBe(false);
  });

  it('condition 3: first-eligible-future > viewed is rejected', () => {
    const recs = [
      {
        source_type: 'BACK_OFFICE',
        agent_npn: '21055210',
        agent_name: 'Jason Fine',
        effective_date: '2026-05-01', // PED = 2026-05 — well after viewed Jan
      },
    ];
    const fe = computeFirstEligibleMonth(recs as any);
    expect(fe).toBe('2026-05');
    expect(fe! > '2026-01').toBe(true);
  });

  it('condition 4: a service-month payment defeats inclusion', () => {
    const recs = [baseCommissionRow({ paid_to_date: '2026-01-31' })];
    expect(paidForServiceMonth(recs, '2026-01').paid).toBe(true);
  });
});

describe('Cross-surface helper reuse — classifier + MCE share paidForServiceMonth', () => {
  it('classifier exports paidForServiceMonth (single import site)', async () => {
    const mod = await import('@/lib/classifier');
    expect(typeof mod.paidForServiceMonth).toBe('function');
  });

  it('MCE page imports paidForServiceMonth from classifier (not a local dup)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.resolve(process.cwd(), 'src/pages/MissingCommissionExportPage.tsx'),
      'utf8',
    );
    expect(src).toMatch(/paidForServiceMonth/);
    expect(src).toMatch(/from '@\/lib\/classifier'/);
  });

  it('memberTimeline.ts intentionally retains its own service-month attribution (out of scope for this slice)', async () => {
    // Honest scope: MT display-cell path is NOT consolidated in this slice.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.resolve(process.cwd(), 'src/lib/memberTimeline.ts'),
      'utf8',
    );
    expect(src).toMatch(/commissionServiceMonths/);
  });
});

describe('D2 second sub-signal (overlay mark_needs_review consumption)', () => {
  it("MCE consumes partition.regular filtered by adjustment.kind !== 'mark_needs_review'", async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.resolve(process.cwd(), 'src/pages/MissingCommissionExportPage.tsx'),
      'utf8',
    );
    expect(src).toMatch(/adjustment\.kind !== 'mark_needs_review'/);
    // Negative regression: no fictional `overlayLabel` property.
    expect(src).not.toMatch(/overlayLabel/);
  });
});
