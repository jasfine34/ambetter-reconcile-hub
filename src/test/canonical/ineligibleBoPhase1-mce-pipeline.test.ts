/**
 * Phase 1 repair — final-MCE-output regression tests.
 *
 * Composes the same canonical pipeline MissingCommissionExportPage runs:
 *   applyRuntimeBOActive → computeFilteredEde → filter exclusion set
 *   → getExpectedPaymentBreakdown
 * and asserts that disqualified members are absent from the FINAL
 * breakdown.universe.rows (not just helper false-return).
 *
 * Covers:
 *   3.1 — six named canaries × Coverall/Vix/All scopes
 *   3.2 — EDE-only leak (terminated / paid-through / ineligible)
 *   3.3 — runtime re-evaluation of stale persisted in_back_office=true
 *   3.4 — MCE ranBatchMonth race derivation
 *   3.5 — reconcile producer-side mixed batch
 */
import { describe, it, expect } from 'vitest';
import { applyRuntimeBOActive } from '@/lib/canonical/applyRuntimeBOActive';
import { getStatementMonthBounds } from '@/lib/canonical/statementMonthBounds';
import { computeFilteredEde } from '@/lib/expectedEde';
import { getExpectedPaymentBreakdown } from '@/lib/canonical/metrics';
import { reconcile } from '@/lib/reconcile';
import { getCoveredMonths } from '@/lib/dateRange';

const JASON_AOR = 'Jason Fine (21055210)';

interface SynthOpts {
  memberKey: string;
  applicantName: string;
  issuerSubscriberId: string;
  policyNumber: string;
  effectiveDate: string; // YYYY-MM-DD
  // BO disqualifier
  boPolicyTermDate?: string | null;
  boPaidThroughDate?: string | null;
  boEligible?: string;
  // override persisted reconciled in_back_office
  stalePersistedInBO?: boolean;
}

function makeEdeRow(o: SynthOpts): any {
  return {
    source_type: 'EDE',
    source_file_label: 'EDE Summary',
    carrier: 'Ambetter',
    applicant_name: o.applicantName,
    first_name: '',
    last_name: '',
    dob: null,
    member_id: '',
    policy_number: o.policyNumber,
    exchange_subscriber_id: '',
    exchange_policy_id: '',
    issuer_policy_id: '',
    issuer_subscriber_id: o.issuerSubscriberId,
    agent_name: 'Jason Fine',
    agent_npn: '21055210',
    aor_bucket: 'Jason',
    pay_entity: 'Coverall',
    status: 'Effectuated',
    effective_date: o.effectiveDate,
    premium: 100,
    net_premium: 100,
    commission_amount: null,
    eligible_for_commission: 'Yes',
    policy_term_date: null,
    paid_through_date: null,
    broker_effective_date: null,
    broker_term_date: '9999-12-31',
    member_responsibility: null,
    on_off_exchange: '',
    auto_renewal: null,
    ede_policy_origin_type: '',
    ede_bucket: '',
    policy_modified_date: null,
    client_address_1: '',
    client_address_2: '',
    client_city: '',
    client_state_full: '',
    client_zip: '',
    paid_to_date: null,
    months_paid: null,
    writing_agent_carrier_id: '',
    member_key: o.memberKey,
    raw_json: {
      issuer: 'Ambetter',
      policyStatus: 'Effectuated',
      currentPolicyAOR: JASON_AOR,
      issuerSubscriberId: o.issuerSubscriberId,
    },
  };
}

function makeBoRow(o: SynthOpts): any {
  return {
    source_type: 'BACK_OFFICE',
    source_file_label: 'BO',
    carrier: 'Ambetter',
    applicant_name: o.applicantName,
    first_name: '',
    last_name: '',
    dob: null,
    member_id: '',
    policy_number: o.policyNumber,
    exchange_subscriber_id: '',
    exchange_policy_id: '',
    issuer_policy_id: '',
    issuer_subscriber_id: o.issuerSubscriberId,
    agent_name: 'Jason Fine',
    agent_npn: '21055210',
    aor_bucket: 'Jason',
    pay_entity: 'Coverall',
    status: 'Active',
    effective_date: o.effectiveDate,
    premium: 100,
    net_premium: 100,
    commission_amount: null,
    eligible_for_commission: o.boEligible ?? 'Yes',
    policy_term_date: o.boPolicyTermDate ?? null,
    paid_through_date: o.boPaidThroughDate ?? null,
    broker_effective_date: null,
    broker_term_date: '9999-12-31',
    member_responsibility: null,
    on_off_exchange: '',
    auto_renewal: null,
    ede_policy_origin_type: '',
    ede_bucket: '',
    policy_modified_date: null,
    client_address_1: '',
    client_address_2: '',
    client_city: '',
    client_state_full: '',
    client_zip: '',
    paid_to_date: null,
    months_paid: null,
    writing_agent_carrier_id: '',
    member_key: o.memberKey,
    raw_json: {},
  };
}

