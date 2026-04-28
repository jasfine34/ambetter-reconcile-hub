/**
 * Expected EDE filter — replicates the user's manual workbook filter against
 * raw normalized records so the Dashboard's Expected Enrollments card matches
 * the EDE Expected Enrollment Debug panel exactly (e.g. 1,627 for Jan 2026
 * Coverall scope).
 *
 * Why this lives outside reconcile: the reconcile pipeline produces a
 * `is_in_expected_ede_universe` flag, but its count drops slightly because
 * Union-Find can collapse two qualified EDE rows into one member_key. The
 * "ground truth" the user validates against is the raw filtered count (one
 * row = one expected enrollment), so we count from raw EDE rows here.
 *
 * Pay-entity scoping rule (mirrors NPN_MAP):
 *   - 'Coverall' → all 3 Coverall NPNs (Jason, Erica, Becky)
 *   - 'Vix'      → only Erica (the only Coverall_or_Vix AOR)
 *   - 'All'      → all 3 (Vix is a subset of Coverall here)
 */
import { NPN_MAP } from './constants';
import { extractNpnFromAorString, isCoverallAORByName } from './agents';
import { lookupResolved, type ResolverIndex } from './resolvedIdentities';
import { pickCurrentPolicyAor } from './aorPicker';
import type { NormalizedRecord } from './normalize';

const QUALIFIED_RAW_STATUSES = new Set([
  'effectuated',
  'pendingeffectuation',
  'pendingtermination',
]);

export type PayEntityScope = 'Coverall' | 'Vix' | 'All';

/** Set of NPNs whose EDE rows belong in the given pay-entity scope. */
function npnSetForScope(scope: PayEntityScope): ReadonlySet<string> {
  if (scope === 'Vix') {
    // Only AORs flagged Coverall_or_Vix (currently just Erica).
    return new Set(
      Object.entries(NPN_MAP)
        .filter(([, v]) => v.expectedPayEntity === 'Coverall_or_Vix')
        .map(([npn]) => npn)
    );
  }
  // Coverall + All include every Coverall AOR.
  return new Set(Object.keys(NPN_MAP));
}

/** True if the raw AOR string belongs in the given scope. */
function isAorInScope(rawAor: string, scope: PayEntityScope): boolean {
  if (!rawAor) return false;
  const npns = npnSetForScope(scope);
  const embeddedNpn = extractNpnFromAorString(rawAor);
  if (embeddedNpn) return npns.has(embeddedNpn);
  // No NPN in the string — fall back to name prefix, then re-check scope.
  if (!isCoverallAORByName(rawAor)) return false;
  if (scope === 'Coverall' || scope === 'All') return true;
  // Vix scope without an embedded NPN: only Erica's name should match.
  const lower = rawAor.toLowerCase();
  return lower.startsWith('erica');
}

export interface FilteredEdeRow {
  member_key: string;
  applicant_name: string;
  policy_number: string;
  exchange_subscriber_id: string;
  issuer_subscriber_id: string;
  current_policy_aor: string;
  effective_date: string;
  policy_status: string;
  covered_member_count: number;
  effective_month: string; // YYYY-MM — the row's ACTUAL effective_date month (NOT span-anchored). Drives the per-month newly-effective breakdown so per-month numbers SUM to the total.
  /**
   * Months within `coveredMonths` during which this EDE record was active
   * (span semantic — an Effectuated EDE row is an ongoing enrollment).
   * Used by classifier/timeline gating. NOTE: per-month breakdowns on the
   * Dashboard count by `effective_month` (newly-effective) instead, so the
   * per-month numbers SUM to the card total — `active_months` would
   * double-count carryover.
   */
  active_months: string[];
  in_back_office: boolean;
  /**
   * If issuer_subscriber_id was filled in from resolved_identities (the row's
   * own value was blank in the source file), this is metadata describing the
   * winning source so the UI can show a small blue "resolved" badge.
   */
  issuer_subscriber_id_resolved?: { source_kind: string; batch_month: string };
}

