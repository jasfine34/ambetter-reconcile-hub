import { describe, it, expect } from 'vitest';
import { normalizeAmbetterBackOfficeRow } from '@/lib/carriers/ambetter/backOffice';

function row(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'Broker Name': 'A',
    'Broker NPN': '12345',
    'Policy Number': 'P1',
    'Insured First Name': 'Jane',
    'Insured Last Name': 'Doe',
    'Policy Effective Date': '2026-01-01',
    'Broker Effective Date': '2026-01-01',
    'Broker Term Date': '12/31/9999',
    'Monthly Premium Amount': '100',
    ...extra,
  };
}

describe('normalizeAmbetterBackOfficeRow client_state_full', () => {
  it("State: 'FL' → 'FL'", () => {
    const r = normalizeAmbetterBackOfficeRow(row({ State: 'FL' }), 'f', '');
    expect(r.client_state_full).toBe('FL');
  });
  it("State: '' and Client State: 'TX' → 'TX'", () => {
    const r = normalizeAmbetterBackOfficeRow(row({ State: '', 'Client State': 'TX' }), 'f', '');
    expect(r.client_state_full).toBe('TX');
  });
  it('no state fields → ""', () => {
    const r = normalizeAmbetterBackOfficeRow(row(), 'f', '');
    expect(r.client_state_full).toBe('');
  });
});
