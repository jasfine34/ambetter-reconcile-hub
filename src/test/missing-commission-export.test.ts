/**
 * #104 — Best Known Member Profile + Messer export tests.
 *
 * Tests are pure (no React render, no DB). They cover:
 *   1. BO-first walk basics
 *   2. Same-month BO blank → later BO wins
 *   3. Full fallback (BO blank everywhere → EDE)
 *   4. All-blank → value:null source_type:null
 *   5. Conflict detection within a tier
 *   6. Messer column mapping (name split, address assemble, member id ladder)
 *   7. Premium-bucket filtering
 *   8. CSV download — column order matches Messer schema; internals NOT included
 */
import { describe, it, expect } from 'vitest';
import Papa from 'papaparse';
import {
  buildMemberProfile,
  splitNameLastSpace,
  assembleAddressLine,
} from '@/lib/canonical/memberProfileView';
import {
  resolveWritingAgentName,
  resolveMemberId,
  classifyNetPremium,
  buildMesserCsv,
  buildMesserCsvFilename,
  resolvePolicyEffectiveDate,
} from '@/pages/MissingCommissionExportPage';
import type { NormalizedRecord } from '@/lib/normalize';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function blankRecord(overrides: Partial<NormalizedRecord> & {
  id?: string;
  batch_id?: string;
  created_at?: string;
  raw_json?: any;
}): any {
  return {
    id: overrides.id ?? Math.random().toString(36).slice(2),
    batch_id: overrides.batch_id ?? 'b-feb',
    created_at: overrides.created_at ?? '2026-02-15T00:00:00Z',
    source_type: overrides.source_type ?? 'EDE',
    source_file_label: overrides.source_file_label ?? 'EDE Summary',
    carrier: 'Ambetter',
    applicant_name: overrides.applicant_name ?? '',
    first_name: '', last_name: '', dob: overrides.dob ?? null,
    member_id: '', policy_number: '', exchange_subscriber_id: '',
    exchange_policy_id: '', issuer_policy_id: '', issuer_subscriber_id: '',
    agent_name: '', agent_npn: '', aor_bucket: '', pay_entity: '',
    status: '', effective_date: null, premium: null, net_premium: null,
    commission_amount: null, eligible_for_commission: '',
    policy_term_date: null, paid_through_date: null,
    broker_effective_date: null, broker_term_date: null,
    member_responsibility: null, on_off_exchange: '', auto_renewal: null,
    ede_policy_origin_type: '', ede_bucket: '', policy_modified_date: null,
    client_address_1: overrides.client_address_1 ?? '',
    client_address_2: '', client_city: overrides.client_city ?? '',
    client_state_full: overrides.client_state_full ?? '',
    client_zip: overrides.client_zip ?? '',
    paid_to_date: null, months_paid: null, writing_agent_carrier_id: '',
    member_key: 'member-1',
    raw_json: overrides.raw_json ?? {},
    ...overrides,
  };
}

function ede(overrides: any): any {
  return blankRecord({
    source_type: 'EDE',
    source_file_label: 'EDE Summary',
    ...overrides,
  });
}

function bo(overrides: any): any {
  return blankRecord({
    source_type: 'BACK_OFFICE',
    source_file_label: 'Jason Back Office',
    ...overrides,
  });
}

const monthMap = new Map([
  ['b-jan', '2026-01'],
  ['b-feb', '2026-02'],
  ['b-mar', '2026-03'],
]);

// ---------------------------------------------------------------------------
// 1. Profile rule basics — same-month BO wins
// ---------------------------------------------------------------------------

