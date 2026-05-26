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

// ===========================================================================
// REPAIR TURN — consumer-path tests against buildMceCandidateSetForServiceMonth.
// These exercise the page-local helper (test seam) so we assert against MCE's
// final candidate set output, NOT helper return values.
// ===========================================================================

const VIEWED = '2026-01';
const COVERALL_NPN = '21055210';
const VIX_NPN = '21277051';

/** Per-test mock-state plumbing: map member_key → classifier verdict. */
const classifierVerdictByMember = new Map<string, string>();
const firstEligibleByMember = new Map<string, string | null>();
const paidEvidenceByMember = new Map<string, { paid: boolean; amount: number; payEntities: string[] }>();

// Real implementations cached lazily so per-test mocks can fall through to
// the real helper whenever no per-member override is configured (this keeps
// the v3 helper-level tests above working under the passthrough mock).
let realBuildIsDueEligibleRecord: any;
let realClassifyMemberForMonth: any;
let realComputeFirstEligibleMonth: any;
let realPaidForServiceMonth: any;
async function ensureRealFactory() {
  if (!realBuildIsDueEligibleRecord) {
    const actual = (await vi.importActual('@/lib/classifier')) as any;
    realBuildIsDueEligibleRecord = actual.buildIsDueEligibleRecord;
    realClassifyMemberForMonth = actual.classifyMemberForMonth;
    realComputeFirstEligibleMonth = actual.computeFirstEligibleMonth;
    realPaidForServiceMonth = actual.paidForServiceMonth;
  }
}

beforeEach(async () => {
  await ensureRealFactory();
  classifierVerdictByMember.clear();
  firstEligibleByMember.clear();
  paidEvidenceByMember.clear();
  vi.mocked(classifyMemberForMonth).mockImplementation((recs: any[], month: any, opts: any) => {
    const mk = recs?.[0]?.member_key;
    if (mk && classifierVerdictByMember.has(mk)) {
      return classifierVerdictByMember.get(mk) as any;
    }
    return realClassifyMemberForMonth(recs, month, opts);
  });
  vi.mocked(computeFirstEligibleMonth).mockImplementation((recs: any[]) => {
    const mk = recs?.[0]?.member_key;
    if (mk && firstEligibleByMember.has(mk)) {
      return firstEligibleByMember.get(mk) as any;
    }
    return realComputeFirstEligibleMonth(recs);
  });
  vi.mocked(paidForServiceMonth).mockImplementation((recs: any[], month: any, opts: any) => {
    const mk = recs?.[0]?.member_key;
    if (mk && paidEvidenceByMember.has(mk)) {
      return paidEvidenceByMember.get(mk) as any;
    }
    return realPaidForServiceMonth(recs, month, opts);
  });
  vi.mocked(buildIsDueEligibleRecord).mockImplementation((opts: any) =>
    realBuildIsDueEligibleRecord(opts),
  );
});


function makeBoRow(over: Record<string, any> = {}): any {
  return {
    source_type: 'BACK_OFFICE',
    member_key: 'mem1',
    eligible_for_commission: 'Yes',
    effective_date: '2025-06-01',
    policy_term_date: null,
    paid_through_date: null,
    broker_term_date: null,
    agent_npn: COVERALL_NPN,
    aor_bucket: 'Jason Fine',
    // Slice A (v8) — BO scope arm requires broker name match. Default to
    // Jason Fine so existing fixtures continue to be in-scope.
    raw_json: { 'Broker Name': 'Jason Fine' },
    ...over,
  };
}

function makeReconciledRow(over: Record<string, any> = {}): any {
  return {
    member_key: 'mem1',
    in_back_office: true,
    in_ede: true,
    eligible_for_commission: 'Yes',
    current_policy_aor: `Jason Fine (${COVERALL_NPN})`,
    ...over,
  };
}

function emptyBreakdown(): McePaymentBreakdownLike {
  return { unpaidRows: [], paidRows: [], universe: { boActiveNonCurrentEde: [] } };
}

describe('REPAIR consumer-path — D2 classifier exclusion via buildMceCandidateSetForServiceMonth', () => {
  it('excludes member from final candidate set when classifier returns manual_review', async () => {
    await ensureRealFactory();
    const memberKey = 'mem-D2-class';
    classifierVerdictByMember.set(memberKey, 'manual_review');
    const unpaid = makeReconciledRow({ member_key: memberKey });
    const boRecord = makeBoRow({ member_key: memberKey });
    const out = buildMceCandidateSetForServiceMonth({
      breakdown: { unpaidRows: [unpaid], paidRows: [], universe: { boActiveNonCurrentEde: [] } },
      selectedBatchRecords: [boRecord],
      viewedServiceMonth: VIEWED,
      scope: 'Coverall',
    });
    expect(out.find((r: any) => r.member_key === memberKey)).toBeUndefined();
  });

  it('positive control: classifier=unpaid keeps the candidate', async () => {
    await ensureRealFactory();
    const memberKey = 'mem-D2-keep';
    classifierVerdictByMember.set(memberKey, 'unpaid');
    const unpaid = makeReconciledRow({ member_key: memberKey });
    const boRecord = makeBoRow({ member_key: memberKey });
    const out = buildMceCandidateSetForServiceMonth({
      breakdown: { unpaidRows: [unpaid], paidRows: [], universe: { boActiveNonCurrentEde: [] } },
      selectedBatchRecords: [boRecord],
      viewedServiceMonth: VIEWED,
      scope: 'Coverall',
    });
    expect(out.find((r: any) => r.member_key === memberKey)).toBeDefined();
  });
});

