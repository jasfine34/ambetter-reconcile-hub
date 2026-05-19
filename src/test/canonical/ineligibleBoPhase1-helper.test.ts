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

  it('paid_through_date === statementMonthEnd → false (last-day-inclusive)', () => {
    expect(
      isActiveBackOfficeRecord({ ...base, paid_through_date: END }, START, END),
    ).toBe(false);
  });

  it('paid_through_date > statementMonthEnd → false', () => {
    expect(
      isActiveBackOfficeRecord({ ...base, paid_through_date: '2026-06-30' }, START, END),
    ).toBe(false);
  });

  it('paid_through_date < statementMonthEnd → true (genuinely unpaid)', () => {
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

  it('end derived when omitted (backward-compat single-arg)', () => {
    expect(
      isActiveBackOfficeRecord({ ...base, paid_through_date: '2026-04-30' }, START),
    ).toBe(false);
  });
});
