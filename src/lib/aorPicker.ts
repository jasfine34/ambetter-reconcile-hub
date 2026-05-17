import type { NormalizedRecord } from './normalize';

/**
 * Canonical "current Policy AOR" picker — single source of truth.
 *
 * CONTEXT (per Jason, 2026-04-27):
 *   In theory each consumer has one ffmAppId. In practice, rogue agents
 *   sometimes open second/third FFM IDs to take clients improperly, and
 *   sometimes legitimate switches happen. The same AOR can also span
 *   multiple ffmAppIds for the same issuer_subscriber_id, so a ffmAppId
 *   change does NOT necessarily mean an AOR change. EDE is the
 *   authoritative + timely AOR source because we upload an EDE file at
 *   month-start specifically to lock in attribution; the back office (BO)
 *   lags and sometimes misses enrollments. Therefore:
 *
 *   (1) If ANY EDE row exists for the member, pick from EDE only — never
 *       fall back to BO.
 *   (2) Sort EDE rows by (#76 precedence, 2026-04-29):
 *         (a) effective_date desc — most recent eff_date wins
 *             (null/unparseable last)
 *         (b) status priority (case-insensitive on rawStatusKey):
 *             Effectuated > PendingEffectuation > PendingTermination > Cancelled
 *         (c) file label priority:
 *             'EDE Summary' > 'EDE Archived Enrolled' > 'EDE Archived Not Enrolled'
 *         (d) lastEDESync desc — final tiebreaker
 *   (3) Pick the first row's currentPolicyAOR (raw_json['currentPolicyAOR']),
 *       trimmed.
 *   (4) Only if NO EDE row exists for that member, fall back to BO records'
 *       current_policy_aor / aor_bucket field.
 */

const STATUS_PRIORITY: Record<string, number> = {
  effectuated: 0,
  pendingeffectuation: 1,
  pendingtermination: 2,
  cancelled: 3,
};

const FILE_LABEL_PRIORITY: Record<string, number> = {
  'EDE Summary': 0,
  'EDE Archived Enrolled': 1,
  'EDE Archived Not Enrolled': 2,
};

function rawStatusKey(r: NormalizedRecord): string {
  const raw = (r.raw_json?.['policyStatus'] ?? r.status ?? '') as string;
  return String(raw).toLowerCase().replace(/\s+/g, '');
}

function statusRank(r: NormalizedRecord): number {
  const k = rawStatusKey(r);
  return k in STATUS_PRIORITY ? STATUS_PRIORITY[k] : 99;
}

function fileLabelRank(r: NormalizedRecord): number {
  const lbl = String(r.source_file_label ?? '').trim();
  return lbl in FILE_LABEL_PRIORITY ? FILE_LABEL_PRIORITY[lbl] : 99;
}

function effDateMs(r: NormalizedRecord): number {
  const s = r.effective_date;
  if (!s) return -Infinity;
  const t = Date.parse(String(s));
  return Number.isFinite(t) ? t : -Infinity;
}

function lastEDESyncMs(r: NormalizedRecord): number {
  const s = r.raw_json?.['lastEDESync'];
  if (!s) return -Infinity;
  const t = Date.parse(String(s));
  return Number.isFinite(t) ? t : -Infinity;
}

/**
 * Sort comparator (lower is better) — #76 precedence:
 *   (1) effective_date desc — most recent eff_date wins
 *   (2) status priority within same eff_date
 *       (Effectuated > PendingEffectuation > PendingTermination > Cancelled)
 *   (3) file label priority (Summary > Archived Enrolled > Archived Not Enrolled)
 *   (4) lastEDESync desc — final tiebreaker
 */
export function compareEDEForAor(a: NormalizedRecord, b: NormalizedRecord): number {
  const da = effDateMs(a), db = effDateMs(b);
  if (da !== db) return db - da; // newer eff_date first
  const sa = statusRank(a), sb = statusRank(b);
  if (sa !== sb) return sa - sb;
  const fa = fileLabelRank(a), fb = fileLabelRank(b);
  if (fa !== fb) return fa - fb;
  const la = lastEDESyncMs(a), lb = lastEDESyncMs(b);
  if (la !== lb) return lb - la; // newer lastEDESync first
  return 0;
}

/**
 * Pick the canonical currentPolicyAOR for a member from their normalized
 * records. Returns '' if nothing usable is found.
 */
export function pickCurrentPolicyAor(recs: NormalizedRecord[]): string {
  const ede = recs.filter(r => r.source_type === 'EDE');
  if (ede.length > 0) {
    const sorted = [...ede].sort(compareEDEForAor);
    for (const e of sorted) {
      const v = String(e.raw_json?.['currentPolicyAOR'] ?? '').trim();
      if (v) return v;
    }
    // EDE rows exist but none carry a currentPolicyAOR string — DO NOT fall
    // back to BO per rule (1). Return empty.
    return '';
  }
  // No EDE row at all — fall back to BO's current_policy_aor / aor_bucket.
  for (const r of recs) {
    if (r.source_type !== 'BACK_OFFICE') continue;
    const v = String(
      (r as any).current_policy_aor ??
      r.raw_json?.['currentPolicyAOR'] ??
      r.aor_bucket ??
      ''
    ).trim();
    if (v) return v;
  }
  return '';
}

