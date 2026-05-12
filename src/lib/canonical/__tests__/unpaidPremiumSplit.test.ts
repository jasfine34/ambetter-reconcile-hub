/**
 * Bundle 4 — Expected But Unpaid premium-evidence split tests.
 *
 * Verifies classifyUnpaidPremium edge cases (null/undefined/blank/non-numeric/
 * 0/negative → zeroNetPremium; parsed numeric > 0 → hasPremium) and that
 * getExpectedPaymentBreakdown.unpaidPremiumSplit sums exactly to unpaidCount
 * and is consistent with the existing source-type unpaidSplit.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyUnpaidPremium,
  getExpectedPaymentBreakdown,
} from '@/lib/canonical/metrics';

describe('classifyUnpaidPremium edge cases', () => {
  const Z = (v: any) => classifyUnpaidPremium({ net_premium: v });
  it('null → zeroNetPremium', () => expect(Z(null)).toBe('zeroNetPremium'));
  it('undefined → zeroNetPremium', () => expect(Z(undefined)).toBe('zeroNetPremium'));
  it('blank string → zeroNetPremium', () => expect(Z('   ')).toBe('zeroNetPremium'));
  it('non-numeric string → zeroNetPremium', () => expect(Z('abc')).toBe('zeroNetPremium'));
  it('0 → zeroNetPremium', () => expect(Z(0)).toBe('zeroNetPremium'));
  it('negative → zeroNetPremium', () => expect(Z(-5)).toBe('zeroNetPremium'));
  it('positive number → hasPremium', () => expect(Z(123.45)).toBe('hasPremium'));
  it('positive numeric string → hasPremium', () => expect(Z('123.45')).toBe('hasPremium'));
  it('Bundle 4.5: net_premium null with positive gross premium → zeroNetPremium (no fallback)', () => {
    expect(classifyUnpaidPremium({ net_premium: null, premium: 500 })).toBe('zeroNetPremium');
  });
  it('Bundle 4.5: net_premium undefined with positive gross premium → zeroNetPremium (no fallback)', () => {
    expect(classifyUnpaidPremium({ premium: 999 })).toBe('zeroNetPremium');
  });
  it('Bundle 4.5: net_premium 0 with positive gross premium → zeroNetPremium', () => {
    expect(classifyUnpaidPremium({ net_premium: 0, premium: 250 })).toBe('zeroNetPremium');
  });
});

describe('unpaidPremiumSplit sums to unpaidCount', () => {
  it('aggregates over the unpaid universe and matches existing source-type split totals', () => {
    // Build a synthetic universe by stubbing reconciled+filteredEde so the
    // helper's classifier puts rows into matched/boOnly/edeOnly buckets.
    const mk = (id: string, props: any) => ({
      member_key: id,
      in_back_office: true,
      in_ede: true,
      eligible_for_commission: 'Yes',
      pay_entity: 'Coverall',
      ...props,
    });
    const reconciled = [
      mk('a', { in_commission: false, net_premium: 100, current_policy_aor: 'Jason Fine (21055210)' }),     // matched, hasPremium, JF
      mk('b', { in_commission: false, net_premium: 0, current_policy_aor: 'Erica Fine (21277051)' }),       // matched, zero, EF
      mk('c', { in_commission: false, net_premium: null, premium: null, current_policy_aor: '' }),          // matched, zero, Other
      mk('d', { in_commission: true, net_premium: 200, current_policy_aor: 'Becky Shuta (16531877)' }),     // matched paid (excluded)
    ];
    const filteredEde = {
      uniqueMembers: reconciled.map((r) => ({
        member_key: r.member_key,
        issuer_subscriber_id: null,
        exchange_subscriber_id: null,
        policy_number: null,
        effective_month: '2026-03',
        covered_member_count: 1,
      })),
      uniqueKeys: 4,
      missingFromBO: [],
      byMonth: { '2026-03': 4 },
    } as any;
    const out = getExpectedPaymentBreakdown(reconciled, 'All', filteredEde, new Set());
    expect(out.unpaidCount).toBe(3);
    expect(out.unpaidPremiumSplit.zeroNetPremium).toBe(2);
    expect(out.unpaidPremiumSplit.hasPremium).toBe(1);
    expect(
      out.unpaidPremiumSplit.zeroNetPremium + out.unpaidPremiumSplit.hasPremium,
    ).toBe(out.unpaidCount);
    // Source-type chips remain accurate on the same card.
    expect(
      out.unpaidSplit.matched + out.unpaidSplit.boOnly + out.unpaidSplit.edeOnly,
    ).toBe(out.unpaidCount);
    // Bundle 8 — ownership split sums to unpaidCount and reflects current_policy_aor.
    expect(out.unpaidOwnerSplit).toEqual({ JF: 1, EF: 1, BS: 0, Other: 1 });
    expect(
      out.unpaidOwnerSplit.JF + out.unpaidOwnerSplit.EF + out.unpaidOwnerSplit.BS + out.unpaidOwnerSplit.Other,
    ).toBe(out.unpaidCount);
  });

  it('Bundle 8 — AOR-transfer: writing-agent NPN ignored; current_policy_aor drives unpaidOwnerSplit', () => {
    const mk = (id: string, props: any) => ({
      member_key: id,
      in_back_office: true,
      in_ede: true,
      eligible_for_commission: 'Yes',
      pay_entity: 'Coverall',
      in_commission: false,
      net_premium: 100,
      ...props,
    });
    // Writing agent Jason, current AOR Erica → must be EF, not JF.
    const reconciled = [
      mk('x', { current_policy_aor: 'Erica Fine (21277051)', agent_npn: '21055210' }),
    ];
    const filteredEde = {
      uniqueMembers: [{ member_key: 'x', issuer_subscriber_id: null, exchange_subscriber_id: null, policy_number: null, effective_month: '2026-03', covered_member_count: 1 }],
      uniqueKeys: 1, missingFromBO: [], byMonth: { '2026-03': 1 },
    } as any;
    const out = getExpectedPaymentBreakdown(reconciled, 'All', filteredEde, new Set());
    expect(out.unpaidOwnerSplit).toEqual({ JF: 0, EF: 1, BS: 0, Other: 0 });
  });
});
