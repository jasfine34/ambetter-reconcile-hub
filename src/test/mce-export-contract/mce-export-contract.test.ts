/**
 * MCE Export Contract — Phase B Item 1.
 *
 * Spec: docs/mce-export-contract.md.
 *
 * Assertion-level tests for the five contract invariants:
 *   §7.1 — Vendor CSV column lock (12 R-MCE-002 labels, in order)
 *   §7.2 — Preview retains dollar (INTERNAL_COLUMNS includes
 *          'Est. missing commission'); status is backing field only
 *   §7.3 — Dollar resolves on full evidence → RESOLVED, non-null
 *   §7.4 — Dollar stays UNSUPPORTED when evidence absent (no false positive)
 *   §7.5 — PED uses policy effective date, not broker effective date (AC-3)
 */
import { describe, it, expect } from 'vitest';
import Papa from 'papaparse';
import * as fs from 'fs';
import * as path from 'path';
import {
  buildMesserCsv,
  resolvePolicyEffectiveDate,
  enrichVendorFields,
  resolveMemberId,
  resolveTargetPayEntity,
  resolveWritingAgentCarrierId,
  resolveWritingAgentName,
} from '@/pages/MissingCommissionExportPage';
import { buildMemberProfile, splitNameLastSpace, assembleAddressLine } from '@/lib/canonical/memberProfileView';
import { extractNpnFromAorString } from '@/lib/agents';
import {
  createEstMissingResolver,
  type EstMissingInputEvidence,
} from '@/lib/canonical/estMissingResolver';
import { buildSourceEvidenceMap } from '@/lib/canonical/estMissingEvidenceAdapter';
import type { CarrierCompRateRow } from '@/lib/canonical/compGrid';

const PAGE_SRC = fs.readFileSync(
  path.join(process.cwd(), 'src/pages/MissingCommissionExportPage.tsx'),
  'utf8',
);

// ---------------------------------------------------------------------------
// §7.1 — Vendor CSV column lock
// ---------------------------------------------------------------------------

describe('MCE contract §7.1 — vendor CSV column lock (12 locked R-MCE-002 columns)', () => {
  const EXPECTED_12 = [
    'Carrier Name',
    'NPN',
    'Writing Agent Carrier ID',
    'Writing Agent Name',
    'Policy Effective Date',
    'Policy #',
    'Member First Name',
    'Member Last Name',
    'DOB',
    'SSN',
    'Member ID',
    'Address (Street, City, State, Zip)',
  ];

  it('buildMesserCsv header equals the 12 locked labels in order', () => {
    const csv = buildMesserCsv([]);
    const parsed = Papa.parse(csv.trim(), { header: false });
    expect((parsed.data as string[][])[0]).toEqual(EXPECTED_12);
  });

  it('vendor CSV header does NOT contain "Estimated Missing Commission"', () => {
    const csv = buildMesserCsv([]);
    expect(csv).not.toContain('Estimated Missing Commission');
  });

  it('vendor CSV header does NOT contain "Est_Missing_Status"', () => {
    const csv = buildMesserCsv([]);
    expect(csv).not.toContain('Est_Missing_Status');
  });

  it('MESSER_COLUMNS source block does NOT mention estimatedMissingCommission or estMissingStatus', () => {
    // C3b-2: the page literal is now a derive expression
    // (`BASE_MESSER_COLUMNS_12.map(...)`) terminated by `;`, not by `];`.
    const messerBlock = PAGE_SRC.match(/const MESSER_COLUMNS[\s\S]*?;\r?\n/)?.[0] ?? '';
    expect(messerBlock.length).toBeGreaterThan(0);
    expect(messerBlock).not.toMatch(/estimatedMissingCommission/);
    expect(messerBlock).not.toMatch(/estMissingStatus/);
    expect(messerBlock).not.toMatch(/Estimated Missing Commission/);
    expect(messerBlock).not.toMatch(/Est_Missing_Status/);
  });
});

