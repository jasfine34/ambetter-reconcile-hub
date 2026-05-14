import { describe, it, expect } from 'vitest';
import { derivePolicyIdentityKey } from '@/lib/canonical/policyIdentityKey';

describe('derivePolicyIdentityKey', () => {
  it('resolves with policy_number when present', () => {
    const r = derivePolicyIdentityKey({ carrier: 'Ambetter', policy_number: 'U12345', issuer_subscriber_id: null });
    expect(r.status).toBe('resolved');
    if (r.status === 'resolved') {
      expect(r.key).toBe('ambetter|u12345');
      expect(r.lineage.used).toBe('policy_number');
    }
  });

  it('resolves with issuer_subscriber_id when policy_number missing', () => {
    const r = derivePolicyIdentityKey({ carrier: 'Ambetter', policy_number: null, issuer_subscriber_id: '00099887' });
    expect(r.status).toBe('resolved');
    if (r.status === 'resolved') {
      expect(r.key).toBe('ambetter|sub:99887');
      expect(r.lineage.used).toBe('issuer_subscriber_id');
    }
  });

  it('aliased when both present and equal after cleaning', () => {
    const r = derivePolicyIdentityKey({ carrier: 'Ambetter', policy_number: 'U12345', issuer_subscriber_id: 'U12345' });
    expect(r.status).toBe('resolved');
    if (r.status === 'resolved') {
      expect(r.key).toBe('ambetter|u12345');
      expect(r.lineage.used).toBe('aliased');
    }
  });

  it('prefers policy_number when both present and differ', () => {
    const r = derivePolicyIdentityKey({ carrier: 'Ambetter', policy_number: 'PN1', issuer_subscriber_id: 'SID2' });
    expect(r.status).toBe('resolved');
    if (r.status === 'resolved') {
      expect(r.key).toBe('ambetter|pn1');
      expect(r.lineage.used).toBe('policy_number');
    }
  });

  it('cleans dashes and apostrophes via cleanId', () => {
    const r = derivePolicyIdentityKey({ carrier: 'Ambetter', policy_number: "'U12345-01", issuer_subscriber_id: null });
    expect(r.status).toBe('resolved');
    if (r.status === 'resolved') expect(r.key).toBe('ambetter|u12345');
  });

  it('strips leading zeros only via cleanSubscriberId', () => {
    const r = derivePolicyIdentityKey({ carrier: 'Ambetter', policy_number: null, issuer_subscriber_id: '0023487406' });
    if (r.status === 'resolved') expect(r.key).toBe('ambetter|sub:23487406');
  });

  it('unresolvable when no carrier canonical', () => {
    const r = derivePolicyIdentityKey({ carrier: 'WeirdCo', policy_number: 'P1', issuer_subscriber_id: null });
    expect(r.status).toBe('unresolvable');
    if (r.status === 'unresolvable') expect(r.reason).toBe('no_carrier');
  });

  it('unresolvable when no identity keys', () => {
    const r = derivePolicyIdentityKey({ carrier: 'Ambetter', policy_number: '', issuer_subscriber_id: null });
    expect(r.status).toBe('unresolvable');
    if (r.status === 'unresolvable') expect(r.reason).toBe('no_identity_keys');
  });

  it('canonicalizes Ambetter Health → ambetter', () => {
    const r = derivePolicyIdentityKey({ carrier: 'Ambetter from Sunshine Health', policy_number: 'P1', issuer_subscriber_id: null });
    if (r.status === 'resolved') expect(r.lineage.carrierCanonical).toBe('ambetter');
  });
});
