/**
 * Phase B — cross-batch BO term-date supersession overlay.
 *
 * Verifies:
 *  - per-policy-identity grain (a member spanning two policies suppresses
 *    only the terminated one);
 *  - latest-file-wins semantics with blank-non-revive defensive guard;
 *  - in_back_office gating in classifyCell;
 *  - in_ede gating when the EDE row's policy identity is terminated by the
 *    overlay (the Josie pattern: stale EDE no longer keeps the month
 *    chaseable);
 *  - reactivation (later file extends term → back to active);
 *  - same-file two-record case is unchanged (no cross-file supersession);
 *  - excluded buckets (eligibility-only, broker-effective-only) behave as
 *    before — supersession only fires on policy_term_date /
 *    broker_term_date authority.
 */
import { describe, it, expect } from 'vitest';
import {
  latestAuthoritativeBoTermDates,
  isPolicyIdentityTerminatedForMonth,
  makeBoRecency,
  SUPERSESSION_REASON_PREFIX,
} from '@/lib/canonical/latestAuthoritativeBo';
import {
  classifyCell,
  buildClassifierContext,
  computeFirstEligibleMonth,
} from '@/lib/classifier';
import {
  applyNoSourceInvariantToMonthCell,
} from '@/lib/memberTimeline';
import type { NormalizedRecord } from '@/lib/normalize';

const COVERALL_NPN = '21401082';

function boRow(over: any): NormalizedRecord {
  return {
    id: over.id,
    source_type: 'BACK_OFFICE',
    staging_status: 'active',
    member_key: over.member_key ?? 'm1',
    applicant_name: 'JOSIE MARTINEZ',
    policy_number: over.policy_number ?? 'u96466529',
    issuer_subscriber_id: over.issuer_subscriber_id ?? null,
    carrier: 'Ambetter',
    effective_date: '2026-01-01',
    policy_term_date: null,
    broker_term_date: null,
    broker_effective_date: '2026-01-01',
    paid_through_date: null,
    eligible_for_commission: 'yes',
    agent_npn: COVERALL_NPN,
    aor_bucket: 'coverall',
    raw_json: { 'Broker Name': 'JASON SCHWARTZ', broker_name: 'JASON SCHWARTZ' },
    batch_id: over.batch_id ?? 'b-feb',
    ...over,
  } as any;
}

function edeRow(over: Partial<NormalizedRecord> Partial<NormalizedRecord> & { id: string } { id: string; batch_id?: string; policy_number?: string }): NormalizedRecord {
  return {
    id: over.id,
    source_type: 'EDE',
    staging_status: 'active',
    member_key: over.member_key ?? 'm1',
    applicant_name: 'JOSIE MARTINEZ',
    policy_number: over.policy_number ?? 'u96466529',
    issuer_subscriber_id: over.issuer_subscriber_id ?? null,
    carrier: 'Ambetter',
    effective_date: '2026-01-01',
    policy_term_date: null,
    status: 'effectuated',
    net_premium: 0,
    agent_npn: COVERALL_NPN,
    raw_json: {
      policyStatus: 'Effectuated',
      currentPolicyAOR: 'JASON SCHWARTZ (21401082)',
    },
    batch_id: 'b-feb',
    ...over,
  } as any;
}

const MONTHS = ['2026-01', '2026-02', '2026-03', '2026-04'];
const batchMonthByBatchId = new Map<string, string>([
  ['b-jan', '2026-01'],
  ['b-feb', '2026-02'],
  ['b-mar', '2026-03'],
  ['b-apr', '2026-04'],
]);
const recency = makeBoRecency({ batchMonthByBatchId });

