/**
 * Weak-match detection for the EE Universe → Found-in-BO gap.
 *
 * Background (2026-04-27): the Dashboard reports a small population of EE
 * members (Mar 2026 Coverall ≈ 57) that are in the Expected Enrollments
 * universe but in NEITHER the Found-in-BO bucket (`is_in_expected_ede_universe
 * && in_back_office`) NOR the actionable Not-in-BO bucket (members where the
 * matcher confirmed no BO sibling exists). These are members where SOME BO
 * record exists (matches name+DOB or fuzzy IDs) but the strict member_key
 * join failed — algorithmic weak matches, not lost members.
 *
 * This module:
 *   1. Identifies weak-match candidates from raw normalized_records.
 *   2. Reads the persistent `weak_match_overrides` table.
 *   3. Applies overrides:
 *        - decision='confirmed' UPGRADES the EE row to in_back_office
 *        - decision='rejected' DEMOTES it back to actionable Not-in-BO
 *        - decision='deferred' or no override → stays in weak-match queue
 *
 * Stable identity key (override_key) priority order:
 *   1. issuer_subscriber_id  (the de-facto ffmAppId on Ambetter rows)
 *   2. exchange_subscriber_id
 *   3. policy_number (cleanId)
 *
 * Never key on member_key — Union-Find can shift it across rebuilds.
 *
 * Note on signals: the spec mentions DOB as one of the matching signals, but
 * MyMFG EDE exports never carry DOB (universally null). We use the available
 * subset of {applicant_name normalized, exchange_subscriber_id,
 * policy_number cleanId, issuer_subscriber_id} and require ≥2 matches.
 */
import { supabase } from '@/integrations/supabase/client';
import { cleanId, cleanSubscriberId } from './normalize';
import type { FilteredEdeRow } from './expectedEde';

export type WeakMatchDecision = 'confirmed' | 'rejected' | 'deferred';

export interface WeakMatchOverride {
  id: string;
  override_key: string;
  candidate_bo_member_key: string | null;
  candidate_bo_stable_key: string | null;
  decision: WeakMatchDecision;
  decided_by: string | null;
  decided_at: string;
  notes: string | null;
  signals: Record<string, unknown> | null;
}

export interface WeakMatchSignals {
  /** Which fields matched between the EDE row and the BO candidate. */
  matched: string[];
  /** Which fields differed (non-empty on both sides but unequal). */
  differed: string[];
  /** Which fields could not be compared (blank on either side). */
  unknown: string[];
}

export interface WeakMatchCandidate {
  /** Stable id for the EE-side row (priority: issuer_sub_id, exch_sub_id, policy#). */
  override_key: string;
  /** EDE/EE-universe row that failed the strict join. */
  ede: FilteredEdeRow;
  /** Best BO candidate (highest signal count). */
  boCandidate: {
    /** The BO normalized record's id (for cross-reference / display). */
    record_id: string;
    member_key: string;
    /** Stable id for the BO candidate (same priority order). */
    stable_key: string;
    applicant_name: string;
    policy_number: string;
    exchange_subscriber_id: string;
    issuer_subscriber_id: string;
    aor_bucket: string;
    agent_name: string;
    state: string;
    eligible_for_commission: string;
  };
  signals: WeakMatchSignals;
}

/** Pick the stable identity key for a row in priority order. */
export function pickStableKey(opts: {
  issuer_subscriber_id?: string | null;
  exchange_subscriber_id?: string | null;
  policy_number?: string | null;
}): string {
  const isid = String(opts.issuer_subscriber_id ?? '').trim();
  if (isid) return `issub:${cleanSubscriberId(isid)}`;
  const esid = String(opts.exchange_subscriber_id ?? '').trim();
  if (esid) return `sub:${cleanSubscriberId(esid)}`;
  const pn = String(opts.policy_number ?? '').trim();
  if (pn) return `policy:${cleanId(pn)}`;
  return '';
}

/** Lower-case alpha-only normalized name for fuzzy comparison. */
function normName(name: string | undefined | null): string {
  if (!name) return '';
  return name.trim().toLowerCase().replace(/[^a-z]/g, '');
}

