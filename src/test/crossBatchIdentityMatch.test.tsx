import { describe, it, expect } from 'vitest';
import { isCrossBatchIdentityMatch } from '@/lib/canonical/crossBatchIdentityMatch';

const baseUnpaid = { carrier: 'Ambetter', policy_number: 'P1', issuer_subscriber_id: 'S1' };

function cand(over: any = {}) {
  return {
    id: over.id ?? 'c1', carrier: 'Ambetter', policy_number: 'P1', issuer_subscriber_id: 'S1',
    paid_to_date: '2026-02-15', months_paid: 1, raw_json: {}, ...over,
  };
}

describe('isCrossBatchIdentityMatch', () => {
  it('matches by policy_number', () => {
    const r = isCrossBatchIdentityMatch({ unpaid: baseUnpaid, targetServiceMonth: '2026-02', candidates: [cand()] });
    expect(r.match).toBe('identified');
  });

  it('falls back to subscriber_id when policy_number missing on one side', () => {
    const r = isCrossBatchIdentityMatch({
      unpaid: { ...baseUnpaid, policy_number: null },
      targetServiceMonth: '2026-02', candidates: [cand({ policy_number: null })],
    });
    expect(r.match).toBe('identified');
  });

  it('manual_review_required on conflicting keys', () => {
    const r = isCrossBatchIdentityMatch({
      unpaid: baseUnpaid, targetServiceMonth: '2026-02',
      candidates: [cand({ policy_number: 'P1', issuer_subscriber_id: 'DIFFERENT' })],
    });
    expect(r.match).toBe('manual_review_required');
  });

  it('no_match when carrier mismatch', () => {
    const r = isCrossBatchIdentityMatch({
      unpaid: baseUnpaid, targetServiceMonth: '2026-02',
      candidates: [cand({ carrier: 'Cigna' })],
    });
    expect(r.match).toBe('no_match');
  });

  it('drops candidate without service-month overlap', () => {
    const r = isCrossBatchIdentityMatch({
      unpaid: baseUnpaid, targetServiceMonth: '2026-05',
      candidates: [cand({ paid_to_date: '2026-02-01', months_paid: 1 })],
    });
    expect(r.match).toBe('no_match');
  });

  it('no_match when no carrier canonical for unpaid', () => {
    const r = isCrossBatchIdentityMatch({
      unpaid: { carrier: 'WeirdCo', policy_number: 'P', issuer_subscriber_id: null },
      targetServiceMonth: '2026-02', candidates: [cand()],
    });
    expect(r.match).toBe('no_match');
    if (r.match === 'no_match') expect(r.reason).toBe('no_carrier_canonical');
  });

  it('no_match when no identity keys on unpaid', () => {
    const r = isCrossBatchIdentityMatch({
      unpaid: { carrier: 'Ambetter', policy_number: null, issuer_subscriber_id: null },
      targetServiceMonth: '2026-02', candidates: [cand()],
    });
    if (r.match === 'no_match') expect(r.reason).toBe('no_identity_keys');
  });

  it('matches multiple candidates', () => {
    const r = isCrossBatchIdentityMatch({
      unpaid: baseUnpaid, targetServiceMonth: '2026-02',
      candidates: [cand({ id: 'a' }), cand({ id: 'b' })],
    });
    if (r.match === 'identified') expect(r.matchedRows.length).toBe(2);
  });

  it('returns identityKeys for policy_number used', () => {
    const r = isCrossBatchIdentityMatch({ unpaid: baseUnpaid, targetServiceMonth: '2026-02', candidates: [cand()] });
    if (r.match === 'identified') expect(r.identityKeys.policy_number).toBeTruthy();
  });

  it('canonicalizes carrier when comparing', () => {
    const r = isCrossBatchIdentityMatch({
      unpaid: { carrier: 'Ambetter Health', policy_number: 'P1', issuer_subscriber_id: null },
      targetServiceMonth: '2026-02',
      candidates: [cand({ carrier: 'Ambetter from Sunshine Health' })],
    });
    expect(r.match).toBe('identified');
  });

  it('paid_to_date + months_paid=3 covers prior months', () => {
    const r = isCrossBatchIdentityMatch({
      unpaid: baseUnpaid, targetServiceMonth: '2025-12',
      candidates: [cand({ paid_to_date: '2026-02-15', months_paid: 3 })],
    });
    expect(r.match).toBe('identified');
  });

  it('candidatesConsidered records dropped reasons', () => {
    const r = isCrossBatchIdentityMatch({
      unpaid: baseUnpaid, targetServiceMonth: '2026-12',
      candidates: [cand({ paid_to_date: '2026-02-15', months_paid: 1 })],
    });
    expect(r.match).toBe('no_match');
  });
});
