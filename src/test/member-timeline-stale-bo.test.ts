/**
 * Stale Back Office classifier guard tests.
 *
 * Covers the Jason 2026-05-18 issue: Member Timeline rows showing UNPAID /
 * PENDING for months where every source flag (EDE / BO / commission) is
 * false, driven by stale historical BO evidence (paid_through_date in 2024)
 * leaking through memberBelongsToUs() + computeFirstEligibleMonth().
 *
 * Fix lives in src/lib/classifier.ts:
 *   Change 1 — hasActiveBoForMonth() delegates to isActiveBackOfficeRecord
 *   Change 2 — classifyCell() guards no-current-source months as
 *              not_expected_cancelled before falling through to Rule 2 pending
 */
import { describe, it, expect } from 'vitest';
import {
  classifyMember,
  buildClassifierContext,
  type ClassifierContext,
} from '@/lib/classifier';
import type { NormalizedRecord } from '@/lib/normalize';
import type { MonthKey } from '@/lib/dateRange';

const COVERALL_NPN = '21055210'; // Jason Fine — one of our AORs
const COVERALL_NAME = 'Jason Fine';

function rec(overrides: Partial<NormalizedRecord>): NormalizedRecord {
  return {
    source_type: '',
    source_file_label: '',
    carrier: 'ambetter',
    applicant_name: '',
    first_name: '',
    last_name: '',
    dob: null,
    member_id: '',
    policy_number: '',
    exchange_subscriber_id: '',
    exchange_policy_id: '',
    issuer_policy_id: '',
    issuer_subscriber_id: '',
    agent_name: '',
    agent_npn: '',
    aor_bucket: '',
    pay_entity: '',
    status: '',
    effective_date: null,
    premium: null,
    net_premium: null,
    commission_amount: null,
    eligible_for_commission: '',
    policy_term_date: null,
    paid_through_date: null,
    broker_effective_date: null,
    broker_term_date: null,
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
    member_key: 'member:test',
    raw_json: {},
    ...overrides,
  } as NormalizedRecord;
}

const MONTHS: MonthKey[] = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05'];

/** Context where every requested month is ripe (commission statement uploaded). */
function ripeContext(months: MonthKey[] = MONTHS): ClassifierContext {
  return {
    months,
    commissionStatementMonths: new Set(months),
    boSnapshotDates: [],
  };
}

function staleBoRow(name: string, paidThrough: string): NormalizedRecord {
  return rec({
    source_type: 'BACK_OFFICE',
    applicant_name: name,
    agent_npn: COVERALL_NPN,
    agent_name: COVERALL_NAME,
    aor_bucket: COVERALL_NAME,
    effective_date: '2023-06-01',
    paid_through_date: paidThrough,
    eligible_for_commission: 'Yes',
  });
}

function assertNoStaleDue(result: ReturnType<typeof classifyMember>) {
  let monthsDue = 0;
  for (const m of MONTHS) {
    const cell = result.cells[m];
    expect(cell.state).not.toBe('unpaid');
    expect(cell.state).not.toBe('pending');
    expect(cell.state).not.toBe('manual_review');
    // No current source flags should be lit
    expect(cell.in_ede).toBe(false);
    expect(cell.in_back_office).toBe(false);
    expect(cell.in_commission).toBe(false);
    if (!cell.state.startsWith('not_expected') && cell.state !== 'paid') {
      monthsDue++;
    }
  }
  expect(monthsDue).toBe(0);
}