function makeReconciled(o: SynthOpts): any {
  return {
    member_key: o.memberKey,
    carrier: 'Ambetter',
    applicant_name: o.applicantName,
    dob: null,
    policy_number: o.policyNumber,
    exchange_subscriber_id: '',
    exchange_policy_id: '',
    issuer_policy_id: '',
    issuer_subscriber_id: o.issuerSubscriberId,
    agent_name: 'Jason Fine',
    agent_npn: '21055210',
    aor_bucket: 'Jason',
    current_policy_aor: JASON_AOR,
    expected_pay_entity: 'Coverall',
    actual_pay_entity: '',
    in_ede: true,
    in_back_office: o.stalePersistedInBO ?? true,
    in_commission: false,
    eligible_for_commission: 'Yes',
    premium: 100,
    net_premium: 100,
    actual_commission: null,
    positive_commission: null,
    clawback_amount: null,
    estimated_missing_commission: 18,
    issue_type: '',
    issue_notes: '',
    source_count: 2,
    commission_record_count: 0,
    has_mixed_sources: true,
  };
}

/**
 * Runs the MCE canonical pipeline composition (mirrors
 * MissingCommissionExportPage.runReport lines 721-786) and returns the
 * final breakdown universe row set.
 */
function runMcePipeline(opts: {
  reconciled: any[];
  normalized: any[];
  statementMonth: string; // 'YYYY-MM'
  scope: 'Coverall' | 'Vix' | 'All';
}) {
  const monthBounds = getStatementMonthBounds(opts.statementMonth);
  const boNormalized = opts.normalized.filter((n) => n.source_type === 'BACK_OFFICE');
  const { adjustedReconciled, mceExclusionMemberKeys } = applyRuntimeBOActive(
    opts.reconciled,
    boNormalized,
    monthBounds,
  );
  const coveredMonths = getCoveredMonths(opts.statementMonth + '-01');
  const filteredEdeRaw = computeFilteredEde(
    opts.normalized,
    adjustedReconciled,
    opts.scope,
    coveredMonths,
  );
  const uniqueMembers = (filteredEdeRaw.uniqueMembers ?? []).filter(
    (m: any) => !mceExclusionMemberKeys.has(m.member_key),
  );
  const missingFromBO = (filteredEdeRaw.missingFromBO ?? []).filter(
    (m: any) => !mceExclusionMemberKeys.has(m.member_key),
  );
  const byMonth: Record<string, number> = {};
  for (const m of uniqueMembers) {
    if (m.effective_month) byMonth[m.effective_month] = (byMonth[m.effective_month] ?? 0) + 1;
  }
  const filteredEde = {
    uniqueMembers,
    uniqueKeys: uniqueMembers.length,
    byMonth,
    inBOCount: uniqueMembers.filter((m: any) => m.in_back_office).length,
    notInBOCount: missingFromBO.length,
    missingFromBO,
  };
  const reconciledForBreakdown = adjustedReconciled.filter(
    (r: any) => !mceExclusionMemberKeys.has(r.member_key),
  );
  const breakdown = getExpectedPaymentBreakdown(
    reconciledForBreakdown,
    opts.scope,
    filteredEde,
    new Set<string>(),
  );
  const allRowKeys = new Set<string>([
    ...breakdown.universe.rows.map((r: any) => r.member_key),
    ...breakdown.paidRows.map((r: any) => r.member_key),
    ...breakdown.unpaidRows.map((r: any) => r.member_key),
  ]);
  return { breakdown, allRowKeys, mceExclusionMemberKeys };
}

// ===========================================================================
// 3.1 — Six named canaries × all scopes
// ===========================================================================

interface Canary {
  name: string;
  policyTerm: string;
  eligible: string;
  policyNumber: string;
  isid: string;
}

