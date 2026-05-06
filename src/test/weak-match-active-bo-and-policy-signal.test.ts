/**
 * #129 — Weak-match queue fixes:
 *  (1) Apply isActiveBackOfficeRecord(rec, periodStart) when indexing BO
 *      candidates so terminated/inactive BO rows do NOT surface as weak
 *      matches (mirrors strict reconcile's active-BO semantics).
 *  (2) Suppress the policy_number signal for Ambetter (where BO
 *      `policy_number` is structurally redundant with `issuer_subscriber_id`
 *      and would otherwise score a guaranteed false mismatch). Keep the
 *      signal for non-Ambetter carriers.
 */
import { describe, it, expect } from 'vitest';
import { findWeakMatches } from '@/lib/weakMatch';
import type { FilteredEdeRow } from '@/lib/expectedEde';

function ede(over: Partial<FilteredEdeRow> = {}): FilteredEdeRow {
  return {
    member_key: 'issub:u70162404',
    applicant_name: 'Kevin Compton',
    policy_number: '',
    exchange_subscriber_id: '3938172',
    issuer_subscriber_id: 'u70162404',
    current_policy_aor: 'Erica',
    effective_date: '2026-01-01',
    policy_status: 'effectuated',
    covered_member_count: 1,
    effective_month: '2026-01',
    active_months: ['2026-03'],
    in_back_office: false,
    ...over,
  };
}

function bo(over: Partial<any> = {}): any {
  return {
    id: over.id ?? `bo-${Math.random().toString(36).slice(2, 8)}`,
    source_type: 'BACK_OFFICE',
    carrier: 'Ambetter',
    applicant_name: 'Kevin Compton',
    member_key: 'issub:u70162404',
    policy_number: 'u70162404',           // Ambetter: same as issuer_subscriber_id
    exchange_subscriber_id: '3938172',
    issuer_subscriber_id: 'u70162404',
    eligible_for_commission: 'Yes',
    policy_term_date: null,
    paid_through_date: null,
    broker_term_date: null,
    raw_json: {},
    ...over,
  };
}

describe('#129 weak-match active-BO filter (Fix 1)', () => {
  it('excludes BO candidates terminated before periodStart', () => {
    const ee = [ede()]; // EE member, not in BO
    const records = [
      bo({
        id: 'bo-terminated',
        policy_term_date: '2026-02-28', // terminated before March
      }),
    ];
    const out = findWeakMatches(ee, records, { periodStart: '2026-03-01' });
    expect(out).toHaveLength(0);
  });

  it('still surfaces active BO candidates within the period', () => {
    const ee = [ede()];
    const records = [
      bo({
        id: 'bo-active',
        policy_term_date: '2026-12-31',
      }),
    ];
    const out = findWeakMatches(ee, records, { periodStart: '2026-03-01' });
    expect(out).toHaveLength(1);
    expect(out[0].boCandidate.record_id).toBe('bo-active');
  });

  it('legacy behavior: omitting periodStart includes terminated BO rows', () => {
    const ee = [ede()];
    const records = [bo({ policy_term_date: '2026-02-28' })];
    const out = findWeakMatches(ee, records);
    expect(out).toHaveLength(1);
  });
});

describe('#129 Ambetter policy_number signal suppression (Fix 2)', () => {
  it('does not include policy_number in matched/differed/unknown for Ambetter', () => {
    const ee = [ede({ carrier: 'Ambetter' } as any)];
    const records = [bo({ policy_term_date: '2026-12-31' })];
    const out = findWeakMatches(ee, records, { periodStart: '2026-03-01' });
    expect(out).toHaveLength(1);
    const sigs = out[0].signals;
    const all = [...sigs.matched, ...sigs.differed, ...sigs.unknown];
    expect(all).not.toContain('policy_number');
  });

  it('does not score the policy_number signal for Ambetter (no false-mismatch demotion)', () => {
    // 3 fuzzy matches available (name, ESID, ISID); without suppression the
    // policy_number compare would falsely report a differed signal.
    const ee = [ede({ carrier: 'Ambetter' } as any)];
    const records = [bo({ policy_term_date: '2026-12-31' })];
    const out = findWeakMatches(ee, records, { periodStart: '2026-03-01' });
    expect(out[0].signals.matched).toEqual(
      expect.arrayContaining(['applicant_name', 'exchange_subscriber_id', 'issuer_subscriber_id']),
    );
    expect(out[0].signals.differed).not.toContain('policy_number');
  });

  it('keeps policy_number signal for non-Ambetter carriers', () => {
    const ee = [ede({ carrier: 'Oscar', policy_number: '208472547' } as any)];
    const records = [
      bo({
        carrier: 'Oscar',
        policy_number: '208472547', // matches
        policy_term_date: '2026-12-31',
      }),
    ];
    const out = findWeakMatches(ee, records, { periodStart: '2026-03-01' });
    expect(out).toHaveLength(1);
    expect(out[0].signals.matched).toContain('policy_number');
  });

  it('preserves true weak match (name + ESID match, ISID differs)', () => {
    // Different person scenario: strict member_key would not unify, but
    // name + ESID still match while ISID disagrees → this is a real weak
    // match the operator must review.
    const ee = [
      ede({
        applicant_name: 'Jane Doe',
        issuer_subscriber_id: 'u11111111',
        exchange_subscriber_id: '5555555',
        member_key: 'issub:u11111111',
      }),
    ];
    const records = [
      bo({
        applicant_name: 'Jane Doe',
        issuer_subscriber_id: 'u22222222',     // differs
        exchange_subscriber_id: '5555555',     // matches
        policy_number: 'u22222222',
        policy_term_date: '2026-12-31',
      }),
    ];
    const out = findWeakMatches(ee, records, { periodStart: '2026-03-01' });
    expect(out).toHaveLength(1);
    expect(out[0].signals.matched).toEqual(
      expect.arrayContaining(['applicant_name', 'exchange_subscriber_id']),
    );
    expect(out[0].signals.differed).toContain('issuer_subscriber_id');
  });
});