/**
 * Surface all distinct ffmAppIds across a member's normalized records.
 *
 * Optional `fallbackCandidates` (added for FFM-ID Class-A display/export
 * fallback) are consulted ONLY when the same-group lookup is empty. Caller
 * is responsible for filtering candidates per the 8 safety rules
 * (source_type, batch, carrier, subscriber match) — typically via
 * {@link buildEdeFfmFallbackIndex}. When candidates are used, they are sorted
 * by `compareEDEForAor` so the surfaced order reflects #76 precedence.
 *
 * IMPORTANT: with no second argument, behavior is byte-equivalent to the
 * pre-fallback version. `reconcile.ts` callers MUST continue to call this
 * with a single argument.
 */
export function collectFfmAppIds(
  recs: NormalizedRecord[],
  fallbackCandidates?: NormalizedRecord[],
): string[] {
  const set = new Set<string>();
  for (const r of recs) {
    const v = r.raw_json?.['ffmAppId'];
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s) set.add(s);
  }
  if (set.size > 0 || !fallbackCandidates || fallbackCandidates.length === 0) {
    return Array.from(set);
  }
  const sorted = [...fallbackCandidates].sort(compareEDEForAor);
  for (const r of sorted) {
    if (r.source_type !== 'EDE') continue;
    const v = String(r.raw_json?.['ffmAppId'] ?? '').trim();
    if (v) set.add(v);
  }
  return Array.from(set);
}

// ---------------------------------------------------------------------------
// FFM-ID Class-A fallback index (display/export only)
//
// Resolves the identity-resolution gap where a BO `issub:*` member key is not
// merged with the EDE `sub:*` member key despite sharing
// `exchange_subscriber_id`. We index already-loaded EDE rows by subscriber
// IDs (scoped to batch_id) so callers can recover the FFM ID for members
// whose same-key records carry no `ffmAppId`. The index never reaches into
// the DB and never mutates records.
//
// Safety rules enforced here / by `lookup`:
//   (a) source_type === 'EDE'
//   (b) nonblank `raw_json.ffmAppId`
//   (c) same `batch_id` as the requesting scope
//   (d) carrier-family match when BOTH sides have nonblank carrier
//   (e) EXACT subscriber-id match (exchange_subscriber_id OR
//       issuer_subscriber_id); no name/DOB / partial-id fallback
// ---------------------------------------------------------------------------

export interface FfmFallbackLookupScope {
  batch_id: string | undefined;
  carrier: string | undefined;
  exchange_subscriber_id?: string;
  issuer_subscriber_id?: string;
}

export interface FfmFallbackIndex {
  lookup(scope: FfmFallbackLookupScope): NormalizedRecord[];
}

function carrierFamily(c: string | undefined | null): string {
  return String(c ?? '').trim().toLowerCase();
}

function indexKey(batchId: string, subId: string): string {
  return `${batchId}::${subId}`;
}

/**
 * Build a batch-scoped index of EDE rows that carry a nonblank `ffmAppId`,
 * keyed by `(batch_id, exchange_subscriber_id)` and
 * `(batch_id, issuer_subscriber_id)`. Pure, no DB calls. Empty input → an
 * empty index whose `lookup` always returns `[]`.
 */
export function buildEdeFfmFallbackIndex(records: NormalizedRecord[]): FfmFallbackIndex {
  const byExchange = new Map<string, NormalizedRecord[]>();
  const byIssuer = new Map<string, NormalizedRecord[]>();

  for (const r of records) {
    if (r.source_type !== 'EDE') continue;
    const ffm = String(r.raw_json?.['ffmAppId'] ?? '').trim();
    if (!ffm) continue;
    const batchId = String((r as any).batch_id ?? '');
    if (!batchId) continue;
    const esid = String(r.exchange_subscriber_id ?? '').trim();
    const isid = String(r.issuer_subscriber_id ?? '').trim();
    if (esid) {
      const k = indexKey(batchId, esid);
      const arr = byExchange.get(k); if (arr) arr.push(r); else byExchange.set(k, [r]);
    }
    if (isid) {
      const k = indexKey(batchId, isid);
      const arr = byIssuer.get(k); if (arr) arr.push(r); else byIssuer.set(k, [r]);
    }
  }

  return {
    lookup(scope: FfmFallbackLookupScope): NormalizedRecord[] {
      const batchId = String(scope.batch_id ?? '');
      if (!batchId) return [];
      const scopeCarrier = carrierFamily(scope.carrier);
      const seen = new Set<NormalizedRecord>();
      const out: NormalizedRecord[] = [];

      const consider = (cands: NormalizedRecord[] | undefined) => {
        if (!cands) return;
        for (const c of cands) {
          if (seen.has(c)) continue;
          const candCarrier = carrierFamily(c.carrier);
          // Carrier family check: only enforce when BOTH sides are nonblank.
          if (scopeCarrier && candCarrier && scopeCarrier !== candCarrier) continue;
          seen.add(c);
          out.push(c);
        }
      };

      const esid = String(scope.exchange_subscriber_id ?? '').trim();
      if (esid) consider(byExchange.get(indexKey(batchId, esid)));
      const isid = String(scope.issuer_subscriber_id ?? '').trim();
      if (isid) consider(byIssuer.get(indexKey(batchId, isid)));

      return out;
    },
  };
}
