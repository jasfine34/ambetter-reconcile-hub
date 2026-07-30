/**
 * L1 — Stale-BO supersession + BO-snapshot control. The 13 required tests.
 *
 * Named members are FIXTURE SHAPES, not branches.
 */
import { describe, it, expect } from 'vitest';
import { classifyMember, buildClassifierContext, classifyCell, type ClassifierContext } from '@/lib/classifier';
import { buildMemberTimeline } from '@/lib/memberTimeline';
import {
  buildBoSnapshotCoverage,
  memberBoPresenceForMonth,
  type BoSnapshotCoverageRow,
} from '@/lib/canonical/boSnapshotCoverage';
import type { NormalizedRecord } from '@/lib/normalize';
import type { MonthKey } from '@/lib/dateRange';
import { derivePolicyIdentityKey } from '@/lib/canonical/policyIdentityKey';

const NPN = '21055210';
const NAME = 'Jason Fine';
const BUCKET = NAME;
const CARRIER = 'ambetter';
const POLICY = 'P1000001';
const POLICY_B = 'P2000002';
const MONTHS: MonthKey[] = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'];

function rec(o: Partial<NormalizedRecord>): NormalizedRecord {
  return {
    source_type: '', source_file_label: '', carrier: CARRIER, applicant_name: '',
    first_name: '', last_name: '', dob: null, member_id: '', policy_number: '',
    exchange_subscriber_id: '', exchange_policy_id: '', issuer_subscriber_id: '',
    issuer_policy_id: '', agent_name: NAME, agent_npn: NPN, aor_bucket: BUCKET,
    pay_entity: '', status: '', effective_date: null, premium: null, net_premium: null,
    commission_amount: null, eligible_for_commission: '', policy_term_date: null,
    paid_through_date: null, broker_effective_date: null, broker_term_date: null,
    member_responsibility: null, on_off_exchange: '', auto_renewal: null,
    ede_policy_origin_type: '', ede_bucket: '', policy_modified_date: null,
    client_address_1: '', client_address_2: '', client_city: '', client_state_full: '',
    client_zip: '', paid_to_date: null, months_paid: null, writing_agent_carrier_id: '',
    member_key: 'member:fixture', raw_json: {}, ...o,
  } as NormalizedRecord;
}

const bo = (o: Partial<NormalizedRecord> = {}) => rec({
  source_type: 'BACK_OFFICE', applicant_name: 'Fixture Member', policy_number: POLICY,
  effective_date: '2025-06-01', eligible_for_commission: 'Yes',
  policy_term_date: '2026-12-31', ...o,
});

const ede = (aor: string, o: Partial<NormalizedRecord> = {}) => rec({
  source_type: 'EDE', applicant_name: 'Fixture Member', policy_number: POLICY,
  effective_date: '2025-06-01', status: 'effectuated',
  raw_json: { policyStatus: 'Effectuated', currentPolicyAOR: aor, issuer: 'Ambetter from Sunshine Health' },
  ...o,
});

const OURS = `${NAME} (${NPN})`;
const THEIRS = 'Some Other Agency (99999999)';

function snap(o: Partial<BoSnapshotCoverageRow>): BoSnapshotCoverageRow {
  return {
    snapshot_id: 's', carrier: CARRIER, agent_bucket: BUCKET, snapshot_date: '2026-01-31',
    promoted: true, recency: '2026-01-31T00:00:00Z', policy_keys: [], ...o,
  };
}
const key = (pn: string) => {
  const k = derivePolicyIdentityKey({ carrier: CARRIER, policy_number: pn, issuer_subscriber_id: '' });
  if (k.status !== 'resolved') throw new Error('fixture key unresolvable');
  return k.key;
};

function ctxWith(coverage: any, months: MonthKey[] = MONTHS, records: NormalizedRecord[] = []): ClassifierContext {
  const ctx = buildClassifierContext(records as any, months, [], { boSnapshotCoverage: coverage });
  // Ripeness: every fixture month has a commission statement cycle loaded.
  return { ...ctx, commissionStatementMonths: new Set(months) };
}