describe('buildMemberProfile — BO-first walk', () => {
  it('1. picks same-month BO over later BO, same-month EDE, later EDE, earlier BO', () => {
    const records = [
      bo({ batch_id: 'b-jan', raw_json: { 'Member Phone Number': '111-EARLIER-BO' } }),
      ede({ batch_id: 'b-feb', raw_json: { phone: '222-SAME-MONTH-EDE' } }),
      ede({ batch_id: 'b-mar', raw_json: { phone: '333-LATER-EDE' } }),
      bo({ batch_id: 'b-mar', raw_json: { 'Member Phone Number': '444-LATER-BO' } }),
      bo({ batch_id: 'b-feb', raw_json: { 'Member Phone Number': '555-SAME-MONTH-BO' } }),
    ];
    const p = buildMemberProfile('member-1', {
      records,
      referenceMonth: '2026-02',
      batchMonthByBatchId: monthMap,
    });
    expect(p.phone.value).toBe('555-SAME-MONTH-BO');
    expect(p.phone.source_type).toBe('back_office');
    expect(p.phone.source_month).toBe('2026-02');
  });

  it('2. falls through to later BO when same-month BO is blank', () => {
    const records = [
      bo({ batch_id: 'b-feb', raw_json: { 'Member Phone Number': '' } }),
      bo({ batch_id: 'b-mar', raw_json: { 'Member Phone Number': '444-LATER-BO' } }),
      ede({ batch_id: 'b-feb', raw_json: { phone: 'EDE-NEVER-WINS-OVER-LATER-BO' } }),
    ];
    const p = buildMemberProfile('member-1', {
      records,
      referenceMonth: '2026-02',
      batchMonthByBatchId: monthMap,
    });
    expect(p.phone.value).toBe('444-LATER-BO');
    expect(p.phone.source_type).toBe('back_office');
    expect(p.phone.source_month).toBe('2026-03');
  });

  it('3. full fallback to same-month EDE when BO is entirely blank', () => {
    const records = [
      bo({ batch_id: 'b-feb', raw_json: { 'Member Phone Number': '' } }),
      ede({ batch_id: 'b-feb', raw_json: { phone: '222-SAME-MONTH-EDE' } }),
    ];
    const p = buildMemberProfile('member-1', {
      records,
      referenceMonth: '2026-02',
      batchMonthByBatchId: monthMap,
    });
    expect(p.phone.value).toBe('222-SAME-MONTH-EDE');
    expect(p.phone.source_type).toBe('ede');
  });

  it('4. all-blank → value:null source_type:null', () => {
    const records = [
      bo({ batch_id: 'b-feb', raw_json: { 'Member Email': '' } }),
      ede({ batch_id: 'b-feb', raw_json: { email: '' } }),
    ];
    const p = buildMemberProfile('member-1', {
      records,
      referenceMonth: '2026-02',
      batchMonthByBatchId: monthMap,
    });
    expect(p.email.value).toBe(null);
    expect(p.email.source_type).toBe(null);
    expect(p.email.conflict).toBe(false);
    expect(p.email.conflict_values).toEqual([]);
  });

  it('5. conflict detection — two BO same month, latest upload wins, losers in conflict_values', () => {
    const records = [
      bo({
        batch_id: 'b-feb',
        created_at: '2026-02-10T00:00:00Z',
        raw_json: { 'Member Phone Number': '111-EARLIER-UPLOAD' },
      }),
      bo({
        batch_id: 'b-feb',
        created_at: '2026-02-20T00:00:00Z',
        raw_json: { 'Member Phone Number': '999-LATER-UPLOAD' },
      }),
    ];
    const p = buildMemberProfile('member-1', {
      records,
      referenceMonth: '2026-02',
      batchMonthByBatchId: monthMap,
    });
    expect(p.phone.value).toBe('999-LATER-UPLOAD');
    expect(p.phone.conflict).toBe(true);
    expect(p.phone.conflict_values.length).toBe(1);
    expect(p.phone.conflict_values[0].value).toBe('111-EARLIER-UPLOAD');
  });
});

// ---------------------------------------------------------------------------
// 6. Messer column mapping
// ---------------------------------------------------------------------------