// ---------------------------------------------------------------------------
// §7.2 — Preview retains the dollar; status is backing-field-only
// ---------------------------------------------------------------------------

describe('MCE contract §7.2 — preview retains Est. missing commission dollar', () => {
  it('INTERNAL_COLUMNS includes _estimatedMissingCommission with label "Est. missing commission"', () => {
    const internalBlock = PAGE_SRC.match(/const INTERNAL_COLUMNS[\s\S]*?\];/)?.[0] ?? '';
    expect(internalBlock).toMatch(
      /_estimatedMissingCommission[\s\S]*Est\. missing commission/,
    );
  });

  it('INTERNAL_COLUMNS does NOT include _estMissingStatus as a standalone preview column', () => {
    const internalBlock = PAGE_SRC.match(/const INTERNAL_COLUMNS[\s\S]*?\];/)?.[0] ?? '';
    expect(internalBlock).not.toMatch(/_estMissingStatus/);
  });

  it('C3a fix-1: row-building path actually calls enrichVendorFields and keeps preview-only fields', () => {
    const buildLoop = PAGE_SRC.match(/for \(const m of missingMembers\)[\s\S]*?allBeforeBucket\.push\(\{[\s\S]*?\}\);/)?.[0] ?? '';
    expect(buildLoop).toMatch(/const\s+vendorFields\s*=\s*enrichVendorFields\(/);
    expect(buildLoop).toMatch(/\.\.\.vendorFields/);
    expect(buildLoop).toMatch(/_memberKey:/);
    expect(buildLoop).toMatch(/_estimatedMissingCommission:\s*estMissing/);
    expect(buildLoop).toMatch(/_estMissingStatus:\s*estMissingStatus/);
  });

  it('C3a fix-1: 12 vendor fields + dollar/status match legacy inline assembly, _ fields retained', () => {
    const records: any[] = [
      {
        id: 'bo-1', source_type: 'BACK_OFFICE', member_key: 'mce-parity', carrier: 'Ambetter',
        applicant_name: 'Ada Lovelace', first_name: 'Ada', last_name: 'Lovelace', dob: '1980-01-02',
        policy_number: 'POL123', issuer_subscriber_id: 'IS123', exchange_subscriber_id: 'EX123',
        agent_name: 'BO Broker', agent_npn: '21055210', effective_date: '2026-01-01',
        client_address_1: '1 Main St', client_city: 'Tampa', client_state_full: 'FL', client_zip: '33602',
        raw_json: { 'Broker Name': 'BO Broker', issuer: 'Ambetter', plan_variant: 'standard' },
        batch_id: 'B-2026-03', writing_agent_carrier_id: '',
      },
      {
        id: 'comm-1', source_type: 'COMMISSION', member_key: 'mce-parity', carrier: 'Ambetter',
        pay_entity: 'Coverall', agent_npn: '21055210', agent_name: 'Commission Agent',
        writing_agent_carrier_id: "'CHG9852", batch_id: 'B-2026-03',
      },
    ];
    const candidate: any = {
      member_key: 'mce-parity', applicant_name: 'Ada Lovelace', dob: '1980-01-02', policy_number: 'POL123',
      issuer_subscriber_id: 'IS123', exchange_subscriber_id: 'EX123', current_policy_aor: 'Jason Fine (21055210)',
      agent_npn: '21055210', expected_pay_entity: 'Coverall', actual_pay_entity: 'Coverall', effective_date: '2026-01-01',
    };
    const profile = buildMemberProfile('mce-parity', {
      records,
      referenceMonth: '2026-03',
      batchMonthByBatchId: new Map([['B-2026-03', '2026-03']]),
      fallbackFfmCandidates: [],
    });
    const lookup = new Map([['ambetter|coverall|21055210', { id: "'CHG9852", conflicts: [] }]]);
    const resolveEstMissing = () => ({ amount: 25, status: 'RESOLVED' as const, evidence: {} as any });
    const helperFields = enrichVendorFields({
      candidate,
      records,
      profile,
      commissionTripleRecords: records,
      scope: 'Coverall',
      writingAgentIdLookup: lookup,
      resolveEstMissing,
    });

    const nameVal = profile.applicant_name.value || candidate.applicant_name || '';
    const { first, last } = splitNameLastSpace(nameVal);
    const aor = String(candidate.current_policy_aor ?? '').trim();
    const npn = extractNpnFromAorString(aor) || String(candidate.agent_npn ?? '').trim();
    const targetPayEntity = resolveTargetPayEntity({
      expectedPayEntity: candidate.expected_pay_entity,
      actualPayEntity: candidate.actual_pay_entity,
      scope: 'Coverall',
      agentNpn: npn,
    });
    const legacyInline = {
      carrierName: 'Ambetter',
      npn,
      writingAgentCarrierId: resolveWritingAgentCarrierId({ records: [...records, ...records], carrier: 'Ambetter', payEntity: targetPayEntity, agentNpn: npn, lookup }),
      writingAgentName: resolveWritingAgentName({ currentPolicyAor: aor, boBrokerName: 'BO Broker', commissionWritingAgentName: 'Commission Agent' }),
      policyEffectiveDate: resolvePolicyEffectiveDate({ records, reconciledEffectiveDate: candidate.effective_date }),
      policyNumber: 'POL123',
      memberFirstName: first,
      memberLastName: last,
      dob: '1980-01-02',
      ssn: '',
      memberId: resolveMemberId({ issuerSubscriberId: 'IS123', policyNumber: 'POL123', exchangeSubscriberId: 'EX123' }),
      address: assembleAddressLine({ address1: profile.address1.value, city: profile.city.value, state: profile.state.value, zip: profile.zip.value }),
      estimatedMissingCommission: 25,
      estMissingStatus: 'RESOLVED',
    };
    expect(helperFields).toEqual(legacyInline);
    expect(buildMesserCsv([{ ...legacyInline, _memberKey: 'mce-parity' } as any])).toBe(
      buildMesserCsv([{ ...helperFields, _memberKey: 'mce-parity' } as any]),
    );
    const pageRow = {
      ...helperFields,
      _memberKey: 'mce-parity',
      _ffmId: profile.ffm_id,
      _exchangeSubscriberId: 'EX123',
      _issuerSubscriberId: 'IS123',
      _aor: aor,
      _netPremiumBucket: 'has_premium',
      _missingReason: 'Missing from Commission',
      _estimatedMissingCommission: helperFields.estimatedMissingCommission,
      _estMissingStatus: helperFields.estMissingStatus,
    };
    expect(pageRow._memberKey).toBe('mce-parity');
    expect(pageRow._estimatedMissingCommission).toBe(25);
    expect(pageRow._estMissingStatus).toBe('RESOLVED');
    expect(pageRow._aor).toBe('Jason Fine (21055210)');
  });
});

