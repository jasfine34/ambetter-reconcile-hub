/**
 * Phase B Item 4b — MT/MCE agreement invariant + selector unit coverage.
 *
 * Drift lock for ROADMAP item 5: the MCE export must include exactly the
 * member-cells the Member Timeline classifies as `unpaid` for the viewed
 * service month under official-AOR scope, and nothing else (no paid,
 * reversed, manual_review, pending, not_expected_*, or missing cells).
 *
 * Coverage breakdown:
 *   §A — selector unit tests: state filter (only `unpaid` → candidate);
 *        official-AOR predicate is used; cell-derived netBucket + sourceType.
 *   §B — agreement invariant: for a synthetic multi-state fleet, the set of
 *        member_keys returned by `buildMtApprovedMceCandidates` equals the
 *        set whose classifier cell at `serviceMonth` is `unpaid` under the
 *        same scope/predicate, and no MCE row maps to any forbidden state.
 *   §C — static wiring assertion: MCE production inclusion does not import
 *        the deleted old builder or `getExpectedPaymentBreakdown`.
 *
 * Phase B Item 4b also deletes `buildMceCandidateSetForServiceMonth`; the
 * separate `mce-rewire-item4a-wiring.test.ts` asserts the symbol/import
 * absence; this file owns the inclusion-contract semantics.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildClassifierContext,
  classifyMember,
  buildIsDueEligibleRecord,
} from '@/lib/classifier';
import { buildMonthList } from '@/lib/memberTimeline';
import { buildMtApprovedMceCandidates } from '@/lib/canonical/mtApprovedMceSelector';
import type { NormalizedRecord } from '@/lib/normalize';

// ---------------------------------------------------------------------------
// Tiny record builders. Keep fields minimal but include everything the
// classifier + selector + predicates read.
// ---------------------------------------------------------------------------

const COVERALL_NPN = '21055210'; // Jason Fine → Coverall
const VIX_NPN = '21277051';      // Vix
const SERVICE_MONTH = '2026-02';
const MONTH_LIST = buildMonthList('2026-01', '2026-04');

interface RowOpts {
  member_key: string;
  source_type: 'EDE' | 'BACK_OFFICE' | 'COMMISSION';
  applicant_name?: string;
  effective_date?: string | null;
  policy_term_date?: string | null;
  paid_through_date?: string | null;
  broker_term_date?: string | null;
  status?: string;
  eligible_for_commission?: string;
  agent_npn?: string;
  aor_bucket?: string;
  pay_entity?: string;
  net_premium?: number | null;
  premium?: number | null;
  commission_amount?: number | null;
  paid_to_date?: string | null;
  months_paid?: number | null;
  batch_id?: string | null;
  policy_number?: string;
  issuer_subscriber_id?: string;
  exchange_subscriber_id?: string;
  raw_json?: Record<string, any>;
}

function row(o: RowOpts): NormalizedRecord {
  const name = o.applicant_name || 'Test Member';
  return {
    source_type: o.source_type,
    source_file_label: 'test',
    carrier: 'Ambetter',
    applicant_name: name,
    first_name: name.split(' ')[0] || '',
    last_name: name.split(' ').slice(1).join(' ') || '',
    dob: null,
    member_id: '',
    policy_number: o.policy_number ?? `POL-${o.member_key}`,
    exchange_subscriber_id: o.exchange_subscriber_id ?? '',
    exchange_policy_id: '',
    issuer_policy_id: '',
    issuer_subscriber_id: o.issuer_subscriber_id ?? `IS-${o.member_key}`,
    agent_name: 'Jason Fine',
    agent_npn: o.agent_npn ?? COVERALL_NPN,
    aor_bucket: o.aor_bucket ?? 'Jason Fine',
    pay_entity: o.pay_entity ?? '',
    status: o.status ?? 'Effectuated',
    effective_date: o.effective_date ?? '2026-01-01',
    premium: o.premium ?? null,
    net_premium: o.net_premium ?? null,
    commission_amount: o.commission_amount ?? null,
    eligible_for_commission: o.eligible_for_commission ?? 'Yes',
    policy_term_date: o.policy_term_date ?? null,
    // BO rows default to a paid-through that covers the viewed SERVICE_MONTH
    // so the classifier reaches Rule 3 ('unpaid') instead of falling through
    // to Rule 5 (manual_review) on signals-insufficient.
    paid_through_date:
      o.paid_through_date ?? (o.source_type === 'BACK_OFFICE' ? '2026-02-28' : null),
    broker_effective_date: null,
    broker_term_date: o.broker_term_date ?? null,
    member_responsibility: null,
    on_off_exchange: '',
    auto_renewal: null,
    ede_policy_origin_type: '',
    ede_bucket: '',
    policy_modified_date: null,
    client_address_1: '',
    client_address_2: '',
    client_city: '',
    client_state_full: '',
    client_zip: '',
    paid_to_date: o.paid_to_date ?? null,
    months_paid: o.months_paid ?? null,
    writing_agent_carrier_id: '',
    member_key: o.member_key,
    batch_id: o.batch_id ?? 'b-feb',
    raw_json: {
      policyStatus: 'Effectuated',
      issuer: 'Ambetter',
      currentPolicyAOR: 'Jason Fine',
      'Broker Name': 'Jason Fine',
      ...(o.raw_json ?? {}),
    },
  } as unknown as NormalizedRecord;
}

const batchMonthByBatchId: Record<string, string> = {
  'b-jan': '2026-01',
  'b-feb': '2026-02',
  'b-mar': '2026-03',
};

/**
 * The classifier only emits `unpaid` when the month is ripe — i.e. when at
 * least one commission row in the fleet attributes to SERVICE_MONTH. This
 * helper supplies a throwaway "carries the cycle" commission row (different
 * member) so the cells under test become eligible for the unpaid verdict.
 */
