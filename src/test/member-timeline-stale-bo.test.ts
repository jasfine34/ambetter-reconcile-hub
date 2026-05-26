/**
 * Stale Back Office classifier guard tests — UPDATED for Ineligible-BO
 * Phase 1 semantics.
 *
 * Phase 1 changed isActiveBackOfficeRecord: paid_through_date is now
 * evaluated INDEPENDENTLY against the statement month END
 * (last-day-inclusive). A paid_through in the past means "behind on
 * payments → active in BO universe" rather than the prior fallback
 * semantic of "terminated".
 *
 * Per directive INTERMEDIATE-STATE NOTE, Member Timeline classifier
 * behavior is intentionally STALE between Phase 1 and Phase 3. Tests
 * below assert the Phase 1 helper-driven behavior; Phase 3 will revisit
 * Member Timeline-specific semantics.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyMember,
  buildClassifierContext,
  type ClassifierContext,
} from '@/lib/classifier';
import type { NormalizedRecord } from '@/lib/normalize';
import type { MonthKey } from '@/lib/dateRange';

const COVERALL_NPN = '21055210';
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
    issuer_subscriber_id: '',
    issuer_policy_id: '',
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

function ripeContext(months: MonthKey[] = MONTHS): ClassifierContext {
  return {
    months,
    commissionStatementMonths: new Set(months),
    boSnapshotDates: [],
  };
}

function bo(name: string, opts: Partial<NormalizedRecord>): NormalizedRecord {
  return rec({
    source_type: 'BACK_OFFICE',
    applicant_name: name,
    agent_npn: COVERALL_NPN,
    agent_name: COVERALL_NAME,
    aor_bucket: COVERALL_NAME,
    effective_date: '2023-06-01',
    eligible_for_commission: 'Yes',
    ...opts,
  });
}

describe('classifier — Ineligible-BO Phase 1 semantics', () => {
  it("eligible='No' — ineligible BO never counts as active", () => {
    const records = [
      bo('Ineligible Member', {
        effective_date: '2025-06-01',
        paid_through_date: '2026-12-31',
        eligible_for_commission: 'No',
      }),
    ];
    const out = classifyMember(records, ripeContext());
    for (const m of MONTHS) {
      expect(out.cells[m].in_back_office).toBe(false);
      expect(out.cells[m].state).not.toBe('unpaid');
      expect(out.cells[m].state).not.toBe('pending');
    }
  });

  it('paid_through covers the month — ACTIVE in v5 (Fix 1: paid_through removed as disqualifier)', () => {
    const month: MonthKey = '2026-05';
    const records = [
      bo('Paid-Through Member', {
        effective_date: '2025-06-01',
        paid_through_date: '2026-05-31',
      }),
    ];
    const out = classifyMember(records, ripeContext([month]));
    expect(out.cells[month].in_back_office).toBe(true);
  });


  it('paid_through BEFORE month end — active (behind on payments)', () => {
    const month: MonthKey = '2026-05';
    const records = [
      bo('Behind Member', {
        effective_date: '2025-06-01',
        paid_through_date: '2026-04-30',
      }),
    ];
    const out = classifyMember(records, ripeContext([month]));
    expect(out.cells[month].in_back_office).toBe(true);
  });

  it('policy_term_date past — terminated, not active', () => {
    const records = [
      bo('Terminated', {
        effective_date: '2023-06-01',
        policy_term_date: '2024-01-01',
      }),
    ];
    const out = classifyMember(records, ripeContext());
    for (const m of MONTHS) {
      expect(out.cells[m].in_back_office).toBe(false);
    }
  });

  it('policy_term_date future — active', () => {
    const month: MonthKey = '2026-03';
    const records = [
      bo('Active', {
        effective_date: '2025-06-01',
        policy_term_date: '2026-12-31',
      }),
    ];
    const out = classifyMember(records, ripeContext([month]));
    expect(out.cells[month].in_back_office).toBe(true);
  });

  it('stale BO + current EDE — EDE still drives the cell', () => {
    const records = [
      bo('Mixed Member', { policy_term_date: '2024-01-01' }),
      rec({
        source_type: 'EDE',
        applicant_name: 'Mixed Member',
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
      expect(out.cells[m].in_ede).toBe(true);
    }
  });

  it('stale BO + commission in one month — paid for that month', () => {
    const paidMonth: MonthKey = '2026-03';
    const records = [
      bo('Comm Member', { policy_term_date: '2024-01-01' }),
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
    const ctx = buildClassifierContext(records, MONTHS, []);
    const out = classifyMember(records, ctx);
    expect(out.cells[paidMonth].state).toBe('paid');
  });
});
