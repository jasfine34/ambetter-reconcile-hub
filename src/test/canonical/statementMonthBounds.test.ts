/**
 * Ineligible-BO Phase 1 — getStatementMonthBounds calendar tests.
 */
import { describe, it, expect } from 'vitest';
import { getStatementMonthBounds } from '@/lib/canonical/statementMonthBounds';

describe('getStatementMonthBounds', () => {
  it('January (31 days)', () => {
    expect(getStatementMonthBounds('2026-01-01')).toEqual({ start: '2026-01-01', end: '2026-01-31' });
  });
  it('February non-leap (28 days)', () => {
    expect(getStatementMonthBounds('2026-02-01')).toEqual({ start: '2026-02-01', end: '2026-02-28' });
  });
  it('February leap year (29 days)', () => {
    expect(getStatementMonthBounds('2024-02-01')).toEqual({ start: '2024-02-01', end: '2024-02-29' });
  });
  it('April (30 days)', () => {
    expect(getStatementMonthBounds('2026-04-01')).toEqual({ start: '2026-04-01', end: '2026-04-30' });
  });
  it('December (31 days, year-transition)', () => {
    expect(getStatementMonthBounds('2026-12-01')).toEqual({ start: '2026-12-01', end: '2026-12-31' });
  });
  it("accepts 'YYYY-MM' input", () => {
    expect(getStatementMonthBounds('2026-04')).toEqual({ start: '2026-04-01', end: '2026-04-30' });
  });
  it('ignores day portion of input', () => {
    expect(getStatementMonthBounds('2026-04-15')).toEqual({ start: '2026-04-01', end: '2026-04-30' });
  });
});