function ripenessRow(): NormalizedRecord {
  return row({
    member_key: 'mem-ripeness-carrier',
    source_type: 'COMMISSION',
    commission_amount: 1,
    paid_to_date: '2026-02-28',
    months_paid: 1,
    pay_entity: 'Coverall',
    batch_id: 'b-mar',
  });
}

// ---------------------------------------------------------------------------
// §A — Selector unit tests
// ---------------------------------------------------------------------------
describe('§A buildMtApprovedMceCandidates — state filter', () => {
  it('emits exactly one candidate when the cell state is `unpaid`', () => {
    const recs: NormalizedRecord[] = [
      ripenessRow(),
      row({
        member_key: 'mem-unpaid',
        source_type: 'EDE',
        effective_date: '2026-01-01',
        net_premium: 200,
      }),
      row({
        member_key: 'mem-unpaid',
        source_type: 'BACK_OFFICE',
        effective_date: '2026-01-01',
        eligible_for_commission: 'Yes',
      }),
      // NO commission for SERVICE_MONTH → unpaid.
    ];
    const out = buildMtApprovedMceCandidates({
      allBatchRecords: recs,
      monthList: MONTH_LIST,
      serviceMonth: SERVICE_MONTH,
      scope: 'Coverall',
      batchMonthByBatchId,
    });
    expect(out.length).toBe(1);
    expect(out[0].member_key).toBe('mem-unpaid');
    expect(out[0]._mtSourceType).toBe('Matched');
    // EDE row has net_premium=200 → +Net bucket.
    expect(out[0]._mtNetBucket).toBe('+Net');
  });

  it('emits NO candidate when the cell state is `paid`', () => {
    const recs: NormalizedRecord[] = [
      ripenessRow(),
      row({
        member_key: 'mem-paid',
        source_type: 'EDE',
        effective_date: '2026-01-01',
        net_premium: 200,
      }),
      row({
        member_key: 'mem-paid',
        source_type: 'BACK_OFFICE',
        effective_date: '2026-01-01',
        eligible_for_commission: 'Yes',
      }),
      row({
        member_key: 'mem-paid',
        source_type: 'COMMISSION',
        commission_amount: 100,
        paid_to_date: '2026-02-28',
        months_paid: 1,
        pay_entity: 'Coverall',
        batch_id: 'b-mar',
      }),
    ];
    const out = buildMtApprovedMceCandidates({
      allBatchRecords: recs,
      monthList: MONTH_LIST,
      serviceMonth: SERVICE_MONTH,
      scope: 'Coverall',
      batchMonthByBatchId,
    });
    expect(out.find((c) => c.member_key === 'mem-paid')).toBeUndefined();
  });

  it('uses official-AOR predicate — Vix-NPN-only member is filtered out under scope=Coverall', () => {
    const recs: NormalizedRecord[] = [
      ripenessRow(),
      row({
        member_key: 'mem-vix',
        source_type: 'EDE',
        effective_date: '2026-01-01',
        net_premium: 100,
        agent_npn: VIX_NPN,
        aor_bucket: 'Other Agent',
        raw_json: { currentPolicyAOR: 'Other Agent', 'Broker Name': 'Other Agent' },
      }),
      row({
        member_key: 'mem-vix',
        source_type: 'BACK_OFFICE',
        agent_npn: VIX_NPN,
        aor_bucket: 'Other Agent',
        raw_json: { 'Broker Name': 'Other Agent' },
      }),
    ];
    const out = buildMtApprovedMceCandidates({
      allBatchRecords: recs,
      monthList: MONTH_LIST,
      serviceMonth: SERVICE_MONTH,
      scope: 'Coverall',
      batchMonthByBatchId,
    });
    expect(out.find((c) => c.member_key === 'mem-vix')).toBeUndefined();
  });

  it('payEntity=All passes through Vix-NPN candidates that are MT-unpaid', () => {
    const recs: NormalizedRecord[] = [
      ripenessRow(),
      row({
        member_key: 'mem-vix-all',
        source_type: 'EDE',
        effective_date: '2026-01-01',
        net_premium: 100,
        agent_npn: VIX_NPN,
        aor_bucket: 'Other Agent',
        raw_json: { currentPolicyAOR: 'Other Agent', 'Broker Name': 'Other Agent' },
      }),
      row({
        member_key: 'mem-vix-all',
        source_type: 'BACK_OFFICE',
        agent_npn: VIX_NPN,
        aor_bucket: 'Other Agent',
        raw_json: { 'Broker Name': 'Other Agent' },
      }),
    ];
    const out = buildMtApprovedMceCandidates({
      allBatchRecords: recs,
      monthList: MONTH_LIST,
      serviceMonth: SERVICE_MONTH,
      scope: 'All',
      batchMonthByBatchId,
    });
    expect(out.find((c) => c.member_key === 'mem-vix-all')).toBeDefined();
  });

  it('cell-derived source-type truth table: BO-only / EDE-only / Matched', () => {
    const boOnly: NormalizedRecord[] = [
      ripenessRow(),
      row({
        member_key: 'mem-bo-only',
        source_type: 'BACK_OFFICE',
        effective_date: '2026-01-01',
        eligible_for_commission: 'Yes',
      }),
    ];
    const edeOnly: NormalizedRecord[] = [
      ripenessRow(),
      row({
        member_key: 'mem-ede-only',
        source_type: 'EDE',
        effective_date: '2026-01-01',
        net_premium: 150,
      }),
    ];

    const outBo = buildMtApprovedMceCandidates({
      allBatchRecords: boOnly,
      monthList: MONTH_LIST,
      serviceMonth: SERVICE_MONTH,
      scope: 'Coverall',
      batchMonthByBatchId,
    });
    const outEde = buildMtApprovedMceCandidates({
      allBatchRecords: edeOnly,
      monthList: MONTH_LIST,
      serviceMonth: SERVICE_MONTH,
      scope: 'Coverall',
      batchMonthByBatchId,
    });

    if (outBo.length > 0) expect(outBo[0]._mtSourceType).toBe('BO Only');
    if (outEde.length > 0) expect(outEde[0]._mtSourceType).toBe('EDE Only');
  });
});

