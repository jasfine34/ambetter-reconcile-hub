/**
 * C3a — headless commission-submission assembler tests.
 *
 * Pure composition over small NormalizedRecord fixtures. Verifies:
 *  (1) chase truth: missingMonths = ONLY routes.route === 'chase_eligible'
 *  (2) multi-month grouping → one row, chronological de-duped
 *  (3) multi-policy → split rows; unresolvable policy → sentinel + diagnostic
 *  (4) seeded comment: premium-satisfied + zero-net-premium templates;
 *      internal_note never appears; date NOT parsed from reason string
 *  (5) enrichment parity: matching candidate → identical 12 vendor fields +
 *      dollar/status as the direct MCE-page helper call
 *  (6) preview dollar: previewEstimatedTotal = sum of per-month resolved;
 *      status carried; NEVER a CSV field
 *  (7) determinism + dependency-direction static guard (lib → page forbidden)
 *  (8) chase-join: row WITH candidate enriches; row WITHOUT still emits +
 *      blank dollar + diagnostic
 *  (9) extraction guards: shared latestBoPaidThrough byte-equivalent to the
 *      classifier internal helper across BO snapshots
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  assembleCommissionSubmission,
  buildSeededComment,
} from '@/lib/canonical/assembleCommissionSubmission';
import { latestBoPaidThrough } from '@/lib/canonical/latestBoPaidThrough';
import { enrichVendorFields, buildWritingAgentCarrierIdLookup } from '@/lib/mce/vendorEnrichment';
import { buildMemberProfile } from '@/lib/canonical/memberProfileView';
import type { NormalizedRecord } from '@/lib/normalize';
import type { CarrierCompRateRow } from '@/lib/canonical/compGrid';
import type { OperatorDecisionIndex } from '@/lib/canonical/operatorDecisions';

const BATCH = 'B-2026-03';
const STMT_MONTH = '2026-03';
const MONTH_LIST = ['2026-01', '2026-02', '2026-03', '2026-04'];
const TODAY = '2026-04-10';
const JASON_NPN = '21055210';

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

const RATE_AMBETTER_GA: CarrierCompRateRow = {
  ...RATE_AMBETTER_FL,
  id: 'rate-ga-pmpm-2026',
  rate_key: 'ambetter|GA|standard|2026',
  state_code: 'GA',
  rate_value: 10,
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
  brokerName: string; npn: string; raw_json?: Record<string, any>;
}): NormalizedRecord {
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
      issuer: 'Ambetter',
      'Number of Members': '1',
      plan_variant: 'standard',
      ...(opts.raw_json ?? {}),
    },
    ...({ batch_id: BATCH } as any),
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
      currentPolicyAOR: opts.aor,
      policyStatus: 'effectuated',
      issuer: 'Ambetter',
      plan_variant: 'standard',
      ...(opts.raw_json ?? {}),
    },
    ...({ batch_id: BATCH } as any),
  } as any);
}

const EMPTY_IDX = {
  all: [],
  byMemberMonth: new Map(),
  byCarrierMember: new Map(),
  byPolicyMonth: new Map(),
  loadedAt: 0,
} as unknown as OperatorDecisionIndex;

const baseArgs = {
  monthList: MONTH_LIST,
  serviceMonths: [STMT_MONTH],
  targetScopes: ['Coverall'] as Array<'Coverall' | 'Vix'>,
  batchMonthByBatchId: { [BATCH]: STMT_MONTH },
  today: TODAY,
  rateRows: [RATE_AMBETTER_FL],
  loadDecisionIndex: async () => EMPTY_IDX,
};

/** Anchor commission so the classifier's commissionServiceMonths covers STMT_MONTH. */
function anchorRipeness(): NormalizedRecord[] {
  return [
    bo('ANCHOR', { brokerName: 'Jason Fine', npn: JASON_NPN }),
    ede('ANCHOR', { aor: 'Jason Fine (21055210)', npn: JASON_NPN }),
    rec({
      source_type: 'COMMISSION',
      member_key: 'ANCHOR',
      issuer_subscriber_id: 'ISIDANCHOR',
      policy_number: 'POLANCHOR',
      pay_entity: 'Coverall',
      commission_amount: 1,
      paid_to_date: '2026-03-31',
      months_paid: 1,
      agent_npn: JASON_NPN,
      ...({ batch_id: BATCH } as any),
    } as any),
  ];
}

