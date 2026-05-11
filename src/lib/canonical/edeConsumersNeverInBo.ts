/**
 * EDE Consumers Never Found in Back Office (Phase 1.8 canonical helper).
 *
 * Business definition (Jason, 2026-05-11):
 *   Members who had qualified Ambetter EDE evidence under our AOR but no
 *   usable Back Office record found anywhere in the available data —
 *   active OR historical.
 *
 * Why this replaces the issue_type='Missing from Back Office' Exception
 * Summary card:
 *   - The persisted predicate gates on raw `inEde` (any EDE row) and `inBo`
 *     (only ACTIVE BO via isActiveBackOfficeRecord). That sweeps in:
 *       - cancelled / non-qualified EDE statuses
 *       - future-effective rows beyond the latest covered month
 *       - members whose AOR is outside the selected scope
 *       - members with HISTORICAL BO records that later terminated /
 *         inactivated (BO presence exists; just not currently active)
 *   - Operationally this conflates "needs BO intervention" with normal
 *     churn, AOR routing, and stale enum carryover. This helper enforces
 *     the strict reading: any BO record at all → excluded.
 *
 * Predicates (ALL must hold):
 *   (a) Source row is an EDE record with carrier=Ambetter and qualified
 *       status (Effectuated / PendingEffectuation / PendingTermination).
 *   (b) Effective month is ≤ the latest covered month (future-effective
 *       rows are excluded — they're next-batch business, not recovery).
 *   (c) Canonical pickCurrentPolicyAor over the member's EDE rows resolves
 *       to an AOR in the selected scope via isAorInScope.
 *   (d) The member has ZERO matching Back Office records in
 *       normalizedRecords — joined across issuer_subscriber_id,
 *       exchange_subscriber_id, policy_number, normalized name, and any
 *       reconciled member_key candidate. NO isActiveBackOfficeRecord gate.
 *   (e) Member is not currently in the Expected Enrollments universe
 *       (filteredEde.uniqueMembers) — those are the top "Not in Back
 *       Office" card and stay on that card.
 *   (f) Member is not a confirmed weak-match upgrade
 *       (confirmedUpgradeMemberKeys).
 *
 * Returned rows are a strict superset relaxation of the top NotInBO card
 * (drops the covered-month span gate, keeps every other gate) and are
 * disjoint from `getNotInBackOfficeRows(filteredEde, …)` by construction.
 * That disjointness is locked by the `ede-consumers-never-in-bo-disjoint-
 * from-current-not-in-bo` runtime invariant.
 */
import {
  type PayEntityScope,
  QUALIFIED_RAW_STATUSES,
  isAorInScope,
} from '../expectedEde';
import { pickCurrentPolicyAor } from '../aorPicker';
import type { NormalizedRecord } from '../normalize';

export interface EdeConsumerNeverInBoRow {
  member_key: string;
  applicant_name: string;
  policy_number: string;
  exchange_subscriber_id: string;
  issuer_subscriber_id: string;
  current_policy_aor: string;
  effective_date: string;
  policy_status: string;
  effective_month: string;
}

export interface EdeConsumersNeverInBoResult {
  rows: EdeConsumerNeverInBoRow[];
  count: number;
}

function normalizeFullName(name: string | undefined | null): string {
  if (!name) return '';
  return name.trim().toLowerCase().replace(/[^a-z]/g, '');
}

/**
 * Canonical helper. See module-level doc-comment for the predicate.
 */