describe('L1 — BO snapshot coverage contract', () => {
  // (1) Yolanda shape — Jan paid; Feb–Jun not_expected_not_ours; zero chase.
  it('1. Yolanda shape end-to-end', () => {
    const coverage = buildBoSnapshotCoverage([
      snap({ snapshot_id: 'jan', snapshot_date: '2026-01-31', policy_keys: [key(POLICY)] }),
      snap({ snapshot_id: 'feb', snapshot_date: '2026-02-28', policy_keys: [] }),
    ]);
    const records = [
      bo(),
      ede(THEIRS),
      rec({ source_type: 'COMMISSION', applicant_name: 'Fixture Member', policy_number: POLICY,
        paid_to_date: '2026-01-31', months_paid: 1, commission_amount: 25 }),
    ];
    const out = classifyMember(records, ctxWith(coverage, MONTHS, records));
    expect(out.cells['2026-01'].state).toBe('paid');
    for (const m of ['2026-02', '2026-03', '2026-04', '2026-05', '2026-06'] as MonthKey[]) {
      expect(out.cells[m].state).toBe('not_expected_not_ours');
      expect(out.cells[m].in_back_office).toBe(false);
    }
  });

  // (2) Darrell shape — chaseable + typed fact, never labeled not-ours.
  it('2. Darrell shape keeps chase + typed fact', () => {
    const coverage = buildBoSnapshotCoverage([snap({ snapshot_id: 'feb', snapshot_date: '2026-02-28', policy_keys: [] })]);
    const records = [bo(), ede(OURS)];
    const out = classifyMember(records, ctxWith(coverage, MONTHS, records));
    const c = out.cells['2026-03'];
    expect(c.state).not.toBe('not_expected_not_ours');
    expect(c.missing_from_carrier_bo).toBe(true);
    expect(c.bo_presence).toBe('authoritatively_absent');
  });

  // (3) Month boundary — present through Mar, absent Apr+.
  it('3. earned months before absence are untouched', () => {
    const coverage = buildBoSnapshotCoverage([
      snap({ snapshot_id: 'mar', snapshot_date: '2026-03-31', policy_keys: [key(POLICY)] }),
      snap({ snapshot_id: 'apr', snapshot_date: '2026-04-30', policy_keys: [] }),
    ]);
    const records = [bo(), ede(THEIRS)];
    const out = classifyMember(records, ctxWith(coverage, MONTHS, records));
    for (const m of ['2026-01', '2026-02', '2026-03'] as MonthKey[]) {
      expect(out.cells[m].state).not.toBe('not_expected_not_ours');
    }
    expect(out.cells['2026-04'].state).toBe('not_expected_not_ours');
  });

  // (4) Legit BO-only direct-write member untouched.
  it('4. BO-only member present in the governing snapshot is unchanged', () => {
    const coverage = buildBoSnapshotCoverage([snap({ snapshot_id: 'jan', policy_keys: [key(POLICY)] })]);
    const records = [bo()];
    const withCov = classifyMember(records, ctxWith(coverage, MONTHS, records));
    const without = classifyMember(records, { ...buildClassifierContext(records as any, MONTHS, []), commissionStatementMonths: new Set(MONTHS) });
    for (const m of MONTHS) {
      expect(withCov.cells[m].state).toBe(without.cells[m].state);
      expect(withCov.cells[m].in_back_office).toBe(without.cells[m].in_back_office);
    }
  });

  // (5) Label invariant — absence alone can never emit not-ours.
  it('5. absence without out-of-scope evidence never emits not_expected_not_ours', () => {
    const coverage = buildBoSnapshotCoverage([snap({ snapshot_id: 'jan', policy_keys: [] })]);
    for (const edeRec of [null, ede(OURS)]) {
      const records = edeRec ? [bo(), edeRec] : [bo()];
      const out = classifyMember(records, ctxWith(coverage, MONTHS, records));
      for (const m of MONTHS) {
        if (out.cells[m].state === 'not_expected_not_ours') {
          throw new Error(`absence alone emitted not-ours for ${m}`);
        }
      }
    }
  });

  // (6) Identity safety — absence on A never suppresses B.
  it('6. presence of a sibling policy keeps the member present', () => {
    const coverage = buildBoSnapshotCoverage([
      snap({ snapshot_id: 'jan', policy_keys: [key(POLICY_B)] }),
    ]);
    const records = [bo(), bo({ policy_number: POLICY_B })];
    expect(memberBoPresenceForMonth(records, '2026-03', coverage)).toBe('present');
  });

  // (7) Paid / reversed byte-identical.
  it('7. paid + reversed cells are byte-identical with and without coverage', () => {
    const coverage = buildBoSnapshotCoverage([snap({ snapshot_id: 'jan', policy_keys: [] })]);
    const records = [
      bo(), ede(THEIRS),
      rec({ source_type: 'COMMISSION', applicant_name: 'Fixture Member', policy_number: POLICY,
        paid_to_date: '2026-02-28', months_paid: 1, commission_amount: 25 }),
    ];
    const a = classifyMember(records, ctxWith(coverage, MONTHS, records));
    const b = classifyMember(records, { ...buildClassifierContext(records as any, MONTHS, []), commissionStatementMonths: new Set(MONTHS) });
    const strip = (c: any) => { const { bo_presence, missing_from_carrier_bo, ...rest } = c; return rest; };
    expect(strip(a.cells['2026-02'])).toEqual(strip(b.cells['2026-02']));
    expect(a.cells['2026-02'].state).toBe('paid');
  });

  // (8) Different agent bucket establishes nothing.
  it('8. a different-agent-bucket snapshot establishes nothing', () => {
    const coverage = buildBoSnapshotCoverage([snap({ snapshot_id: 'other', agent_bucket: 'Other Agency', policy_keys: [] })]);
    expect(memberBoPresenceForMonth([bo()], '2026-03', coverage)).toBe('unknown');
  });

  // (9) Non-promoted upload establishes nothing.
  it('9. a failed/staged/non-promoted upload establishes nothing', () => {
    const coverage = buildBoSnapshotCoverage([snap({ snapshot_id: 'staged', promoted: false, policy_keys: [] })]);
    expect(memberBoPresenceForMonth([bo()], '2026-03', coverage)).toBe('unknown');
  });

  // (10) Future snapshot cannot create absence for earlier months.
  it('10. a future snapshot never proves absence for earlier months', () => {
    const coverage = buildBoSnapshotCoverage([snap({ snapshot_id: 'jun', snapshot_date: '2026-06-30', policy_keys: [] })]);
    expect(memberBoPresenceForMonth([bo()], '2026-03', coverage)).toBe('unknown');
    expect(memberBoPresenceForMonth([bo()], '2026-06', coverage)).toBe('authoritatively_absent');
  });

  // (11) Missing metadata ⇒ unknown ⇒ current behavior.
  it('11. missing snapshot metadata yields unknown and unchanged behavior', () => {
    const coverage = buildBoSnapshotCoverage([snap({ snapshot_id: 'nodate', snapshot_date: null, policy_keys: [] })]);
    const records = [bo(), ede(THEIRS)];
    expect(memberBoPresenceForMonth(records, '2026-03', coverage)).toBe('unknown');
    const a = classifyMember(records, ctxWith(coverage, MONTHS, records));
    const b = classifyMember(records, { ...buildClassifierContext(records as any, MONTHS, []), commissionStatementMonths: new Set(MONTHS) });
    for (const m of MONTHS) expect(a.cells[m].state).toBe(b.cells[m].state);
  });

  // (12) Reappearance — each month judges its own governing snapshot.
  it('12. absent-then-reappears follows the per-month governing snapshot', () => {
    const coverage = buildBoSnapshotCoverage([
      snap({ snapshot_id: 'feb', snapshot_date: '2026-02-28', policy_keys: [] }),
      snap({ snapshot_id: 'apr', snapshot_date: '2026-04-30', policy_keys: [key(POLICY)] }),
    ]);
    expect(memberBoPresenceForMonth([bo()], '2026-01', coverage)).toBe('unknown');
    expect(memberBoPresenceForMonth([bo()], '2026-02', coverage)).toBe('authoritatively_absent');
    expect(memberBoPresenceForMonth([bo()], '2026-03', coverage)).toBe('authoritatively_absent');
    expect(memberBoPresenceForMonth([bo()], '2026-04', coverage)).toBe('present');
    expect(memberBoPresenceForMonth([bo()], '2026-05', coverage)).toBe('present');
  });

  // (13) Cross-surface consistency — one BoPresence value everywhere.
  it('13. classifier, MonthCell and downstream read the identical BoPresence', () => {
    const coverage = buildBoSnapshotCoverage([snap({ snapshot_id: 'feb', snapshot_date: '2026-02-28', policy_keys: [] })]);
    const records = [bo(), ede(OURS)];
    const month: MonthKey = '2026-03';
    const cls = classifyCell(records, month, null, ctxWith(coverage, MONTHS, records));
    const rows = buildMemberTimeline(records as any, MONTHS, () => true, { boSnapshotCoverage: coverage } as any);
    const cell = rows[0].cells[month];
    const helper = memberBoPresenceForMonth(records, month, coverage);
    expect(cls.bo_presence).toBe('authoritatively_absent');
    expect(cell.bo_presence).toBe(cls.bo_presence);
    expect(helper).toBe(cls.bo_presence);
    expect(cell.in_back_office).toBe(false);
  });
});