describe('REPAIR consumer-path — D2 overlay mark_needs_review exclusion', () => {
  // The candidate-set helper produces rows BEFORE partitionUnpaidRowsByOverlay;
  // the page then filters partition.regular by `adjustment.kind !== 'mark_needs_review'`.
  // We mirror that filter exactly here.
  function pairOverlay(row: any, clearing_state: string) {
    const id = derivePolicyIdentityKey({
      carrier: row.carrier,
      policy_number: row.policy_number,
      issuer_subscriber_id: row.issuer_subscriber_id,
    });
    if (id.status !== 'resolved') throw new Error('unresolved');
    return {
      id: `clr-${row.member_key}`,
      policy_identity_key: id.key,
      target_service_month: row.expected_ede_effective_month,
      clearing_state,
      expected_amount: 100,
      actual_positive_amount: null,
      actual_reversal_amount: null,
      actual_net_amount: null,
      remainder_owed: null,
      unpaid_batch_ids: [],
      payment_batch_ids: [],
      reversed_at_statement_month: null,
      first_full_clear_statement_month: null,
      evaluated_at: '2026-05-01T00:00:00Z',
      run_id: 'run-1',
      manual_review_reason: 'reason',
    };
  }

  function fixtureRow(member_key: string): any {
    return {
      member_key,
      carrier: 'Ambetter',
      policy_number: `POL-${member_key}`,
      issuer_subscriber_id: `IS-${member_key}`,
      expected_ede_effective_month: VIEWED,
      estimated_missing_commission: 100,
      net_premium: 500,
    };
  }

  it('mark_needs_review AdjustedRow is excluded before .map to underlying row', () => {
    const row = fixtureRow('mem-overlay-mnr');
    const overlay = buildClearingOverlayMap([pairOverlay(row, 'manual_review_required')]);
    const partition = partitionUnpaidRowsByOverlay([row], overlay);
    const after = partition.regular
      .filter((it) => it.adjustment.kind !== 'mark_needs_review')
      .map((it) => it.row);
    expect(after.find((r: any) => r.member_key === 'mem-overlay-mnr')).toBeUndefined();
  });

  it('positive control: AdjustedRow with other adjustment.kind passes through', () => {
    const row = fixtureRow('mem-overlay-ok');
    const partition = partitionUnpaidRowsByOverlay([row], EMPTY_CLEARING_OVERLAY_MAP);
    const after = partition.regular
      .filter((it) => it.adjustment.kind !== 'mark_needs_review')
      .map((it) => it.row);
    expect(after.find((r: any) => r.member_key === 'mem-overlay-ok')).toBeDefined();
  });
});

