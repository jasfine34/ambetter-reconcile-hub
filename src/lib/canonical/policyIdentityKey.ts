/**
 * Bundle 13b — Policy identity key derivation.
 */
import { canonicalCarrier } from '@/lib/carrierCanonical';
import { cleanId, cleanSubscriberId } from '@/lib/normalize';

export type PolicyIdentityKeyResult =
  | {
      status: 'resolved';
      key: string;
      lineage: {
        carrierCanonical: string;
        used: 'policy_number' | 'issuer_subscriber_id' | 'aliased';
        policy_number_clean: string;
        issuer_subscriber_id_clean: string;
      };
    }
  | { status: 'unresolvable'; reason: 'no_carrier' | 'no_identity_keys' };

export function derivePolicyIdentityKey(args: {
  carrier: string | null | undefined;
  policy_number: string | null | undefined;
  issuer_subscriber_id: string | null | undefined;
}): PolicyIdentityKeyResult {
  const cc = canonicalCarrier(args.carrier);
  if (!cc) return { status: 'unresolvable', reason: 'no_carrier' };

  const pn = cleanId(args.policy_number);
  const sid = cleanSubscriberId(args.issuer_subscriber_id);

  if (pn && sid && pn === sid) {
    return {
      status: 'resolved',
      key: `${cc}|${pn}`,
      lineage: { carrierCanonical: cc, used: 'aliased', policy_number_clean: pn, issuer_subscriber_id_clean: sid },
    };
  }
  if (pn) {
    return {
      status: 'resolved',
      key: `${cc}|${pn}`,
      lineage: { carrierCanonical: cc, used: 'policy_number', policy_number_clean: pn, issuer_subscriber_id_clean: sid },
    };
  }
  if (sid) {
    return {
      status: 'resolved',
      key: `${cc}|sub:${sid}`,
      lineage: { carrierCanonical: cc, used: 'issuer_subscriber_id', policy_number_clean: pn, issuer_subscriber_id_clean: sid },
    };
  }
  return { status: 'unresolvable', reason: 'no_identity_keys' };
}