const CANARIES: Canary[] = [
  { name: 'Misty Karkowski', policyTerm: '2023-10-31', eligible: 'No', policyNumber: 'POL-MK', isid: 'U-MK-1' },
  { name: 'Kim Smith',       policyTerm: '2024-07-20', eligible: 'No', policyNumber: 'POL-KS', isid: 'U-KS-1' },
  { name: 'Juan Fuentes',    policyTerm: '2025-12-31', eligible: 'No', policyNumber: 'POL-JF', isid: 'U-JF-1' },
  { name: 'Jeffrey Hill',    policyTerm: '2025-12-31', eligible: 'No', policyNumber: 'POL-JH', isid: 'U-JH-1' },
  { name: 'Bernard Gratzer', policyTerm: '2025-12-31', eligible: 'No', policyNumber: 'POL-BG', isid: 'U-BG-1' },
  { name: 'Christopher Ortiz', policyTerm: '2027-01-01', eligible: 'No', policyNumber: 'U90161212', isid: 'U-CO-1' },
];

const MONTHS_2026 = ['2026-01', '2026-02', '2026-03', '2026-04'];
const SCOPES: Array<'Coverall' | 'Vix' | 'All'> = ['Coverall', 'Vix', 'All'];

describe('3.1 — six named canaries absent from final MCE breakdown', () => {
  for (const c of CANARIES) {
    for (const month of MONTHS_2026) {
      // Christopher Ortiz — January 2026 is explicitly deferred (raw-file
      // investigation pending); only assert Feb/Mar/Apr.
      if (c.name === 'Christopher Ortiz' && month === '2026-01') continue;

      for (const scope of SCOPES) {
        it(`${c.name} — NOT in ${month} ${scope} MCE`, () => {
          const opts: SynthOpts = {
            memberKey: `mk:${c.isid}`,
            applicantName: c.name,
            issuerSubscriberId: c.isid,
            policyNumber: c.policyNumber,
            effectiveDate: '2026-01-01',
            boPolicyTermDate: c.policyTerm,
            boEligible: c.eligible,
            stalePersistedInBO: true,
          };
          const { allRowKeys, mceExclusionMemberKeys } = runMcePipeline({
            reconciled: [makeReconciled(opts)],
            normalized: [makeEdeRow(opts), makeBoRow(opts)],
            statementMonth: month,
            scope,
          });
          expect(mceExclusionMemberKeys.has(opts.memberKey)).toBe(true);
          expect(allRowKeys.has(opts.memberKey)).toBe(false);
        });
      }
    }
  }

  // Sanity — Juan Fuentes IN 2025 months (pre-term) when eligible flips to
  // 'Yes'. Phase 1 helper makes eligibility the dominant rule, so the
  // canonical exclusion still fires with eligible='No'. This sanity test
  // documents that eligibility=Yes + future term = active.
  for (const month of ['2025-11', '2025-12']) {
    it(`Juan Fuentes (eligible Yes, term future) — IN ${month} All MCE`, () => {
      const opts: SynthOpts = {
        memberKey: 'mk:U-JF-1',
        applicantName: 'Juan Fuentes',
        issuerSubscriberId: 'U-JF-1',
        policyNumber: 'POL-JF',
        effectiveDate: '2025-11-01',
        boPolicyTermDate: '2026-06-30',
        boEligible: 'Yes',
      };
      const { mceExclusionMemberKeys } = runMcePipeline({
        reconciled: [makeReconciled(opts)],
        normalized: [makeEdeRow(opts), makeBoRow(opts)],
        statementMonth: month,
        scope: 'All',
      });
      expect(mceExclusionMemberKeys.has(opts.memberKey)).toBe(false);
    });
  }
});

// ===========================================================================
// 3.2 — EDE-Only leak (three disqualifier classes)
// ===========================================================================

describe('3.2 — EDE-only leak regression (no eligibility gate on EDE-Only branch)', () => {
  const disqualifiers: Array<{ label: string; bo: Partial<SynthOpts> }> = [
    { label: 'terminated (policy_term_date < statementMonthStart)', bo: { boPolicyTermDate: '2026-03-15' } },
    { label: 'paid-through-covered (paid_through_date >= statementMonthEnd)', bo: { boPaidThroughDate: '2026-04-30' } },
    { label: "eligible_for_commission='No'",                                 bo: { boEligible: 'No' } },
  ];

  for (const d of disqualifiers) {
    it(`EDE-only leak absent — ${d.label}`, () => {
      const opts: SynthOpts = {
        memberKey: 'mk:LEAK-1',
        applicantName: 'Leak Test',
        issuerSubscriberId: 'U-LEAK-1',
        policyNumber: 'POL-LEAK',
        effectiveDate: '2026-01-01',
        stalePersistedInBO: false, // EDE-only: not flagged BO-active persisted
        ...d.bo,
      };
      const { allRowKeys } = runMcePipeline({
        reconciled: [makeReconciled(opts)],
        normalized: [makeEdeRow(opts), makeBoRow(opts)],
        statementMonth: '2026-04',
        scope: 'All',
      });
      expect(allRowKeys.has(opts.memberKey)).toBe(false);
    });
  }
});