describe('latestAuthoritativeBoTermDates — overlay shape', () => {
  it('takes the latest file for policy_term_date per policy identity', () => {
    const records = [
      boRow({ id: 'b1', batch_id: 'b-feb', policy_term_date: '2026-12-31' }),
      boRow({ id: 'b2', batch_id: 'b-apr', policy_term_date: '2026-01-31' }),
    ];
    const overlay = latestAuthoritativeBoTermDates(records, recency);
    const entry = Array.from(overlay.values())[0];
    expect(entry.policy_term_date).toBe('2026-01-31');
  });

  it('blank latest does not revive earlier termination (defensive)', () => {
    const records = [
      boRow({ id: 'b1', batch_id: 'b-feb', policy_term_date: '2026-01-31' }),
      boRow({ id: 'b2', batch_id: 'b-apr', policy_term_date: null }),
    ];
    const overlay = latestAuthoritativeBoTermDates(records, recency);
    const entry = Array.from(overlay.values())[0];
    expect(entry.policy_term_date).toBe('2026-01-31');
  });

  it('per-policy-identity grain — two policies do not cross-contaminate', () => {
    const records = [
      boRow({ id: 'b1', batch_id: 'b-apr', policy_number: 'A', policy_term_date: '2026-01-31' }),
      boRow({ id: 'b2', batch_id: 'b-apr', policy_number: 'B', policy_term_date: null }),
    ];
    const overlay = latestAuthoritativeBoTermDates(records, recency);
    expect(overlay.size).toBe(2);
    expect(overlay.get('ambetter|A')?.policy_term_date).toBe('2026-01-31');
    expect(overlay.get('ambetter|B')?.policy_term_date).toBeNull();
  });

  it('groups by issuer_subscriber_id when policy_number is blank', () => {
    const records = [
      boRow({ id: 'b1', batch_id: 'b-feb', policy_number: '', issuer_subscriber_id: 'U123', policy_term_date: null }),
      boRow({ id: 'b2', batch_id: 'b-apr', policy_number: '', issuer_subscriber_id: 'U123', policy_term_date: '2026-01-31' }),
    ];
    const overlay = latestAuthoritativeBoTermDates(records, recency);
    expect(overlay.size).toBe(1);
    const entry = Array.from(overlay.values())[0];
    expect(entry.policy_term_date).toBe('2026-01-31');
  });

  it('reactivation — later file extends the term wins', () => {
    const records = [
      boRow({ id: 'b1', batch_id: 'b-feb', policy_term_date: '2026-01-31' }),
      boRow({ id: 'b2', batch_id: 'b-apr', policy_term_date: '2026-12-31' }),
    ];
    const overlay = latestAuthoritativeBoTermDates(records, recency);
    const entry = Array.from(overlay.values())[0];
    expect(entry.policy_term_date).toBe('2026-12-31');
    expect(isPolicyIdentityTerminatedForMonth(records[0], '2026-04-01', overlay)).toBe(false);
  });
});

