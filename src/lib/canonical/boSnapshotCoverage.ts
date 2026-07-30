/**
 * L1 — BO snapshot coverage contract.
 *
 * Absence of a policy from the Back Office universe must be PROVEN by a
 * governing carrier snapshot, never inferred from "we have no rows".
 *
 * Locked temporal rule (mirrors R-INELIG-008 so BO and EDE share one model):
 * for each service month, BO presence is evaluated against the LATEST
 * APPLICABLE (same carrier + same agent bucket) SUCCESSFUL/PROMOTED snapshot
 * whose month is ON-OR-BEFORE that service month (`snapshotMonth <=
 * serviceMonth`, greatest wins; ties broken by deterministic upload/record
 * recency). Consequences:
 *   - a FUTURE snapshot never establishes absence for earlier months;
 *   - a snapshot for a DIFFERENT agent bucket never establishes absence;
 *   - a failed / staged / partial / non-promoted upload never establishes
 *     absence;
 *   - missing snapshot metadata ⇒ `unknown`, never `authoritatively_absent`;
 *   - reappearance: each month judges against its OWN governing snapshot.
 *
 * "Successful/promoted" derives from EXISTING canonical predicates only:
 * the associated `uploaded_files.staging_status = 'active'` AND
 * `uploaded_files.superseded_at IS NULL`; the presence set is built ONLY from
 * normalized rows that are themselves canonically active. No new completeness
 * flag is invented or persisted.
 *
 * This module is pure — no React, no Supabase, no loaders.
 */
import type { NormalizedRecord } from '../normalize';
import { derivePolicyIdentityKey } from './policyIdentityKey';
import { canonicalCarrier } from '@/lib/carrierCanonical';

export type BoPresence = 'present' | 'authoritatively_absent' | 'unknown';

/** Typed carrier note — exported for L5's future use. L1 emits nothing. */
export const MISSING_BO_CARRIER_NOTE =
  'Member missing from carrier back office; payment could not be verified.';

/** Raw loader shape — one row per BO snapshot. */
export interface BoSnapshotCoverageRow {
  snapshot_id: string;
  carrier: string | null | undefined;
  agent_bucket: string | null | undefined;
  /** Authoritative snapshot date 'YYYY-MM-DD' (uploaded_files.snapshot_date
   *  or bo_snapshots.snapshot_date). */
  snapshot_date: string | null | undefined;
  /** uploaded_files.staging_status === 'active' && superseded_at IS NULL. */
  promoted: boolean;
  /** Deterministic tiebreak within the same snapshot month (created_at ISO). */
  recency?: string | null;
  /** Canonical policy-identity keys present in this snapshot (active rows). */
  policy_keys: string[];
}

export interface BoSnapshotCoverageEntry {
  snapshot_id: string;
  carrierCanonical: string;
  agentBucket: string;
  snapshotMonth: string;
  snapshotDate: string;
  promoted: boolean;
  recency: string;
  keys: Set<string>;
}

export interface BoSnapshotCoverageIndex {
  entries: BoSnapshotCoverageEntry[];
  presenceForPolicyMonth(args: {
    carrier: string | null | undefined;
    agentBucket: string | null | undefined;
    serviceMonth: string;
    policyKey: string;
  }): BoPresence;
}

function normBucket(v: string | null | undefined): string {
  return String(v ?? '').trim().toLowerCase();
}

/** `cc|X` ↔ `cc|sub:X` — same-value sibling identity forms. */
export function siblingPolicyIdentityKey(key: string): string | null {
  const i = key.indexOf('|');
  if (i < 0) return null;
  const cc = key.substring(0, i);
  const rest = key.substring(i + 1);
  if (rest.startsWith('sub:')) return `${cc}|${rest.substring(4)}`;
  return `${cc}|sub:${rest}`;
}