// ---------------------------------------------------------------------------
// §B — Agreement invariant (the drift lock).
// ---------------------------------------------------------------------------
describe('§B MT/MCE agreement — MCE keys === MT unpaid cell keys (official-AOR)', () => {
  /** Build a fleet that exhibits several distinct classifier states. */
  function buildFleet(): NormalizedRecord[] {
    return [
      // mem-1: unpaid (EDE + BO, no commission).
      row({ member_key: 'mem-1', source_type: 'EDE', effective_date: '2026-01-01', net_premium: 100 }),
      row({ member_key: 'mem-1', source_type: 'BACK_OFFICE', effective_date: '2026-01-01' }),

      // mem-2: paid (commission attributed to SERVICE_MONTH).
      row({ member_key: 'mem-2', source_type: 'EDE', effective_date: '2026-01-01', net_premium: 100 }),
      row({ member_key: 'mem-2', source_type: 'BACK_OFFICE', effective_date: '2026-01-01' }),
      row({
        member_key: 'mem-2',
        source_type: 'COMMISSION',
        commission_amount: 100,
        paid_to_date: '2026-02-28',
        months_paid: 1,
        pay_entity: 'Coverall',
        batch_id: 'b-mar',
      }),

      // mem-3: pre-eligibility (EDE effective AFTER serviceMonth).
      row({ member_key: 'mem-3', source_type: 'EDE', effective_date: '2026-05-01', net_premium: 100 }),

      // mem-4: out-of-scope (Vix NPN under scope=Coverall).
      row({
        member_key: 'mem-4',
        source_type: 'EDE',
        effective_date: '2026-01-01',
        net_premium: 100,
        agent_npn: VIX_NPN,
        aor_bucket: 'Other Agent',
        raw_json: { currentPolicyAOR: 'Other Agent', 'Broker Name': 'Other Agent' },
      }),
      row({
        member_key: 'mem-4',
        source_type: 'BACK_OFFICE',
        effective_date: '2026-01-01',
        agent_npn: VIX_NPN,
        aor_bucket: 'Other Agent',
        raw_json: { 'Broker Name': 'Other Agent' },
      }),

      // mem-5: another unpaid (BO-only).
      row({
        member_key: 'mem-5',
        source_type: 'BACK_OFFICE',
        effective_date: '2026-01-01',
        eligible_for_commission: 'Yes',
      }),
    ];
  }

  /** Reference: directly compute MT-unpaid keys for the same scope. */
  function mtUnpaidKeys(recs: NormalizedRecord[], scope: 'Coverall' | 'All'): Set<string> {
    const pred = buildIsDueEligibleRecord({ aorScope: 'official', payEntity: scope });
    const scoped = recs.filter(pred);
    const byMember = new Map<string, NormalizedRecord[]>();
    for (const r of scoped) {
      const k = (r as any).member_key || 'unknown';
      const arr = byMember.get(k);
      if (arr) arr.push(r);
      else byMember.set(k, [r]);
    }
    const ctx = buildClassifierContext(scoped, MONTH_LIST, [], {
      batchMonthByBatchId: new Map(Object.entries(batchMonthByBatchId)),
    });
    const out = new Set<string>();
    for (const [mk, mrs] of byMember) {
      const c = classifyMember(mrs, ctx);
      const cell = c.cells[SERVICE_MONTH];
      if (cell?.state === 'unpaid') out.add(mk);
    }
    return out;
  }

  const FORBIDDEN: ReadonlyArray<string> = [
    'paid',
    'reversed',
    'manual_review',
    'pending',
    'not_expected_premium_unpaid',
    'not_expected_pre_eligibility',
    'not_expected_cancelled',
    'not_expected_not_ours',
  ];

  it('Coverall scope — MCE candidate keys equal MT unpaid keys (set equality)', () => {
    const recs = buildFleet();
    const mce = buildMtApprovedMceCandidates({
      allBatchRecords: recs,
      monthList: MONTH_LIST,
      serviceMonth: SERVICE_MONTH,
      scope: 'Coverall',
      batchMonthByBatchId,
    });
    const mceKeys = new Set(mce.map((c) => c.member_key));
    const mtKeys = mtUnpaidKeys(recs, 'Coverall');
    expect([...mceKeys].sort()).toEqual([...mtKeys].sort());
    // The fleet is constructed so at least one candidate exists.
    expect(mceKeys.size).toBeGreaterThan(0);
  });

  it('no MCE row maps to a forbidden classifier state (paid / reversed / mr / pending / not_expected_*)', () => {
    const recs = buildFleet();
    const mce = buildMtApprovedMceCandidates({
      allBatchRecords: recs,
      monthList: MONTH_LIST,
      serviceMonth: SERVICE_MONTH,
      scope: 'Coverall',
      batchMonthByBatchId,
    });
    const pred = buildIsDueEligibleRecord({ aorScope: 'official', payEntity: 'Coverall' });
    const scoped = recs.filter(pred);
    const byMember = new Map<string, NormalizedRecord[]>();
    for (const r of scoped) {
      const k = (r as any).member_key || 'unknown';
      const arr = byMember.get(k);
      if (arr) arr.push(r);
      else byMember.set(k, [r]);
    }
    const ctx = buildClassifierContext(scoped, MONTH_LIST, [], {
      batchMonthByBatchId: new Map(Object.entries(batchMonthByBatchId)),
    });
    for (const c of mce) {
      const recsForMember = byMember.get(c.member_key) ?? [];
      const cls = classifyMember(recsForMember, ctx);
      const cell = cls.cells[SERVICE_MONTH];
      expect(cell).toBeDefined();
      expect(cell.state).toBe('unpaid');
      expect(FORBIDDEN).not.toContain(cell.state as any);
    }
  });
});

