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
 *   (2) Sort EDE rows by:
 *         (a) status priority (case-insensitive on rawStatusKey):
 *             Effectuated > PendingEffectuation > PendingTermination > Cancelled
 *         (b) effective_date desc (newest first; null/unparseable last)
 *         (c) file label priority:
 *             'EDE Summary' > 'EDE Archived Enrolled' > 'EDE Archived Not Enrolled'
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

/** Surface all distinct ffmAppIds across a member's normalized records. */
export function collectFfmAppIds(recs: NormalizedRecord[]): string[] {
  const set = new Set<string>();
  for (const r of recs) {
    const v = r.raw_json?.['ffmAppId'];
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s) set.add(s);
  }
  return Array.from(set);
}
