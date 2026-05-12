/**
 * Bundle 4 — Total Policies Paid attribution split tests.
 *
 * Verifies the canonical priority Vix > EF > JF > BS > Downlines, that
 * EF/JF/BS map by NPN OR writing_agent_carrier_id (any positive amount),
 * that Erica's Vix-statement activity lands under Vix (not EF), and that
 * the chips sum exactly to Total Policies Paid for the input set.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyPaidAttribution,
  getTotalPoliciesPaidAttribution,
} from '@/lib/canonical/metrics';

const NPN = { JF: '21055210', EF: '21277051', BS: '16531877' };

const comm = (overrides: any) => ({
  source_type: 'COMMISSION',
  pay_entity: 'Coverall',
  agent_npn: '',
  writing_agent_carrier_id: '',
  commission_amount: 1,
  member_key: 'm1',
  ...overrides,
});

describe('classifyPaidAttribution priority order', () => {
  it('EF: Coverall-statement Erica NPN, any positive amount', () => {
    expect(classifyPaidAttribution([comm({ agent_npn: NPN.EF, commission_amount: 0.5 })])).toBe('EF');
  });
  it('Erica Vix-statement activity is Vix, never EF', () => {
    expect(classifyPaidAttribution([comm({ pay_entity: 'Vix', agent_npn: NPN.EF })])).toBe('Vix');
  });
  it('JF: Coverall-statement Jason NPN', () => {
    expect(classifyPaidAttribution([comm({ agent_npn: NPN.JF })])).toBe('JF');
  });
  it('BS: Coverall-statement Becky NPN (also via writing_agent_carrier_id)', () => {
    expect(classifyPaidAttribution([comm({ writing_agent_carrier_id: NPN.BS })])).toBe('BS');
  });
  it('Downlines: any other positive Coverall-statement NPN', () => {
    expect(classifyPaidAttribution([comm({ agent_npn: '21077804' })])).toBe('Downlines');
  });
  it('Multi-evidence policy follows priority Vix > EF > JF > BS > Downlines', () => {
    const evidence = [
      comm({ agent_npn: '99999999' }), // Downlines
      comm({ agent_npn: NPN.BS }), // BS
      comm({ agent_npn: NPN.JF }), // JF
      comm({ agent_npn: NPN.EF }), // EF
      comm({ pay_entity: 'Vix', agent_npn: NPN.EF }), // Vix
    ];
    expect(classifyPaidAttribution(evidence)).toBe('Vix');
    expect(classifyPaidAttribution(evidence.slice(0, 4))).toBe('EF');
    expect(classifyPaidAttribution(evidence.slice(0, 3))).toBe('JF');
    expect(classifyPaidAttribution(evidence.slice(0, 2))).toBe('BS');
    expect(classifyPaidAttribution(evidence.slice(0, 1))).toBe('Downlines');
  });
  it('returns null with no positive evidence', () => {
    expect(classifyPaidAttribution([])).toBeNull();
  });
});

describe('getTotalPoliciesPaidAttribution sums exactly to Total Policies Paid', () => {
  it('counts each policy exactly once and sums to input size', () => {
    const paid = [
      { member_key: 'mJF' },
      { member_key: 'mEF' },
      { member_key: 'mBS' },
      { member_key: 'mDL' },
      { member_key: 'mVix' },
      { member_key: 'mEFviaVix' },
      { member_key: 'mMulti' },
    ];
    const normalized = [
      comm({ member_key: 'mJF', agent_npn: NPN.JF }),
      comm({ member_key: 'mEF', agent_npn: NPN.EF, commission_amount: 0.25 }),
      comm({ member_key: 'mBS', writing_agent_carrier_id: NPN.BS }),
      comm({ member_key: 'mDL', agent_npn: '15978551' }),
      comm({ member_key: 'mVix', pay_entity: 'Vix', agent_npn: NPN.JF }),
      comm({ member_key: 'mEFviaVix', pay_entity: 'Vix', agent_npn: NPN.EF }),
      // Multi-evidence: should land in Vix.
      comm({ member_key: 'mMulti', agent_npn: NPN.JF }),
      comm({ member_key: 'mMulti', pay_entity: 'Vix' }),
      // Negative/zero rows must be ignored.
      comm({ member_key: 'mJF', agent_npn: NPN.JF, commission_amount: -50 }),
      comm({ member_key: 'mJF', agent_npn: NPN.JF, commission_amount: 0 }),
    ];
    const out = getTotalPoliciesPaidAttribution(paid, normalized);
    expect(out).toEqual({ JF: 1, EF: 1, BS: 1, Downlines: 1, Vix: 3, unattributed: 0 });
    const sum = out.JF + out.EF + out.BS + out.Downlines + out.Vix + out.unattributed;
    expect(sum).toBe(paid.length);
  });
});
