import { describe, it, expect } from 'vitest';
import { isActiveBackOfficeRecord } from '@/lib/canonical/isActiveBackOfficeRecord';

const periodStart = new Date('2026-04-01');

describe('canonical/isActiveBackOfficeRecord', () => {
  it('(a) policy active + broker active + eligible Yes → true', () => {
    expect(
      isActiveBackOfficeRecord(
        {
          source_type: 'BACK_OFFICE',
          policy_term_date: '2026-12-31',
          broker_term_date: '9999-12-31',
          eligible_for_commission: 'Yes',
        },
        periodStart,
      ),
    ).toBe(true);
  });

  it('(b) policy active + broker terminated before period → false', () => {
    expect(
      isActiveBackOfficeRecord(
        {
          source_type: 'BACK_OFFICE',
          policy_term_date: '2026-12-31',
          broker_term_date: '2026-03-15',
          eligible_for_commission: 'Yes',
        },
        periodStart,
      ),
    ).toBe(false);
  });

  it("(c) policy active + eligibility 'No' → false", () => {
    expect(
      isActiveBackOfficeRecord(
        {
          source_type: 'BACK_OFFICE',
          policy_term_date: '2026-12-31',
          broker_term_date: null,
          eligible_for_commission: 'No',
        },
        periodStart,
      ),
    ).toBe(false);
  });

  it('(d) policy terminated before period → false', () => {
    expect(
      isActiveBackOfficeRecord(
        {
          source_type: 'BACK_OFFICE',
          policy_term_date: '2026-02-28',
          broker_term_date: null,
          eligible_for_commission: 'Yes',
        },
        periodStart,
      ),
    ).toBe(false);
  });

  it('treats 9999-12-31 sentinel as active (broker)', () => {
    expect(
      isActiveBackOfficeRecord(
        {
          source_type: 'BACK_OFFICE',
          policy_term_date: '2026-12-31',
          broker_term_date: '9999-12-31',
          eligible_for_commission: 'Yes',
        },
        periodStart,
      ),
    ).toBe(true);
  });

  it('falls back to paid_through_date when policy_term_date is null', () => {
    expect(
      isActiveBackOfficeRecord(
        {
          source_type: 'BACK_OFFICE',
          policy_term_date: null,
          paid_through_date: '2026-02-28',
          eligible_for_commission: 'Yes',
        },
        periodStart,
      ),
    ).toBe(false);
  });

  it('passes through non-BACK_OFFICE records as active', () => {
    expect(
      isActiveBackOfficeRecord(
        { source_type: 'EDE', eligible_for_commission: 'No' },
        periodStart,
      ),
    ).toBe(true);
  });
});
