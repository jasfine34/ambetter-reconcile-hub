/**
 * Phase 1.8 — getEdeConsumersNeverFoundInBackOffice helper tests.
 *
 * Each scenario builds a tiny normalizedRecords fixture and asserts whether
 * the member appears in the helper's row set under the documented predicate.
 *
 * Phase 1.8 fix (2026-05-11): the helper now consumes a passed-in
 * `currentNotInBoMemberKeys: Set<string>` (= the Dashboard's already-
 * computed `filteredMissingFromBO` member_key set) instead of the full
 * `FilteredEdeResult`. The old contract over-subtracted the entire EE
 * universe, zeroing the card. These tests pin the new contract.
 */
import { describe, it, expect } from 'vitest';
import { getEdeConsumersNeverFoundInBackOffice } from '@/lib/canonical/edeConsumersNeverInBo';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const COVERED = ['2026-01'];
const SCOPE = 'Coverall' as const;
const EMPTY_NOT_IN_BO = new Set<string>();

function ede(over: Partial<any> = {}): any {
  return {
    source_type: 'EDE',
    carrier: 'Ambetter',
    effective_date: '2026-01-01',
    member_key: over.member_key || 'm1',
    applicant_name: over.applicant_name || 'Alpha Test',
    issuer_subscriber_id: over.issuer_subscriber_id || 'U1',
    exchange_subscriber_id: '',
    policy_number: 'P1',
    status: 'Effectuated',
    raw_json: {
      issuer: 'Ambetter',
      policyStatus: 'Effectuated',
      effectiveDate: '2026-01-01',
      currentPolicyAOR: 'Jason Fine (21055210)',
      exchangePolicyId: 'P1',
      issuerSubscriberId: over.issuer_subscriber_id || 'U1',
    },
    ...over,
  };
}

function bo(over: Partial<any> = {}): any {
  return {
    source_type: 'BACK_OFFICE',
    applicant_name: 'Alpha Test',
    issuer_subscriber_id: 'U1',
    exchange_subscriber_id: '',
    policy_number: 'P1',
    member_key: 'mBO1',
    raw_json: {},
    ...over,
  };
}

