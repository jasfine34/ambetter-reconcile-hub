import { describe, it, expect } from 'vitest';
import { isEDEQualified } from '@/lib/canonical/edeQualified';

describe('canonical isEDEQualified (Fix 6)', () => {
  it('Effectuated Ambetter → true', () => {
    expect(isEDEQualified({ source_type: 'EDE', raw_json: { policyStatus: 'Effectuated', issuer: 'Ambetter from Sunshine Health' } })).toBe(true);
  });
  it('Pending Effectuation Ambetter → true', () => {
    expect(isEDEQualified({ source_type: 'EDE', raw_json: { policyStatus: 'Pending Effectuation', issuer: 'Ambetter' } })).toBe(true);
  });
  it('Pending Termination Ambetter → true', () => {
    expect(isEDEQualified({ source_type: 'EDE', raw_json: { policyStatus: 'Pending Termination', issuer: 'Ambetter' } })).toBe(true);
  });
  it('Cancelled Ambetter → false', () => {
    expect(isEDEQualified({ source_type: 'EDE', raw_json: { policyStatus: 'Cancelled', issuer: 'Ambetter' } })).toBe(false);
  });
  it('Effectuated but non-Ambetter → false', () => {
    expect(isEDEQualified({ source_type: 'EDE', raw_json: { policyStatus: 'Effectuated', issuer: 'Oscar' } })).toBe(false);
  });
  it('Non-EDE source → false', () => {
    expect(isEDEQualified({ source_type: 'BACK_OFFICE', raw_json: { policyStatus: 'Effectuated', issuer: 'Ambetter' } })).toBe(false);
  });
  it('Falls back to normalized status when raw_json missing', () => {
    expect(isEDEQualified({ source_type: 'EDE', status: 'Effectuated', carrier: 'Ambetter' })).toBe(true);
  });
});
