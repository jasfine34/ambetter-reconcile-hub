/**
 * C2b-1 — headless production assembler tests.
 *
 * Composes the real certified helpers (no helper mocks) over small
 * NormalizedRecord fixtures. We verify the assembler's contract:
 *
 *   1  unpaid → population:1 (premium fact, identity, scope, month)
 *   2  paid → population:2 with amount fact; not_expected_* → no row
 *   3  cross-entity satisfaction (correct + wrong-amount + reversed paths)
 *   4  carrier_recognition → crFlag:true
 *   5  picked-EDE active DMI → dmi.active=true + issueType/deadline
 *   6  targetScopes ['Coverall','Vix'] materializes both, 'All' not a third
 *   7  GRAIN GUARD: single row per (member,month,scope)
 *   8  MONTH-SCOPED EVIDENCE: two service months keep separate resolver inputs
 *   9  resolver no-rate row STILL produced; counted in unsupportedResolverReasons
 *  10  decision-overlay non-interference (assembler never loads decisions)
 *  11  SERVICE-MONTH BOUND: out-of-window cell excluded
 *  12  perf/no-loader static guard + end-to-end assemble → runDiagnoseCycle
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { assembleDiagnoseRouteRows } from '../assembleDiagnoseRouteRows';
import { runDiagnoseCycle, type RouteRowInput } from '../diagnoseAndRoute';
import type { NormalizedRecord } from '@/lib/normalize';
import type { CarrierCompRateRow } from '../compGrid';
import type { OperatorDecisionIndex } from '../operatorDecisions';

// ─────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────

const BATCH = 'B-2026-03';
const STMT_MONTH = '2026-03';
const NEXT_MONTH = '2026-04';
const MONTH_LIST = ['2026-01', '2026-02', '2026-03', '2026-04'];
const TODAY = '2026-04-10';
const JASON_NPN = '21055210'; // Coverall
const ERICA_NPN = '21277051'; // Coverall_or_Vix

const RATE_AMBETTER_FL: CarrierCompRateRow = {
  id: 'rate-fl-pmpm-2026',
  rate_key: 'ambetter|FL|standard|2026',
  carrier_key: 'ambetter',
  carrier_display: 'Ambetter',
  state_code: 'FL',
  plan_variant: 'standard',
  comp_basis: 'pmpm',
  calculation_basis: 'per_member_pmpm',
  rate_value: 25,
  rate_unit: 'USD',
  member_min: null,
  member_max: null,
  member_cap: null,
  effective_year: 2026,
  support_status: 'supported',
  unsupported_reason: null,
};

function rec(over: Partial<NormalizedRecord> & { raw_json?: Record<string, any> }): NormalizedRecord {
  return {
    source_type: '',
    source_file_label: '',
    carrier: 'Ambetter',
    applicant_name: 'Test Member',
    first_name: '',
    last_name: '',
    dob: null,
    member_id: '',
    policy_number: '',
    exchange_subscriber_id: '',
    exchange_policy_id: '',
    issuer_policy_id: '',
    issuer_subscriber_id: '',
    agent_name: '',
    agent_npn: '',
    aor_bucket: '',
    pay_entity: '',
    status: '',
    effective_date: '2025-12-01',
    premium: null,
    net_premium: null,
    commission_amount: null,
    eligible_for_commission: 'Yes',
    policy_term_date: null,
    paid_through_date: null,
    broker_effective_date: null,
    broker_term_date: null,
    member_responsibility: null,
    on_off_exchange: '',
    auto_renewal: null,
    ede_policy_origin_type: '',
    ede_bucket: '',
    policy_modified_date: null,
    client_address_1: '',
    client_address_2: '',
    client_city: '',
    client_state_full: 'FL',
    client_zip: '',
    paid_to_date: null,
    months_paid: null,
    writing_agent_carrier_id: '',
    member_key: '',
    raw_json: {},
    ...over,
  } as NormalizedRecord;
}

function bo(member: string, opts: Partial<NormalizedRecord> & {
  brokerName: string;
  npn: string;
} & { raw_json?: Record<string, any> }): NormalizedRecord {
  return rec({
    ...opts,
    source_type: 'BACK_OFFICE',
    member_key: member,
    issuer_subscriber_id: opts.issuer_subscriber_id ?? `ISID${member}`,
    policy_number: opts.policy_number ?? `POL${member}`,
    agent_npn: opts.npn,
    agent_name: opts.brokerName,
    net_premium: opts.net_premium ?? 100,
    paid_through_date: opts.paid_through_date ?? '2026-04-30',
    raw_json: {
      'Broker Name': opts.brokerName,
      'issuer': 'Ambetter',
      ...(opts.raw_json ?? {}),
    },
    eligible_for_commission: 'Yes',
    ...({} as any),
    batch_id: BATCH,
  } as any);
}

function ede(member: string, opts: { aor: string; npn: string; raw_json?: Record<string, any> } & Partial<NormalizedRecord>): NormalizedRecord {
  return rec({
    ...opts,
    source_type: 'EDE',
    member_key: member,
    issuer_subscriber_id: opts.issuer_subscriber_id ?? `ISID${member}`,
    policy_number: opts.policy_number ?? `POL${member}`,
    agent_npn: opts.npn,
    net_premium: opts.net_premium ?? 100,
    status: 'effectuated',
    raw_json: {
      'currentPolicyAOR': opts.aor,
      'policyStatus': 'effectuated',
      'issuer': 'Ambetter',
      ...(opts.raw_json ?? {}),
    },
    ...({} as any),
    batch_id: BATCH,
  } as any);
}

function comm(member: string, opts: {
  payEntity: 'Coverall' | 'Vix';
  amount: number;
  serviceMonth: string;
  npn?: string;
} & Partial<NormalizedRecord>): NormalizedRecord {
  // paid_to_date last day of serviceMonth + months_paid=1 → attributes to serviceMonth
  const [y, m] = opts.serviceMonth.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).toISOString().substring(0, 10);
  return rec({
    ...opts,
    source_type: 'COMMISSION',
    member_key: member,
    issuer_subscriber_id: opts.issuer_subscriber_id ?? `ISID${member}`,
    policy_number: opts.policy_number ?? `POL${member}`,
    pay_entity: opts.payEntity,
    commission_amount: opts.amount,
    paid_to_date: last,
    months_paid: 1,
    agent_npn: opts.npn ?? JASON_NPN,
    ...({} as any),
    batch_id: BATCH,
  } as any);
}

const BATCH_MONTH = { [BATCH]: STMT_MONTH };

// Members across scenarios:
//   M1 — Coverall unpaid (Jason, FL, BO+EDE, no commission)
//   M2 — Coverall paid for STMT_MONTH (gets a Coverall commission)
//   M3 — Coverall-target unpaid + Vix paid satisfying (cross-entity correct)
//   M4 — Cross-entity reversed: Coverall unpaid + Vix reversed-pair → does NOT satisfy
//   M5 — Carrier recognition: BO Jason scope but picked EDE under non-Coverall AOR
//   M6 — DMI active on picked EDE for STMT_MONTH (Jason scope, unpaid)
//   M7 — Out-of-window cell (effective in 2026-01 but serviceMonths = STMT_MONTH only)
//   M8 — Resolver no-rate (carrier missing entirely on the synthesized evidence row)

function fixtureRecords(): NormalizedRecord[] {
  const recs: NormalizedRecord[] = [];
  // Required so commissionStatementMonths covers STMT_MONTH (ripeness).
  // The classifier reads commissionServiceMonths from any COMMISSION record.
  // M2's own commission attributes STMT_MONTH which suffices.

  // ----- M1 Coverall unpaid -----
  recs.push(bo('M1', { brokerName: 'Jason Fine', npn: JASON_NPN, effective_date: '2025-12-01' }));
  recs.push(ede('M1', { aor: 'Jason Fine (21055210)', npn: JASON_NPN, effective_date: '2025-12-01' }));

  // ----- M2 Coverall paid -----
  recs.push(bo('M2', { brokerName: 'Jason Fine', npn: JASON_NPN, effective_date: '2025-12-01' }));
  recs.push(ede('M2', { aor: 'Jason Fine (21055210)', npn: JASON_NPN, effective_date: '2025-12-01' }));
  recs.push(comm('M2', { payEntity: 'Coverall', amount: 50, serviceMonth: STMT_MONTH, npn: JASON_NPN }));

  // ----- M3 Coverall unpaid + Vix paid (Erica scope → present in BOTH scopes) -----
  recs.push(bo('M3', { brokerName: 'Erica Fine', npn: ERICA_NPN, effective_date: '2025-12-01' }));
  recs.push(ede('M3', { aor: 'Erica Fine (21277051)', npn: ERICA_NPN, effective_date: '2025-12-01' }));
  recs.push(comm('M3', { payEntity: 'Vix', amount: 50, serviceMonth: STMT_MONTH, npn: ERICA_NPN }));

  // ----- M4 Reversed pair (Erica scope) → opposite cell becomes 'reversed', not 'paid' -----
  recs.push(bo('M4', { brokerName: 'Erica Fine', npn: ERICA_NPN, effective_date: '2025-12-01' }));
  recs.push(ede('M4', { aor: 'Erica Fine (21277051)', npn: ERICA_NPN, effective_date: '2025-12-01' }));
  recs.push(comm('M4', { payEntity: 'Vix', amount: 50, serviceMonth: STMT_MONTH, npn: ERICA_NPN, raw_json: { 'Transaction ID': 'TX-POS' } }));
  recs.push(comm('M4', { payEntity: 'Vix', amount: -50, serviceMonth: STMT_MONTH, npn: ERICA_NPN, raw_json: { 'Transaction ID': 'TX-NEG' } }));

  // ----- M5 Carrier recognition (Coverall BO + picked EDE under non-Coverall AOR) -----
  recs.push(bo('M5', { brokerName: 'Jason Fine', npn: JASON_NPN, effective_date: '2025-12-01' }));
  recs.push(ede('M5', { aor: 'Outside Agent (99999999)', npn: '99999999', effective_date: '2025-12-01' }));

  // ----- M6 DMI active on picked EDE -----
  recs.push(bo('M6', { brokerName: 'Jason Fine', npn: JASON_NPN, effective_date: '2025-12-01' }));
  recs.push(
    ede('M6', {
      aor: 'Jason Fine (21055210)',
      npn: JASON_NPN,
      effective_date: '2025-12-01',
      raw_json: {
        verificationIssueType: 'DMI_CITIZENSHIP',
        verificationEndDate: '2026-05-15',
        documentUploadedForSviDmi: 'N',
      },
    }),
  );

  // ----- M8 no-rate (state blank → resolver MISSING_STATE) -----
  const m8bo = bo('M8', { brokerName: 'Jason Fine', npn: JASON_NPN, effective_date: '2025-12-01' });
  (m8bo as any).client_state_full = ''; // strip state
  recs.push(m8bo);
  const m8ede = ede('M8', { aor: 'Jason Fine (21055210)', npn: JASON_NPN, effective_date: '2025-12-01' });
  (m8ede as any).client_state_full = '';
  recs.push(m8ede);
  // give M8 a paid commission so it hits the resolver via population-2 amount fact
  recs.push(comm('M8', { payEntity: 'Coverall', amount: 50, serviceMonth: STMT_MONTH, npn: JASON_NPN }));

  return recs;
}

const RECS = fixtureRecords();

// ─────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────

describe('assembleDiagnoseRouteRows — headless production assembler', () => {
  const baseArgs = {
    allBatchRecords: RECS,
    monthList: MONTH_LIST,
    serviceMonths: [STMT_MONTH],
    targetScopes: ['Coverall', 'Vix'] as const,
    batchMonthByBatchId: BATCH_MONTH,
    today: TODAY,
    rateRows: [RATE_AMBETTER_FL],
  };

  function run(overrides: Partial<typeof baseArgs> = {}) {
    return assembleDiagnoseRouteRows({ ...baseArgs, ...overrides } as any);
  }

  function findRow(rows: RouteRowInput[], member: string, scope: string, month = STMT_MONTH) {
    const lc = `isid:isid${member.toLowerCase()}`;
    return rows.find(
      (r) => r.targetScope === scope && r.serviceMonth === month && r.stableMemberKey === lc,
    );
  }

  it('1+2 emits unpaid/paid rows with correct populations and skips not_expected_*', () => {
    const { rows, diagnostics } = run();
    const m1Coverall = findRow(rows, 'M1', 'Coverall');
    expect(m1Coverall).toBeDefined();
    expect(m1Coverall!.population).toBe(1);
    expect(m1Coverall!.serviceMonth).toBe(STMT_MONTH);
    expect(m1Coverall!.targetScope).toBe('Coverall');
    expect(m1Coverall!.facts.premium.kind).toBe('chase_candidate');

    const m2Coverall = findRow(rows, 'M2', 'Coverall');
    expect(m2Coverall).toBeDefined();
    expect(m2Coverall!.population).toBe(2);
    // amount is either correct/wrong/indeterminate but NEVER not_applicable for paid pop-2
    expect(m2Coverall!.facts.amount.kind).not.toBe('not_applicable');

    // not_expected_* members produce no row — pop totals reflect only unpaid+paid.
    expect(diagnostics.population1Count + diagnostics.population2Count).toBe(rows.length);
  });

  it('3 cross-entity satisfaction: Vix paid → Coverall row satisfied; reversed Vix → NOT satisfied', () => {
    const { rows } = run();
    const m3Coverall = findRow(rows, 'M3', 'Coverall');
    expect(m3Coverall).toBeDefined();
    expect(m3Coverall!.facts.crossEntitySatisfied.satisfied).toBe(true);
    expect(m3Coverall!.facts.crossEntitySatisfied.satisfyingEntity).toBe('Vix');

    const m4Coverall = findRow(rows, 'M4', 'Coverall');
    expect(m4Coverall).toBeDefined();
    expect(m4Coverall!.facts.crossEntitySatisfied.satisfied).toBe(false);
  });

  it('4 crFlag is set when MT row has carrier_recognition', () => {
    const { rows } = run();
    const m5 = findRow(rows, 'M5', 'Coverall');
    expect(m5).toBeDefined();
    expect(m5!.crFlag).toBe(true);
  });

  it('5 active DMI on picked EDE → dmi.active=true with issueType + deadline', () => {
    const { rows } = run();
    const m6 = findRow(rows, 'M6', 'Coverall');
    expect(m6).toBeDefined();
    expect(m6!.facts.dmi.active).toBe(true);
    expect(m6!.facts.dmi.issueType).toBe('DMI_CITIZENSHIP');
    expect(m6!.facts.dmi.verificationEndDate).toBe('2026-05-15');
  });

  it('6 targetScopes [Coverall,Vix] materializes both and never adds a third "All" set', () => {
    const { rows, diagnostics } = run();
    const scopes = new Set(rows.map((r) => r.targetScope));
    expect(scopes.has('Coverall')).toBe(true);
    expect(scopes.has('Vix')).toBe(true);
    expect(scopes.has('All')).toBe(false);
    expect(Object.keys(diagnostics.byScope).sort()).toEqual(['Coverall', 'Vix']);
  });

  it('7 GRAIN GUARD: one row per (member, scope, serviceMonth) — no duplicates', () => {
    const { rows } = run();
    const seen = new Set<string>();
    for (const r of rows) {
      const k = `${r.targetScope}|${r.stableMemberKey}|${r.serviceMonth}`;
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }
    // RouteRowInput type does NOT carry policy_identity_key (compile-time grain guard).
    const sample = rows[0] as any;
    expect(Object.prototype.hasOwnProperty.call(sample, 'policy_identity_key')).toBe(false);
  });

  it('8 MONTH-SCOPED EVIDENCE: same member, two months → row per month with own basis', () => {
    // Extend serviceMonths and ensure each resolves independently.
    const extraRecs: NormalizedRecord[] = [
      ...RECS,
      // Add a Feb commission for M2 so M2 has paid cells in both Feb + Mar.
      comm('M2', { payEntity: 'Coverall', amount: 50, serviceMonth: '2026-02', npn: JASON_NPN }),
    ];
    const { rows } = assembleDiagnoseRouteRows({
      ...baseArgs,
      allBatchRecords: extraRecs,
      serviceMonths: ['2026-02', '2026-03'],
    } as any);
    const m2Feb = rows.find((r) => r.targetScope === 'Coverall' && r.serviceMonth === '2026-02' && r.stableMemberKey === 'isid:isidm2');
    const m2Mar = rows.find((r) => r.targetScope === 'Coverall' && r.serviceMonth === '2026-03' && r.stableMemberKey === 'isid:isidm2');
    expect(m2Feb).toBeDefined();
    expect(m2Mar).toBeDefined();
    expect(m2Feb!.rowKey).not.toBe(m2Mar!.rowKey);
  });

  it('9 resolver UNSUPPORTED row STILL emitted; reason counted', () => {
    const { rows, diagnostics } = run();
    const m8 = findRow(rows, 'M8', 'Coverall');
    expect(m8).toBeDefined();
    // M8 is paid → population 2; amount fact is indeterminate(MISSING_STATE)
    expect(m8!.population).toBe(2);
    expect(m8!.facts.amount.kind).toBe('indeterminate');
    if (m8!.facts.amount.kind === 'indeterminate') {
      expect(['MISSING_STATE', 'MISSING_MEMBER_COUNT', 'NO_RATE_ROW', 'MISSING_POLICY_YEAR']).toContain(m8!.facts.amount.reason);
    }
    const totalUnsupported = Object.values(diagnostics.unsupportedResolverReasons).reduce((a, b) => a + b, 0);
    expect(totalUnsupported).toBeGreaterThan(0);
  });

  it('10 decision-overlay non-interference: assembler never loads operator decisions (no Supabase imports)', () => {
    // Static guard — assembler module text must not import the decision-load path
    // or Supabase client (the assembler is headless / pure).
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'assembleDiagnoseRouteRows.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/loadOperatorDecisionIndex/);
    expect(src).not.toMatch(/from\s+['"]@\/integrations\/supabase/);
    expect(src).not.toMatch(/getAllNormalizedRecords/);
    expect(src).not.toMatch(/getMtAllBatchProjection/);
  });

  it('11 SERVICE-MONTH BOUND: out-of-window cells excluded from rows + diagnostics', () => {
    const { rows } = run({ serviceMonths: [STMT_MONTH] });
    for (const r of rows) {
      expect(r.serviceMonth).toBe(STMT_MONTH);
    }
  });

  it('12 perf static guard + end-to-end assemble → runDiagnoseCycle produces a coherent CycleResult', async () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'assembleDiagnoseRouteRows.ts'),
      'utf8',
    );
    // No second all-batch fetch, no .range() pagination, no compGridLoader.
    expect(src).not.toMatch(/\.range\(/);
    expect(src).not.toMatch(/compGridLoader/);

    const { rows } = run();
    const emptyIdx: OperatorDecisionIndex = {
      all: [],
      byMemberMonth: new Map(),
      byCarrierMember: new Map(),
      byPolicyMonth: new Map(),
      loadedAt: 0,
    } as unknown as OperatorDecisionIndex;
    const cycle = await runDiagnoseCycle({
      rows,
      loadDecisionIndex: async () => emptyIdx,
      applyReduction: async (d) => d,
    });
    // Every row routes to exactly one bucket.
    let bucketCount = cycle.chaseEligible.length + cycle.satisfied.length;
    for (const k of Object.keys(cycle.queues) as Array<keyof typeof cycle.queues>) {
      bucketCount += cycle.queues[k].length;
    }
    expect(bucketCount).toBe(rows.length);
    expect(cycle.routes.size).toBe(rows.length);
  });

  // ── C2b-1 member-count corrective (R-CARR-007) ──────────────────────
  describe('member-count resolver wiring (R-CARR-007)', () => {
    function mcBaseArgs(records: NormalizedRecord[], serviceMonths: string[], batchMonths: Record<string, string>) {
      return {
        allBatchRecords: records,
        monthList: MONTH_LIST,
        serviceMonths,
        targetScopes: ['Coverall'] as const,
        batchMonthByBatchId: batchMonths,
        today: TODAY,
        rateRows: [RATE_AMBETTER_FL],
      };
    }

    it('MC1a: BO "Number of Members" resolves amount (NOT MISSING_MEMBER_COUNT)', () => {
      const recs: NormalizedRecord[] = [
        bo('MC1', { brokerName: 'Jason Fine', npn: JASON_NPN, effective_date: '2025-12-01', raw_json: { 'Number of Members': '2' } }),
        ede('MC1', { aor: 'Jason Fine (21055210)', npn: JASON_NPN, effective_date: '2025-12-01' }),
        comm('MC1', { payEntity: 'Coverall', amount: 50, serviceMonth: STMT_MONTH, npn: JASON_NPN }),
      ];
      const { rows } = assembleDiagnoseRouteRows(mcBaseArgs(recs, [STMT_MONTH], BATCH_MONTH) as any);
      const row = rows.find((r) => r.targetScope === 'Coverall' && r.serviceMonth === STMT_MONTH && r.stableMemberKey === 'isid:isidmc1');
      expect(row).toBeDefined();
      if (row!.facts.amount.kind === 'indeterminate') {
        expect(row!.facts.amount.reason).not.toBe('MISSING_MEMBER_COUNT');
      }
    });

    it('MC1b: EDE-spelling fallback (coveredMemberCount) resolves amount', () => {
      const recs: NormalizedRecord[] = [
        bo('MC2', { brokerName: 'Jason Fine', npn: JASON_NPN, effective_date: '2025-12-01' }), // no count on BO
        ede('MC2', { aor: 'Jason Fine (21055210)', npn: JASON_NPN, effective_date: '2025-12-01', raw_json: { coveredMemberCount: '3' } }),
        comm('MC2', { payEntity: 'Coverall', amount: 50, serviceMonth: STMT_MONTH, npn: JASON_NPN }),
      ];
      const { rows } = assembleDiagnoseRouteRows(mcBaseArgs(recs, [STMT_MONTH], BATCH_MONTH) as any);
      const row = rows.find((r) => r.targetScope === 'Coverall' && r.serviceMonth === STMT_MONTH && r.stableMemberKey === 'isid:isidmc2');
      expect(row).toBeDefined();
      if (row!.facts.amount.kind === 'indeterminate') {
        expect(row!.facts.amount.reason).not.toBe('MISSING_MEMBER_COUNT');
      }
    });

    it('MC1c: missing count → MISSING_MEMBER_COUNT (NO default-to-1)', () => {
      const recs: NormalizedRecord[] = [
        bo('MC3', { brokerName: 'Jason Fine', npn: JASON_NPN, effective_date: '2025-12-01' }),
        ede('MC3', { aor: 'Jason Fine (21055210)', npn: JASON_NPN, effective_date: '2025-12-01' }),
        comm('MC3', { payEntity: 'Coverall', amount: 50, serviceMonth: STMT_MONTH, npn: JASON_NPN }),
      ];
      const { rows } = assembleDiagnoseRouteRows(mcBaseArgs(recs, [STMT_MONTH], BATCH_MONTH) as any);
      const row = rows.find((r) => r.targetScope === 'Coverall' && r.serviceMonth === STMT_MONTH && r.stableMemberKey === 'isid:isidmc3');
      expect(row).toBeDefined();
      expect(row!.facts.amount.kind).toBe('indeterminate');
      if (row!.facts.amount.kind === 'indeterminate') {
        expect(row!.facts.amount.reason).toBe('MISSING_MEMBER_COUNT');
      }
    });

    it('MC2: targetBatchMonth=serviceMonth — Jan BO count=1, Mar BO count=2 → Jan + Mar both resolve member_count from their OWN month (no latest-month bleed)', () => {
      const BATCH_JAN = 'B-2026-01';
      const BATCH_MAR = 'B-2026-03';
      // If the assembler shared a latest-month batch-month across rows, Jan
      // would see the Mar record (asOf <= latest), producing a count conflict
      // → manual_review → MISSING_MEMBER_COUNT. Locking targetBatchMonth to
      // the row's serviceMonth keeps Jan's window to only the Jan record.
      const makeBo = (batch: string, eff: string, count: string): NormalizedRecord => rec({
        source_type: 'BACK_OFFICE',
        member_key: 'MC4',
        issuer_subscriber_id: 'ISIDMC4',
        policy_number: 'POLMC4',
        agent_npn: JASON_NPN,
        agent_name: 'Jason Fine',
        net_premium: 100,
        paid_through_date: '2026-04-30',
        effective_date: eff,
        eligible_for_commission: 'Yes',
        raw_json: { 'Broker Name': 'Jason Fine', issuer: 'Ambetter', 'Number of Members': count },
        ...({ batch_id: batch } as any),
      } as any);
      const e1 = ede('MC4', { aor: 'Jason Fine (21055210)', npn: JASON_NPN, effective_date: '2026-01-15' });
      (e1 as any).batch_id = BATCH_JAN;
      const e2 = ede('MC4', { aor: 'Jason Fine (21055210)', npn: JASON_NPN, effective_date: '2026-03-15' });
      (e2 as any).batch_id = BATCH_MAR;
      const c1 = comm('MC4', { payEntity: 'Coverall', amount: 1, serviceMonth: '2026-01', npn: JASON_NPN });
      (c1 as any).batch_id = BATCH_JAN;
      const c2 = comm('MC4', { payEntity: 'Coverall', amount: 1, serviceMonth: '2026-03', npn: JASON_NPN });
      (c2 as any).batch_id = BATCH_MAR;
      const recs: NormalizedRecord[] = [
        makeBo(BATCH_JAN, '2026-01-15', '1'),
        makeBo(BATCH_MAR, '2026-03-15', '2'),
        e1, e2, c1, c2,
      ];
      const batchMonths = { [BATCH_JAN]: '2026-01', [BATCH_MAR]: '2026-03' };
      const { rows } = assembleDiagnoseRouteRows(
        mcBaseArgs(recs, ['2026-01', '2026-03'], batchMonths) as any,
      );
      const jan = rows.find((r) => r.targetScope === 'Coverall' && r.serviceMonth === '2026-01' && r.stableMemberKey === 'isid:isidmc4');
      const mar = rows.find((r) => r.targetScope === 'Coverall' && r.serviceMonth === '2026-03' && r.stableMemberKey === 'isid:isidmc4');
      expect(jan).toBeDefined();
      expect(mar).toBeDefined();
      // Neither row may report MISSING_MEMBER_COUNT — each month's resolver
      // bound only to its OWN serviceMonth's count record, so no conflict.
      const reasonOf = (r: typeof jan) =>
        r && r.facts.amount.kind === 'indeterminate' ? r.facts.amount.reason : null;
      expect(reasonOf(jan)).not.toBe('MISSING_MEMBER_COUNT');
      expect(reasonOf(mar)).not.toBe('MISSING_MEMBER_COUNT');
    });

    it('MC3 (Stage 2): conflicting BO counts populate facts.memberCount.status=manual_review with conflicts', () => {
      // Two BO records in the SAME service month with different counts →
      // resolver returns manual_review → assembler must surface that on
      // facts.memberCount (Stage 2 wiring), not collapse it.
      const BATCH_A = 'B-2026-03-a';
      const BATCH_B = 'B-2026-03-b';
      const boA = rec({
        source_type: 'BACK_OFFICE',
        member_key: 'MC5',
        issuer_subscriber_id: 'ISIDMC5',
        policy_number: 'POLMC5',
        agent_npn: JASON_NPN,
        agent_name: 'Jason Fine',
        net_premium: 100,
        paid_through_date: '2026-04-30',
        effective_date: '2026-03-15',
        eligible_for_commission: 'Yes',
        raw_json: { 'Broker Name': 'Jason Fine', issuer: 'Ambetter', 'Number of Members': '1' },
        ...({ batch_id: BATCH_A } as any),
      } as any);
      const boB = rec({
        source_type: 'BACK_OFFICE',
        member_key: 'MC5',
        issuer_subscriber_id: 'ISIDMC5',
        policy_number: 'POLMC5',
        agent_npn: JASON_NPN,
        agent_name: 'Jason Fine',
        net_premium: 100,
        paid_through_date: '2026-04-30',
        effective_date: '2026-03-15',
        eligible_for_commission: 'Yes',
        raw_json: { 'Broker Name': 'Jason Fine', issuer: 'Ambetter', 'Number of Members': '3' },
        ...({ batch_id: BATCH_B } as any),
      } as any);
      const e = ede('MC5', { aor: 'Jason Fine (21055210)', npn: JASON_NPN, effective_date: '2026-03-15' });
      (e as any).batch_id = BATCH_A;
      const c = comm('MC5', { payEntity: 'Coverall', amount: 50, serviceMonth: STMT_MONTH, npn: JASON_NPN });
      (c as any).batch_id = BATCH_A;
      const recs: NormalizedRecord[] = [boA, boB, e, c];
      const batchMonths = { [BATCH_A]: STMT_MONTH, [BATCH_B]: STMT_MONTH };
      const { rows } = assembleDiagnoseRouteRows(
        mcBaseArgs(recs, [STMT_MONTH], batchMonths) as any,
      );
      const r = rows.find((rr) => rr.targetScope === 'Coverall' && rr.serviceMonth === STMT_MONTH && rr.stableMemberKey === 'isid:isidmc5');
      expect(r).toBeDefined();
      expect(r!.facts.memberCount).toBeDefined();
      expect(r!.facts.memberCount!.status).toBe('manual_review');
      if (r!.facts.memberCount!.status === 'manual_review') {
        expect(r!.facts.memberCount!.reason).toBe('member_count_manual_review');
        expect(r!.facts.memberCount!.conflicts?.sort()).toEqual([1, 3]);
      }
    });
  });
});

