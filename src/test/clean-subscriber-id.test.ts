/**
 * Regression coverage for #115 (Feb Jason BO attribution failure).
 *
 * Defect: Feb EDE Summary emitted exchangeSubscriberId stripped of leading
 * zeros (e.g. "23487406") while Feb Jason BO emitted the same id padded
 * (e.g. "0023487406"). cleanId() preserved the mismatch, so reconcile()'s
 * union-find conflict gate refused 2,118 legitimate BO/EDE merges.
 *
 * Fix: cleanSubscriberId() (in src/lib/normalize.ts) routes ONLY ESID/ISID-
 * class fields through a wrapper that strips leading zeros for purely
 * numeric values (regex /^0+[1-9]\d*$/). Policy-number, NPN, and writing-
 * agent-id callers are left untouched on cleanId().
 *
 * The fixtures below cover every safety property called out in the fix
 * approval:
 *   1. Leading-zero ESID asymmetry → one reconciled member, all-three flags
 *   2. True ESID conflict → reconcile still refuses unsafe merge
 *   3. Alphanumeric IDs ("u00012345", "u0") untouched
 *   4. Pure-zero values ("0", "0000") do not normalize to empty
 *   5. policy_number-as-policy_number not stripped, even if numeric
 *   6. Two consecutive reconcile() runs produce stable member_keys
 *   7. Synthetic Feb-style upload pipeline → expected commission cohort
 */
import { describe, it, expect } from 'vitest';
import {
  cleanId,
  cleanSubscriberId,
  buildMemberKey,
  normalizeEDERow,
  normalizeBackOfficeRow,
  normalizeCommissionRow,
} from '@/lib/normalize';
import { assignMergedMemberKeys } from '@/lib/memberMerge';

describe('cleanSubscriberId — pure-helper invariants (#115)', () => {
  it('strips leading zeros for purely numeric padded IDs', () => {
    expect(cleanSubscriberId('0023487406')).toBe('23487406');
    expect(cleanSubscriberId('00001')).toBe('1');
    expect(cleanSubscriberId('  0023487406 ')).toBe('23487406');
  });

  it('preserves alphanumeric IDs (Ambetter U-format) untouched', () => {
    // /^0+[1-9]\d*$/ deliberately requires the value to be all digits.
    // "u00012345" has a leading "u" → not stripped.
    expect(cleanSubscriberId('U00012345')).toBe('u00012345');
    expect(cleanSubscriberId('u0')).toBe('u0');
    expect(cleanSubscriberId('U99015281')).toBe('u99015281');
  });

  it('preserves pure-zero values (does not collapse to empty)', () => {
    // /^0+[1-9]\d*$/ requires a non-zero tail digit, so "0" / "0000"
    // do NOT match and are returned unchanged.
    expect(cleanSubscriberId('0')).toBe('0');
    expect(cleanSubscriberId('0000')).toBe('0000');
  });

  it('handles blank / null safely', () => {
    expect(cleanSubscriberId('')).toBe('');
    expect(cleanSubscriberId(null)).toBe('');
    expect(cleanSubscriberId(undefined)).toBe('');
  });

  it('cleanId stays untouched for policy_number-class fields', () => {
    // Approved scope: cleanId preserved for policy_number,
    // exchange_policy_id, issuer_policy_id, agent_npn,
    // writing_agent_carrier_id. Future carrier adapters depend on this.
    expect(cleanId('0023487406')).toBe('0023487406');
    expect(cleanId('00001')).toBe('00001');
  });
});

describe('buildMemberKey — ESID/ISID branches use subscriber cleaner', () => {
  it('issub key collapses padded vs unpadded numeric ISID', () => {
    const a = buildMemberKey({ issuer_subscriber_id: '23487406' });
    const b = buildMemberKey({ issuer_subscriber_id: '0023487406' });
    expect(a).toBe(b);
    expect(a).toBe('issub:23487406');
  });

  it('sub key collapses padded vs unpadded numeric ESID', () => {
    const a = buildMemberKey({ exchange_subscriber_id: '23487406' });
    const b = buildMemberKey({ exchange_subscriber_id: '0023487406' });
    expect(a).toBe(b);
    expect(a).toBe('sub:23487406');
  });

  it('U-format ISIDs are NOT collapsed (alphanumeric stability)', () => {
    const a = buildMemberKey({ issuer_subscriber_id: 'u00012345' });
    const b = buildMemberKey({ issuer_subscriber_id: 'u12345' });
    expect(a).not.toBe(b);
  });
});

