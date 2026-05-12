/**
 * Bundle 7 — Canonical EDE Current Policy AOR ownership helper.
 *
 * Ownership is determined ONLY by the EDE `current_policy_aor` value
 * selected by `pickCurrentPolicyAor`. JF / EF / BS / Other are ownership
 * buckets. Vix is a pay entity, NOT ownership. Downlines is payment /
 * writing evidence, NOT ownership.
 *
 * Every ownership / attribution surface (reconcile issue assignment,
 * Total Policies Paid chips, Agent Summary unpaid grouping, Dashboard
 * drilldown labels) MUST consume this single helper. Do not re-implement
 * inline; do not fall back to writing-agent NPN, commission `agent_npn`,
 * commission `writing_agent_carrier_id`, or `aor_bucket`.
 */
import { extractNpnFromAorString } from '../agents';

export type PolicyOwnerBucket = 'JF' | 'EF' | 'BS' | 'Other';

/** NPN ↔ owner bucket map. Mirrors the active AORs in NPN_MAP. */
export const POLICY_OWNER_NPNS: Readonly<Record<PolicyOwnerBucket, string>> = {
  JF: '21055210',
  EF: '21277051',
  BS: '16531877',
  Other: '',
};

/** Lowercased name prefix → bucket, used when no NPN is embedded in the AOR string. */
const NAME_PREFIX_TO_BUCKET: ReadonlyArray<{ prefix: string; bucket: PolicyOwnerBucket }> = [
  { prefix: 'jason fine', bucket: 'JF' },
  { prefix: 'erica fine', bucket: 'EF' },
  { prefix: 'becky shuta', bucket: 'BS' },
];

const NPN_TO_BUCKET: Readonly<Record<string, PolicyOwnerBucket>> = {
  [POLICY_OWNER_NPNS.JF]: 'JF',
  [POLICY_OWNER_NPNS.EF]: 'EF',
  [POLICY_OWNER_NPNS.BS]: 'BS',
};

/**
 * Classify the EDE current_policy_aor string into a single ownership bucket.
 *
 * Rules:
 *   - JF: identifies Jason Fine (NPN 21055210).
 *   - EF: identifies Erica Fine (NPN 21277051).
 *   - BS: identifies Becky Shuta (NPN 16531877).
 *   - Other: null / blank / unknown / downstream / unrecognized AORs.
 *
 * NPN extracted via `extractNpnFromAorString` is the primary signal; the
 * lowercased-name prefix is the fallback when no NPN is embedded.
 */
export function classifyPolicyOwnerFromCurrentAor(
  currentPolicyAor: string | null | undefined,
): PolicyOwnerBucket {
  if (!currentPolicyAor) return 'Other';
  const s = String(currentPolicyAor).trim();
  if (!s) return 'Other';
  const npn = extractNpnFromAorString(s);
  if (npn && NPN_TO_BUCKET[npn]) return NPN_TO_BUCKET[npn];
  const lower = s.toLowerCase();
  for (const { prefix, bucket } of NAME_PREFIX_TO_BUCKET) {
    if (lower.startsWith(prefix)) return bucket;
  }
  return 'Other';
}

/**
 * Expected pay entity inferred from the current AOR owner.
 *   JF / BS → 'Coverall'
 *   EF      → 'Coverall_or_Vix' (preserve existing Erica semantics)
 *   Other   → '' (blank/unknown)
 */
export function expectedPayEntityForOwner(bucket: PolicyOwnerBucket): string {
  switch (bucket) {
    case 'JF':
    case 'BS':
      return 'Coverall';
    case 'EF':
      return 'Coverall_or_Vix';
    case 'Other':
    default:
      return '';
  }
}
