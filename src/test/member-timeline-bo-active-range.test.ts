/**
 * MT cell-assembly tests — Fix 2 (BO range day-aware term + paid_through
 * removed) + Fix 5 (BED-aware start) + Fix 7 (BO stamping per-month
 * canonical predicate AND scope gate).
 */
import { describe, it, expect } from 'vitest';
import { buildMemberTimeline, buildMonthList } from '@/lib/memberTimeline';
import type { NormalizedRecord } from '@/lib/normalize';

function bo(over: Partial<NormalizedRecord> & Record<string, any>): any {
  return {
    source_type: 'BACK_OFFICE',
    carrier: 'ambetter',
    applicant_name: 'Test',
    member_key: 'm:1',
    effective_date: '2026-01-01',
    eligible_for_commission: 'Yes',
    policy_term_date: null,
    paid_through_date: null,
    broker_effective_date: null,
    broker_term_date: null,
    member_responsibility: null,
    raw_json: {},
    ...over,
  };
}

const MONTHS = buildMonthList('2026-01', '2026-06');

describe('Fix 2 — backOfficeActiveRange paid_through removed + day-aware term', () => {
  it('paid_through past, no policy_term → in_back_office through end of range', () => {
    const rows = buildMemberTimeline([bo({ paid_through_date: '2025-12-31' })], MONTHS);
    for (const m of MONTHS) expect(rows[0].cells[m].in_back_office).toBe(true);
  });

  it('policy_term day 01 → previous month is last active (R-INELIG-001)', () => {
    const rows = buildMemberTimeline([bo({ policy_term_date: '2026-04-01' })], MONTHS);
    expect(rows[0].cells['2026-03'].in_back_office).toBe(true);
    expect(rows[0].cells['2026-04'].in_back_office).toBe(false);
  });

  it('policy_term day 15 → term month is last active (R-INELIG-001)', () => {
    const rows = buildMemberTimeline([bo({ policy_term_date: '2026-04-15' })], MONTHS);
    expect(rows[0].cells['2026-04'].in_back_office).toBe(true);
    expect(rows[0].cells['2026-05'].in_back_office).toBe(false);
  });
});

describe('Fix 5 — BED-aware start', () => {
  it('BED > PED → BO does not stamp pre-BED months', () => {
    const rows = buildMemberTimeline(
      [bo({ effective_date: '2026-01-01', broker_effective_date: '2026-04-15' })],
      MONTHS,
    );
    expect(rows[0].cells['2026-03'].in_back_office).toBe(false);
    expect(rows[0].cells['2026-04'].in_back_office).toBe(true);
  });
});

describe('Fix 7 — per-month canonical predicate + scope gate', () => {
  it('broker_term inside service month → next month NOT stamped (canonical predicate disqualifies)', () => {
    const rows = buildMemberTimeline([bo({ broker_term_date: '2026-03-15' })], MONTHS);
    expect(rows[0].cells['2026-03'].in_back_office).toBe(true);
    // broker_term_date '2026-03-15' <= statementMonthStart '2026-04-01' → disqualified for April
    expect(rows[0].cells['2026-04'].in_back_office).toBe(false);
  });

  it('eligible_for_commission=No → in_back_office=false for every month (Fix 7 canonical gate)', () => {
    const rows = buildMemberTimeline([bo({ eligible_for_commission: 'No' })], MONTHS);
    for (const m of MONTHS) expect(rows[0].cells[m].in_back_office).toBe(false);
  });

  it('off-scope active BO (eligibleForDue=false) → in_back_office=false AND due=false (Fix 7 v5 C1)', () => {
    const offScope = () => false; // every record off-scope
    const rows = buildMemberTimeline([bo({ policy_term_date: '2027-12-31' })], MONTHS, offScope);
    for (const m of MONTHS) {
      expect(rows[0].cells[m].in_back_office).toBe(false);
      expect(rows[0].cells[m].due).toBe(false);
    }
  });
});
