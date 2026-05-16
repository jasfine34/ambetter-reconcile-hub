import { describe, it, expect } from 'vitest';
import { firstNonblankString } from './firstNonblankString';

describe('firstNonblankString', () => {
  it('empty list → null', () => {
    expect(firstNonblankString()).toBeNull();
  });
  it('single nonblank value → trimmed value', () => {
    expect(firstNonblankString('FL')).toBe('FL');
  });
  it('single blank string → null', () => {
    expect(firstNonblankString('   ')).toBeNull();
  });
  it('single non-string value → null', () => {
    expect(firstNonblankString(42 as unknown)).toBeNull();
  });
  it("('', '  ', 'FL') → 'FL'", () => {
    expect(firstNonblankString('', '  ', 'FL')).toBe('FL');
  });
  it("(null, undefined, 'TX') → 'TX'", () => {
    expect(firstNonblankString(null, undefined, 'TX')).toBe('TX');
  });
  it("(0, '', 'NY') → 'NY' (skips non-strings)", () => {
    expect(firstNonblankString(0, '', 'NY')).toBe('NY');
  });
  it("('  FL  ', 'TX') → 'FL' trimmed", () => {
    expect(firstNonblankString('  FL  ', 'TX')).toBe('FL');
  });
  it("('first', 'second') → 'first'", () => {
    expect(firstNonblankString('first', 'second')).toBe('first');
  });
});
