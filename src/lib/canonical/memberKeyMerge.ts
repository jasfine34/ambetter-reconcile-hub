/**
 * Canonical member-key merge — the SINGLE entry point both reconcile() and
 * the read-time pages (Member Timeline, Source Funnel, audit scripts) MUST
 * use to collapse normalized records into merged member groups.
 *
 * Why this exists (Codex finding pass #2, P1):
 *   reconcile.ts applied the resolved_identities sidecar overlay BEFORE the
 *   carrier-key union, but read-time callers (MemberTimelinePage,
 *   SourceFunnelCard, audit scripts) called assignMergedMemberKeys() which
 *   did NOT apply the sidecar. A member with two FFM application IDs that
 *   the sidecar collapses to one identity therefore appeared as ONE row in
 *   dashboard counts and TWO rows in the Member Timeline — user-visible
 *   drift. This module unifies the overlay step so all consumers see the
 *   same merged identities.
 *
 * Same family as canonical/scope.ts and canonical/metrics.ts: one predicate,
 * shared by every page.
 */
import type { NormalizedRecord } from '../normalize';
import { cleanId } from '../normalize';
import { assignMergedMemberKeys } from '../memberMerge';
import { type ResolverIndex, lookupResolved } from '../resolvedIdentities';

/**
 * Apply the resolved_identities sidecar overlay (if any), then run the
 * existing multi-strategy carrier-key union to assign `member_key` on each
 * input record. Mutates `records` in place and returns the same array for
 * chaining convenience.
 *
 * @param records - normalized records to merge
 * @param resolverIndex - resolved_identities sidecar index, or `null` when
 *   the caller has explicitly decided no overlay is needed (e.g. unit tests
 *   or audit scripts that exercise carrier-key union only). Required so that
 *   future callers cannot silently forget the sidecar.
 */
export function mergeRecordsToMemberKeys(
  records: NormalizedRecord[],
  resolverIndex: ResolverIndex | null,
): NormalizedRecord[] {
  if (records.length === 0) return records;

  // Step 1: cross-batch identity overlay from resolved_identities. Fills in
  // issuer_subscriber_id / issuer_policy_id / exchange_policy_id when the
  // record's own field is blank AND a resolved value exists in the sidecar.
  // Originals on disk stay byte-for-byte intact; we only mutate the in-memory
  // copy so blank EDE rows can join the right Union-Find group downstream.
  if (resolverIndex && resolverIndex.totalRows > 0) {
    for (const r of records) {
      const hit = lookupResolved(r as any, resolverIndex);
      if (!hit) continue;
      if (!r.issuer_subscriber_id && hit.resolved_issuer_subscriber_id) {
        r.issuer_subscriber_id = cleanId(hit.resolved_issuer_subscriber_id);
      }
      if (!r.issuer_policy_id && hit.resolved_issuer_policy_id) {
        r.issuer_policy_id = cleanId(hit.resolved_issuer_policy_id);
      }
      if (!r.exchange_policy_id && hit.resolved_exchange_policy_id) {
        r.exchange_policy_id = cleanId(hit.resolved_exchange_policy_id);
      }
    }
  }

  // Step 2: existing carrier-key union (issuer_subscriber_id,
  // exchange_subscriber_id, policy_number, then cross-source name).
  // The signature requires the resolverIndex too so any caller that goes
  // around this canonical wrapper still has to make a conscious choice.
  return assignMergedMemberKeys(records, resolverIndex);
}
