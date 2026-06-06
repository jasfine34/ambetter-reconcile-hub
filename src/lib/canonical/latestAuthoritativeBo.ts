/**
 * Cross-batch Back Office termination supersession overlay.
 *
 * Problem: hasActiveBoForMonth / hasEdeForMonth use `.some()` over a member's
 * records. When the same policy appears in multiple BO snapshots, any active
 * record keeps the cell chaseable — so a stale earlier record beats a later
 * carrier file that correctly set policy_term_date. Latest-file-wins.
 *
 * This module computes, per canonical policy-identity key, the latest
 * authoritative `policy_term_date` + `broker_term_date` across BO records.
 * Consumers gate `in_back_office` / `in_ede` against the overlay so a
 * superseded month flips to `not_expected_cancelled` via the existing
 * stale-source guard — no new ClassificationState introduced.
 *
 * Rules (locked by directive):
 *   - Date authority = policy_term_date + broker_term_date ONLY. We do NOT
 *     supersede on eligible_for_commission (stays per-record), policy
 *     effective_date, broker_effective_date, or paid_through_date.
 *   - Latest file wins, not most-restrictive: a later file that extends the
 *     term reactivates the policy.
 *   - Per-field latest-non-blank: a blank latest value does NOT revive an
 *     earlier termination (defensive guard).
 *   - Grain = canonical policy-identity key (derivePolicyIdentityKey), NOT
 *     raw policy_number. A merged member spanning two policy identities has
 *     each evaluated independently.
 *   - broker_term_date at typed-field certainty only this pass — see
 *     src/lib/carriers/ambetter/backOffice.ts where 12/31/9999 and blank
 *     collapse to null. No raw-field projection.
 */
import type { NormalizedRecord } from '../normalize';
import { derivePolicyIdentityKey } from './policyIdentityKey';

/** Sortable triple; lexical comparison; larger = more recent. */
export interface BoRecencyKey {
  primary: string;    // batch statement_month YYYY-MM
  secondary: string;  // file/upload created_at ISO (optional)
  tertiary: string;   // stable record id
}

export interface BoRecency {
  keyFor: (record: NormalizedRecord) => BoRecencyKey;
}

export interface LatestAuthoritativeBoTermDates {
  policy_term_date: string | null;
  broker_term_date: string | null;
  /** Record id whose term values were chosen (most-recent providing each). */
  source_record_id_policy: string | null;
  source_record_id_broker: string | null;
}

export type LatestAuthoritativeBoOverlay = Map<string, LatestAuthoritativeBoTermDates>;

/**
 * Build the per-policy-identity supersession overlay from a flat record set.
 * Non-BO records and unresolvable-identity BO records are skipped.
 *
 * Alias-aware bridging (corrective fix): derivePolicyIdentityKey produces
 * two keys for one logical policy when a BO row carries
 * `policy_number === issuer_subscriber_id` (key = `cc|X`) while an EDE row
 * for the same policy has a blank `policy_number` and
 * `issuer_subscriber_id = X` (key = `cc|sub:X`). Without bridging the
 * EDE-side gate lookup misses the BO-built overlay entry and the
 * supersession fails to flip the cell (Josie-pattern root cause).
 *
 * After grouping BO records by their primary key, we additionally index
 * each aliased group `cc|X` (where some record has `pn==sid==X`) under
 * `cc|sub:X` — but ONLY when subscriber X resolves to a single policy
 * (co-resident safety: if two distinct `policy_number`s both claim
 * subscriber X, neither bridges, so one policy's termination cannot
 * cancel another). The bridge never overwrites an explicit BO-only
 * `cc|sub:X` group.
 */