// ---------------------------------------------------------------------------
// §7.3 / §7.4 — Resolver behavior driven by adapter-built evidence
// ---------------------------------------------------------------------------

const AMBETTER_FL_RATE_2026: CarrierCompRateRow = {
  id: 'rate-fl-2026',
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

describe('MCE contract §7.3 — full-evidence dollar resolves to RESOLVED', () => {
  it('synthetic missing member with state + member_count + months + policy_year → RESOLVED, non-null amount', () => {
    // Synthetic reconciled-style row enriched with the resolved state +
    // member_count the contract requires (AC-2 wires these in from the
    // normalized BO/EDE evidence via the resolver-record adapters).
    const syntheticRow = {
      member_key: 'mk-full-evidence',
      carrier: 'Ambetter',
      state: 'FL',
      member_count: 2,
      target_service_month: '2026-03',
      plan_variant: 'standard',
      current_policy_aor: 'Jason Fine (21055210)',
      actual_pay_entity: 'Coverall',
      policy_identity_key: 'pik-1',
    };
    const evidenceMap = buildSourceEvidenceMap([syntheticRow]);
    const ev = evidenceMap.get('mk-full-evidence') as EstMissingInputEvidence;
    expect(ev.state).toBe('FL');
    expect(ev.member_count).toBe(2);
    expect(ev.policy_year).toBe(2026);

    const resolver = createEstMissingResolver({
      rateRows: [AMBETTER_FL_RATE_2026],
      batchMonth: '2026-03',
      scope: 'Coverall',
      sourceEvidenceByMemberKey: evidenceMap,
    });
    // Override carrier to canonical lowercase form (rate rows use carrier_key).
    const res = resolver.resolve({
      row: { member_key: 'mk-full-evidence' },
      inputEvidence: { ...ev, carrier: 'ambetter' },
    });
    expect(res.status).toBe('RESOLVED');
    expect(res.amount).not.toBeNull();
    expect(res.amount).toBeGreaterThan(0);
  });
});

describe('MCE contract §7.4 — no-evidence row stays UNSUPPORTED (no false positive)', () => {
  it('row with no state and no member_count → UNSUPPORTED, blank amount', () => {
    const syntheticRow = {
      member_key: 'mk-no-evidence',
      carrier: 'Ambetter',
      state: null,
      member_count: null,
      target_service_month: '2026-03',
      current_policy_aor: 'Jason Fine (21055210)',
      actual_pay_entity: 'Coverall',
    };
    const evidenceMap = buildSourceEvidenceMap([syntheticRow]);
    const resolver = createEstMissingResolver({
      rateRows: [AMBETTER_FL_RATE_2026],
      batchMonth: '2026-03',
      scope: 'Coverall',
      sourceEvidenceByMemberKey: evidenceMap,
    });
    const res = resolver.resolve({ row: { member_key: 'mk-no-evidence' } });
    expect(res.status).toBe('UNSUPPORTED');
    expect(res.amount).toBeNull();
    // Legitimate failure mode — first missing input wins.
    expect(['MISSING_STATE', 'MISSING_MEMBER_COUNT']).toContain(
      res.unsupported_reason,
    );
  });
});

// ---------------------------------------------------------------------------
// §7.5 — Policy Effective Date uses policy date, not broker date
// ---------------------------------------------------------------------------

describe('MCE contract §7.5 / AC-3 — Policy Effective Date precedence', () => {
  it('BO-only row: typed effective_date wins over broker_effective_date AND raw Policy Effective Date', () => {
    const records = [
      {
        source_type: 'BACK_OFFICE',
        effective_date: '2026-01-01',
        broker_effective_date: '2026-02-15',
        raw_json: { 'Policy Effective Date': '1/1/2026' },
      },
    ];
    const eff = resolvePolicyEffectiveDate({ records, reconciledEffectiveDate: null });
    expect(eff).toBe('2026-01-01');
    expect(eff).not.toBe('2026-02-15');
  });

  it('EDE row still wins when both EDE and BO present', () => {
    const records = [
      {
        source_type: 'EDE',
        effective_date: '2026-03-01',
        raw_json: { effectiveDate: '2026-03-01' },
      },
      {
        source_type: 'BACK_OFFICE',
        effective_date: '2026-01-01',
        broker_effective_date: '2026-02-15',
      },
    ];
    const eff = resolvePolicyEffectiveDate({ records, reconciledEffectiveDate: null });
    expect(eff).toBe('2026-03-01');
  });

  it('BO broker_effective_date is last-ditch ONLY (never ahead of typed BO effective_date)', () => {
    const records = [
      {
        source_type: 'BACK_OFFICE',
        effective_date: null,
        broker_effective_date: '2026-02-15',
      },
    ];
    const eff = resolvePolicyEffectiveDate({ records, reconciledEffectiveDate: null });
    expect(eff).toBe('2026-02-15');
  });
});
