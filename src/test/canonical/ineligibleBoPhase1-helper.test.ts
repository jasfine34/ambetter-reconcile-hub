/**
 * Ineligible-BO Phase 1 — comprehensive helper edge-case tests.
 */
import { describe, it, expect } from 'vitest';
import { isActiveBackOfficeRecord } from '@/lib/canonical/isActiveBackOfficeRecord';

const START = '2026-04-01';
const END = '2026-04-30';

const base = {
  source_type: 'BACK_OFFICE' as const,
  eligible_for_commission: 'Yes' as const,
};

describe('Phase 1 — isActiveBackOfficeRecord edge cases', () => {
  it("eligible_for_commission='No' → false regardless of dates", () => {
    expect(
      isActiveBackOfficeRecord(
        { ...base, eligible_for_commission: 'No', policy_term_date: '9999-12-31' },
        START,
        END,
      ),
    ).toBe(false);
  });

  it('eligible_for_commission=false (boolean) → false', () => {
    expect(
      isActiveBackOfficeRecord({ ...base, eligible_for_commission: false }, START, END),
    ).toBe(false);
  });

  it('policy_term_date < statementMonthStart → false', () => {
    expect(
      isActiveBackOfficeRecord({ ...base, policy_term_date: '2026-03-15' }, START, END),
    ).toBe(false);
  });

  it('policy_term_date === statementMonthStart → false (current <= behavior preserved)', () => {
    expect(
      isActiveBackOfficeRecord({ ...base, policy_term_date: START }, START, END),
    ).toBe(false);
  });

  it('policy_term_date > statementMonthStart → true', () => {
    expect(
      isActiveBackOfficeRecord({ ...base, policy_term_date: '2026-12-31' }, START, END),
    ).toBe(true);
  });

  it('paid_through_date === statementMonthEnd → true (v5 prerequisite Fix 1: paid_through removed as disqualifier)', () => {
    expect(
      isActiveBackOfficeRecord({ ...base, paid_through_date: END }, START, END),
    ).toBe(true);
  });

  it('paid_through_date > statementMonthEnd → true (v5 prerequisite Fix 1: paid_through removed)', () => {
    expect(
      isActiveBackOfficeRecord({ ...base, paid_through_date: '2026-06-30' }, START, END),
    ).toBe(true);
  });

  it('paid_through_date < statementMonthEnd → true (genuinely unpaid — unchanged)', () => {
    expect(
      isActiveBackOfficeRecord({ ...base, paid_through_date: '2026-03-31' }, START, END),
    ).toBe(true);
  });

  it('both dates null → true (no exclusion evidence)', () => {
    expect(
      isActiveBackOfficeRecord({ ...base, policy_term_date: null, paid_through_date: null }, START, END),
    ).toBe(true);
  });

  it('CRITICAL: policy_term FUTURE + paid_through PAST → true (old combined-fallback bug fixed)', () => {
    expect(
      isActiveBackOfficeRecord(
        { ...base, policy_term_date: '2027-01-01', paid_through_date: '2025-01-31' },
        START,
        END,
      ),
    ).toBe(true);
  });

  it('9999-* policy_term sentinel treated as no end', () => {
    expect(
      isActiveBackOfficeRecord({ ...base, policy_term_date: '9999-12-31' }, START, END),
    ).toBe(true);
  });

  it('Phase 2 strict signature: both bounds required + paid_through no longer disqualifies', () => {
    expect(
      isActiveBackOfficeRecord({ ...base, paid_through_date: '2026-04-30' }, START, END),
    ).toBe(true);
  });

  // ── Fix 5 — broker_effective_date disqualifier ─────────────────────────
  it('Fix 5: broker_effective_date > statementMonthEnd → false (broker not yet effective)', () => {
    expect(
      isActiveBackOfficeRecord(
        { ...base, policy_term_date: '2027-12-31', broker_effective_date: '2026-05-15' },
        START,
        END,
      ),
    ).toBe(false);
  });

  it('Fix 5: broker_effective_date <= statementMonthEnd → true', () => {
    expect(
      isActiveBackOfficeRecord(
        { ...base, policy_term_date: '2027-12-31', broker_effective_date: '2026-04-15' },
        START,
        END,
      ),
    ).toBe(true);
  });

  it('Fix 5: broker_effective_date 9999-* sentinel ignored', () => {
    expect(
      isActiveBackOfficeRecord(
        { ...base, policy_term_date: '2027-12-31', broker_effective_date: '9999-12-31' },
        START,
        END,
      ),
    ).toBe(true);
  });
});

