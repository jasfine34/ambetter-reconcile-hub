/**
 * Bundle 13b — Cross-batch identity match.
 */
import { canonicalCarrier } from '@/lib/carrierCanonical';
import { cleanId, cleanSubscriberId } from '@/lib/normalize';
import { deriveCoveredServiceMonths } from './serviceMonth';

export interface IdentityMatchInput {
  id: string;
  carrier: string | null;
  policy_number: string | null;
  issuer_subscriber_id: string | null;
  paid_to_date?: string | null;
  months_paid?: number | null;
  raw_json?: any;
}

export type IdentityMatchResult =
  | { match: 'identified'; matchedRows: IdentityMatchInput[]; identityKeys: { policy_number?: string; issuer_subscriber_id?: string } }
  | { match: 'manual_review_required'; reason: 'conflicting_identity_keys'; candidatesConsidered: any[] }
  | { match: 'no_match'; reason: 'no_carrier_canonical' | 'no_identity_keys' | 'no_candidate_matched' | 'no_service_month_overlap' };

export function isCrossBatchIdentityMatch(args: {
  unpaid: { carrier: string | null; policy_number: string | null; issuer_subscriber_id: string | null };
  targetServiceMonth: string;
  candidates: IdentityMatchInput[];
}): IdentityMatchResult {
  const unpaidCC = canonicalCarrier(args.unpaid.carrier);
  if (!unpaidCC) return { match: 'no_match', reason: 'no_carrier_canonical' };
  const upn = cleanId(args.unpaid.policy_number);
  const usid = cleanSubscriberId(args.unpaid.issuer_subscriber_id);
  if (!upn && !usid) return { match: 'no_match', reason: 'no_identity_keys' };

  const matched: IdentityMatchInput[] = [];
  const candidatesConsidered: any[] = [];
  let hadConflict = false;
  let usedPolicyNumber = false;
  let usedSubscriberId = false;

  for (const c of args.candidates) {
    const cCC = canonicalCarrier(c.carrier);
    if (cCC !== unpaidCC) continue;
    const cpn = cleanId(c.policy_number);
    const csid = cleanSubscriberId(c.issuer_subscriber_id);

    const pnBoth = !!(upn && cpn);
    const sidBoth = !!(usid && csid);

    let identityHit: 'pn' | 'sid' | null = null;
    if (pnBoth && upn === cpn) identityHit = 'pn';
    else if ((!upn || !cpn) && sidBoth && usid === csid) identityHit = 'sid';

    if (identityHit && pnBoth && sidBoth) {
      const pnEq = upn === cpn;
      const sidEq = usid === csid;
      if (pnEq !== sidEq) {
        hadConflict = true;
        candidatesConsidered.push({ id: c.id, reason: 'conflict' });
        continue;
      }
    }

    if (!identityHit) continue;

    const months = deriveCoveredServiceMonths({ paid_to_date: c.paid_to_date, months_paid: c.months_paid });
    if (months.status !== 'resolved') {
      candidatesConsidered.push({ id: c.id, reason: 'service_months_unresolvable' });
      continue;
    }
    if (!months.months.includes(args.targetServiceMonth)) {
      candidatesConsidered.push({ id: c.id, reason: 'no_service_month_overlap', months: months.months });
      continue;
    }

    if (identityHit === 'pn') usedPolicyNumber = true;
    if (identityHit === 'sid') usedSubscriberId = true;
    matched.push(c);
  }

  if (hadConflict && matched.length === 0) {
    return { match: 'manual_review_required', reason: 'conflicting_identity_keys', candidatesConsidered };
  }
  if (matched.length === 0) {
    return {
      match: 'no_match',
      reason: candidatesConsidered.length > 0 ? 'no_service_month_overlap' : 'no_candidate_matched',
    };
  }
  const identityKeys: { policy_number?: string; issuer_subscriber_id?: string } = {};
  if (usedPolicyNumber && upn) identityKeys.policy_number = upn;
  if (usedSubscriberId && usid) identityKeys.issuer_subscriber_id = usid;
  return { match: 'identified', matchedRows: matched, identityKeys };
}