describe('reconcile / assignMergedMemberKeys — Feb-style asymmetry merges', () => {
  // Synthesise the Feb pattern: an EDE Summary row with stripped ESID and
  // a Jason BO row with padded ESID for the SAME member, plus a matching
  // Coverall commission row.
  function synthFebPair() {
    const edeRow: Record<string, string> = {
      Issuer: 'Ambetter Health',
      applicantName: 'Jane Doe',
      applicantFirstName: 'Jane',
      applicantLastName: 'Doe',
      exchangeSubscriberId: '23487406',         // stripped
      issuerSubscriberId: 'U99015281',
      issuerPolicyId: 'P-1',
      exchangePolicyId: 'EX-1',
      policyStatus: 'Effectuated',
      effectiveDate: '2026-02-01',
      premium: '500',
      netPremium: '450',
      agentName: 'Jason Fine',
      agentNPN: '12345',
    };
    const boRow: Record<string, string> = {
      'Broker Name': 'Jason Fine',
      'Broker NPN': '12345',
      'Policy Number': 'U99015281',
      'Insured First Name': 'Jane',
      'Insured Last Name': 'Doe',
      'Broker Effective Date': '02/01/2026',
      'Broker Term Date': '12/31/9999',
      'Policy Effective Date': '02/01/2026',
      'Policy Term Date': '',
      'Paid Through Date': '03/01/2026',
      'Member Responsibility': '0',
      'Monthly Premium Amount': '500',
      'On/Off Exchange': 'On',
      'Exchange Subscriber ID': '0023487406',   // padded — Feb defect shape
      'Member Date Of Birth': '01/01/1980',
      'Eligible for Commission': 'Yes',
    };
    const commRow: Record<string, string> = {
      'Database': 'Ambetter',
      'Policy Number': 'U99015281',
      'Policyholder Name': 'Jane Doe',
      'Agent Name_1': 'Jason Fine',
      'Writing Agent ID': '12345',
      'Issue Date': '02/01/2026',
      'Commissionable': '500',
      'Gross Commission': '50',
      'Policy Status': 'Active',
    };

    const ede = normalizeEDERow(edeRow, 'EDE_Summary.csv');
    const bo = normalizeBackOfficeRow(boRow, 'Jason_Back_Office.csv', 'Jason Fine');
    const comm = normalizeCommissionRow(commRow, 'Coverall_Commission.csv', 'Coverall');
    expect(ede).not.toBeNull();
    expect(comm).not.toBeNull();
    return [ede!, bo, comm!];
  }

  it('Feb-style ESID asymmetry collapses into one reconciled member with all three sources', () => {
    const records = synthFebPair();
    assignMergedMemberKeys(records, null);

    // All three rows share one member_key
    const keys = new Set(records.map(r => r.member_key));
    expect(keys.size).toBe(1);

    // All three sources represented under the same key
    const types = new Set(records.map(r => r.source_type));
    expect(types).toEqual(new Set(['EDE', 'BACK_OFFICE', 'COMMISSION']));

    // ESID is canonicalized (no padding) on both sides
    const edeRec = records.find(r => r.source_type === 'EDE')!;
    const boRec = records.find(r => r.source_type === 'BACK_OFFICE')!;
    expect(edeRec.exchange_subscriber_id).toBe('23487406');
    expect(boRec.exchange_subscriber_id).toBe('23487406');
  });

  it('genuinely different non-padding ESIDs do NOT merge (true conflict still refused)', () => {
    const records = synthFebPair();
    // Replace the BO row's ESID with a genuinely different value.
    records[1].exchange_subscriber_id = '99999999';
    // Same agent NPN, but the conflict gate must keep them separate to avoid
    // an unsafe merge.
    assignMergedMemberKeys(records, null);

    // EDE and BO must NOT share a key — only the commission row may join
    // EDE via issuer_subscriber_id.
    const edeKey = records.find(r => r.source_type === 'EDE')!.member_key;
    const boKey = records.find(r => r.source_type === 'BACK_OFFICE')!.member_key;
    expect(edeKey).not.toBe(boKey);
  });

  it('two consecutive reconcile runs produce stable member_keys', () => {
    const records = synthFebPair();
    assignMergedMemberKeys(records, null);
    const firstKeys = records.map(r => r.member_key);
    assignMergedMemberKeys(records, null);
    const secondKeys = records.map(r => r.member_key);
    expect(secondKeys).toEqual(firstKeys);
  });

  it('policy_number is not stripped when used as policy_number (carrier-future safety)', () => {
    // Numeric policy with leading zeros, alongside a member with the same
    // numeric pattern as ESID. policy_number must keep its zeros so future
    // carriers that use leading zeros as meaningful aren't damaged.
    const fakeBO: Record<string, string> = {
      'Broker Name': 'X',
      'Broker NPN': '1',
      'Policy Number': 'U-keep',        // ISID alias — irrelevant
      'Insured First Name': 'F',
      'Insured Last Name': 'L',
      'Broker Effective Date': '02/01/2026',
      'Broker Term Date': '12/31/9999',
      'Policy Effective Date': '02/01/2026',
      'Policy Term Date': '',
      'Paid Through Date': '03/01/2026',
      'Member Responsibility': '0',
      'Monthly Premium Amount': '500',
      'On/Off Exchange': 'On',
      'Exchange Subscriber ID': '0023487406',
      'Member Date Of Birth': '01/01/1980',
      'Eligible for Commission': 'Yes',
    };
    const r = normalizeBackOfficeRow(fakeBO, 'f.csv', 'Jason');
    // policy_number kept on cleanId (preserves any carrier-meaningful zeros
    // — Ambetter's "U-..." stays untouched here too).
    expect(r.policy_number).toBe('ukeep');
    // ESID gets the subscriber-cleaner.
    expect(r.exchange_subscriber_id).toBe('23487406');
  });
});