/**
 * Compute weak-match candidates: EE-universe members whose strict join to BO
 * failed BUT at least one BO record matches on ≥2 of the available signals.
 *
 * @param eeUniverse   filteredEde.uniqueMembers (EE-universe rows)
 * @param normalizedRecords  raw normalized_records for the batch
 *
 * Returns one candidate per EE member (the best BO candidate by signal count).
 * Members already in `in_back_office` are excluded.
 */
export function findWeakMatches(
  eeUniverse: FilteredEdeRow[],
  normalizedRecords: any[],
): WeakMatchCandidate[] {
  // Index BO records by every signal we can match on.
  const boByName = new Map<string, any[]>();
  const boByEsid = new Map<string, any[]>();
  const boByIsid = new Map<string, any[]>();
  const boByPolicy = new Map<string, any[]>();

  const push = (m: Map<string, any[]>, k: string, r: any) => {
    if (!k) return;
    const arr = m.get(k);
    if (arr) arr.push(r);
    else m.set(k, [r]);
  };

  for (const r of normalizedRecords) {
    if (r.source_type !== 'BACK_OFFICE') continue;
    const nm = normName(r.applicant_name);
    if (nm) push(boByName, nm, r);
    if (r.exchange_subscriber_id) push(boByEsid, cleanSubscriberId(r.exchange_subscriber_id), r);
    if (r.issuer_subscriber_id) push(boByIsid, cleanSubscriberId(r.issuer_subscriber_id), r);
    if (r.policy_number) push(boByPolicy, cleanId(r.policy_number), r);
  }

  const candidates: WeakMatchCandidate[] = [];

  for (const fe of eeUniverse) {
    // Strict-found members are excluded — they're already in the Found-in-BO
    // bucket via the EE Universe Audit's lookup.
    if (fe.in_back_office) continue;

    // Gather candidate BO records via every available signal from the EE row.
    const seen = new Map<string, any>();
    const consider = (rs: any[] | undefined) => {
      if (!rs) return;
      for (const r of rs) seen.set(r.id, r);
    };
    consider(boByName.get(normName(fe.applicant_name)));
    if (fe.exchange_subscriber_id) consider(boByEsid.get(cleanSubscriberId(fe.exchange_subscriber_id)));
    if (fe.issuer_subscriber_id) consider(boByIsid.get(cleanSubscriberId(fe.issuer_subscriber_id)));
    if (fe.policy_number) consider(boByPolicy.get(cleanId(fe.policy_number)));

    if (seen.size === 0) continue; // genuine Not-in-BO — not a weak match

    // Score every candidate; keep the one with the highest signal count
    // (≥2 required). Ties broken by name match presence.
    let best: { rec: any; signals: WeakMatchSignals; score: number } | null = null;
    for (const r of seen.values()) {
      const matched: string[] = [];
      const differed: string[] = [];
      const unknown: string[] = [];

      // applicant_name
      const feName = normName(fe.applicant_name);
      const boName = normName(r.applicant_name);
      if (feName && boName) {
        if (feName === boName) matched.push('applicant_name');
        else differed.push('applicant_name');
      } else unknown.push('applicant_name');

      // exchange_subscriber_id
      const feE = cleanSubscriberId(fe.exchange_subscriber_id);
      const boE = cleanSubscriberId(r.exchange_subscriber_id);
      if (feE && boE) {
        if (feE === boE) matched.push('exchange_subscriber_id');
        else differed.push('exchange_subscriber_id');
      } else unknown.push('exchange_subscriber_id');

      // issuer_subscriber_id (the de-facto ffmAppId)
      const feI = cleanSubscriberId(fe.issuer_subscriber_id);
      const boI = cleanSubscriberId(r.issuer_subscriber_id);
      if (feI && boI) {
        if (feI === boI) matched.push('issuer_subscriber_id');
        else differed.push('issuer_subscriber_id');
      } else unknown.push('issuer_subscriber_id');

      // policy_number (cleanId — strips suffix)
      const feP = cleanId(fe.policy_number);
      const boP = cleanId(r.policy_number);
      if (feP && boP) {
        if (feP === boP) matched.push('policy_number');
        else differed.push('policy_number');
      } else unknown.push('policy_number');

      const score = matched.length;
      const tieBreak = matched.includes('applicant_name') ? 0.5 : 0;
      const bestScore = best ? best.score + (best.signals.matched.includes('applicant_name') ? 0.5 : 0) : -1;
      if (score >= 2 && score + tieBreak > bestScore) {
        best = { rec: r, signals: { matched, differed, unknown }, score };
      }
    }

    if (!best) continue;

    const overrideKey = pickStableKey({
      issuer_subscriber_id: fe.issuer_subscriber_id,
      exchange_subscriber_id: fe.exchange_subscriber_id,
      policy_number: fe.policy_number,
    });
    if (!overrideKey) continue;

    const boStableKey = pickStableKey({
      issuer_subscriber_id: best.rec.issuer_subscriber_id,
      exchange_subscriber_id: best.rec.exchange_subscriber_id,
      policy_number: best.rec.policy_number,
    });

    const raw = (best.rec.raw_json || {}) as Record<string, any>;
    const state = String(raw['State'] ?? raw['state'] ?? '').trim().toUpperCase();

    candidates.push({
      override_key: overrideKey,
      ede: fe,
      boCandidate: {
        record_id: best.rec.id,
        member_key: best.rec.member_key || '',
        stable_key: boStableKey,
        applicant_name: best.rec.applicant_name || '',
        policy_number: best.rec.policy_number || '',
        exchange_subscriber_id: best.rec.exchange_subscriber_id || '',
        issuer_subscriber_id: best.rec.issuer_subscriber_id || '',
        aor_bucket: best.rec.aor_bucket || '',
        agent_name: best.rec.agent_name || '',
        state,
        eligible_for_commission: best.rec.eligible_for_commission || '',
      },
      signals: best.signals,
    });
  }

  return candidates;
}

