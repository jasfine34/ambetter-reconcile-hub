/**
 * Bundle 13a — carrierCanonical regression + new-carrier coverage.
 *
 * Locked behaviors:
 *  - Pre-existing aliases still resolve (Ambetter, Anthem, BCBS, etc.).
 *  - Specific entries beat generic substrings (anthem_bcbs > anthem|bcbs).
 *  - New 13a carriers resolve to their canonical keys.
 *  - Wellpoint resolves cleanly.
 *  - Vague non-carrier strings ("health", "care", "first") yield ''.
 */
import { describe, it, expect } from 'vitest';
import { canonicalCarrier } from '@/lib/carrierCanonical';

describe('carrierCanonical — pre-existing aliases (regression)', () => {
  it.each([
    ['Ambetter Health', 'ambetter'],
    ['Ambetter from Sunshine Health', 'ambetter'],
    ['MOLINA HEALTHCARE', 'molina'],
    ['Cigna', 'cigna'],
    ['UnitedHealthcare', 'united'],
    ['UHC', 'united'],
    ['HCSC BCBS IL', 'bcbs'],
    ['Aetna', 'aetna'],
    ['Humana', 'humana'],
  ])('"%s" → %s', (raw, expected) => {
    expect(canonicalCarrier(raw)).toBe(expected);
  });
});

describe('carrierCanonical — specific-before-generic ordering', () => {
  it('"Anthem BCBS" canonicalizes to anthem_bcbs (not anthem, not bcbs)', () => {
    expect(canonicalCarrier('Anthem BCBS')).toBe('anthem_bcbs');
  });
  it('"Blue Shield CA" canonicalizes to bs_ca (not generic bcbs)', () => {
    expect(canonicalCarrier('Blue Shield CA')).toBe('bs_ca');
  });
  it('plain "Anthem" still resolves to anthem', () => {
    expect(canonicalCarrier('Anthem')).toBe('anthem');
  });
});

describe('carrierCanonical — new 13a carriers', () => {
  it.each([
    ['Alliant', 'alliant'],
    ['AmeriHealth Caritas LA', 'amerihealth_caritas'],
    ['Antidote', 'antidote'],
    ['AvMed', 'avmed'],
    ['Baylor Scott & White', 'baylor_scott_white'],
    ['CareSource', 'caresource'],
    ['Christus', 'christus'],
    ['Health First', 'health_first'],
    ['Highmark', 'highmark'],
    ['Imperial', 'imperial'],
    ['Wellpoint', 'wellpoint'],
  ])('"%s" → %s', (raw, expected) => {
    expect(canonicalCarrier(raw)).toBe(expected);
  });
});

describe('carrierCanonical — vague tokens never match', () => {
  it.each(['health', 'care', 'first', 'med', 'plan', '', '   '])(
    '"%s" returns empty string',
    raw => {
      expect(canonicalCarrier(raw)).toBe('');
    },
  );
});