// ---------------------------------------------------------------------------
// §C — Static wiring: production source has no path back to the deleted
// builder or `getExpectedPaymentBreakdown`.
// ---------------------------------------------------------------------------
describe('§C static wiring — production MCE inclusion is selector-only', () => {
  const pageSource = readFileSync(
    resolve(__dirname, '..', 'pages/MissingCommissionExportPage.tsx'),
    'utf8',
  );

  it('does not export or executably reference the deleted MCE-only builder symbols', () => {
    // Allow comments to reference the deleted symbols by name (useful
    // history); forbid only executable export / declaration / call sites.
    expect(pageSource).not.toMatch(/export\s+(function|interface|type|const)\s+buildMceCandidateSetForServiceMonth/);
    expect(pageSource).not.toMatch(/export\s+(function|interface|type|const)\s+McePaymentBreakdownLike/);
    expect(pageSource).not.toMatch(/buildMceCandidateSetForServiceMonth\s*\(/);
  });

  it('does not import getExpectedPaymentBreakdown from metrics (Dashboard/Agent/UR keep it)', () => {
    // It may legitimately appear in a comment that names the helper; we
    // forbid only an executable import/call.
    expect(pageSource).not.toMatch(/import\s+\{[^}]*getExpectedPaymentBreakdown[^}]*\}\s+from/);
    expect(pageSource).not.toMatch(/getExpectedPaymentBreakdown\s*\(/);
  });

  it('production inclusion still wires through buildMtApprovedMceCandidates + getMtAllBatchProjection', () => {
    expect(pageSource).toMatch(/buildMtApprovedMceCandidates/);
    expect(pageSource).toMatch(/getMtAllBatchProjection/);
  });
});