/**
 * Load all weak-match overrides from Supabase.
 * Returns a Map keyed by override_key for O(1) lookup. Latest decision wins
 * when multiple rows share an override_key (we order by decided_at DESC).
 */
export async function loadWeakMatchOverrides(): Promise<Map<string, WeakMatchOverride>> {
  const { data, error } = await supabase
    .from('weak_match_overrides')
    .select('*')
    .order('decided_at', { ascending: false });
  if (error) throw error;
  const out = new Map<string, WeakMatchOverride>();
  for (const row of (data ?? []) as WeakMatchOverride[]) {
    if (!out.has(row.override_key)) out.set(row.override_key, row);
  }
  return out;
}

/** Insert a new override row (one decision per call). */
export async function recordWeakMatchOverride(opts: {
  override_key: string;
  candidate_bo_member_key?: string | null;
  candidate_bo_stable_key?: string | null;
  decision: WeakMatchDecision;
  decided_by?: string | null;
  notes?: string | null;
  signals?: WeakMatchSignals | null;
}): Promise<void> {
  const { error } = await supabase.from('weak_match_overrides').insert({
    override_key: opts.override_key,
    candidate_bo_member_key: opts.candidate_bo_member_key ?? null,
    candidate_bo_stable_key: opts.candidate_bo_stable_key ?? null,
    decision: opts.decision,
    decided_by: opts.decided_by ?? null,
    notes: opts.notes ?? null,
    signals: (opts.signals ?? null) as any,
  });
  if (error) throw error;
}

/**
 * Apply weak-match overrides to a list of weak-match candidates.
 * Returns:
 *   - confirmedKeys: override_keys whose decision='confirmed' → upgrade to Found-in-BO
 *   - rejectedKeys:  override_keys whose decision='rejected' → demote to Not-in-BO
 *   - pending:       candidates with no decision OR decision='deferred' → stay in queue
 */
export function applyOverrides(
  candidates: WeakMatchCandidate[],
  overrides: Map<string, WeakMatchOverride>,
): {
  confirmedKeys: Set<string>;
  rejectedKeys: Set<string>;
  pending: WeakMatchCandidate[];
} {
  const confirmedKeys = new Set<string>();
  const rejectedKeys = new Set<string>();
  const pending: WeakMatchCandidate[] = [];
  for (const c of candidates) {
    const ov = overrides.get(c.override_key);
    if (ov?.decision === 'confirmed') {
      confirmedKeys.add(c.override_key);
    } else if (ov?.decision === 'rejected') {
      rejectedKeys.add(c.override_key);
    } else {
      // No override OR deferred → stays in queue
      pending.push(c);
    }
  }
  return { confirmedKeys, rejectedKeys, pending };
}
