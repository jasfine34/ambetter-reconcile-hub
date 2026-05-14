import { describe, it, expect } from 'vitest';
import { deriveCoveredServiceMonths } from '@/lib/canonical/serviceMonth';

describe('deriveCoveredServiceMonths', () => {
  it('paid_to_date + months_paid=3 → walks back 3 months', () => {
    const r = deriveCoveredServiceMonths({ paid_to_date: '2026-02-15', months_paid: 3 });
    expect(r.status).toBe('resolved');
    if (r.status === 'resolved') expect(r.months).toEqual(['2025-12', '2026-01', '2026-02']);
  });
  it('months_paid=1 → single month', () => {
    const r = deriveCoveredServiceMonths({ paid_to_date: '2026-02-15', months_paid: 1 });
    if (r.status === 'resolved') expect(r.months).toEqual(['2026-02']);
  });
  it('missing paid_to_date → unresolvable', () => {
    const r = deriveCoveredServiceMonths({ paid_to_date: null, months_paid: 1 });
    expect(r.status).toBe('unresolvable');
  });
  it('missing months_paid → unresolvable', () => {
    const r = deriveCoveredServiceMonths({ paid_to_date: '2026-02-15', months_paid: null });
    expect(r.status).toBe('unresolvable');
  });
  it('invalid months_paid (zero) → unresolvable', () => {
    const r = deriveCoveredServiceMonths({ paid_to_date: '2026-02-15', months_paid: 0 });
    expect(r.status).toBe('unresolvable');
  });
  it('invalid date → unresolvable', () => {
    const r = deriveCoveredServiceMonths({ paid_to_date: 'garbage', months_paid: 1 });
    expect(r.status).toBe('unresolvable');
  });
});
