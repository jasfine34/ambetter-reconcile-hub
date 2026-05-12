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
  it('falls back to premium when net_premium is null', () => {
    expect(classifyUnpaidPremium({ net_premium: null, premium: 50 })).toBe('hasPremium');
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
      mk('a', { in_commission: false, net_premium: 100 }),     // matched, hasPremium
      mk('b', { in_commission: false, net_premium: 0 }),       // matched, zero
      mk('c', { in_commission: false, net_premium: null, premium: null }), // matched, zero
      mk('d', { in_commission: true, net_premium: 200 }),      // matched paid (excluded)
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
  });
});