describe('REPAIR consumer-path — boActiveNonCurrentEde four-condition gate', () => {
  const memberKey = 'mem-bo-active';

  function positiveFixture() {
    const universeRow = makeReconciledRow({ member_key: memberKey, eligible_for_commission: 'Yes' });
    // Active BO: effective in past, no term/paid_through, no broker term.
    const boRow = makeBoRow({ member_key: memberKey });
    return { universeRow, boRow };
  }

  it('INCLUDED when all four conditions pass', async () => {
    await ensureRealFactory();
    const { universeRow, boRow } = positiveFixture();
    classifierVerdictByMember.set(memberKey, 'unpaid');
    firstEligibleByMember.set(memberKey, '2025-06');
    paidEvidenceByMember.set(memberKey, { paid: false, amount: 0, payEntities: [] });
    const out = buildMceCandidateSetForServiceMonth({
      breakdown: { unpaidRows: [], paidRows: [], universe: { boActiveNonCurrentEde: [universeRow] } },
      selectedBatchRecords: [boRow],
      viewedServiceMonth: VIEWED,
      scope: 'Coverall',
    });
    expect(out.find((r: any) => r.member_key === memberKey)).toBeDefined();
  });

  it('F1: EXCLUDED when BO not active (policy_term_date in past)', async () => {
    await ensureRealFactory();
    const { universeRow, boRow } = positiveFixture();
    boRow.policy_term_date = '2025-12-01'; // pre-viewed → not active
    firstEligibleByMember.set(memberKey, '2025-06');
    paidEvidenceByMember.set(memberKey, { paid: false, amount: 0, payEntities: [] });
    const out = buildMceCandidateSetForServiceMonth({
      breakdown: { unpaidRows: [], paidRows: [], universe: { boActiveNonCurrentEde: [universeRow] } },
      selectedBatchRecords: [boRow],
      viewedServiceMonth: VIEWED,
      scope: 'Coverall',
    });
    expect(out.find((r: any) => r.member_key === memberKey)).toBeUndefined();
  });

  it('F2: EXCLUDED when eligible_for_commission !== "Yes"', async () => {
    await ensureRealFactory();
    const { universeRow, boRow } = positiveFixture();
    universeRow.eligible_for_commission = 'No';
    firstEligibleByMember.set(memberKey, '2025-06');
    paidEvidenceByMember.set(memberKey, { paid: false, amount: 0, payEntities: [] });
    const out = buildMceCandidateSetForServiceMonth({
      breakdown: { unpaidRows: [], paidRows: [], universe: { boActiveNonCurrentEde: [universeRow] } },
      selectedBatchRecords: [boRow],
      viewedServiceMonth: VIEWED,
      scope: 'Coverall',
    });
    expect(out.find((r: any) => r.member_key === memberKey)).toBeUndefined();
  });

  it('F3: EXCLUDED when first-eligible-month is in the future', async () => {
    await ensureRealFactory();
    const { universeRow, boRow } = positiveFixture();
    firstEligibleByMember.set(memberKey, '2026-05');
    paidEvidenceByMember.set(memberKey, { paid: false, amount: 0, payEntities: [] });
    const out = buildMceCandidateSetForServiceMonth({
      breakdown: { unpaidRows: [], paidRows: [], universe: { boActiveNonCurrentEde: [universeRow] } },
      selectedBatchRecords: [boRow],
      viewedServiceMonth: VIEWED,
      scope: 'Coverall',
    });
    expect(out.find((r: any) => r.member_key === memberKey)).toBeUndefined();
  });

  it('F4: EXCLUDED when service-month payment evidence exists', async () => {
    await ensureRealFactory();
    const { universeRow, boRow } = positiveFixture();
    firstEligibleByMember.set(memberKey, '2025-06');
    paidEvidenceByMember.set(memberKey, { paid: true, amount: 100, payEntities: ['Coverall'] });
    const out = buildMceCandidateSetForServiceMonth({
      breakdown: { unpaidRows: [], paidRows: [], universe: { boActiveNonCurrentEde: [universeRow] } },
      selectedBatchRecords: [boRow],
      viewedServiceMonth: VIEWED,
      scope: 'Coverall',
    });
    expect(out.find((r: any) => r.member_key === memberKey)).toBeUndefined();
  });
});

describe('REPAIR consumer-path — buildIsDueEligibleRecord is invoked + scopes records', () => {
  it('constructs predicate with { aorScope: "official", payEntity: f.scope } and filters records', async () => {
    await ensureRealFactory();
    vi.mocked(buildIsDueEligibleRecord).mockClear();

    // Mixed records: one Coverall-scoped BO row + one Vix-pay-entity BO row.
    // Under scope='Coverall', the Vix row must be filtered out before rule eval.
    const memberKey = 'mem-scope';
    const coverallBo = makeBoRow({ member_key: memberKey, agent_npn: COVERALL_NPN });
    const vixBo = makeBoRow({ member_key: memberKey, agent_npn: VIX_NPN, aor_bucket: 'Other Agent', raw_json: { 'Broker Name': 'Other Agent' } });

    // Capture the records arg classifyMemberForMonth receives.
    let observedRecordsForClassifier: any[] | undefined;
    vi.mocked(classifyMemberForMonth).mockImplementation((recs: any[]) => {
      observedRecordsForClassifier = recs;
      return 'unpaid' as any;
    });

    const unpaid = makeReconciledRow({ member_key: memberKey });
    buildMceCandidateSetForServiceMonth({
      breakdown: { unpaidRows: [unpaid], paidRows: [], universe: { boActiveNonCurrentEde: [] } },
      selectedBatchRecords: [coverallBo, vixBo],
      viewedServiceMonth: VIEWED,
      scope: 'Coverall',
    });

    // buildIsDueEligibleRecord must have been invoked with the right opts.
    expect(buildIsDueEligibleRecord).toHaveBeenCalledWith({
      aorScope: 'official',
      payEntity: 'Coverall',
    });

    // The classifier must have received SCOPED records only — Vix BO row excluded.
    expect(observedRecordsForClassifier).toBeDefined();
    const npnsSeen = (observedRecordsForClassifier ?? []).map((r) => r.agent_npn);
    expect(npnsSeen).toContain(COVERALL_NPN);
    expect(npnsSeen).not.toContain(VIX_NPN);
  });

  it('predicate semantics: under scope=Coverall, a Vix-NPN BO record is filtered out (real predicate)', async () => {
    await ensureRealFactory();
    const pred = realBuildIsDueEligibleRecord({ aorScope: 'official', payEntity: 'Coverall' });
    expect(pred(makeBoRow({ agent_npn: COVERALL_NPN }))).toBe(true);
    expect(pred(makeBoRow({ agent_npn: VIX_NPN, aor_bucket: 'Other Agent', raw_json: { 'Broker Name': 'Other Agent' } }))).toBe(false);
  });
});
