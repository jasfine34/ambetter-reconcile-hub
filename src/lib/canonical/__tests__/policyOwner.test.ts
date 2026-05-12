/**
 * Bundle 7 — classifyPolicyOwnerFromCurrentAor edge-case lock.
 *
 * Ownership ALWAYS comes from EDE current_policy_aor. No fallback to
 * writing-agent NPN, commission agent_npn, aor_bucket, or any other field.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { classifyPolicyOwnerFromCurrentAor } from '@/lib/canonical/policyOwner';

describe('classifyPolicyOwnerFromCurrentAor — NPN-driven buckets', () => {
  it("returns 'JF' for Jason Fine's NPN 21055210", () => {
    expect(classifyPolicyOwnerFromCurrentAor('Jason Fine (21055210)')).toBe('JF');
    // NPN match wins even with a different name in the string.
    expect(classifyPolicyOwnerFromCurrentAor('Some Other Name (21055210)')).toBe('JF');
  });
  it("returns 'EF' for Erica Fine's NPN 21277051", () => {
    expect(classifyPolicyOwnerFromCurrentAor('Erica Fine (21277051)')).toBe('EF');
    expect(classifyPolicyOwnerFromCurrentAor('Erica L Fine (21277051)')).toBe('EF');
  });
  it("returns 'BS' for Becky Shuta's NPN 16531877", () => {
    expect(classifyPolicyOwnerFromCurrentAor('Becky Shuta (16531877)')).toBe('BS');
  });
});

describe('classifyPolicyOwnerFromCurrentAor — Other / null / blank', () => {
  it("returns 'Other' for null current_policy_aor", () => {
    expect(classifyPolicyOwnerFromCurrentAor(null)).toBe('Other');
  });
  it("returns 'Other' for undefined current_policy_aor", () => {
    expect(classifyPolicyOwnerFromCurrentAor(undefined)).toBe('Other');
  });
  it("returns 'Other' for blank string", () => {
    expect(classifyPolicyOwnerFromCurrentAor('')).toBe('Other');
    expect(classifyPolicyOwnerFromCurrentAor('   ')).toBe('Other');
  });
  it("returns 'Other' for unknown / downstream NPNs", () => {
    expect(classifyPolicyOwnerFromCurrentAor('Allen Ford (21077804)')).toBe('Other');
    expect(classifyPolicyOwnerFromCurrentAor('Some Downline (99999999)')).toBe('Other');
    expect(classifyPolicyOwnerFromCurrentAor('Random Person')).toBe('Other');
  });
});

describe('classifyPolicyOwnerFromCurrentAor — name-prefix fallback (no NPN embedded)', () => {
  it('matches lowercased name prefix when no NPN is present', () => {
    expect(classifyPolicyOwnerFromCurrentAor('jason fine')).toBe('JF');
    expect(classifyPolicyOwnerFromCurrentAor('Erica Fine')).toBe('EF');
    expect(classifyPolicyOwnerFromCurrentAor('Becky Shuta')).toBe('BS');
  });
});

describe('classifyPolicyOwnerFromCurrentAor — wiring guards', () => {
  const src = readFileSync(resolve(__dirname, '../policyOwner.ts'), 'utf8');
  it('uses the canonical extractNpnFromAorString parser (no inline regex copy)', () => {
    expect(src).toMatch(/extractNpnFromAorString/);
  });
  it('input alone determines output — no fallback chains over other fields', () => {
    // Writing-agent NPN / commission evidence MUST NOT influence ownership.
    expect(classifyPolicyOwnerFromCurrentAor('Erica Fine (21277051)')).toBe('EF');
    // Pure function: identical input → identical output.
    expect(classifyPolicyOwnerFromCurrentAor('Jason Fine (21055210)')).toBe(
      classifyPolicyOwnerFromCurrentAor('Jason Fine (21055210)'),
    );
  });
});
