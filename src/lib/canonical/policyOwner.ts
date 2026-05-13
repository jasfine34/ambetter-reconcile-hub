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
 * Bundle 10 — Display-time variant: identical to
 * `classifyPolicyOwnerFromCurrentAor` UNLESS the caller opts in to the
 * commission-evidence fallback AND asserts the row matches the canonical
 * "Paid: Commission Statement Only" Source Coverage bucket. In that case
 * the writing-agent NPN may map the row to JF/EF/BS, otherwise the new
 * "Commission-Only" bucket is returned.
 *
 * IMPORTANT: this helper has NO knowledge of the Paid: Commission Statement
 * Only predicate — that lives in `getSourceCoverageBuckets` in metrics.ts.
 * Callers compute it once and pass `isCommissionStatementOnly` per row.
 *
 * Default opts → behavior identical to `classifyPolicyOwnerFromCurrentAor`.
 * Only the Total Policies Paid attribution surface opts in. All other
 * ownership consumers (reconcile, Agent Summary, EBU chips, drilldown AOR
 * column) continue to use the no-fallback canonical helper.
 *
 * NPN-only fallback discipline (consistent with prior audit decisions):
 * the writing-agent NPN is compared exactly against POLICY_OWNER_NPNS.
 * No name-based fallback on agent_npn.
 */
export type PolicyOwnerDisplayBucket = PolicyOwnerBucket | 'Commission-Only';

export function classifyPolicyOwnerForDisplay(
  row: { current_policy_aor?: string | null; agent_npn?: string | null },
  opts?: {
    allowCommissionOnlyFallback?: boolean;
    isCommissionStatementOnly?: boolean;
  },
): PolicyOwnerDisplayBucket {
  const aorBucket = classifyPolicyOwnerFromCurrentAor(row?.current_policy_aor);
  if (aorBucket === 'JF' || aorBucket === 'EF' || aorBucket === 'BS') return aorBucket;
  if (opts?.allowCommissionOnlyFallback && opts?.isCommissionStatementOnly) {
    const npn = String(row?.agent_npn ?? '').trim();
    if (npn) {
      if (npn === POLICY_OWNER_NPNS.JF) return 'JF';
      if (npn === POLICY_OWNER_NPNS.EF) return 'EF';
      if (npn === POLICY_OWNER_NPNS.BS) return 'BS';
    }
    return 'Commission-Only';
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
