import { describe, it, expect } from 'vitest';
import { lastActiveMonthForTermDate } from '@/lib/canonical/termBoundary';

describe('lastActiveMonthForTermDate (Fix 2 / R-INELIG-001)', () => {
  it('term day=01 → last active month is previous month', () => {
    expect(lastActiveMonthForTermDate('2026-02-01')).toBe('2026-01');
    expect(lastActiveMonthForTermDate('2026-01-01')).toBe('2025-12');
  });
  it('term day>=02 → last active month is term month', () => {
    expect(lastActiveMonthForTermDate('2026-01-31')).toBe('2026-01');
    expect(lastActiveMonthForTermDate('2026-04-15')).toBe('2026-04');
    expect(lastActiveMonthForTermDate('2026-04-02')).toBe('2026-04');
  });
  it('9999-* sentinel → null (no real end)', () => {
    expect(lastActiveMonthForTermDate('9999-12-31')).toBeNull();
  });
  it('null/empty/garbage → null', () => {
    expect(lastActiveMonthForTermDate(null)).toBeNull();
    expect(lastActiveMonthForTermDate('')).toBeNull();
    expect(lastActiveMonthForTermDate('garbage')).toBeNull();
  });
  it('YYYY-MM only → conservative prior-month', () => {
    expect(lastActiveMonthForTermDate('2026-03')).toBe('2026-02');
  });
});