export interface FilteredEdeResult {
  /** One entry per unique member_key, after dedupe. */
  uniqueMembers: FilteredEdeRow[];
  /** Count of unique member_keys passing the filter (== uniqueMembers.length). */
  uniqueKeys: number;
  /** Members per effective month (YYYY-MM). */
  byMonth: Record<string, number>;
  /** Members in BO. */
  inBOCount: number;
  /** Members NOT in BO. */
  notInBOCount: number;
  /** Members not in BO (drilldown rows). */
  missingFromBO: FilteredEdeRow[];
}

/**
 * Apply the filter to raw normalized records and join to reconciled members for
 * the in_back_office flag.
 *
 * @param normalizedRecords  raw rows from getNormalizedRecords()
 * @param reconciled         post-reconcile members (used for in_back_office lookup)
 * @param scope              pay-entity scope filter
 * @param coveredMonths      ['YYYY-MM', 'YYYY-MM'] — restricts to batch's covered months
 */
export function computeFilteredEde(
  normalizedRecords: any[],
  reconciled: any[],
  scope: PayEntityScope,
  coveredMonths: string[],
  resolverIndex?: ResolverIndex | null,
): FilteredEdeResult {
  // Build a multi-key in_back_office lookup keyed on every ID a reconciled
  // member exposes (issuer_sub_id, exchange_sub_id, policy_number, normalized
  // name). This is necessary because raw normalized_records carry their
  // *pre-Union-Find* member_key (assigned at normalize time), while
  // reconciled_members carry the *post-Union-Find* member_key. A direct
  // member_key→reconciled lookup misses ~all of them, which is what made
  // "Not in Back Office" report ~1,167 instead of the true ~76.
  //
  // By indexing every ID the reconciled member knows about, we replay the
  // union-find result and tie out exactly to the Source Funnel EDE → BO gap.
  const boByCandidateKey = new Map<string, boolean>();
  const memberKeyByCandidate = new Map<string, string>();
  const registerCandidate = (key: string, m: any) => {
    if (!key) return;
    // First wins (stable). Real conflicts are vanishingly rare since reconcile
    // already collapsed by these IDs.
    if (!boByCandidateKey.has(key)) {
      boByCandidateKey.set(key, !!m.in_back_office);
      memberKeyByCandidate.set(key, m.member_key);
    }
  };
  for (const m of reconciled) {
    if (m.issuer_subscriber_id) registerCandidate(`issub:${m.issuer_subscriber_id}`, m);
    if (m.exchange_subscriber_id) registerCandidate(`sub:${m.exchange_subscriber_id}`, m);
    if (m.policy_number) registerCandidate(`policy:${m.policy_number}`, m);
    if (m.applicant_name) registerCandidate(`name:${normalizeFullName(m.applicant_name)}`, m);
    // Direct member_key fallback (handles `grp:N` synthetic keys from reconcile).
    registerCandidate(m.member_key, m);
  }

  /** Same priority order reconcile uses to pick a group's member_key. */
  function lookupReconciled(r: any, raw: Record<string, any>): { key: string; inBO: boolean } {
    const issub = String(raw.issuerSubscriberId ?? r.issuer_subscriber_id ?? '').trim();
    if (issub) {
      const k = `issub:${issub}`;
      if (boByCandidateKey.has(k)) return { key: memberKeyByCandidate.get(k)!, inBO: boByCandidateKey.get(k)! };
    }
    const exsub = String(raw.exchangeSubscriberId ?? r.exchange_subscriber_id ?? '').trim();
    if (exsub) {
      const k = `sub:${exsub}`;
      if (boByCandidateKey.has(k)) return { key: memberKeyByCandidate.get(k)!, inBO: boByCandidateKey.get(k)! };
    }
    const polNum = String(r.policy_number ?? raw.exchangePolicyId ?? '').trim();
    if (polNum) {
      const k = `policy:${polNum}`;
      if (boByCandidateKey.has(k)) return { key: memberKeyByCandidate.get(k)!, inBO: boByCandidateKey.get(k)! };
    }
    const name = normalizeFullName(r.applicant_name);
    if (name) {
      const k = `name:${name}`;
      if (boByCandidateKey.has(k)) return { key: memberKeyByCandidate.get(k)!, inBO: boByCandidateKey.get(k)! };
    }
    // Last-ditch: try the raw record's stored member_key (works only if
    // reconcile didn't merge this record into a different group).
    const ownKey = r.member_key || '';
    if (ownKey && boByCandidateKey.has(ownKey)) {
      return { key: memberKeyByCandidate.get(ownKey)!, inBO: boByCandidateKey.get(ownKey)! };
    }
    return { key: ownKey || `unmatched:${r.id ?? Math.random()}`, inBO: false };
  }

  const sortedCovered = coveredMonths.filter(Boolean).slice().sort();
  const earliestCovered = sortedCovered[0] ?? '';
  const latestCovered = sortedCovered[sortedCovered.length - 1] ?? '';

  // Pass 1: collect qualified Ambetter EDE rows, grouped by *resolved*
  // member_key. NO scope filter here — we need the member's full EDE row set
  // so the canonical AOR picker (aorPicker.pickCurrentPolicyAor) sees the
  // same rows reconcile sees. Scope is decided per-member in pass 2 against
  // the picked AOR. This is the Option A alignment fix (2026-04-28).
  interface PerRowCtx {
    raw: Record<string, any>;
    rec: any;
    effMonth: string;
    activeMonths: string[];
    displayIsid: string;
    isidResolvedMeta?: { source_kind: string; batch_month: string };
    rawAor: string;
  }
  const groups = new Map<string, { ctxs: PerRowCtx[]; inBO: boolean }>();

  const sortedCovered = coveredMonths.filter(Boolean).slice().sort();
  const earliestCovered = sortedCovered[0] ?? '';
  const latestCovered = sortedCovered[sortedCovered.length - 1] ?? '';

  for (const r of normalizedRecords) {
    if (r.source_type !== 'EDE') continue;

    const raw = (r.raw_json || {}) as Record<string, any>;

    // Issuer must be Ambetter
    const issuer = String(raw.issuer ?? r.carrier ?? '').toLowerCase();
    if (!issuer.includes('ambetter')) continue;

    // Status must be qualified
    const status = String(raw.policyStatus ?? r.status ?? '')
      .toLowerCase()
      .replace(/\s+/g, '');
    if (!QUALIFIED_RAW_STATUSES.has(status)) continue;

    // Effective date required
    const effDate = r.effective_date as string | null;
    if (!effDate) continue;
    const effMonth = effDate.substring(0, 7);

    // Span-overlap with covered months
    const termRaw = String(raw.policyTermDate ?? raw.policy_term_date ?? r.policy_term_date ?? '').trim();
    const termMonth = termRaw ? termRaw.substring(0, 7) : '';
    if (sortedCovered.length > 0) {
      if (effMonth > latestCovered) continue;
      if (termMonth && termMonth <= earliestCovered) continue;
    }
    const activeMonths: string[] = [];
    for (const m of sortedCovered) {
      if (m < effMonth) continue;
      if (termMonth && m >= termMonth) continue;
      activeMonths.push(m);
    }
    if (sortedCovered.length > 0 && activeMonths.length === 0) continue;

    // Resolved-identity overlay (cross-batch isid resolution).
    const ownIsid = String(raw.issuerSubscriberId ?? r.issuer_subscriber_id ?? '').trim();
    let displayIsid = ownIsid;
    let isidResolvedMeta: { source_kind: string; batch_month: string } | undefined;
    let lookupRecord: any = r;
    if (!ownIsid && resolverIndex && resolverIndex.totalRows > 0) {
      const hit = lookupResolved(r, resolverIndex);
      if (hit?.resolved_issuer_subscriber_id) {
        displayIsid = hit.resolved_issuer_subscriber_id;
        isidResolvedMeta = {
          source_kind: hit.source_kind ?? 'unknown',
          batch_month: hit.source_batch_month ?? '',
        };
        lookupRecord = { ...r, issuer_subscriber_id: hit.resolved_issuer_subscriber_id };
      }
    }

    const { key: resolvedKey, inBO } = lookupReconciled(
      lookupRecord,
      lookupRecord === r ? raw : { ...raw, issuerSubscriberId: displayIsid },
    );

    const rawAor = String(raw.currentPolicyAOR ?? '').trim();
    const ctx: PerRowCtx = { raw, rec: r, effMonth, activeMonths, displayIsid, isidResolvedMeta, rawAor };
    const g = groups.get(resolvedKey);
    if (g) {
      g.ctxs.push(ctx);
      g.inBO = g.inBO || inBO;
    } else {
      groups.set(resolvedKey, { ctxs: [ctx], inBO });
    }
  }

  // Pass 2: per member, pick the canonical AOR via aorPicker — the SAME
  // sort order reconcile.ts uses to write reconciled.current_policy_aor.
  // Then check scope on the picked AOR. This guarantees EE universe and
  // reconciled.current_policy_aor agree on every member.
  const byKey = new Map<string, FilteredEdeRow>();

  for (const [resolvedKey, group] of groups) {
    // Build NormalizedRecord-shaped array for the picker. The picker reads
    // source_type, raw_json.policyStatus, effective_date, source_file_label,
    // and raw_json.currentPolicyAOR — all already on r.
    const recs = group.ctxs.map((c) => c.rec) as NormalizedRecord[];
    const pickedAor = pickCurrentPolicyAor(recs);
    if (!isAorInScope(pickedAor, scope)) continue;

    // Member is in scope. Build the FilteredEdeRow by merging the member's
    // qualifying EDE rows (same merge semantics as before — earliest
    // effective month wins, union of active months).
    let winner: PerRowCtx | null = null;
    const allActive = new Set<string>();
    let earliestEff = '';
    for (const c of group.ctxs) {
      for (const m of c.activeMonths) allActive.add(m);
      if (!earliestEff || (c.effMonth && c.effMonth < earliestEff)) earliestEff = c.effMonth;
      if (!winner) {
        winner = c;
      } else if (c.effMonth && c.effMonth < winner.effMonth) {
        winner = c;
      }
    }
    if (!winner) continue;
    const w = winner;
    const wraw = w.raw;
    const wrec = w.rec;

    const cmcRaw = wraw.coveredMemberCount ?? wraw.CoveredMemberCount ?? wraw.covered_member_count;
    const cmcParsed = cmcRaw != null && String(cmcRaw).trim() !== '' ? parseInt(String(cmcRaw), 10) : NaN;
    const coveredMembers = Number.isFinite(cmcParsed) && cmcParsed > 0 ? cmcParsed : 1;

    byKey.set(resolvedKey, {
      member_key: resolvedKey,
      applicant_name: wrec.applicant_name ?? '',
      policy_number: String(wraw.exchangePolicyId ?? wrec.exchange_policy_id ?? wrec.policy_number ?? ''),
      exchange_subscriber_id: String(wraw.exchangeSubscriberId ?? wrec.exchange_subscriber_id ?? ''),
      issuer_subscriber_id: w.displayIsid,
      // Surface the PICKED canonical AOR — this is what reconciled.current_policy_aor
      // will hold for this member. EE universe and reconciled now agree by construction.
      current_policy_aor: pickedAor,
      effective_date: String(wraw.effectiveDate ?? wrec.effective_date ?? ''),
      policy_status: String(wraw.policyStatus ?? wrec.status ?? ''),
      covered_member_count: coveredMembers,
      effective_month: earliestEff || w.effMonth,
      active_months: Array.from(allActive).sort(),
      in_back_office: group.inBO,
      issuer_subscriber_id_resolved: w.isidResolvedMeta,
    });
  }

  const uniqueMembers = Array.from(byKey.values());
  const byMonth: Record<string, number> = {};
  for (const r of uniqueMembers) {
    const m = r.effective_month;
    if (!m) continue;
    byMonth[m] = (byMonth[m] ?? 0) + 1;
  }

  const missingFromBO = uniqueMembers.filter(r => !r.in_back_office);
  const inBOCount = uniqueMembers.length - missingFromBO.length;

  return {
    uniqueMembers,
    uniqueKeys: uniqueMembers.length,
    byMonth,
    inBOCount,
    notInBOCount: missingFromBO.length,
    missingFromBO,
  };
}

/** Same as reconcile.ts — kept inline to avoid an import cycle. */
function normalizeFullName(applicantName: string | undefined | null): string {
  if (!applicantName) return '';
  return applicantName.trim().toLowerCase().replace(/[^a-z]/g, '');
}