describe('Messer column mapping helpers', () => {
  it('splitNameLastSpace — "Jane Marie Smith" → first=Jane Marie, last=Smith', () => {
    expect(splitNameLastSpace('Jane Marie Smith')).toEqual({ first: 'Jane Marie', last: 'Smith' });
    expect(splitNameLastSpace('Cher')).toEqual({ first: '', last: 'Cher' });
    expect(splitNameLastSpace('  ')).toEqual({ first: '', last: '' });
    expect(splitNameLastSpace(null)).toEqual({ first: '', last: '' });
  });

  it('assembleAddressLine — comma separators, skips blanks', () => {
    expect(assembleAddressLine({ address1: '123 Main St', city: 'Macon', state: 'GA', zip: '31201' }))
      .toBe('123 Main St, Macon, GA 31201');
    expect(assembleAddressLine({ address1: '', city: 'Macon', state: 'GA', zip: '31201' }))
      .toBe('Macon, GA 31201');
    expect(assembleAddressLine({})).toBe('');
  });

  it('resolveMemberId — issuer → policy → exchange ladder', () => {
    expect(resolveMemberId({ issuerSubscriberId: 'U1', policyNumber: 'P1', exchangeSubscriberId: 'E1' })).toBe('U1');
    expect(resolveMemberId({ issuerSubscriberId: '', policyNumber: 'P1', exchangeSubscriberId: 'E1' })).toBe('P1');
    expect(resolveMemberId({ issuerSubscriberId: '', policyNumber: '', exchangeSubscriberId: 'E1' })).toBe('E1');
    expect(resolveMemberId({ issuerSubscriberId: '', policyNumber: '', exchangeSubscriberId: '' })).toBe('');
  });

  it('resolveWritingAgentName — AOR primary, strips embedded NPN, falls back', () => {
    expect(resolveWritingAgentName({
      currentPolicyAor: 'Jason Fine (21055210)', boBrokerName: 'BO Name', commissionWritingAgentName: 'Comm Name',
    })).toBe('Jason Fine');
    expect(resolveWritingAgentName({
      currentPolicyAor: '', boBrokerName: 'BO Name', commissionWritingAgentName: 'Comm Name',
    })).toBe('BO Name');
    expect(resolveWritingAgentName({
      currentPolicyAor: '', boBrokerName: '', commissionWritingAgentName: 'Comm Name',
    })).toBe('Comm Name');
    expect(resolveWritingAgentName({ currentPolicyAor: '', boBrokerName: '', commissionWritingAgentName: '' })).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 7. Premium-bucket filtering
// ---------------------------------------------------------------------------

describe('classifyNetPremium', () => {
  it('buckets correctly', () => {
    expect(classifyNetPremium(0)).toBe('zero_premium');
    expect(classifyNetPremium(null)).toBe('zero_premium');
    expect(classifyNetPremium(undefined)).toBe('zero_premium');
    expect(classifyNetPremium(0.01)).toBe('has_premium');
    expect(classifyNetPremium(500)).toBe('has_premium');
  });
});

// ---------------------------------------------------------------------------
// 8. CSV download — columns match Messer schema, internals excluded
// ---------------------------------------------------------------------------

describe('buildMesserCsv + buildMesserCsvFilename', () => {
  it('produces CSV with EXACTLY the Messer column order; no internal columns', () => {
    const row: any = {
      carrierName: 'Ambetter',
      npn: '21055210',
      writingAgentCarrierId: 'WAC-1',
      writingAgentName: 'Jason Fine',
      policyEffectiveDate: '2026-02-01',
      policyNumber: 'U12345',
      memberFirstName: 'Jane Marie',
      memberLastName: 'Smith',
      dob: '1980-05-15',
      ssn: '',
      memberId: 'U12345',
      address: '123 Main St, Macon, GA 31201',
      _memberKey: 'sub:u12345',
      _ffmId: { value: 'ffm-abc', source_type: 'ede', source_month: '2026-02', source_file_label: 'EDE', conflict: false, conflict_values: [] },
      _exchangeSubscriberId: 'esid-1',
      _issuerSubscriberId: 'isid-1',
      _aor: 'Jason Fine (21055210)',
      _netPremiumBucket: 'zero_premium',
      _missingReason: 'Missing from Commission',
      _estimatedMissingCommission: 18,
      _profile: {} as any,
      _hasConflict: false,
    };
    const csv = buildMesserCsv([row]);
    const parsed = Papa.parse(csv, { header: true });
    const headers = parsed.meta.fields ?? [];

    // Exact Messer order
    expect(headers).toEqual([
      'Carrier Name', 'NPN', 'Writing Agent Carrier ID', 'Writing Agent Name',
      'Policy Effective Date', 'Policy #', 'Member First Name', 'Member Last Name',
      'DOB', 'SSN', 'Member ID', 'Address',
    ]);
    // SSN present but blank (v1)
    const data = parsed.data as Record<string, string>[];
    expect(data[0]['SSN']).toBe('');
    expect(data[0]['Member First Name']).toBe('Jane Marie');
    expect(data[0]['Member Last Name']).toBe('Smith');
    expect(data[0]['Address']).toBe('123 Main St, Macon, GA 31201');

    // No internal columns leaked
    for (const h of headers) {
      expect(h.startsWith('_')).toBe(false);
      expect(h).not.toContain('member_key');
      expect(h).not.toContain('FFM');
    }
  });

  it('filename matches the Messer convention', () => {
    const fn = buildMesserCsvFilename({
      scope: 'Coverall',
      batchMonth: '2026-03',
      filter: 'has_premium',
      downloadDate: new Date(2026, 4, 4), // 2026-05-04
    });
    expect(fn).toBe('messer_missing_commission_ambetter_coverall_2026_03_has_premium_2026_05_04.csv');
  });

  it('filename handles Vix scope and zero_premium filter', () => {
    const fn = buildMesserCsvFilename({
      scope: 'Vix',
      batchMonth: '2026-02',
      filter: 'zero_premium',
      downloadDate: new Date(2026, 0, 15),
    });
    expect(fn).toBe('messer_missing_commission_ambetter_vix_2026_02_zero_premium_2026_01_15.csv');
  });
});

// ---------------------------------------------------------------------------
// 9. Regression: Address / FFM ID / Policy Effective Date must NOT all-blank
// (Codex review pass #2 finding — real Ambetter BO has no Address column,
// so address/ffm_id/effective_date must come from EDE rows. These guards
// also pin BO-as-Address-source for future carriers like Molina/Cigna.)
// ---------------------------------------------------------------------------

describe('non-blank guards: Address / FFM ID / Policy Effective Date', () => {
  it('Address: BO has no Address column → EDE typed columns win', () => {
    // Realistic Ambetter shape: BO row has phone/email but NO Address/City/etc.
    // EDE row carries client_address_1 (typed).
    const records = [
      bo({
        batch_id: 'b-feb',
        raw_json: { 'Member Phone Number': '555-1212', 'Member Email': 'a@b.com' },
        // intentionally no client_address_1 set on BO
      }),
      ede({
        batch_id: 'b-feb',
        client_address_1: '742 Evergreen Terrace',
        client_city: 'Springfield',
        client_state_full: 'IL',
        client_zip: '62701',
        raw_json: { ffmAppId: 'FFM-12345', effectiveDate: '2026-02-01' },
      }),
    ];
    const p = buildMemberProfile('member-1', {
      records, referenceMonth: '2026-02', batchMonthByBatchId: monthMap,
    });
    expect(p.address1.value).toBe('742 Evergreen Terrace');
    expect(p.address1.source_type).toBe('ede');
    expect(p.city.value).toBe('Springfield');
    expect(p.state.value).toBe('IL');
    expect(p.zip.value).toBe('62701');
    const line = assembleAddressLine({
      address1: p.address1.value, city: p.city.value, state: p.state.value, zip: p.zip.value,
    });
    expect(line).toBe('742 Evergreen Terrace, Springfield, IL 62701');
  });

  it('FFM ID: comes from EDE raw_json.ffmAppId (BO never has it)', () => {
    const records = [
      bo({ batch_id: 'b-feb', raw_json: { 'Member Phone Number': '555' } }),
      ede({ batch_id: 'b-feb', raw_json: { ffmAppId: 'FFM-ABCDE' } }),
    ];
    const p = buildMemberProfile('member-1', {
      records, referenceMonth: '2026-02', batchMonthByBatchId: monthMap,
    });
    expect(p.ffm_id.value).toBe('FFM-ABCDE');
    expect(p.ffm_id.source_type).toBe('ede');
  });

  it('Policy Effective Date: prefers EDE typed effective_date over BO/reconciled', () => {
    const records = [
      ede({ batch_id: 'b-feb', effective_date: '2026-02-01' as any, raw_json: { effectiveDate: '2026-02-01' } }),
      bo({ batch_id: 'b-feb', broker_effective_date: '2026-02-15' as any, raw_json: { 'Policy Effective Date': '2/15/2026' } }),
    ];
    const eff = resolvePolicyEffectiveDate({
      records,
      reconciledEffectiveDate: '2026-03-01', // should be ignored — EDE wins
    });
    expect(eff).toBe('2026-02-01');
  });

  it('Policy Effective Date: falls back to EDE raw effectiveDate when typed is null', () => {
    const records = [
      ede({ batch_id: 'b-feb', effective_date: null, raw_json: { effectiveDate: '2026-02-01' } }),
    ];
    const eff = resolvePolicyEffectiveDate({ records, reconciledEffectiveDate: null });
    expect(eff).toBe('2026-02-01');
  });

  it('Policy Effective Date: falls back to BO when no EDE row exists', () => {
    const records = [
      bo({ batch_id: 'b-feb', broker_effective_date: '2026-02-15' as any, raw_json: { 'Policy Effective Date': '2/15/2026' } }),
    ];
    const eff = resolvePolicyEffectiveDate({ records, reconciledEffectiveDate: null });
    expect(eff).toBe('2026-02-15');
  });

  it('Combined fixture: BO supplies phone, EDE supplies address+FFM+effective date', () => {
    // Lock-in fixture: a single member where each Messer-critical field
    // comes from a different source. Exercises the full pipeline shape
    // identified in the #104 live verification.
    const records = [
      bo({
        batch_id: 'b-feb',
        raw_json: {
          'Member Phone Number': '404-555-0100',
          'Member Email': 'john@example.com',
          // no street address — Ambetter BO does not carry it
        },
      }),
      ede({
        batch_id: 'b-feb',
        client_address_1: '100 Peachtree St',
        client_city: 'Atlanta',
        client_state_full: 'GA',
        client_zip: '30303',
        effective_date: '2026-02-01' as any,
        raw_json: { ffmAppId: 'FFM-XYZ', effectiveDate: '2026-02-01' },
      }),
    ];
    const p = buildMemberProfile('member-1', {
      records, referenceMonth: '2026-02', batchMonthByBatchId: monthMap,
    });
    // Address from EDE
    expect(p.address1.value).toBe('100 Peachtree St');
    expect(p.address1.source_type).toBe('ede');
    // Phone from BO (BO-first when present)
    expect(p.phone.value).toBe('404-555-0100');
    expect(p.phone.source_type).toBe('back_office');
    // Email from BO
    expect(p.email.value).toBe('john@example.com');
    expect(p.email.source_type).toBe('back_office');
    // FFM ID from EDE
    expect(p.ffm_id.value).toBe('FFM-XYZ');
    // Effective date from EDE (row context, not enrichment)
    expect(resolvePolicyEffectiveDate({ records, reconciledEffectiveDate: null })).toBe('2026-02-01');
  });
});
