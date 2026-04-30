import { describe, it, expect } from 'vitest';
import { extractErrorMessage, isTransientRebuildError } from '@/lib/rebuild';

describe('extractErrorMessage (PostgrestError unwrapping)', () => {
  it('returns the .message of a PostgrestError-shaped object (no [object Object])', () => {
    const pgErr = {
      message: 'canceling statement due to statement timeout',
      details: null,
      hint: null,
      code: '57014',
    };
    const msg = extractErrorMessage(pgErr);
    expect(msg).not.toContain('[object Object]');
    expect(msg).toContain('canceling statement due to statement timeout');
    expect(msg).toContain('57014');
  });

  it('handles plain Error', () => {
    expect(extractErrorMessage(new Error('boom'))).toBe('boom');
  });

  it('handles strings', () => {
    expect(extractErrorMessage('plain string failure')).toBe('plain string failure');
  });

  it('falls back to JSON.stringify for arbitrary objects', () => {
    const out = extractErrorMessage({ foo: 'bar', n: 1 });
    expect(out).toContain('foo');
    expect(out).toContain('bar');
  });

  it('returns "unknown error" for null/undefined', () => {
    expect(extractErrorMessage(null)).toBe('unknown error');
    expect(extractErrorMessage(undefined)).toBe('unknown error');
  });

  it('preserves the Postgres timeout signal so isTransientRebuildError still trips', () => {
    const pgErr = { message: 'canceling statement due to statement timeout', code: '57014' };
    expect(isTransientRebuildError(pgErr)).toBe(true);
    // And the surfaced text is still real:
    expect(extractErrorMessage(pgErr)).toMatch(/timeout/i);
  });
});
