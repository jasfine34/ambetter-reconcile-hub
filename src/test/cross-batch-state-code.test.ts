import { describe, it, expect } from 'vitest';
import { normalizeUsStateCode } from '@/lib/canonical/stateCode';

describe('normalizeUsStateCode', () => {
  it('two-letter codes pass through (uppercased)', () => {
    expect(normalizeUsStateCode('FL')).toBe('FL');
    expect(normalizeUsStateCode('fl')).toBe('FL');
  });
  it('full names map to codes', () => {
    expect(normalizeUsStateCode('Florida')).toBe('FL');
    expect(normalizeUsStateCode('florida')).toBe('FL');
    expect(normalizeUsStateCode('  Florida  ')).toBe('FL');
    expect(normalizeUsStateCode('North Carolina')).toBe('NC');
    expect(normalizeUsStateCode('District of Columbia')).toBe('DC');
  });
  it('all 50 states valid', () => {
    const states = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'];
    expect(states.length).toBe(50);
    for (const s of states) expect(normalizeUsStateCode(s)).toBe(s);
  });
  it('DC valid', () => expect(normalizeUsStateCode('DC')).toBe('DC'));
  it('territories valid', () => {
    expect(normalizeUsStateCode('PR')).toBe('PR');
    expect(normalizeUsStateCode('GU')).toBe('GU');
    expect(normalizeUsStateCode('VI')).toBe('VI');
    expect(normalizeUsStateCode('AS')).toBe('AS');
    expect(normalizeUsStateCode('MP')).toBe('MP');
  });
  it('null/blank/unknown → null', () => {
    expect(normalizeUsStateCode(null)).toBeNull();
    expect(normalizeUsStateCode('')).toBeNull();
    expect(normalizeUsStateCode('   ')).toBeNull();
    expect(normalizeUsStateCode('XX')).toBeNull();
    expect(normalizeUsStateCode('Westeros')).toBeNull();
  });
  it('Puerto Rico full name', () => {
    expect(normalizeUsStateCode('Puerto Rico')).toBe('PR');
  });
  it('case insensitivity for full name', () => {
    expect(normalizeUsStateCode('NEW YORK')).toBe('NY');
  });
});
