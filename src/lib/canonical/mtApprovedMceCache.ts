/**
 * MCE Rewire — Phase B Item 4a (v2). Session/page-level cache for the
 * all-batch MT projection.
 *
 * The MT-approved MCE selector requires the full all-batch merged record
 * set. Cold-loading that on every click would push MCE Run Report well
 * past its current SLA; we therefore memoize the loader result keyed by:
 *
 *   `useAllBatchesDataVersion()` (per-fleet rebuild fingerprint)
 *     + `ResolverIndex.fingerprint` (sidecar content fingerprint)
 *
 * The cache is in-memory only — no persistence, no Supabase round trip
 * — and lives at the module scope so multiple MCE Run Report clicks in a
 * single session reuse the same merged projection.
 */
import type { NormalizedRecord } from '../normalize';
import { mergeRecordsToMemberKeys } from './memberKeyMerge';
import type { ResolverIndex } from '../resolvedIdentities';
import { resolverIndexFingerprint } from '../resolvedIdentities';

export interface MtAllBatchProjection {
  /** Identity-merged normalized records across all batches. */
  records: NormalizedRecord[];
}

type CacheEntry = {
  key: string;
  promise: Promise<MtAllBatchProjection>;
};

let _entry: CacheEntry | null = null;

export function makeMtAllBatchCacheKey(
  allBatchesDataVersion: string | null | undefined,
  resolverIndex: ResolverIndex | null | undefined,
): string {
  const dv = String(allBatchesDataVersion ?? '∅');
  const rf = resolverIndex ? resolverIndex.fingerprint || resolverIndexFingerprint(resolverIndex) : 'no-resolver';
  return `${dv}::${rf}`;
}

export interface GetMtAllBatchProjectionArgs {
  allBatchesDataVersion: string | null | undefined;
  resolverIndex: ResolverIndex | null;
  loader: () => Promise<NormalizedRecord[]>;
}

/**
 * Return the cached merged projection if the cache key matches; otherwise
 * load via `loader`, run the canonical identity merge, and cache the result
 * keyed by (data-version + resolver-fingerprint).
 */
export function getMtAllBatchProjection(
  args: GetMtAllBatchProjectionArgs,
): Promise<MtAllBatchProjection> {
  const key = makeMtAllBatchCacheKey(args.allBatchesDataVersion, args.resolverIndex);
  if (_entry && _entry.key === key) return _entry.promise;
  const promise = (async () => {
    const records = await args.loader();
    mergeRecordsToMemberKeys(records as any, args.resolverIndex);
    return { records };
  })();
  _entry = { key, promise };
  return promise;
}

/** Drop the cached projection (used by tests, and could be called by a
 *  future "force refresh" debug control). */
export function invalidateMtAllBatchProjectionCache(): void {
  _entry = null;
}

/** Test seam — peek the current cache key (or null if empty). */
export function _peekMtAllBatchCacheKey(): string | null {
  return _entry ? _entry.key : null;
}
