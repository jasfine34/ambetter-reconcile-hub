import { describe, it, expect } from 'vitest';
import { normalizeEDERow } from '@/lib/normalize';

function row(extra: Record<string, string> = {}): Record<string, string> {
  return {
    issuer: 'Ambetter',
    applicantFirstName: 'Jane',
    applicantLastName: 'Doe',
    ...extra,
  };
}

describe('normalizeEDERow client_state_full', () => {
  it("clientState: 'FL' → 'FL'", () => {
    const r = normalizeEDERow(row({ clientState: 'FL' }), 'f')!;
    expect(r.client_state_full).toBe('FL');
  });
  it("clientState: '' AND state: 'FL' → 'FL' (Erica Flowers live case)", () => {
    const r = normalizeEDERow(row({ clientState: '', state: 'FL' }), 'f')!;
    expect(r.client_state_full).toBe('FL');
  });
  it("clientState missing AND state: 'TX' → 'TX'", () => {
    const r = normalizeEDERow(row({ state: 'TX' }), 'f')!;
    expect(r.client_state_full).toBe('TX');
  });
  it('no state fields → ""', () => {
    const r = normalizeEDERow(row(), 'f')!;
    expect(r.client_state_full).toBe('');
  });
});
