/**
 * Multi-strategy member merging — same algorithm reconcile.ts uses to collapse
 * EDE / Back Office / Commission rows for the same person into one group.
 *
 * Used by the Member Timeline (and any other consumer that groups normalized
 * records by member) so duplicates like "Aaron Barrett by U-sub-id" + "Aaron
 * Barrett by Ambetter policy number" collapse into a single row.
 *
 * Mutates `member_key` (and re-cleans IDs) on each input record in place.
 */
import { cleanId, normalizePolicyStatus } from './normalize';
import type { NormalizedRecord } from './normalize';

function cleanPolicyBase(val: string | undefined | null): string {
  if (!val) return '';
  let v = val.replace(/^'+/, '').trim();
  const dashIdx = v.indexOf('-');
  if (dashIdx > 0) v = v.substring(0, dashIdx);
  v = v.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');
  return v;
}

function normalizeName(first: string | undefined | null, last: string | undefined | null): string {
  const f = (first || '').trim().toLowerCase().replace(/[^a-z]/g, '');
  const l = (last || '').trim().toLowerCase().replace(/[^a-z]/g, '');
  if (!f && !l) return '';
  return `${f}${l}`;
}

function normalizeFullName(applicantName: string | undefined | null): string {
  if (!applicantName) return '';
  return applicantName.trim().toLowerCase().replace(/[^a-z]/g, '');
}

function reclean(r: NormalizedRecord): void {
  r.issuer_subscriber_id = cleanPolicyBase(r.issuer_subscriber_id);
  r.exchange_subscriber_id = cleanId(r.exchange_subscriber_id);
  r.exchange_policy_id = cleanId(r.exchange_policy_id);
  r.issuer_policy_id = cleanId(r.issuer_policy_id);
  r.policy_number = cleanPolicyBase(r.policy_number);
  if (r.source_type === 'EDE') {
    r.status = normalizePolicyStatus(r.status);
  }
}

interface UnionFindIds {
  isid: Set<string>;
  esid: Set<string>;
}

function setsOverlap(a: Set<string>, b: Set<string>): boolean {
  for (const v of a) if (b.has(v)) return true;
  return false;
}

class UnionFind {
  private parent: number[];
  private ids: UnionFindIds[];
  constructor(records: NormalizedRecord[]) {
    this.parent = Array.from({ length: records.length }, (_, i) => i);
    this.ids = records.map(r => ({
      isid: r.issuer_subscriber_id ? new Set([r.issuer_subscriber_id]) : new Set<string>(),
      esid: r.exchange_subscriber_id ? new Set([r.exchange_subscriber_id]) : new Set<string>(),
    }));
  }
  find(x: number): number {
    if (this.parent[x] !== x) this.parent[x] = this.find(this.parent[x]);
    return this.parent[x];
  }
  union(a: number, b: number): boolean {
    const ra = this.find(a), rb = this.find(b);
    if (ra === rb) return true;
    const ia = this.ids[ra], ib = this.ids[rb];
    const isidConflict = ia.isid.size > 0 && ib.isid.size > 0 && !setsOverlap(ia.isid, ib.isid);
    const esidConflict = ia.esid.size > 0 && ib.esid.size > 0 && !setsOverlap(ia.esid, ib.esid);
    if (isidConflict || esidConflict) return false;
    this.parent[ra] = rb;
    for (const v of ia.isid) ib.isid.add(v);
    for (const v of ia.esid) ib.esid.add(v);
    return true;
  }
}

/**
 * Mutates each record's `member_key` so all records belonging to the same
 * person (matched via issuer_subscriber_id / exchange_subscriber_id /
 * policy_number / cross-source name) share a key.
 *
 * NOTE: Prefer `mergeRecordsToMemberKeys` from `@/lib/canonical/memberKeyMerge`
 * — it layers the resolved_identities sidecar overlay on top of this union.
 * The `_resolverIndex` parameter here is REQUIRED (even if you pass `null`)
 * so that any caller who forgets the sidecar fails the typechecker rather
 * than silently producing per-page-divergent member_keys (Codex pass #2).
 *
 * Returns the same array for chaining convenience.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function assignMergedMemberKeys(
  records: NormalizedRecord[],
  _resolverIndex: import('./resolvedIdentities').ResolverIndex | null,
): NormalizedRecord[] {
  if (records.length === 0) return records;

  // Re-clean IDs (records may have been stored with older normalization)
  for (const r of records) reclean(r);

  // ---- Promote issuer_subscriber_id onto EDE rows that are missing it,
  // pulling from sibling BO/Commission rows linked by exchange ids / policy.
  // Skip "poison" non-EDE rows whose own (esid, isid) cross-link two
  // different EDE members.
  const origEdeIdxByEsid = new Map<string, Set<number>>();
  const origEdeIdxByIsid = new Map<string, Set<number>>();
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.source_type !== 'EDE') continue;
    if (r.exchange_subscriber_id) {
      let s = origEdeIdxByEsid.get(r.exchange_subscriber_id);
      if (!s) { s = new Set(); origEdeIdxByEsid.set(r.exchange_subscriber_id, s); }
      s.add(i);
    }
    if (r.issuer_subscriber_id) {
      let s = origEdeIdxByIsid.get(r.issuer_subscriber_id);
      if (!s) { s = new Set(); origEdeIdxByIsid.set(r.issuer_subscriber_id, s); }
      s.add(i);
    }
  }
  const isCrossLinkedNonEde = (r: NormalizedRecord): boolean => {
    if (r.source_type === 'EDE') return false;
    const e = r.exchange_subscriber_id, ii = r.issuer_subscriber_id;
    if (!e || !ii) return false;
    const a = origEdeIdxByEsid.get(e), b = origEdeIdxByIsid.get(ii);
    if (!a || !b || a.size === 0 || b.size === 0) return false;
    for (const idx of a) if (b.has(idx)) return false;
    return true;
  };
  const uSubIdByExchangeSubId = new Map<string, string>();
  const uSubIdByExchangePolId = new Map<string, string>();
  const uSubIdByPolicyNumber = new Map<string, string>();
  for (const r of records) {
    if (r.source_type === 'EDE') continue;
    if (isCrossLinkedNonEde(r)) continue;
    const sid = r.issuer_subscriber_id;
    if (!sid || !sid.startsWith('u')) continue;
    if (r.exchange_subscriber_id && !uSubIdByExchangeSubId.has(r.exchange_subscriber_id)) {
      uSubIdByExchangeSubId.set(r.exchange_subscriber_id, sid);
    }
    if (r.exchange_policy_id && !uSubIdByExchangePolId.has(r.exchange_policy_id)) {
      uSubIdByExchangePolId.set(r.exchange_policy_id, sid);
    }
    if (r.policy_number && !uSubIdByPolicyNumber.has(r.policy_number)) {
      uSubIdByPolicyNumber.set(r.policy_number, sid);
    }
  }
  for (const r of records) {
    if (r.source_type !== 'EDE') continue;
    if (r.issuer_subscriber_id) continue;
    let promoted: string | undefined;
    if (r.exchange_subscriber_id) promoted = uSubIdByExchangeSubId.get(r.exchange_subscriber_id);
    if (!promoted && r.exchange_policy_id) promoted = uSubIdByExchangePolId.get(r.exchange_policy_id);
    if (!promoted && r.policy_number) promoted = uSubIdByPolicyNumber.get(r.policy_number);
    if (promoted) {
      r.issuer_subscriber_id = promoted;
      if (!r.member_id) r.member_id = promoted;
    }
  }

  // ---- Detect poison non-EDE rows (cross-linked IDs) — they must not bridge.
  const edeIdxByEsid = new Map<string, Set<number>>();
  const edeIdxByIsid = new Map<string, Set<number>>();
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.source_type !== 'EDE') continue;
    if (r.exchange_subscriber_id) {
      let s = edeIdxByEsid.get(r.exchange_subscriber_id);
      if (!s) { s = new Set(); edeIdxByEsid.set(r.exchange_subscriber_id, s); }
      s.add(i);
    }
    if (r.issuer_subscriber_id) {
      let s = edeIdxByIsid.get(r.issuer_subscriber_id);
      if (!s) { s = new Set(); edeIdxByIsid.set(r.issuer_subscriber_id, s); }
      s.add(i);
    }
  }
  const poisonIndices = new Set<number>();
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.source_type === 'EDE') continue;
    const myIsid = r.issuer_subscriber_id;
    const myEsid = r.exchange_subscriber_id;
    if (!myIsid || !myEsid) continue;
    const a = edeIdxByEsid.get(myEsid);
    const b = edeIdxByIsid.get(myIsid);
    if (!a || a.size === 0) continue;
    if (!b || b.size === 0) continue;
    let overlap = false;
    for (const idx of a) if (b.has(idx)) { overlap = true; break; }
    if (!overlap) poisonIndices.add(i);
  }

  const uf = new UnionFind(records);
  const skipUnion = (i: number) => poisonIndices.has(i);

  // Strategy A: issuer_subscriber_id
  const isidIndex = new Map<string, number>();
  for (let i = 0; i < records.length; i++) {
    if (skipUnion(i)) continue;
    const id = records[i].issuer_subscriber_id;
    if (!id) continue;
    const existing = isidIndex.get(id);
    if (existing !== undefined) uf.union(i, existing);
    else isidIndex.set(id, i);
  }
  // Strategy B: exchange_subscriber_id
  const esidIndex = new Map<string, number>();
  for (let i = 0; i < records.length; i++) {
    if (skipUnion(i)) continue;
    const id = records[i].exchange_subscriber_id;
    if (!id) continue;
    const existing = esidIndex.get(id);
    if (existing !== undefined) uf.union(i, existing);
    else esidIndex.set(id, i);
  }
  // Strategy C: policy_number
  const pnIndex = new Map<string, number>();
  for (let i = 0; i < records.length; i++) {
    if (skipUnion(i)) continue;
    const pn = records[i].policy_number;
    if (!pn) continue;
    const existing = pnIndex.get(pn);
    if (existing !== undefined) uf.union(i, existing);
    else pnIndex.set(pn, i);
  }
  // Strategy D: name (only if it bridges different source types)
  const nameIndex = new Map<string, number[]>();
  for (let i = 0; i < records.length; i++) {
    if (skipUnion(i)) continue;
    const r = records[i];
    let nm = r.first_name || r.last_name ? normalizeName(r.first_name, r.last_name) : '';
    if (!nm) nm = normalizeFullName(r.applicant_name);
    if (!nm || nm.length < 4) continue;
    const arr = nameIndex.get(nm) || [];
    arr.push(i);
    nameIndex.set(nm, arr);
  }
  for (const [, indices] of nameIndex) {
    if (indices.length < 2) continue;
    const types = new Set(indices.map(i => records[i].source_type));
    if (types.size > 1) {
      for (let j = 1; j < indices.length; j++) uf.union(indices[0], indices[j]);
    }
  }

  // ---- Assign a stable member_key per group root.
  const groupMembers = new Map<number, number[]>();
  for (let i = 0; i < records.length; i++) {
    const root = uf.find(i);
    const arr = groupMembers.get(root) || [];
    arr.push(i);
    groupMembers.set(root, arr);
  }
  let groupIdx = 0;
  for (const [, indices] of groupMembers) {
    const recs = indices.map(i => records[i]);
    let key = '';
    for (const r of recs) if (r.issuer_subscriber_id) { key = `issub:${r.issuer_subscriber_id}`; break; }
    if (!key) for (const r of recs) if (r.exchange_subscriber_id) { key = `sub:${r.exchange_subscriber_id}`; break; }
    if (!key) for (const r of recs) if (r.policy_number) { key = `policy:${r.policy_number}`; break; }
    if (!key) for (const r of recs) if (r.applicant_name) { key = `name:${normalizeFullName(r.applicant_name)}`; break; }
    if (!key) key = `grp:${groupIdx}`;
    groupIdx++;
    for (const r of recs) r.member_key = key;
  }

  return records;
}
