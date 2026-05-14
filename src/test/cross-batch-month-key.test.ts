import { describe, it, expect } from 'vitest';
import { isValidMonthKey, parseMonthKey } from '@/lib/canonical/monthKey';

describe('monthKey', () => {
  it.each(['2026-01', '2026-12', '2025-06'])('accepts %s', (k) => expect(isValidMonthKey(k)).toBe(true));
  it.each(['2026-13', '2026-00', '2026-1', 'Jan 2026', '', '2026-01-01', '26-01', null, undefined, 123])(
    'rejects %s', (k) => expect(isValidMonthKey(k as any)).toBe(false));

  it('parseMonthKey returns year/month for valid', () => {
    expect(parseMonthKey('2026-03')).toEqual({ year: 2026, month: 3 });
  });
  it('parseMonthKey returns null for invalid', () => {
    expect(parseMonthKey('2026-13')).toBeNull();
  });
});
