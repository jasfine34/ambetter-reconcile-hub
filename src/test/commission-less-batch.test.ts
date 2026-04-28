/**
 * Regression tests for #74 — commission-less batch flow.
 *
 * Early-month onboarding pattern: user creates a batch and uploads EDE +
 * Back Office files when the carrier provides them, then adds the
 * commission statement ~3 weeks later. The reconciler MUST:
 *
 *   1. Produce reconciled_members rows from EDE + BO matching even when
 *      ZERO commission rows exist for the batch.
 *   2. NOT fabricate `estimated_missing_commission` for those members
 *      (no statement = nothing is "missing yet"; the $18 default would
 *      inflate the Unpaid dollar bucket and trigger phantom disputes).
 *   3. Label eligible-but-unpaid members as 'Pending Commission Statement'
 *      rather than 'Missing from Commission' so the dashboard's exception
 *      queues stay focused on real issues.
 *   4. Flip back to normal estimate behavior the moment ANY commission
 *      rows are present in the same batch (e.g. after the statement
 *      arrives and rebuild reruns).
 */
import { describe, it, expect } from 'vitest';
import { reconcile } from '@/lib/reconcile';

function ede(overrides: Partial<any> = {}): any {
  return {
    source_type: 'EDE',
    source_file_label: 'ede.csv',
    applicant_name: 'Alpha One',
    first_name: 'Alpha',
    last_name: 'One',
    issuer_subscriber_id: 'U100',
    exchange_subscriber_id: '0000100',
    policy_number: 'P100',
    effective_date: '2026-04-01',
    policy_term_date: '2026-12-31',
    eligible_for_commission: 'Yes',
    raw_json: { coveredMemberCount: 1 },
    ...overrides,
  };
}
function bo(overrides: Partial<any> = {}): any {
  return {
    source_type: 'BACK_OFFICE',
    source_file_label: 'bo.csv',
    applicant_name: 'Alpha One',
    first_name: 'Alpha',
    last_name: 'One',
    issuer_subscriber_id: 'U100',
    exchange_subscriber_id: '0000100',
    policy_number: 'P100',
    effective_date: '2026-04-01',
    policy_term_date: '2026-12-31',
    paid_through_date: '2026-04-30',
    eligible_for_commission: 'Yes',
    agent_npn: '21055210',
    aor_bucket: 'Coverall',
    raw_json: {},
    ...overrides,
  };
}
function comm(overrides: Partial<any> = {}): any {
  return {
    source_type: 'COMMISSION',
    source_file_label: 'comm.csv',
    applicant_name: 'Alpha One',
    issuer_subscriber_id: 'U100',
    policy_number: 'P100',
    agent_npn: '21055210',
    pay_entity: 'Coverall',
    commission_amount: 25.0,
    raw_json: {},
    ...overrides,
  };
}

describe('reconcile — commission-less batch (#74)', () => {
  it('produces reconciled members from EDE+BO when no COMMISSION rows exist', () => {
    const records = [ede(), bo()];
    const { members } = reconcile(records, '2026-04', null);
    expect(members.length).toBe(1);
    const m = members[0];
    expect(m.in_ede).toBe(true);
    expect(m.in_back_office).toBe(true);
    expect(m.in_commission).toBe(false);
  });

  it('suppresses estimated_missing_commission when batch has zero commission rows', () => {
    const records = [ede(), bo()];
    const { members } = reconcile(records, '2026-04', null);
    const m = members[0];
    // Critical assertion: no $18 default fabricated when there is no
    // commission statement to reason about.
    expect(m.estimated_missing_commission).toBeNull();
  });

  it('labels eligible-but-unpaid members as Pending Commission Statement when no commission file', () => {
    const records = [ede(), bo()];
    const { members } = reconcile(records, '2026-04', null);
    expect(members[0].issue_type).toBe('Pending Commission Statement');
  });

  it('reverts to Missing from Commission + populates estimate once any COMMISSION row is present', () => {
    // Two members: m1 has comm (so the file is "present" for the batch),
    // m2 is eligible but unpaid -> should now get a real estimate.
    const records = [
      ede({ issuer_subscriber_id: 'U100', exchange_subscriber_id: '0000100', policy_number: 'P100', applicant_name: 'Alpha One', first_name: 'Alpha', last_name: 'One' }),
      bo({ issuer_subscriber_id: 'U100', exchange_subscriber_id: '0000100', policy_number: 'P100', applicant_name: 'Alpha One', first_name: 'Alpha', last_name: 'One' }),
      comm({ issuer_subscriber_id: 'U100', policy_number: 'P100', commission_amount: 25 }),
      ede({ issuer_subscriber_id: 'U200', exchange_subscriber_id: '0000200', policy_number: 'P200', applicant_name: 'Beta Two', first_name: 'Beta', last_name: 'Two' }),
      bo({ issuer_subscriber_id: 'U200', exchange_subscriber_id: '0000200', policy_number: 'P200', applicant_name: 'Beta Two', first_name: 'Beta', last_name: 'Two' }),
    ];
    const { members } = reconcile(records, '2026-04', null);
    const m2 = members.find((x) => (x.applicant_name || '').toLowerCase().includes('beta'))!;
    expect(m2).toBeTruthy();
    expect(m2.in_commission).toBe(false);
    expect(m2.issue_type).toBe('Missing from Commission');
    // Estimate uses agent's avg ($25) since the same NPN was paid for U100.
    expect(m2.estimated_missing_commission).toBeGreaterThan(0);
  });
});