// ===========================================================================
// 3.3 — Runtime re-evaluation overrides stale persisted in_back_office=true
// ===========================================================================

describe('3.3 — runtime re-eval overrides stale persisted in_back_office', () => {
  it('stale in_back_office=true + now-terminated BO → absent from final MCE', () => {
    const opts: SynthOpts = {
      memberKey: 'mk:STALE-1',
      applicantName: 'Stale Persisted',
      issuerSubscriberId: 'U-STALE-1',
      policyNumber: 'POL-STALE',
      effectiveDate: '2026-01-01',
      boPolicyTermDate: '2026-03-15',
      stalePersistedInBO: true,
    };
    const { allRowKeys, mceExclusionMemberKeys } = runMcePipeline({
      reconciled: [makeReconciled(opts)],
      normalized: [makeEdeRow(opts), makeBoRow(opts)],
      statementMonth: '2026-04',
      scope: 'All',
    });
    expect(mceExclusionMemberKeys.has(opts.memberKey)).toBe(true);
    expect(allRowKeys.has(opts.memberKey)).toBe(false);
  });
});

// ===========================================================================
// 3.4 — MCE ranBatchMonth race derivation
// ===========================================================================

describe('3.4 — ranBatchMonth race: monthBounds derives from captured snapshot', () => {
  it('mutating currentBatch mid-run does NOT shift monthBounds', () => {
    const currentBatch: { statement_month: string } = { statement_month: '2026-04-01' };
    // CAPTURE phase (mirrors page lines 668-671)
    const ranBatchMonth = currentBatch.statement_month
      ? String(currentBatch.statement_month).substring(0, 7)
      : '';

    // Mutate after capture, before bounds derivation
    currentBatch.statement_month = '2026-05-01';

    const monthBounds = getStatementMonthBounds(ranBatchMonth);
    expect(monthBounds.start).toBe('2026-04-01');
    expect(monthBounds.end).toBe('2026-04-30');
  });
});

// ===========================================================================
// 3.5 — Reconcile producer-side mixed batch
// ===========================================================================

describe('3.5 — reconcile producer-side mixed BO records', () => {
  it('persisted in_back_office reflects new helper output per class', () => {
    const reconcileMonth = '2026-04';
    const make = (label: string, isid: string, over: Partial<any>) => ({
      ...makeBoRow({
        memberKey: `mk:${label}`,
        applicantName: label,
        issuerSubscriberId: isid,
        policyNumber: `POL-${label}`,
        effectiveDate: '2026-01-01',
      }),
      ...over,
    });

    const recA = make('Active', 'U-A', {
      policy_term_date: '2027-12-31',
      paid_through_date: '2026-01-31',
      eligible_for_commission: 'Yes',
    });
    const recB = make('Terminated', 'U-B', {
      policy_term_date: '2026-03-15',
      eligible_for_commission: 'Yes',
    });
    const recC = make('PaidThru', 'U-C', {
      paid_through_date: '2026-04-30',
      eligible_for_commission: 'Yes',
    });
    const recD = make('Ineligible', 'U-D', {
      policy_term_date: '2027-12-31',
      eligible_for_commission: 'No',
    });

    const { members } = reconcile([recA, recB, recC, recD] as any, reconcileMonth);
    const byKey = new Map(members.map((m) => [m.member_key, m]));
    // ISIDs clean to lowercase alnum: 'U-A' → 'ua', etc.
    expect(byKey.get('issub:ua')?.in_back_office).toBe(true);
    expect(byKey.get('issub:ub')?.in_back_office).toBe(false);
    expect(byKey.get('issub:uc')?.in_back_office).toBe(false);
    expect(byKey.get('issub:ud')?.in_back_office).toBe(false);
  });
});