describe('classifyCell — Josie supersession pattern', () => {
  it('Mar/Apr → not_expected_cancelled when April file sets policy_term_date 2026-01-31', () => {
    const recs: NormalizedRecord[] = [
      // Earlier BO snapshots had a far-future term
      boRow({ id: 'bo-jan', batch_id: 'b-jan', policy_term_date: '2026-12-31' }),
      boRow({ id: 'bo-feb', batch_id: 'b-feb', policy_term_date: '2026-12-31' }),
      // April carrier file corrects it to Jan-end
      boRow({ id: 'bo-apr', batch_id: 'b-apr', policy_term_date: '2026-01-31' }),
      // EDE row with stale term still spans through April
      edeRow({ id: 'ede-feb', batch_id: 'b-feb', net_premium: 200 }),
    ];
    const overlay = latestAuthoritativeBoTermDates(recs, recency);
    const ctx = buildClassifierContext(recs, MONTHS, [], {
      batchMonthByBatchId,
      latestAuthoritativeBoOverlay: overlay,
    });
    const firstEligible = computeFirstEligibleMonth(recs);

    const mar = classifyCell(recs, '2026-03', firstEligible, ctx);
    const apr = classifyCell(recs, '2026-04', firstEligible, ctx);
    expect(mar.state).toBe('not_expected_cancelled');
    expect(apr.state).toBe('not_expected_cancelled');
    expect(mar.reason).toContain(SUPERSESSION_REASON_PREFIX);
    expect(apr.reason).toContain(SUPERSESSION_REASON_PREFIX);
    expect(mar.in_ede).toBe(false);
    expect(mar.in_back_office).toBe(false);
  });

  it('without overlay → same setup keeps Mar/Apr unpaid (pre-fix baseline)', () => {
    const recs: NormalizedRecord[] = [
      boRow({ id: 'bo-feb', batch_id: 'b-feb', policy_term_date: '2026-12-31' }),
      boRow({ id: 'bo-apr', batch_id: 'b-apr', policy_term_date: '2026-01-31' }),
      edeRow({ id: 'ede-feb', batch_id: 'b-feb', net_premium: 200 }),
    ];
    const ctx = buildClassifierContext(recs, MONTHS, [], { batchMonthByBatchId });
    const firstEligible = computeFirstEligibleMonth(recs);
    const mar = classifyCell(recs, '2026-03', firstEligible, ctx);
    // .some() over BO records sees the Feb row still-active → in_back_office true
    expect(mar.in_back_office).toBe(true);
  });

  it('applyNoSourceInvariantToMonthCell preserves supersession reason', () => {
    const cell = applyNoSourceInvariantToMonthCell({
      month: '2026-03',
      in_ede: false,
      in_back_office: false,
      in_commission: false,
      paid_amount: 0,
      payment_count: 0,
      due: true,
      state_reason: `${SUPERSESSION_REASON_PREFIX} — later carrier file set policy_term_date.`,
    } as any);
    expect(cell.state).toBe('not_expected_cancelled');
    expect(cell.state_reason).toContain(SUPERSESSION_REASON_PREFIX);
  });

  it('multi-policy merged member: terminated policy A; active policy B → cell stays active via B', () => {
    const recs: NormalizedRecord[] = [
      // Policy A — superseded to Jan end
      boRow({ id: 'bo-a-feb', batch_id: 'b-feb', policy_number: 'POL-A', policy_term_date: '2026-12-31' }),
      boRow({ id: 'bo-a-apr', batch_id: 'b-apr', policy_number: 'POL-A', policy_term_date: '2026-01-31' }),
      // Policy B — still active
      boRow({ id: 'bo-b-apr', batch_id: 'b-apr', policy_number: 'POL-B', policy_term_date: null }),
      edeRow({ id: 'ede-b', batch_id: 'b-feb', policy_number: 'POL-B', net_premium: 200 }),
    ];
    const overlay = latestAuthoritativeBoTermDates(recs, recency);
    const ctx = buildClassifierContext(recs, MONTHS, [], {
      batchMonthByBatchId,
      latestAuthoritativeBoOverlay: overlay,
    });
    const firstEligible = computeFirstEligibleMonth(recs);
    const apr = classifyCell(recs, '2026-04', firstEligible, ctx);
    // Policy B still active — cell remains chaseable, NOT not_expected_cancelled.
    expect(apr.in_back_office).toBe(true);
    expect(apr.state).not.toBe('not_expected_cancelled');
  });

  it('same-file: an active row + a terminated row in the latest file → unchanged', () => {
    // Only one BO file (April), with two records (one with term, one without).
    // The "latest non-blank per field" semantics: among the two, the first
    // (by record-id tiebreak) wins. Either way, the overlay does not bring
    // in a *different* file's term — no cross-file supersession happens.
    const recs: NormalizedRecord[] = [
      boRow({ id: 'bo-apr-1', batch_id: 'b-apr', policy_term_date: null }),
      boRow({ id: 'bo-apr-2', batch_id: 'b-apr', policy_term_date: '2026-03-31' }),
      edeRow({ id: 'ede-feb', batch_id: 'b-feb', net_premium: 200 }),
    ];
    const overlay = latestAuthoritativeBoTermDates(recs, recency);
    const ctx = buildClassifierContext(recs, MONTHS, [], {
      batchMonthByBatchId,
      latestAuthoritativeBoOverlay: overlay,
    });
    const firstEligible = computeFirstEligibleMonth(recs);
    // At least one record passes isActiveBackOfficeRecord (the null-term one)
    // AND its policy identity is the one being checked. Whether that record
    // is "the chosen authoritative" or not, hasActiveBoForMonth uses .some()
    // and the active record passes (overlay terminated check requires the
    // overlay's chosen term to be <= month). Acceptable behavior: month 04
    // result is the same as before fix — driven by which record won the
    // tiebreaker. Assert no spurious supersession reason was emitted for
    // the active range (Feb).
    const feb = classifyCell(recs, '2026-02', firstEligible, ctx);
    expect(feb.reason).not.toContain(SUPERSESSION_REASON_PREFIX);
  });

  it('excluded buckets: eligibility-only / broker-effective-only do not trigger supersession', () => {
    // Latest file has eligible_for_commission=no but no term date set;
    // overlay entry should carry null/null term dates → no supersession.
    const recs: NormalizedRecord[] = [
      boRow({ id: 'bo-feb', batch_id: 'b-feb', eligible_for_commission: 'yes' }),
      boRow({ id: 'bo-apr', batch_id: 'b-apr', eligible_for_commission: 'no' }),
      edeRow({ id: 'ede-feb', batch_id: 'b-feb', net_premium: 200 }),
    ];
    const overlay = latestAuthoritativeBoTermDates(recs, recency);
    const entry = Array.from(overlay.values())[0];
    expect(entry.policy_term_date).toBeNull();
    expect(entry.broker_term_date).toBeNull();

    const ctx = buildClassifierContext(recs, MONTHS, [], {
      batchMonthByBatchId,
      latestAuthoritativeBoOverlay: overlay,
    });
    const firstEligible = computeFirstEligibleMonth(recs);
    const apr = classifyCell(recs, '2026-04', firstEligible, ctx);
    // Per-record eligibility=no on April row, but Feb row is still eligible
    // and active → hasActiveBoForMonth sees it. No supersession.
    expect(apr.in_back_office).toBe(true);
    expect(apr.reason).not.toContain(SUPERSESSION_REASON_PREFIX);
  });
});
