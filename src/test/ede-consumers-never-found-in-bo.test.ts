/**
 * Phase 1.8 — getEdeConsumersNeverFoundInBackOffice helper tests.
 *
 * Each scenario builds a tiny normalizedRecords fixture and asserts whether
 * the member appears in the helper's row set under the documented predicate.
 */
import { describe, it, expect } from 'vitest';
import { getEdeConsumersNeverFoundInBackOffice } from '@/lib/canonical/edeConsumersNeverInBo';
import type { FilteredEdeResult } from '@/lib/expectedEde';

const COVERED = ['2026-01'];
const SCOPE = 'Coverall' as const;

function emptyFilteredEde(): FilteredEdeResult {
  return { uniqueMembers: [], uniqueKeys: 0, byMonth: {}, inBOCount: 0, notInBOCount: 0, missingFromBO: [] };
}

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
      [ede()], [], SCOPE, emptyFilteredEde(), new Set(), COVERED,
    );
    expect(res.count).toBe(1);
    expect(res.rows[0].issuer_subscriber_id).toBe('U1');
  });

  it('returns rows + count consistently', () => {
    const res = getEdeConsumersNeverFoundInBackOffice(
      [ede()], [], SCOPE, emptyFilteredEde(), new Set(), COVERED,
    );
    expect(res.count).toBe(res.rows.length);
  });

  it('EXCLUDES members with a historical-but-terminated BO record (key Phase 1.8 gate)', () => {
    // BO record present in normalizedRecords but would fail isActiveBackOfficeRecord.
    // The old issue_type predicate would have INCLUDED this member; the
    // helper MUST exclude.
    const records = [
      ede(),
      bo({ raw_json: { policyTermDate: '2025-06-30' } }),
    ];
    const res = getEdeConsumersNeverFoundInBackOffice(
      records, [], SCOPE, emptyFilteredEde(), new Set(), COVERED,
    );
    expect(res.count).toBe(0);
  });

  it('EXCLUDES members with an active BO record', () => {
    const res = getEdeConsumersNeverFoundInBackOffice(
      [ede(), bo()], [], SCOPE, emptyFilteredEde(), new Set(), COVERED,
    );
    expect(res.count).toBe(0);
  });

  it('EXCLUDES cancelled / non-qualified EDE status', () => {
    const res = getEdeConsumersNeverFoundInBackOffice(
      [ede({ raw_json: { issuer: 'Ambetter', policyStatus: 'Cancelled', effectiveDate: '2026-01-01', currentPolicyAOR: 'Jason Fine (21055210)' } })],
      [], SCOPE, emptyFilteredEde(), new Set(), COVERED,
    );
    expect(res.count).toBe(0);
  });

  it('EXCLUDES future-effective rows past the latest covered month', () => {
    const res = getEdeConsumersNeverFoundInBackOffice(
      [ede({ effective_date: '2026-05-01', raw_json: { issuer: 'Ambetter', policyStatus: 'Effectuated', effectiveDate: '2026-05-01', currentPolicyAOR: 'Jason Fine (21055210)' } })],
      [], SCOPE, emptyFilteredEde(), new Set(), COVERED,
    );
    expect(res.count).toBe(0);
  });

  it('EXCLUDES current EE Not-in-BO members (top NotInBO card owns them)', () => {
    const filteredEde: FilteredEdeResult = {
      ...emptyFilteredEde(),
      uniqueMembers: [{ member_key: 'm1', applicant_name: 'A', policy_number: 'P1', exchange_subscriber_id: '', issuer_subscriber_id: 'U1', current_policy_aor: '', effective_date: '2026-01-01', policy_status: 'Effectuated', covered_member_count: 1, effective_month: '2026-01', active_months: ['2026-01'], in_back_office: false }],
      uniqueKeys: 1,
    };
    const res = getEdeConsumersNeverFoundInBackOffice(
      [ede()], [], SCOPE, filteredEde, new Set(), COVERED,
    );
    expect(res.count).toBe(0);
  });

  it('EXCLUDES weak-match confirmed members', () => {
    const res = getEdeConsumersNeverFoundInBackOffice(
      [ede()], [], SCOPE, emptyFilteredEde(), new Set(['m1']), COVERED,
    );
    expect(res.count).toBe(0);
  });

  it('EXCLUDES non-Ambetter EDE rows', () => {
    const res = getEdeConsumersNeverFoundInBackOffice(
      [ede({ carrier: 'OtherCarrier', raw_json: { issuer: 'OtherCarrier', policyStatus: 'Effectuated', effectiveDate: '2026-01-01', currentPolicyAOR: 'Jason Fine (21055210)' } })],
      [], SCOPE, emptyFilteredEde(), new Set(), COVERED,
    );
    expect(res.count).toBe(0);
  });

  it('EXCLUDES AOR not in selected scope', () => {
    const res = getEdeConsumersNeverFoundInBackOffice(
      [ede({ raw_json: { issuer: 'Ambetter', policyStatus: 'Effectuated', effectiveDate: '2026-01-01', currentPolicyAOR: 'Random Other Agent (99999999)' } })],
      [], SCOPE, emptyFilteredEde(), new Set(), COVERED,
    );
    expect(res.count).toBe(0);
  });
});