export function buildBoSnapshotCoverage(
  rows: BoSnapshotCoverageRow[],
): BoSnapshotCoverageIndex {
  const entries: BoSnapshotCoverageEntry[] = [];
  for (const r of rows) {
    const cc = canonicalCarrier(r.carrier);
    const date = String(r.snapshot_date ?? '').substring(0, 10);
    if (!cc || date.length < 7) continue; // missing metadata ⇒ contributes nothing
    entries.push({
      snapshot_id: r.snapshot_id,
      carrierCanonical: cc,
      agentBucket: normBucket(r.agent_bucket),
      snapshotMonth: date.substring(0, 7),
      snapshotDate: date,
      promoted: !!r.promoted,
      recency: String(r.recency ?? ''),
      keys: new Set(r.policy_keys ?? []),
    });
  }

  function governing(
    cc: string,
    bucket: string,
    serviceMonth: string,
  ): BoSnapshotCoverageEntry | null {
    let best: BoSnapshotCoverageEntry | null = null;
    for (const e of entries) {
      if (!e.promoted) continue;                        // non-promoted proves nothing
      if (e.carrierCanonical !== cc) continue;
      if (!e.agentBucket || e.agentBucket !== bucket) continue; // wrong/absent bucket
      if (e.snapshotMonth > serviceMonth) continue;     // future never proves absence
      if (!best) { best = e; continue; }
      if (e.snapshotMonth > best.snapshotMonth) { best = e; continue; }
      if (e.snapshotMonth === best.snapshotMonth) {
        const a = `${e.recency}|${e.snapshot_id}`;
        const b = `${best.recency}|${best.snapshot_id}`;
        if (a > b) best = e;
      }
    }
    return best;
  }

  return {
    entries,
    presenceForPolicyMonth({ carrier, agentBucket, serviceMonth, policyKey }) {
      const cc = canonicalCarrier(carrier);
      const bucket = normBucket(agentBucket);
      if (!cc || !bucket || !policyKey || !serviceMonth) return 'unknown';
      const g = governing(cc, bucket, serviceMonth);
      if (!g) return 'unknown';
      if (g.keys.has(policyKey)) return 'present';
      const sib = siblingPolicyIdentityKey(policyKey);
      if (sib && g.keys.has(sib)) return 'present';
      return 'authoritatively_absent';
    },
  };
}

/** Canonical policy-identity key for a record, or '' when unresolvable. */
export function policyIdentityKeyForRecord(r: NormalizedRecord): string {
  const pik = derivePolicyIdentityKey({
    carrier: r.carrier,
    policy_number: r.policy_number,
    issuer_subscriber_id: r.issuer_subscriber_id,
  });
  return pik.status === 'resolved' ? pik.key : '';
}

/**
 * Canonical per-member, per-month BO presence — the ONE value shared by the
 * classifier, MonthCell, the MCE selector and Operator Review.
 *
 * Evaluated over the member's BACK_OFFICE records at canonical policy-identity
 * grain: any policy `present` ⇒ present; else any `unknown` ⇒ unknown; else
 * `authoritatively_absent`. No BO record / no coverage ⇒ `unknown`
 * (fail-open — absence semantics require proof).
 */
export function memberBoPresenceForMonth(
  records: NormalizedRecord[],
  month: string,
  coverage?: BoSnapshotCoverageIndex,
): BoPresence {
  if (!coverage) return 'unknown';
  let sawAbsent = false;
  let sawAny = false;
  for (const r of records) {
    if (r.source_type !== 'BACK_OFFICE') continue;
    const key = policyIdentityKeyForRecord(r);
    if (!key) return 'unknown';
    sawAny = true;
    const p = coverage.presenceForPolicyMonth({
      carrier: r.carrier,
      agentBucket: (r.aor_bucket || r.agent_name) as string,
      serviceMonth: month,
      policyKey: key,
    });
    if (p === 'present') return 'present';
    if (p === 'unknown') return 'unknown';
    sawAbsent = true;
  }
  if (!sawAny) return 'unknown';
  return sawAbsent ? 'authoritatively_absent' : 'unknown';
}