export function getEdeConsumersNeverFoundInBackOffice(
  normalizedRecords: any[],
  reconciled: any[],
  scope: PayEntityScope,
  filteredEde: FilteredEdeResult,
  confirmedUpgradeMemberKeys: Set<string>,
  coveredMonths: string[],
): EdeConsumersNeverInBoResult {
  // ----- BO presence index -----
  // ANY back-office record presence (active or terminated) excludes the
  // member. Index by every candidate key the source files might carry.
  const boIssuer = new Set<string>();
  const boExch = new Set<string>();
  const boPolicy = new Set<string>();
  const boName = new Set<string>();
  const boMemberKey = new Set<string>();
  for (const rec of normalizedRecords) {
    if (rec.source_type !== 'BACK_OFFICE') continue;
    const iss = String(rec.issuer_subscriber_id ?? rec.raw_json?.issuerSubscriberId ?? '').trim();
    if (iss) boIssuer.add(iss);
    const exch = String(rec.exchange_subscriber_id ?? rec.raw_json?.exchangeSubscriberId ?? '').trim();
    if (exch) boExch.add(exch);
    const pol = String(rec.policy_number ?? rec.raw_json?.exchangePolicyId ?? '').trim();
    if (pol) boPolicy.add(pol);
    const nm = normalizeFullName(rec.applicant_name);
    if (nm) boName.add(nm);
    const mk = String(rec.member_key ?? '').trim();
    if (mk) boMemberKey.add(mk);
  }

  // Reconciled-member ID alias map: a single reconciled member_key may carry
  // multiple ID candidates (post-Union-Find). We use this to attribute every
  // EDE row to its post-merge member_key so we don't fragment one member
  // across multiple candidate IDs.
  const reconciledByCandidate = new Map<string, string>();
  for (const m of reconciled) {
    if (m.issuer_subscriber_id) reconciledByCandidate.set(`issub:${m.issuer_subscriber_id}`, m.member_key);
    if (m.exchange_subscriber_id) reconciledByCandidate.set(`sub:${m.exchange_subscriber_id}`, m.member_key);
    if (m.policy_number) reconciledByCandidate.set(`policy:${m.policy_number}`, m.member_key);
    if (m.applicant_name) reconciledByCandidate.set(`name:${normalizeFullName(m.applicant_name)}`, m.member_key);
    if (m.member_key) reconciledByCandidate.set(m.member_key, m.member_key);
  }
  const resolveMemberKey = (r: any, raw: Record<string, any>): string => {
    const iss = String(raw.issuerSubscriberId ?? r.issuer_subscriber_id ?? '').trim();
    if (iss && reconciledByCandidate.has(`issub:${iss}`)) return reconciledByCandidate.get(`issub:${iss}`)!;
    const exch = String(raw.exchangeSubscriberId ?? r.exchange_subscriber_id ?? '').trim();
    if (exch && reconciledByCandidate.has(`sub:${exch}`)) return reconciledByCandidate.get(`sub:${exch}`)!;
    const pol = String(raw.exchangePolicyId ?? r.policy_number ?? '').trim();
    if (pol && reconciledByCandidate.has(`policy:${pol}`)) return reconciledByCandidate.get(`policy:${pol}`)!;
    const nm = normalizeFullName(r.applicant_name);
    if (nm && reconciledByCandidate.has(`name:${nm}`)) return reconciledByCandidate.get(`name:${nm}`)!;
    if (r.member_key && reconciledByCandidate.has(r.member_key)) return reconciledByCandidate.get(r.member_key)!;
    return r.member_key || `unmatched:${r.id ?? Math.random()}`;
  };

  const sortedCovered = coveredMonths.filter(Boolean).slice().sort();
  const latestCovered = sortedCovered[sortedCovered.length - 1] ?? '';

  // Group qualified Ambetter EDE rows by resolved member_key.
  interface Ctx { r: any; raw: Record<string, any>; effMonth: string }
  const groups = new Map<string, { ctxs: Ctx[]; hasBoRecord: boolean }>();
  for (const r of normalizedRecords) {
    if (r.source_type !== 'EDE') continue;
    const raw = (r.raw_json || {}) as Record<string, any>;
    const issuer = String(raw.issuer ?? r.carrier ?? '').toLowerCase();
    if (!issuer.includes('ambetter')) continue;
    const status = String(raw.policyStatus ?? r.status ?? '').toLowerCase().replace(/\s+/g, '');
    if (!QUALIFIED_RAW_STATUSES.has(status)) continue;
    const effDate = (r.effective_date as string | null) ?? '';
    if (!effDate) continue;
    const effMonth = effDate.substring(0, 7);
    // Exclude future-effective rows past the latest covered month.
    if (latestCovered && effMonth > latestCovered) continue;

    const memberKey = resolveMemberKey(r, raw);

    // BO presence check — any single hit excludes the member.
    const iss = String(raw.issuerSubscriberId ?? r.issuer_subscriber_id ?? '').trim();
    const exch = String(raw.exchangeSubscriberId ?? r.exchange_subscriber_id ?? '').trim();
    const pol = String(raw.exchangePolicyId ?? r.policy_number ?? '').trim();
    const nm = normalizeFullName(r.applicant_name);
    const hasBoRecord =
      (!!iss && boIssuer.has(iss)) ||
      (!!exch && boExch.has(exch)) ||
      (!!pol && boPolicy.has(pol)) ||
      (!!nm && boName.has(nm)) ||
      boMemberKey.has(memberKey);

    const ctx: Ctx = { r, raw, effMonth };
    const g = groups.get(memberKey);
    if (g) {
      g.ctxs.push(ctx);
      g.hasBoRecord = g.hasBoRecord || hasBoRecord;
    } else {
      groups.set(memberKey, { ctxs: [ctx], hasBoRecord });
    }
  }

  // Current EE universe members are owned by the top NotInBO card; exclude
  // them here so the two cards are disjoint by construction.
  const eeUniverse = new Set(filteredEde.uniqueMembers.map((m) => m.member_key));

  const rows: EdeConsumerNeverInBoRow[] = [];
  for (const [memberKey, group] of groups) {
    if (group.hasBoRecord) continue;
    if (eeUniverse.has(memberKey)) continue;
    if (confirmedUpgradeMemberKeys.has(memberKey)) continue;

    // Canonical AOR pick over the member's EDE rows (same picker reconcile
    // uses for current_policy_aor) — then scope-gate on the picked AOR.
    const recs = group.ctxs.map((c) => c.r) as NormalizedRecord[];
    const pickedAor = pickCurrentPolicyAor(recs);
    if (!isAorInScope(pickedAor, scope)) continue;

    // Winner = earliest qualifying effective month (stable, descriptive).
    let winner = group.ctxs[0];
    for (const c of group.ctxs) {
      if (c.effMonth && (!winner.effMonth || c.effMonth < winner.effMonth)) winner = c;
    }
    const w = winner;
    rows.push({
      member_key: memberKey,
      applicant_name: String(w.r.applicant_name ?? ''),
      policy_number: String(w.raw.exchangePolicyId ?? w.r.policy_number ?? ''),
      exchange_subscriber_id: String(w.raw.exchangeSubscriberId ?? w.r.exchange_subscriber_id ?? ''),
      issuer_subscriber_id: String(w.raw.issuerSubscriberId ?? w.r.issuer_subscriber_id ?? ''),
      current_policy_aor: pickedAor,
      effective_date: String(w.raw.effectiveDate ?? w.r.effective_date ?? ''),
      policy_status: String(w.raw.policyStatus ?? w.r.status ?? ''),
      effective_month: w.effMonth,
    });
  }

  return { rows, count: rows.length };
}