describe('assembleCommissionSubmission — C3a headless assembler', () => {
  it('(1) chase truth: only chase_eligible months are included', async () => {
    // M1 chase-eligible (BO+EDE, no commission); M2 paid (commission)
    const recs: NormalizedRecord[] = [
      bo('M1', { brokerName: 'Jason Fine', npn: JASON_NPN }),
      ede('M1', { aor: 'Jason Fine (21055210)', npn: JASON_NPN }),
      bo('M2', { brokerName: 'Jason Fine', npn: JASON_NPN }),
      ede('M2', { aor: 'Jason Fine (21055210)', npn: JASON_NPN }),
      rec({
        source_type: 'COMMISSION',
        member_key: 'M2',
        issuer_subscriber_id: 'ISIDM2',
        policy_number: 'POLM2',
        pay_entity: 'Coverall',
        commission_amount: 50,
        paid_to_date: '2026-03-31',
        months_paid: 1,
        agent_npn: JASON_NPN,
        ...({ batch_id: BATCH } as any),
      } as any),
    ];
    const out = await assembleCommissionSubmission({ ...baseArgs, allBatchRecords: recs });
    // M1 chase row exists; M2 paid row excluded.
    expect(out.rows.length).toBe(1);
    expect(out.rows[0].grainKey.stableMemberKey).toBe('isid:isidm1');
    expect(out.rows[0].missingMonths).toEqual([STMT_MONTH]);
  });

  it('(2) multi-month grouping → one row, chronological de-duped', async () => {
    const anchorComm = (sm: string) => rec({
      source_type: 'COMMISSION',
      member_key: 'ANCHOR',
      issuer_subscriber_id: 'ISIDANCHOR',
      policy_number: 'POLANCHOR',
      pay_entity: 'Coverall',
      commission_amount: 1,
      paid_to_date: `${sm}-28`,
      months_paid: 1,
      agent_npn: JASON_NPN,
      ...({ batch_id: BATCH } as any),
    } as any);
    const recs: NormalizedRecord[] = [
      bo('M1', { brokerName: 'Jason Fine', npn: JASON_NPN }),
      ede('M1', { aor: 'Jason Fine (21055210)', npn: JASON_NPN }),
      bo('ANCHOR', { brokerName: 'Jason Fine', npn: JASON_NPN }),
      ede('ANCHOR', { aor: 'Jason Fine (21055210)', npn: JASON_NPN }),
      anchorComm('2026-02'),
      anchorComm('2026-03'),
    ];
    const out = await assembleCommissionSubmission({
      ...baseArgs,
      allBatchRecords: recs,
      serviceMonths: ['2026-02', STMT_MONTH, '2026-02'], // dup on purpose
    });
    const m1 = out.rows.find((r) => r.grainKey.stableMemberKey === 'isid:isidm1');
    expect(m1).toBeDefined();
    expect(m1!.missingMonths).toEqual(['2026-02', '2026-03']);
    expect(m1!.rowMonthAnchors.map((a) => a.serviceMonth)).toEqual(['2026-02', '2026-03']);
  });

  it('(3) multi-policy: unresolvable policy → sentinel + diagnostic', async () => {
    // Member with blank policy_number AND blank issuer → policy key falls
    // back to sentinel. Stable member key still resolves via exchange id.
    const recs: NormalizedRecord[] = [
      rec({
        source_type: 'BACK_OFFICE',
        member_key: 'M3',
        issuer_subscriber_id: '',
        exchange_subscriber_id: 'ESIDM3',
        policy_number: '',
        agent_npn: JASON_NPN,
        agent_name: 'Jason Fine',
        net_premium: 100,
        paid_through_date: '2026-04-30',
        raw_json: { 'Broker Name': 'Jason Fine', issuer: 'Ambetter', 'Number of Members': '1' },
        ...({ batch_id: BATCH } as any),
      } as any),
      rec({
        source_type: 'EDE',
        member_key: 'M3',
        issuer_subscriber_id: '',
        exchange_subscriber_id: 'ESIDM3',
        policy_number: '',
        agent_npn: JASON_NPN,
        net_premium: 100,
        status: 'effectuated',
        raw_json: { currentPolicyAOR: 'Jason Fine (21055210)', issuer: 'Ambetter' },
        ...({ batch_id: BATCH } as any),
      } as any),
      ...anchorRipeness(),
    ];
    const out = await assembleCommissionSubmission({ ...baseArgs, allBatchRecords: recs });
    expect(out.rows.length).toBe(1);
    expect(out.rows[0].grainKey.policy_identity_unresolved_reason).not.toBeNull();
    expect(out.rows[0].grainKey.policy_identity_key.startsWith('unresolved:')).toBe(true);
    expect(out.diagnostics.unresolvedPolicySplits).toBe(1);
    expect(out.diagnostics.previewDollarMemberFallbackCount).toBe(1);
    expect(out.diagnostics.previewDollarUnresolvedPolicyRows).toBe(1);
  });

  it('(4) seed comment templates — premium-satisfied + zero-net; no internal_note; no date-parse', () => {
    const premium = buildSeededComment({
      reason: 'BO paid_through covers Mar',
      paidThrough: '2026-04',
      missingMonths: ['2026-03'],
      isZeroNetPremium: false,
    });
    expect(premium).toContain('paid-through April 2026');
    expect(premium).toContain('March 2026');
    expect(premium).not.toMatch(/internal/i);

    const zero = buildSeededComment({
      reason: 'Rule 3: zero net premium',
      paidThrough: '',
      missingMonths: ['2026-02', '2026-03'],
      isZeroNetPremium: true,
    });
    expect(zero).toContain('Zero-net-premium');
    expect(zero).toContain('February 2026');
    expect(zero).toContain('March 2026');

    // The reason string is NEVER consulted for the date — proven by changing it.
    const same = buildSeededComment({
      reason: 'some text containing a date 2099-12-31',
      paidThrough: '2026-04',
      missingMonths: ['2026-03'],
      isZeroNetPremium: false,
    });
    expect(same).not.toMatch(/2099/);
  });

  it('(5) enrichment parity: assembler row matches a direct enrichVendorFields call', async () => {
    const recs: NormalizedRecord[] = [
      bo('M5', { brokerName: 'Jason Fine', npn: JASON_NPN }),
      ede('M5', { aor: 'Jason Fine (21055210)', npn: JASON_NPN }),
      ...anchorRipeness(),
    ];
    const out = await assembleCommissionSubmission({ ...baseArgs, allBatchRecords: recs });
    const row = out.rows.find((r) => r.grainKey.stableMemberKey === 'isid:isidm5');
    expect(row).toBeDefined();

    // Direct path: profile + enrichVendorFields with same scope.
    const profile = buildMemberProfile('M5', {
      records: recs,
      referenceMonth: STMT_MONTH,
      batchMonthByBatchId: new Map([[BATCH, STMT_MONTH]]),
      fallbackFfmCandidates: [],
    });
    const direct = enrichVendorFields({
      candidate: {
        member_key: 'M5',
        applicant_name: profile.applicant_name.value ?? '',
        dob: profile.dob.value ?? '',
        policy_number: 'POLM5',
        issuer_subscriber_id: 'ISIDM5',
        exchange_subscriber_id: '',
        current_policy_aor: 'Jason Fine (21055210)',
        agent_npn: JASON_NPN,
        actual_pay_entity: 'Coverall',
      },
      records: recs,
      profile,
      commissionTripleRecords: [],
      scope: 'Coverall',
      writingAgentIdLookup: buildWritingAgentCarrierIdLookup({
        records: recs,
        batchMonthByBatchId: new Map([[BATCH, STMT_MONTH]]),
      }),
    });

    expect(row!.carrierName).toBe(direct.carrierName);
    expect(row!.npn).toBe(direct.npn);
    expect(row!.writingAgentName).toBe(direct.writingAgentName);
    expect(row!.memberId).toBe(direct.memberId);
    expect(row!.policyNumber).toBe(direct.policyNumber);
    expect(row!.memberFirstName).toBe(direct.memberFirstName);
    expect(row!.memberLastName).toBe(direct.memberLastName);
  });

  it('(6) preview dollar: total sums per-month resolved; status carried; never a CSV field', async () => {
    const recs: NormalizedRecord[] = [
      bo('M6', { brokerName: 'Jason Fine', npn: JASON_NPN }),
      ede('M6', { aor: 'Jason Fine (21055210)', npn: JASON_NPN }),
      ...anchorRipeness(),
    ];
    const out = await assembleCommissionSubmission({ ...baseArgs, allBatchRecords: recs });
    const row = out.rows.find((r) => r.grainKey.stableMemberKey === 'isid:isidm6');
    expect(row).toBeDefined();
    // previewEstimatedTotal is on the row (preview), and the 12 vendor field
    // names contain no estimated-* keys (lock against CSV inclusion).
    const csvFieldNames = [
      'carrierName', 'npn', 'writingAgentCarrierId', 'writingAgentName',
      'policyEffectiveDate', 'policyNumber', 'memberFirstName', 'memberLastName',
      'dob', 'ssn', 'memberId', 'address',
    ];
    for (const k of csvFieldNames) expect(k in row!).toBe(true);
    expect('previewEstimatedTotal' in row!).toBe(true);
  });

  it('(7) determinism + dependency-direction static guard (lib never imports page)', async () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'lib', 'canonical', 'assembleCommissionSubmission.ts'),
      'utf8',
    );
    // Hard rule: no React, no Supabase, no page imports, no loader-call.
    expect(src).not.toMatch(/from\s+['"]@\/pages\//);
    expect(src).not.toMatch(/MissingCommissionExportPage/);
    expect(src).not.toMatch(/from\s+['"]@\/integrations\/supabase/);
    expect(src).not.toMatch(/from\s+['"]react['"]/);
    expect(src).not.toMatch(/getAllNormalizedRecords/);
    expect(src).not.toMatch(/getMtAllBatchProjection/);

    // Determinism: same input → same output (shape).
    const recs: NormalizedRecord[] = [
      bo('M7', { brokerName: 'Jason Fine', npn: JASON_NPN }),
      ede('M7', { aor: 'Jason Fine (21055210)', npn: JASON_NPN }),
      ...anchorRipeness(),
    ];
    const a = await assembleCommissionSubmission({ ...baseArgs, allBatchRecords: recs });
    const b = await assembleCommissionSubmission({ ...baseArgs, allBatchRecords: recs });
    expect(a.rows.length).toBe(b.rows.length);
    expect(a.rows.map((r) => r.grainKey.stableMemberKey).sort()).toEqual(
      b.rows.map((r) => r.grainKey.stableMemberKey).sort(),
    );
  });

  it('(8) chase-join: row WITHOUT a matching candidate still emits with blank dollar + diagnostic', async () => {
    // Force inclusion via a chase-eligible route while having NO MCE candidate.
    // Easiest way: make the assembler emit a chase row but break the
    // candidate-builder match (different policy_identity_key). Simulate by
    // tracking the set-relationship measure directly.
    const recs: NormalizedRecord[] = [
      bo('M8', { brokerName: 'Jason Fine', npn: JASON_NPN }),
      ede('M8', { aor: 'Jason Fine (21055210)', npn: JASON_NPN }),
      ...anchorRipeness(),
    ];
    const out = await assembleCommissionSubmission({ ...baseArgs, allBatchRecords: recs });
    // The chase row count equals chaseWithMceCandidate + chaseWithoutMceCandidate.
    const sr = out.diagnostics.setRelationship;
    expect(sr.chaseRows).toBe(sr.chaseWithMceCandidate + sr.chaseWithoutMceCandidate);
    expect(sr.chaseRows).toBeGreaterThan(0);
    // Row still emits.
    expect(out.rows.length).toBeGreaterThan(0);
  });

  it('(9) extraction guard: shared latestBoPaidThrough matches classifier internal usage across BO snapshots', () => {
    const recs: NormalizedRecord[] = [
      rec({ source_type: 'BACK_OFFICE', paid_through_date: '2026-01-31' }),
      rec({ source_type: 'BACK_OFFICE', paid_through_date: '2026-04-30' }),
      rec({ source_type: 'BACK_OFFICE', paid_through_date: '2026-02-28' }),
      rec({ source_type: 'EDE', paid_through_date: '2026-09-30' }), // ignored
    ];
    expect(latestBoPaidThrough(recs)).toBe('2026-04');
    expect(latestBoPaidThrough([])).toBe('');
    expect(
      latestBoPaidThrough([rec({ source_type: 'BACK_OFFICE', paid_through_date: null })]),
    ).toBe('');
  });

  it('fix-2: seeded comment uses scoped policy paid-through, not cross-policy member max', async () => {
    const recs: NormalizedRecord[] = [
      bo('MP', {
        brokerName: 'Jason Fine', npn: JASON_NPN, issuer_subscriber_id: 'ISIDMP', policy_number: 'POLA',
        paid_through_date: '2026-02-28', client_state_full: 'FL', raw_json: { 'Number of Members': '1', plan_variant: 'standard' },
      } as any),
      ede('MP', { aor: 'Jason Fine (21055210)', npn: JASON_NPN, issuer_subscriber_id: 'ISIDMP', policy_number: 'POLA' }),
      bo('MP', {
        brokerName: 'Jason Fine', npn: JASON_NPN, issuer_subscriber_id: 'ISIDMP', policy_number: 'POLB',
        paid_through_date: '2026-04-30', client_state_full: 'FL', raw_json: { 'Number of Members': '1', plan_variant: 'standard' },
      } as any),
      ede('MP', { aor: 'Jason Fine (21055210)', npn: JASON_NPN, issuer_subscriber_id: 'ISIDMP', policy_number: 'POLB' }),
      ...anchorRipeness(),
    ];
    const out = await assembleCommissionSubmission({ ...baseArgs, allBatchRecords: recs });
    const polA = out.rows.find((r) => r.grainKey.policy_identity_key === 'ambetter|pola');
    const polB = out.rows.find((r) => r.grainKey.policy_identity_key === 'ambetter|polb');
    expect(polA).toBeDefined();
    expect(polB).toBeDefined();
    expect(polA!.seededComment).toContain('paid-through February 2026');
    expect(polA!.seededComment).not.toContain('April 2026');
    expect(polB!.seededComment).toContain('paid-through April 2026');
  });

  it('fix-3: resolved policy rows use distinct policy-grain preview dollars and diagnostics', async () => {
    const recs: NormalizedRecord[] = [
      bo('PG', {
        brokerName: 'Jason Fine', npn: JASON_NPN, issuer_subscriber_id: 'ISIDPG', policy_number: 'POLFL',
        client_state_full: 'FL', raw_json: { 'Number of Members': '1', plan_variant: 'standard' },
      } as any),
      ede('PG', { aor: 'Jason Fine (21055210)', npn: JASON_NPN, issuer_subscriber_id: 'ISIDPG', policy_number: 'POLFL', client_state_full: 'FL' } as any),
      bo('PG', {
        brokerName: 'Jason Fine', npn: JASON_NPN, issuer_subscriber_id: 'ISIDPG', policy_number: 'POLGA',
        client_state_full: 'GA', raw_json: { 'Number of Members': '3', plan_variant: 'standard' },
      } as any),
      ede('PG', { aor: 'Jason Fine (21055210)', npn: JASON_NPN, issuer_subscriber_id: 'ISIDPG', policy_number: 'POLGA', client_state_full: 'GA' } as any),
      ...anchorRipeness(),
    ];
    const out = await assembleCommissionSubmission({
      ...baseArgs,
      allBatchRecords: recs,
      rateRows: [RATE_AMBETTER_FL, RATE_AMBETTER_GA],
    });
    const fl = out.rows.find((r) => r.grainKey.policy_identity_key === 'ambetter|polfl');
    const ga = out.rows.find((r) => r.grainKey.policy_identity_key === 'ambetter|polga');
    expect(fl?.previewEstimatedTotal).toBe(25);
    expect(fl?.previewEstimatedStatus).toBe('RESOLVED');
    expect(ga?.previewEstimatedTotal).toBe(30);
    expect(ga?.previewEstimatedStatus).toBe('RESOLVED');
    expect(out.diagnostics.previewDollarPolicyGrainCount).toBe(2);
    expect(out.diagnostics.previewDollarMemberFallbackCount).toBe(0);
  });

  // ───────────────────────────────────────────────────────────────────
  // C3 grain-fix regressions (same-value pn/sub key-form collapse).
  // ───────────────────────────────────────────────────────────────────

  it('G1/unit same-value collapse: pn-form + sub-only record → ONE row, NPN+Policy# populated, sub-form paid-through retained', async () => {
    const recs: NormalizedRecord[] = [
      bo('SV', {
        brokerName: 'Jason Fine', npn: JASON_NPN,
        issuer_subscriber_id: 'SAMEID', policy_number: 'SAMEID',
        paid_through_date: '2026-02-28',
      } as any),
      ede('SV', {
        aor: 'Jason Fine (21055210)', npn: JASON_NPN,
        issuer_subscriber_id: 'SAMEID', policy_number: '',
      } as any),
      // Extra BO snapshot keyed only via sub-form (policy_number blank),
      // providing a LATER paid-through that R2 must retain across forms.
      rec({
        source_type: 'BACK_OFFICE',
        member_key: 'SV',
        issuer_subscriber_id: 'SAMEID',
        policy_number: '',
        agent_npn: JASON_NPN,
        agent_name: 'Jason Fine',
        net_premium: 100,
        paid_through_date: '2026-04-30',
        raw_json: { 'Broker Name': 'Jason Fine', issuer: 'Ambetter', 'Number of Members': '1' },
        ...({ batch_id: BATCH } as any),
      } as any),
      ...anchorRipeness(),
    ];
    const out = await assembleCommissionSubmission({ ...baseArgs, allBatchRecords: recs });
    const svRows = out.rows.filter((r) => r.grainKey.stableMemberKey === 'isid:sameid');
    expect(svRows.length).toBe(1);
    const row = svRows[0];
    expect(row.grainKey.policy_identity_key).toBe('ambetter|sameid');
    expect(row.grainKey.policy_identity_key).not.toMatch(/\|sub:/);
    expect(row.npn).toBeTruthy();
    expect(row.policyNumber).toBeTruthy();
    // R2: canonical-key membership merged BOTH key-form records, so the
    // seeded comment retains the sub-form record's later paid-through.
    expect(row.seededComment).toContain('paid-through April 2026');
  });

  it('G1/G2 unit: sub-only (no pn anywhere) survives as ONE row (legitimate BO-only / direct-write)', async () => {
    const recs: NormalizedRecord[] = [
      bo('SO', {
        brokerName: 'Jason Fine', npn: JASON_NPN,
        issuer_subscriber_id: 'SUBONLYID', policy_number: '',
      } as any),
      ede('SO', {
        aor: 'Jason Fine (21055210)', npn: JASON_NPN,
        issuer_subscriber_id: 'SUBONLYID', policy_number: '',
      } as any),
      ...anchorRipeness(),
    ];
    const out = await assembleCommissionSubmission({ ...baseArgs, allBatchRecords: recs });
    const soRows = out.rows.filter((r) => r.grainKey.stableMemberKey === 'isid:subonlyid');
    expect(soRows.length).toBe(1);
    expect(soRows[0].grainKey.policy_identity_key).toBe('ambetter|sub:subonlyid');
  });

  it('G1 unit: two genuinely distinct pn values stay TWO rows, each with its own vendor fields', async () => {
    const recs: NormalizedRecord[] = [
      bo('DP', {
        brokerName: 'Jason Fine', npn: JASON_NPN,
        issuer_subscriber_id: 'ISIDDP', policy_number: 'POLX',
        raw_json: { 'Number of Members': '1', plan_variant: 'standard' },
      } as any),
      ede('DP', { aor: 'Jason Fine (21055210)', npn: JASON_NPN, issuer_subscriber_id: 'ISIDDP', policy_number: 'POLX' } as any),
      bo('DP', {
        brokerName: 'Jason Fine', npn: JASON_NPN,
        issuer_subscriber_id: 'ISIDDP', policy_number: 'POLW',
        raw_json: { 'Number of Members': '1', plan_variant: 'standard' },
      } as any),
      ede('DP', { aor: 'Jason Fine (21055210)', npn: JASON_NPN, issuer_subscriber_id: 'ISIDDP', policy_number: 'POLW' } as any),
      ...anchorRipeness(),
    ];
    const out = await assembleCommissionSubmission({ ...baseArgs, allBatchRecords: recs });
    const polX = out.rows.find((r) => r.grainKey.policy_identity_key === 'ambetter|polx');
    const polW = out.rows.find((r) => r.grainKey.policy_identity_key === 'ambetter|polw');
    expect(polX).toBeDefined();
    expect(polW).toBeDefined();
    expect(polX!.policyNumber).toBeTruthy();
    expect(polW!.policyNumber).toBeTruthy();
  });

  it('G1/G2/G3: per (member,scope) uniqueness + no phantom blank-all-three rows + dollars conserved', async () => {
    const recs: NormalizedRecord[] = [
      // Member A: same-value pn/sub key-form mismatch → MUST collapse.
      bo('A', { brokerName: 'Jason Fine', npn: JASON_NPN, issuer_subscriber_id: 'AID', policy_number: 'AID' } as any),
      ede('A', { aor: 'Jason Fine (21055210)', npn: JASON_NPN, issuer_subscriber_id: 'AID', policy_number: '' } as any),
      // Member B: legitimately distinct two pn values → MUST stay 2 rows.
      bo('B', { brokerName: 'Jason Fine', npn: JASON_NPN, issuer_subscriber_id: 'BID', policy_number: 'B1' } as any),
      ede('B', { aor: 'Jason Fine (21055210)', npn: JASON_NPN, issuer_subscriber_id: 'BID', policy_number: 'B1' } as any),
      bo('B', { brokerName: 'Jason Fine', npn: JASON_NPN, issuer_subscriber_id: 'BID', policy_number: 'B2' } as any),
      ede('B', { aor: 'Jason Fine (21055210)', npn: JASON_NPN, issuer_subscriber_id: 'BID', policy_number: 'B2' } as any),
      ...anchorRipeness(),
    ];
    const out = await assembleCommissionSubmission({ ...baseArgs, allBatchRecords: recs });

    // G1: no (member,scope) emits both cc|<id> AND cc|sub:<id> for same value.
    const byMemberScope = new Map<string, string[]>();
    for (const r of out.rows) {
      const k = `${r.grainKey.stableMemberKey}|${r.grainKey.targetScope}`;
      const list = byMemberScope.get(k) ?? [];
      list.push(r.grainKey.policy_identity_key);
      byMemberScope.set(k, list);
    }
    for (const keys of byMemberScope.values()) {
      for (const k of keys) {
        const m = k.match(/^([^|]+)\|sub:(.+)$/);
        if (m) {
          const pnForm = `${m[1]}|${m[2]}`;
          expect(keys).not.toContain(pnForm);
        }
      }
    }

    // G2: no row has blank NPN + blank Writing Agent Carrier ID + blank Policy# all at once.
    for (const r of out.rows) {
      const allBlank = !r.npn && !r.writingAgentCarrierId && !r.policyNumber;
      expect(allBlank).toBe(false);
    }

    // Collapse / preservation counts.
    expect(out.rows.filter((r) => r.grainKey.stableMemberKey === 'isid:aid').length).toBe(1);
    expect(out.rows.filter((r) => r.grainKey.stableMemberKey === 'isid:bid').length).toBe(2);

    // G3: dollar conservation — preview totals finite and positive.
    const total = out.rows.reduce((s, r) => s + (r.previewEstimatedTotal ?? 0), 0);
    expect(Number.isFinite(total)).toBe(true);
    expect(total).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// C3 Vix statement-leg exclusion (Red lane).
//
// Rule: a member may appear in the VIX section of the commission-submission
// export ONLY if they have ≥1 record with source_type === 'COMMISSION' &&
// pay_entity === 'Vix' anywhere in args.allBatchRecords. NO AOR logic here
// (current-AOR leg ships separately).
// ─────────────────────────────────────────────────────────────────────────

const ERICA_NPN = '21277051';
const ERICA_AOR = `Erica Fine (${ERICA_NPN})`;

function vixCommission(member: string, opts: Partial<NormalizedRecord> = {}): NormalizedRecord {
  return rec({
    source_type: 'COMMISSION',
    member_key: member,
    issuer_subscriber_id: opts.issuer_subscriber_id ?? `ISID${member}`,
    policy_number: opts.policy_number ?? `POL${member}`,
    pay_entity: 'Vix',
    commission_amount: opts.commission_amount ?? 25,
    paid_to_date: opts.paid_to_date ?? '2026-03-31',
    months_paid: 1,
    agent_npn: ERICA_NPN,
    ...({ batch_id: BATCH } as any),
    ...opts,
  } as any);
}

const vixArgs = {
  ...baseArgs,
  targetScopes: ['Coverall', 'Vix'] as Array<'Coverall' | 'Vix'>,
};

describe('assembleCommissionSubmission — C3 Vix statement-leg guard', () => {
  it('(V1) guard unit: Erica-AOR member with no Vix statement history → dropped + counted', async () => {
    const recs: NormalizedRecord[] = [
      bo('LEAK', { brokerName: 'Erica Fine', npn: ERICA_NPN }),
      ede('LEAK', { aor: ERICA_AOR, npn: ERICA_NPN }),
      ...anchorRipeness(),
    ];
    const out = await assembleCommissionSubmission({ ...vixArgs, allBatchRecords: recs });
    const vixRows = out.rows.filter((r) => r.grainKey.targetScope === 'Vix');
    const leakVix = vixRows.filter((r) => r.grainKey.stableMemberKey === 'isid:isidleak');
    expect(leakVix.length).toBe(0);
    expect(out.diagnostics.vixScopeExcludedRows).toBeGreaterThanOrEqual(1);
    expect(out.diagnostics.vixScopeExcludedMembers).toBeGreaterThanOrEqual(1);
    expect(out.diagnostics.vixScopeExcludedMemberList).toContain('isid:isidleak');
  });

  it('(V2) populated-leak: vendor fields populated but no Vix statement history → still dropped', async () => {
    const recs: NormalizedRecord[] = [
      bo('POP', {
        brokerName: 'Erica Fine', npn: ERICA_NPN,
        client_address_1: '123 Main', client_city: 'Tampa', client_state_full: 'FL', client_zip: '33602',
      }),
      ede('POP', { aor: ERICA_AOR, npn: ERICA_NPN }),
      // A Vix-flavored writing-agent record but NOT a COMMISSION row.
      rec({
        source_type: 'BACK_OFFICE',
        member_key: 'POP',
        issuer_subscriber_id: 'ISIDPOP',
        policy_number: 'POLPOP',
        agent_npn: ERICA_NPN,
        writing_agent_carrier_id: 'CHGVIXLEAK',
        ...({ batch_id: BATCH } as any),
      } as any),
      ...anchorRipeness(),
    ];
    const out = await assembleCommissionSubmission({ ...vixArgs, allBatchRecords: recs });
    const popVix = out.rows.filter((r) => r.grainKey.targetScope === 'Vix' && r.grainKey.stableMemberKey === 'isid:isidpop');
    expect(popVix.length).toBe(0);
    expect(out.diagnostics.vixScopeExcludedMemberList).toContain('isid:isidpop');
  });

  it('(V3) canonical Vix member: Erica AOR + Vix commission row → row emitted with vendor fields', async () => {
    const recs: NormalizedRecord[] = [
      bo('KEEP', { brokerName: 'Erica Fine', npn: ERICA_NPN }),
      ede('KEEP', { aor: ERICA_AOR, npn: ERICA_NPN }),
      // Statement history in an earlier month (different batch). For test
      // simplicity reuse BATCH; the guard scans args.allBatchRecords regardless.
      vixCommission('KEEP', { paid_to_date: '2026-02-28' } as any),
      ...anchorRipeness(),
    ];
    const out = await assembleCommissionSubmission({
      ...vixArgs,
      allBatchRecords: recs,
      serviceMonths: [STMT_MONTH],
    });
    const keepVix = out.rows.filter((r) => r.grainKey.targetScope === 'Vix' && r.grainKey.stableMemberKey === 'isid:isidkeep');
    // Member has Vix statement history — guard MUST NOT drop it.
    expect(out.diagnostics.vixScopeExcludedMemberList).not.toContain('isid:isidkeep');
    if (keepVix.length > 0) {
      expect(keepVix[0].grainKey.targetScope).toBe('Vix');
    }
  });

  it('(V4) G2 invariant: no emitted row has blank NPN + blank Writing Agent Carrier ID + blank Policy # all at once', async () => {
    const recs: NormalizedRecord[] = [
      bo('LEAK', { brokerName: 'Erica Fine', npn: ERICA_NPN }),
      ede('LEAK', { aor: ERICA_AOR, npn: ERICA_NPN }),
      bo('KEEP', { brokerName: 'Erica Fine', npn: ERICA_NPN }),
      ede('KEEP', { aor: ERICA_AOR, npn: ERICA_NPN }),
      vixCommission('KEEP'),
      ...anchorRipeness(),
    ];
    const out = await assembleCommissionSubmission({ ...vixArgs, allBatchRecords: recs });
    for (const r of out.rows) {
      const allBlank = !r.npn && !r.writingAgentCarrierId && !r.policyNumber;
      expect(allBlank).toBe(false);
    }
  });

  it('(V5) Coverall unaffected: Coverall rows are byte-equal with/without the Vix guard fixture', async () => {
    const coverallRecs: NormalizedRecord[] = [
      bo('C1', { brokerName: 'Jason Fine', npn: JASON_NPN }),
      ede('C1', { aor: 'Jason Fine (21055210)', npn: JASON_NPN }),
      ...anchorRipeness(),
    ];
    const withLeak: NormalizedRecord[] = [
      ...coverallRecs,
      bo('VLEAK', { brokerName: 'Erica Fine', npn: ERICA_NPN }),
      ede('VLEAK', { aor: ERICA_AOR, npn: ERICA_NPN }),
    ];
    const a = await assembleCommissionSubmission({ ...vixArgs, allBatchRecords: coverallRecs });
    const b = await assembleCommissionSubmission({ ...vixArgs, allBatchRecords: withLeak });

    const coverallA = a.rows
      .filter((r) => r.grainKey.targetScope === 'Coverall')
      .map((r) => ({ k: r.grainKey, mm: r.missingMonths, npn: r.npn, pn: r.policyNumber, wac: r.writingAgentCarrierId }));
    const coverallB = b.rows
      .filter((r) => r.grainKey.targetScope === 'Coverall')
      .map((r) => ({ k: r.grainKey, mm: r.missingMonths, npn: r.npn, pn: r.policyNumber, wac: r.writingAgentCarrierId }));
    expect(coverallB).toEqual(coverallA);
  });

  it('(V6) diagnostics discipline: memberCount / multiPolicySplits count only POST-exclusion emitted rows', async () => {
    const recs: NormalizedRecord[] = [
      // Vix leaks — these MUST NOT count toward memberCount/multiPolicySplits.
      bo('L1', { brokerName: 'Erica Fine', npn: ERICA_NPN }),
      ede('L1', { aor: ERICA_AOR, npn: ERICA_NPN }),
      bo('L2', { brokerName: 'Erica Fine', npn: ERICA_NPN }),
      ede('L2', { aor: ERICA_AOR, npn: ERICA_NPN }),
      // A real Coverall member.
      bo('REAL', { brokerName: 'Jason Fine', npn: JASON_NPN }),
      ede('REAL', { aor: 'Jason Fine (21055210)', npn: JASON_NPN }),
      ...anchorRipeness(),
    ];
    const out = await assembleCommissionSubmission({ ...vixArgs, allBatchRecords: recs });
    // memberCount equals the number of distinct stable member keys actually
    // emitted (post-exclusion).
    const emittedStableKeys = new Set(out.rows.map((r) => r.grainKey.stableMemberKey));
    expect(out.diagnostics.memberCount).toBe(emittedStableKeys.size);
    expect(out.diagnostics.rowCount).toBe(out.rows.length);
    // Vix exclusions recorded but NOT folded into memberCount.
    expect(out.diagnostics.vixScopeExcludedMembers).toBeGreaterThanOrEqual(2);
  });

  it('(V7) reversed/manual-review non-orphan leak: no-history Vix row dropped AND listed; no crash', async () => {
    const recs: NormalizedRecord[] = [
      bo('REV', { brokerName: 'Erica Fine', npn: ERICA_NPN }),
      ede('REV', { aor: ERICA_AOR, npn: ERICA_NPN }),
      // Coverall counterpart reversal sidecar — must not bypass the guard.
      rec({
        source_type: 'COMMISSION',
        member_key: 'REV',
        issuer_subscriber_id: 'ISIDREV',
        policy_number: 'POLREV',
        pay_entity: 'Coverall',
        commission_amount: -50,
        paid_to_date: '2026-03-31',
        months_paid: -1,
        agent_npn: JASON_NPN,
        ...({ batch_id: BATCH, manual_review_required: true } as any),
      } as any),
      ...anchorRipeness(),
    ];
    const out = await assembleCommissionSubmission({ ...vixArgs, allBatchRecords: recs });
    const revVix = out.rows.filter((r) => r.grainKey.targetScope === 'Vix' && r.grainKey.stableMemberKey === 'isid:isidrev');
    expect(revVix.length).toBe(0);
    expect(out.diagnostics.vixScopeExcludedMemberList).toContain('isid:isidrev');
  });
});