describe('getEdeConsumersNeverFoundInBackOffice', () => {
  it('includes a qualified Ambetter EDE row when no BO record exists anywhere', () => {
    const res = getEdeConsumersNeverFoundInBackOffice(
      [ede()], [], SCOPE, EMPTY_NOT_IN_BO, new Set(), COVERED,
    );
    expect(res.count).toBe(1);
    expect(res.rows[0].issuer_subscriber_id).toBe('U1');
  });

  it('returns rows + count consistently (card count === helper rows length contract)', () => {
    const res = getEdeConsumersNeverFoundInBackOffice(
      [ede()], [], SCOPE, EMPTY_NOT_IN_BO, new Set(), COVERED,
    );
    expect(res.count).toBe(res.rows.length);
  });

  it('EXCLUDES members with a historical-but-terminated BO record (key Phase 1.8 gate)', () => {
    const records = [ede(), bo({ raw_json: { policyTermDate: '2025-06-30' } })];
    const res = getEdeConsumersNeverFoundInBackOffice(
      records, [], SCOPE, EMPTY_NOT_IN_BO, new Set(), COVERED,
    );
    expect(res.count).toBe(0);
  });

  it('EXCLUDES members with an active BO record', () => {
    const res = getEdeConsumersNeverFoundInBackOffice(
      [ede(), bo()], [], SCOPE, EMPTY_NOT_IN_BO, new Set(), COVERED,
    );
    expect(res.count).toBe(0);
  });

  it('EXCLUDES cancelled / non-qualified EDE status', () => {
    const res = getEdeConsumersNeverFoundInBackOffice(
      [ede({ raw_json: { issuer: 'Ambetter', policyStatus: 'Cancelled', effectiveDate: '2026-01-01', currentPolicyAOR: 'Jason Fine (21055210)' } })],
      [], SCOPE, EMPTY_NOT_IN_BO, new Set(), COVERED,
    );
    expect(res.count).toBe(0);
  });

  it('EXCLUDES future-effective rows past the latest covered month', () => {
    const res = getEdeConsumersNeverFoundInBackOffice(
      [ede({ effective_date: '2026-05-01', raw_json: { issuer: 'Ambetter', policyStatus: 'Effectuated', effectiveDate: '2026-05-01', currentPolicyAOR: 'Jason Fine (21055210)' } })],
      [], SCOPE, EMPTY_NOT_IN_BO, new Set(), COVERED,
    );
    expect(res.count).toBe(0);
  });

  it('EXCLUDES members present in the current Not-in-BO row set (top card owns them)', () => {
    const res = getEdeConsumersNeverFoundInBackOffice(
      [ede()], [], SCOPE, new Set(['m1']), new Set(), COVERED,
    );
    expect(res.count).toBe(0);
  });

  it('Phase 1.8 FIX: INCLUDES a member in the EE universe but NOT in the current Not-in-BO row set', () => {
    // Pre-fix bug: helper subtracted full FilteredEdeResult.uniqueMembers,
    // so any EE-universe member was excluded — even though only the current
    // Not-in-BO row set is supposed to be subtracted. Post-fix: the caller
    // controls the subtraction set, so a member present in EE universe but
    // absent from filteredMissingFromBO must still appear here.
    const currentNotInBo = new Set<string>(['someOtherMember']);
    const res = getEdeConsumersNeverFoundInBackOffice(
      [ede()], [], SCOPE, currentNotInBo, new Set(), COVERED,
    );
    expect(res.count).toBe(1);
    expect(res.rows[0].member_key).toBe('m1');
  });

  it('EXCLUDES weak-match confirmed members', () => {
    const res = getEdeConsumersNeverFoundInBackOffice(
      [ede()], [], SCOPE, EMPTY_NOT_IN_BO, new Set(['m1']), COVERED,
    );
    expect(res.count).toBe(0);
  });

  it('EXCLUDES non-Ambetter EDE rows', () => {
    const res = getEdeConsumersNeverFoundInBackOffice(
      [ede({ carrier: 'OtherCarrier', raw_json: { issuer: 'OtherCarrier', policyStatus: 'Effectuated', effectiveDate: '2026-01-01', currentPolicyAOR: 'Jason Fine (21055210)' } })],
      [], SCOPE, EMPTY_NOT_IN_BO, new Set(), COVERED,
    );
    expect(res.count).toBe(0);
  });

  it('EXCLUDES AOR not in selected scope', () => {
    const res = getEdeConsumersNeverFoundInBackOffice(
      [ede({ raw_json: { issuer: 'Ambetter', policyStatus: 'Effectuated', effectiveDate: '2026-01-01', currentPolicyAOR: 'Random Other Agent (99999999)' } })],
      [], SCOPE, EMPTY_NOT_IN_BO, new Set(), COVERED,
    );
    expect(res.count).toBe(0);
  });

  it('does NOT contain a parallel Not-in-BO predicate (no recompute inside the helper)', () => {
    // Static guard: the helper must consume the caller-provided
    // `currentNotInBoMemberKeys` set and must not re-derive a Not-in-BO
    // predicate (no getNotInBackOfficeRows call, no missingFromBO traversal,
    // no inBOCount logic, no FilteredEdeResult dependency).
    const src = readFileSync(
      join(process.cwd(), 'src/lib/canonical/edeConsumersNeverInBo.ts'),
      'utf8',
    );
    // Strip block + line comments so the doc-comment doesn't trip the guard.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/getNotInBackOfficeRows\s*\(/);
    expect(code).not.toMatch(/\.missingFromBO\b/);
    expect(code).not.toMatch(/FilteredEdeResult/);
    expect(code).toMatch(/currentNotInBoMemberKeys/);
  });
});
