/**
 * Bundle 7 — Total Policies Paid attribution split tests (REPLACES Bundle 4).
 *
 * Ownership is determined ONLY by EDE current_policy_aor via the canonical
 * policyOwner helper. Buckets: JF / EF / BS / Other. Vix and Downlines are
 * NOT ownership buckets and must not appear in attribution output.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyPaidAttribution,
  getTotalPoliciesPaidAttribution,
} from '@/lib/canonical/metrics';

const aor = (s: string) => ({ current_policy_aor: s });

describe('Bundle 7 — classifyPaidAttribution uses current_policy_aor only', () => {
  it('JF / EF / BS via embedded NPN', () => {
    expect(classifyPaidAttribution(aor('Jason Fine (21055210)'))).toBe('JF');
    expect(classifyPaidAttribution(aor('Erica Fine (21277051)'))).toBe('EF');
    expect(classifyPaidAttribution(aor('Becky Shuta (16531877)'))).toBe('BS');
  });
  it('JF / EF / BS via name prefix when no NPN embedded', () => {
    expect(classifyPaidAttribution(aor('Jason Fine'))).toBe('JF');
    expect(classifyPaidAttribution(aor('erica fine'))).toBe('EF');
    expect(classifyPaidAttribution(aor('Becky Shuta'))).toBe('BS');
  });
  it('Other for null / blank / unknown / downstream AORs', () => {
    expect(classifyPaidAttribution(aor(''))).toBe('Other');
    expect(classifyPaidAttribution({ current_policy_aor: null })).toBe('Other');
    expect(classifyPaidAttribution({})).toBe('Other');
    expect(classifyPaidAttribution(aor('Some Downline (99999999)'))).toBe('Other');
    expect(classifyPaidAttribution(aor('Allen Ford (21077804)'))).toBe('Other');
  });
  it('Writing-agent NPN on the row MUST NOT influence ownership (AOR-transfer)', () => {
    // Writing agent Jason; current AOR Erica → EF.
    expect(classifyPaidAttribution({
      current_policy_aor: 'Erica Fine (21277051)',
      agent_npn: '21055210',
    })).toBe('EF');
    // Writing agent Erica; current AOR Jason → JF.
    expect(classifyPaidAttribution({
      current_policy_aor: 'Jason Fine (21055210)',
      agent_npn: '21277051',
    })).toBe('JF');
  });
});

describe('Bundle 7 — getTotalPoliciesPaidAttribution sums to Total Policies Paid', () => {
  it('chip counts sum exactly to input row count, no commission evidence consulted', () => {
    const paid = [
      aor('Jason Fine (21055210)'),
      aor('Erica Fine (21277051)'),
      aor('Becky Shuta (16531877)'),
      aor('Random Downline (99999999)'),
      { current_policy_aor: '' },
      // AOR-transfer: writing-agent NPN must be ignored.
      { current_policy_aor: 'Jason Fine (21055210)', agent_npn: '21277051' },
    ];
    const out = getTotalPoliciesPaidAttribution(paid);
    expect(out).toEqual({ JF: 2, EF: 1, BS: 1, Other: 2 });
    const sum = out.JF + out.EF + out.BS + out.Other;
    expect(sum).toBe(paid.length);
  });

  it('second arg (legacy normalizedRecords) is ignored — commission rows are not ownership', () => {
    const paid = [aor('Erica Fine (21277051)')];
    const fakeCommission = [{ source_type: 'COMMISSION', agent_npn: '21055210', commission_amount: 100 }];
    const out = getTotalPoliciesPaidAttribution(paid, fakeCommission);
    expect(out.EF).toBe(1);
    expect(out.JF).toBe(0);
  });
});