describe('classifier — stale Back Office no-current-source guard', () => {
  it('Aaron Stanley canary — BO paid_through 2024-01-01, no current EDE/commission', () => {
    const records = [staleBoRow('Aaron Stanley', '2024-01-01')];
    const out = classifyMember(records, ripeContext());
    assertNoStaleDue(out);
    for (const m of MONTHS) {
      expect(out.cells[m].state).toBe('not_expected_cancelled');
    }
  });

  it('Alexis Gibson canary — same shape, paid_through 2024-01-01', () => {
    const records = [staleBoRow('Alexis Gibson', '2024-01-01')];
    const out = classifyMember(records, ripeContext());
    assertNoStaleDue(out);
  });

  it('Amanda Price canary — BO paid_through 2024-05-31', () => {
    const records = [staleBoRow('Amanda Price', '2024-05-31')];
    const out = classifyMember(records, ripeContext());
    assertNoStaleDue(out);
  });

  it("eligible='No' regression — future paid_through but ineligible → no UNPAID/PENDING", () => {
    const records = [
      rec({
        source_type: 'BACK_OFFICE',
        applicant_name: 'Ineligible Member',
        agent_npn: COVERALL_NPN,
        effective_date: '2025-06-01',
        paid_through_date: '2026-12-31',
        eligible_for_commission: 'No',
      }),
    ];
    const out = classifyMember(records, ripeContext());
    for (const m of MONTHS) {
      expect(out.cells[m].state).not.toBe('unpaid');
      expect(out.cells[m].state).not.toBe('pending');
      expect(out.cells[m].in_back_office).toBe(false);
    }
  });

  it('active BO-only regression guard — eligible, paid_through covers month → UNPAID', () => {
    const month: MonthKey = '2026-05';
    const records = [
      rec({
        source_type: 'BACK_OFFICE',
        applicant_name: 'Active Member',
        agent_npn: COVERALL_NPN,
        effective_date: '2025-06-01',
        paid_through_date: '2026-05-31',
        eligible_for_commission: 'Yes',
      }),
    ];
    const out = classifyMember(records, ripeContext([month]));
    const cell = out.cells[month];
    expect(cell.in_back_office).toBe(true);
    expect(cell.state).toBe('unpaid');
  });

  it('stale BO + current EDE — EDE drives classification, stale BO does not poison', () => {
    const records = [
      staleBoRow('Mixed Member', '2024-01-01'),
      rec({
        source_type: 'EDE',
        applicant_name: 'Mixed Member',
        carrier: 'ambetter',
        effective_date: '2026-01-01',
        status: 'effectuated',
        raw_json: {
          policyStatus: 'Effectuated',
          currentPolicyAOR: `${COVERALL_NAME} (${COVERALL_NPN})`,
          issuer: 'Ambetter from Sunshine Health',
        },
      }),
    ];
    const out = classifyMember(records, ripeContext());
    for (const m of MONTHS) {
      const cell = out.cells[m];
      expect(cell.in_ede).toBe(true);
      // With EDE present, cell is no longer the no-source guard case
      expect(cell.state).not.toBe('not_expected_cancelled');
    }
  });

  it('stale BO + commission in one month — paid for that month, no unpaid elsewhere', () => {
    const paidMonth: MonthKey = '2026-03';
    const records = [
      staleBoRow('Comm Member', '2024-01-01'),
      rec({
        source_type: 'COMMISSION',
        applicant_name: 'Comm Member',
        agent_npn: COVERALL_NPN,
        aor_bucket: COVERALL_NAME,
        paid_to_date: '2026-03-31',
        months_paid: 1,
        commission_amount: 42.5,
      }),
    ];
    // Derive context from commission rows so paidMonth is the statement month
    const ctx = buildClassifierContext(records, MONTHS, []);
    const out = classifyMember(records, ctx);
    expect(out.cells[paidMonth].state).toBe('paid');
    for (const m of MONTHS) {
      if (m === paidMonth) continue;
      expect(out.cells[m].state).not.toBe('unpaid');
      expect(out.cells[m].state).not.toBe('pending');
    }
  });

  it('historical-leakage canary — historical BO establishes belongsToUs, but no current source → not_expected', () => {
    // Member was historically ours (memberBelongsToUs=true,
    // computeFirstEligibleMonth returns 2023-06 from effective_date), but
    // every classified month has no current source flag.
    const records = [staleBoRow('Historic Member', '2024-01-01')];
    const out = classifyMember(records, ripeContext());
    expect(out.first_eligible_month).toBe('2023-06');
    for (const m of MONTHS) {
      expect(out.cells[m].state).toBe('not_expected_cancelled');
    }
    // Row contributes zero months_due (no eligible cells)
    const dueCells = Object.values(out.cells).filter(
      c => !c.state.startsWith('not_expected') && c.state !== 'paid',
    );
    expect(dueCells.length).toBe(0);
  });

  it('classifier-level no-source invariant — every month with all-false sources is not_expected_*', () => {
    const records = [staleBoRow('Invariant Member', '2024-01-01')];
    const out = classifyMember(records, ripeContext());
    for (const m of MONTHS) {
      const cell = out.cells[m];
      if (!cell.in_ede && !cell.in_back_office && !cell.in_commission && cell.paid_amount === 0) {
        expect(cell.state.startsWith('not_expected')).toBe(true);
      }
    }
  });
});