export function latestAuthoritativeBoTermDates(
  records: NormalizedRecord[],
  recency: BoRecency,
): LatestAuthoritativeBoOverlay {
  type Entry = {
    rec: NormalizedRecord;
    key: BoRecencyKey;
    sidClean: string;
    carrierCanonical: string;
  };
  const groups = new Map<string, Entry[]>();
  for (const r of records) {
    if (r.source_type !== 'BACK_OFFICE') continue;
    const pik = derivePolicyIdentityKey({
      carrier: r.carrier,
      policy_number: r.policy_number,
      issuer_subscriber_id: r.issuer_subscriber_id,
    });
    if (pik.status !== 'resolved') continue;
    let g = groups.get(pik.key);
    if (!g) { g = []; groups.set(pik.key, g); }
    g.push({
      rec: r,
      key: recency.keyFor(r),
      sidClean: pik.lineage.issuer_subscriber_id_clean,
      carrierCanonical: pik.lineage.carrierCanonical,
    });
  }
  const cmp = (a: BoRecencyKey, b: BoRecencyKey) => {
    if (a.primary !== b.primary) return a.primary > b.primary ? -1 : 1;
    if (a.secondary !== b.secondary) return a.secondary > b.secondary ? -1 : 1;
    if (a.tertiary !== b.tertiary) return a.tertiary > b.tertiary ? -1 : 1;
    return 0;
  };
  const out: LatestAuthoritativeBoOverlay = new Map();
  const primariesBySubAlias = new Map<string, Set<string>>();
  const subAliasesByPrimary = new Map<string, Set<string>>();

  for (const [primaryKey, entries] of groups) {
    entries.sort((a, b) => cmp(a.key, b.key));
    let policy_term_date: string | null = null;
    let broker_term_date: string | null = null;
    let src_policy: string | null = null;
    let src_broker: string | null = null;
    const subAliases = new Set<string>();
    for (const e of entries) {
      const { rec, sidClean, carrierCanonical } = e;
      if (policy_term_date === null) {
        const v = (rec.policy_term_date || '').trim();
        if (v) { policy_term_date = v; src_policy = String((rec as any).id ?? ''); }
      }
      if (broker_term_date === null) {
        const v = (rec.broker_term_date || '').trim();
        if (v) { broker_term_date = v; src_broker = String((rec as any).id ?? ''); }
      }
      if (sidClean) {
        const subKey = `${carrierCanonical}|sub:${sidClean}`;
        if (subKey !== primaryKey) subAliases.add(subKey);
      }
    }
    out.set(primaryKey, {
      policy_term_date,
      broker_term_date,
      source_record_id_policy: src_policy,
      source_record_id_broker: src_broker,
    });
    subAliasesByPrimary.set(primaryKey, subAliases);
    for (const s of subAliases) {
      let claimants = primariesBySubAlias.get(s);
      if (!claimants) { claimants = new Set(); primariesBySubAlias.set(s, claimants); }
      claimants.add(primaryKey);
    }
  }

  // Apply alias bridge with co-resident safety.
  for (const [primaryKey, subAliases] of subAliasesByPrimary) {
    const entry = out.get(primaryKey);
    if (!entry) continue;
    for (const subKey of subAliases) {
      if (out.has(subKey)) continue; // explicit BO-only sub-group already present
      const claimants = primariesBySubAlias.get(subKey);
      if (!claimants || claimants.size !== 1) continue; // co-resident — unsafe to bridge
      out.set(subKey, entry);
    }
  }
  return out;
}

function isSentinel(date: string): boolean {
  return date.startsWith('9999-');
}

/**
 * True if the policy identity of `rec` is authoritatively terminated by
 * the overlay for the given month-start ISO date. Termination = either
 * policy_term_date or broker_term_date <= firstOfMonth, after blanks /
 * sentinels filtered.
 */
export function isPolicyIdentityTerminatedForMonth(
  rec: NormalizedRecord,
  firstOfMonth: string,
  overlay: LatestAuthoritativeBoOverlay | undefined,
): boolean {
  if (!overlay) return false;
  const pik = derivePolicyIdentityKey({
    carrier: rec.carrier,
    policy_number: rec.policy_number,
    issuer_subscriber_id: rec.issuer_subscriber_id,
  });
  if (pik.status !== 'resolved') return false;
  const entry = overlay.get(pik.key);
  if (!entry) return false;
  const pt = entry.policy_term_date;
  if (pt && !isSentinel(pt) && pt <= firstOfMonth) return true;
  const bt = entry.broker_term_date;
  if (bt && !isSentinel(bt) && bt <= firstOfMonth) return true;
  return false;
}

/**
 * Default production recency: batch statement_month → upload created_at
 * (optional) → record id. Bigger = more recent under lexical compare.
 */
export function makeBoRecency(opts?: {
  batchMonthByBatchId?: Map<string, string>;
  uploadCreatedAtByFileId?: Map<string, string>;
}): BoRecency {
  const bm = opts?.batchMonthByBatchId;
  const um = opts?.uploadCreatedAtByFileId;
  return {
    keyFor(rec) {
      const batchId = (rec as any).batch_id ? String((rec as any).batch_id) : '';
      const fileId = (rec as any).uploaded_file_id ? String((rec as any).uploaded_file_id) : '';
      const primary = (batchId && bm?.get(batchId)) || '';
      const secondary = (fileId && um?.get(fileId)) || '';
      const tertiary = String((rec as any).id ?? '');
      return { primary, secondary, tertiary };
    },
  };
}

/** Stable prefix used in cell reason text + preserved by the no-source
 *  invariant guard. Internal — do not leak to vendor CSV exports. */
export const SUPERSESSION_REASON_PREFIX = 'Superseded by later BO termination';

/**
 * C2a alignment: suppress owed (unpaid) rows whose policy identity is
 * terminated for the statement month per the latest authoritative BO overlay.
 * NEVER suppresses rows with commission evidence (paid; see reversal rule).
 */
export function filterLatestBoTerminatedOwedRows<T extends { in_commission?: boolean | null }>(
  rows: T[],
  overlay: LatestAuthoritativeBoOverlay,
  statementMonthStartIso: string,
): T[] {
  return rows.filter((r) =>
    r?.in_commission === true || !isPolicyIdentityTerminatedForMonth(r as any, statementMonthStartIso, overlay),
  );
}
