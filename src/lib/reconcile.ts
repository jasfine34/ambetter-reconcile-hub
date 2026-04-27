import { NPN_MAP, DEFAULT_COMMISSION_ESTIMATE, SBA_STATES } from './constants';
import { cleanId, normalizePolicyStatus } from './normalize';
import type { NormalizedRecord } from './normalize';
import { isCoverallAORByName } from './agents';
import { getCoveredMonths, fallbackReconcileMonth } from './dateRange';
import { lookupResolved, type ResolverIndex } from './resolvedIdentities';

const SBA_STATE_SET: ReadonlySet<string> = new Set(SBA_STATES);

/** True if any BO record in the group has a State column in the SBA list. */
function groupHasSbaStateBo(recs: NormalizedRecord[]): boolean {
  for (const r of recs) {
    if (r.source_type !== 'BACK_OFFICE') continue;
    const raw = (r.raw_json || {}) as Record<string, any>;
    const st = String(raw['State'] ?? raw['state'] ?? '').trim().toUpperCase();
    if (st && SBA_STATE_SET.has(st)) return true;
  }
  return false;
}

// Qualified EDE rows must match user's exact filter, applied to the RAW source
// fields (raw_json) so we replicate the export they validated against.
const QUALIFIED_RAW_STATUSES = new Set([
  'effectuated',
  'pendingeffectuation',
  'pendingtermination',
]);

function rawStatusKey(r: NormalizedRecord): string {
  const raw = (r.raw_json?.['policyStatus'] ?? r.status ?? '') as string;
  return String(raw).toLowerCase().replace(/\s+/g, '');
}

function rawAorKey(r: NormalizedRecord): string {
  const raw = (r.raw_json?.['currentPolicyAOR'] ?? '') as string;
  return String(raw).toLowerCase().trim();
}

function rawIssuerKey(r: NormalizedRecord): string {
  const raw = (r.raw_json?.['issuer'] ?? r.carrier ?? '') as string;
  return String(raw).toLowerCase();
}

/**
 * SPAN SEMANTIC (2026-04-26): an Effectuated EDE row is an ongoing enrollment,
 * not a single-month event. A row qualifies for the "expected EDE universe"
 * for a batch if its active span overlaps the batch's covered months:
 *   include if  effectiveMonth ≤ latestCoveredMonth
 *          AND  (policyTermMonth is null OR policyTermMonth > earliestCoveredMonth)
 * (term date is exclusive — same convention as memberTimeline.ts and BO.)
 *
 * `coveredMonths` is sorted YYYY-MM strings (e.g. ['2026-02','2026-03']).
 */
function isExpectedEDERow(r: NormalizedRecord, coveredMonths: readonly string[]): boolean {
  if (r.source_type !== 'EDE') return false;
  if (!r.effective_date) return false;
  if (coveredMonths.length > 0) {
    const effMonth = r.effective_date.substring(0, 7);
    const earliest = coveredMonths[0];
    const latest = coveredMonths[coveredMonths.length - 1];
    if (effMonth > latest) return false;
    const termMonth = r.policy_term_date ? r.policy_term_date.substring(0, 7) : '';
    if (termMonth && termMonth <= earliest) return false;
  }
  if (!QUALIFIED_RAW_STATUSES.has(rawStatusKey(r))) return false;
  if (!rawIssuerKey(r).includes('ambetter')) return false;
  return isCoverallAORByName(rawAorKey(r));
}

/**
 * First active covered month for a qualified EDE row, given the batch's
 * sorted covered months. Used to anchor `expected_ede_effective_month` to
 * the earliest month in scope where the enrollment was active (rather than
 * the raw effective_date, which may predate the batch window).
 */
function firstActiveCoveredMonth(r: NormalizedRecord, coveredMonths: readonly string[]): string {
  if (!r.effective_date) return '';
  const effMonth = r.effective_date.substring(0, 7);
  const termMonth = r.policy_term_date ? r.policy_term_date.substring(0, 7) : '';
  for (const m of coveredMonths) {
    if (m < effMonth) continue;
    if (termMonth && m >= termMonth) continue;
    return m;
  }
  return effMonth;
}

export interface ReconciledMember {
  member_key: string;
  carrier: string;
  applicant_name: string;
  dob: string | null;
  policy_number: string;
  exchange_subscriber_id: string;
  exchange_policy_id: string;
  issuer_policy_id: string;
  issuer_subscriber_id: string;
  agent_name: string;
  agent_npn: string;
  aor_bucket: string;
  expected_pay_entity: string;
  actual_pay_entity: string;
  in_ede: boolean;
  in_back_office: boolean;
  in_commission: boolean;
  eligible_for_commission: string;
  premium: number | null;
  net_premium: number | null;
  actual_commission: number | null;
  positive_commission: number | null;
  clawback_amount: number | null;
  estimated_missing_commission: number | null;
  issue_type: string;
  issue_notes: string;
  source_count: number;
  commission_record_count: number;
  has_mixed_sources: boolean;
  ede_qualified: boolean;
  is_in_expected_ede_universe: boolean;
  expected_ede_effective_month: string; // '2026-01' | '2026-02' | ''
}

export interface MatchDebugStats {
  totalEDE: number;
  totalBO: number;
  totalComm: number;
  totalRawRecords: number;
  uniqueMemberKeys: number;
  avgRecordsPerKey: number;
  edeWithIssuerSubId: number;
  boStartingWithU: number;
  commStartingWithU: number;
  matchByIssuerSubId: number;
  matchByExchangeSubId: number;
  matchByPolicyNumber: number;
  matchByName: number;
  matchByFallback: number;
  edeStatusBreakdown: Record<string, number>;
  edeQualifiedCount: number;
  edeRawTotal: number;
  edeAfterFilter: number;
  edeUniqueKeysAfterFilter: number;
  edeInvalidDateCount: number;
  edeEffDateSamples: string[];
  // Issuer Sub ID extraction debug
  edeMissingIssuerSubId: number;
  edeMissingIssuerSubIdWithExchange: number;
  edePromotedIssuerSubIdFromExchange: number;
  edeMissingIssuerSubIdSamples: Array<{
    applicant_name: string;
    exchange_subscriber_id: string;
    exchange_policy_id: string;
    source_file_label: string;
  }>;
  // Commission aggregation debug
  commRawRows: number;
  commPositiveRows: number;
  commNegativeRows: number;
  commDistinctPolicyRaw: number;
  commDistinctPolicyNormalized: number;
  commTotalPositive: number;
  commTotalNegative: number;
  commSampleRaw: string[];
  commSampleParsed: number[];
  // Covered lives = sum of coveredMemberCount across qualified EDE rows
  totalCoveredLives: number;
  /**
   * Per-month breakdown of covered lives, keyed on YYYY-MM. Driven by the
   * batch's statement_month via getCoveredMonths() — normally contains two
   * entries (statement month and the prior month). Replaces the older
   * totalCoveredLivesJan / totalCoveredLivesFeb pair that assumed 2026-01/02.
   */
  totalCoveredLivesByMonth: Record<string, number>;
  /** Ordered list of the months this reconciliation covers. */
  coveredMonths: string[];
  boActiveCount: number;
  boExcludedCount: number;
  boMissingTermDate: number;
}

/**
 * Determines if a Back Office record represents an active policy
 * during the reconciliation month.
 * Rules:
 * - If policy_term_date is null/blank → assume active → INCLUDE
 * - If policy_term_date > first day of reconcile month → INCLUDE
 * - If policy_term_date <= first day of reconcile month → EXCLUDE
 * - Falls back to paid_through_date if policy_term_date is absent
 * - Effective date is intentionally ignored — a policy effective 3/1/2023
 *   terminating 12/31/2026 is treated identically to one effective 1/1/2026
 */
function isActiveBackOfficeRecord(r: NormalizedRecord, reconcileMonth: string): boolean {
  if (r.source_type !== 'BACK_OFFICE') return true;
  const firstOfMonth = `${reconcileMonth}-01`;
  const termDate = r.policy_term_date || r.paid_through_date;
  if (!termDate) return true;
  return termDate > firstOfMonth;
}

/**
 * Strip everything after first "-" in a policy/ID, then clean.
 * E.g. "U12345-01" → "u12345", "U12345-AR" → "u12345"
 */
function cleanPolicyBase(val: string | undefined | null): string {
  if (!val) return '';
  let v = val.replace(/^'+/, '').trim();
  // Take only the part before first dash
  const dashIdx = v.indexOf('-');
  if (dashIdx > 0) v = v.substring(0, dashIdx);
  v = v.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');
  return v;
}

/**
 * Normalize a full name for matching: lowercase, remove all non-alpha chars.
 */
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

/**
 * Re-clean IDs on DB records (which may have been stored with older normalization).
 */
function reclean(r: NormalizedRecord): void {
  r.issuer_subscriber_id = cleanPolicyBase(r.issuer_subscriber_id);
  r.exchange_subscriber_id = cleanId(r.exchange_subscriber_id);
  r.exchange_policy_id = cleanId(r.exchange_policy_id);
  r.issuer_policy_id = cleanId(r.issuer_policy_id);
  r.policy_number = cleanPolicyBase(r.policy_number);
  if (r.source_type === 'EDE') {
    r.status = normalizePolicyStatus(r.status);
    if (r.effective_date) {
      const raw = String(r.effective_date).trim();
      const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/);
      if (isoMatch) {
        r.effective_date = `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
      } else {
        const slashMatch = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
        if (slashMatch) {
          let [, m, d, y] = slashMatch;
          let yr = parseInt(y);
          if (yr < 100) yr += 2000;
          r.effective_date = `${yr}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
        }
      }
    }
  }
}

/**
 * Union-Find for merging records into groups via multiple matching strategies.
 *
 * Conflict-aware: each root tracks the set of distinct values it has seen for
 * key strong-ID fields (issuer_subscriber_id, exchange_subscriber_id). A union
 * is REFUSED if it would mix two different non-empty values for any tracked
 * field. This prevents a single bad Back Office row (with cross-linked IDs
 * from two different real members) from collapsing two distinct people into
 * one reconciled group.
 */
interface UnionFindIds {
  isid: Set<string>;
  esid: Set<string>;
}
class UnionFind {
  private parent: number[];
  private ids: UnionFindIds[];
  public refusedMerges: Array<{ a: number; b: number; reason: string }> = [];
  constructor(n: number, records: NormalizedRecord[]) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.ids = records.map(r => ({
      isid: r.issuer_subscriber_id ? new Set([r.issuer_subscriber_id]) : new Set<string>(),
      esid: r.exchange_subscriber_id ? new Set([r.exchange_subscriber_id]) : new Set<string>(),
    }));
  }
  find(x: number): number {
    if (this.parent[x] !== x) this.parent[x] = this.find(this.parent[x]);
    return this.parent[x];
  }
  /** Returns true if merge succeeded, false if refused due to ID conflict. */
  union(a: number, b: number): boolean {
    const ra = this.find(a), rb = this.find(b);
    if (ra === rb) return true;
    const ia = this.ids[ra], ib = this.ids[rb];
    // Check for conflicts on strong-ID fields
    const isidConflict = ia.isid.size > 0 && ib.isid.size > 0 && !setsOverlap(ia.isid, ib.isid);
    const esidConflict = ia.esid.size > 0 && ib.esid.size > 0 && !setsOverlap(ia.esid, ib.esid);
    if (isidConflict || esidConflict) {
      const reason = [
        isidConflict ? `issuer_subscriber_id mismatch (${[...ia.isid].join(',')} vs ${[...ib.isid].join(',')})` : '',
        esidConflict ? `exchange_subscriber_id mismatch (${[...ia.esid].join(',')} vs ${[...ib.esid].join(',')})` : '',
      ].filter(Boolean).join('; ');
      this.refusedMerges.push({ a, b, reason });
      return false;
    }
    // Merge: rb becomes new root, fold ra's id sets into rb
    this.parent[ra] = rb;
    for (const v of ia.isid) ib.isid.add(v);
    for (const v of ia.esid) ib.esid.add(v);
    return true;
  }
}

function setsOverlap(a: Set<string>, b: Set<string>): boolean {
  for (const v of a) if (b.has(v)) return true;
  return false;
}

export function reconcile(
  records: NormalizedRecord[],
  reconcileMonth: string = fallbackReconcileMonth(),
  resolverIndex?: ResolverIndex | null,
): { members: ReconciledMember[]; debug: MatchDebugStats } {
  // Derive the covered month window for this batch. For Feb 2026 (statement
  // month = 2026-02) this is ['2026-01','2026-02'] — the prior month plus
  // the statement month. See src/lib/dateRange.ts and §8 of ARCHITECTURE_PLAN.
  const coveredMonths = getCoveredMonths(reconcileMonth);
  // SPAN SEMANTIC (2026-04-26): EDE universe is now scope-checked against the
  // batch's covered-month *window*, not a discrete set of effective dates.
  // See isExpectedEDERow() for the span rule.
  const sortedCoveredMonths: readonly string[] = coveredMonths.slice().sort();

  // Step 1: Re-clean all IDs
  for (const r of records) {
    reclean(r);
  }

  // Step 1a: cross-batch identity overlay (sidecar). Read-through only —
  // fills in issuer_subscriber_id / issuer_policy_id / exchange_policy_id
  // when the record's own field is blank AND a resolved value exists in
  // resolved_identities (keyed by ffmAppId, then exchangeSubscriberId
  // fallback). Originals on disk stay byte-for-byte intact; this just
  // mutates the in-memory copy reconcile is about to consume so blank
  // EDE rows can join the right Union-Find group.
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


  // Step 1b: Promote issuer_subscriber_id for EDE rows that are missing it
  // when a sibling COMMISSION/BACK_OFFICE record (matched by exchange_subscriber_id,
  // exchange_policy_id, or policy_number) carries a valid "U" sub id.
  // This recovers cases where EDE export omitted the issuerSubscriberId column.
  //
  // IMPORTANT: skip non-EDE rows whose own (esid, isid) pair would cross-link
  // two different EDE members — those rows would propagate the wrong U-id onto
  // an EDE Summary record that's actually a different person. We detect this
  // using the ORIGINAL (pre-promotion) EDE id maps.
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
    if (isCrossLinkedNonEde(r)) continue; // poisonous source: don't propagate its IDs
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
  let promotedCount = 0;
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
      promotedCount++;
    }
  }

  // Step 2: Count raw stats
  const debug: MatchDebugStats = {
    totalEDE: 0, totalBO: 0, totalComm: 0,
    totalRawRecords: records.length,
    uniqueMemberKeys: 0, avgRecordsPerKey: 0,
    edeWithIssuerSubId: 0, boStartingWithU: 0, commStartingWithU: 0,
    matchByIssuerSubId: 0, matchByExchangeSubId: 0, matchByPolicyNumber: 0, matchByName: 0, matchByFallback: 0,
    edeStatusBreakdown: {},
    edeQualifiedCount: 0,
    edeRawTotal: 0,
    edeAfterFilter: 0,
    edeUniqueKeysAfterFilter: 0,
    edeInvalidDateCount: 0,
    edeEffDateSamples: [],
    edeMissingIssuerSubId: 0,
    edeMissingIssuerSubIdWithExchange: 0,
    edePromotedIssuerSubIdFromExchange: 0,
    edeMissingIssuerSubIdSamples: [],
    commRawRows: 0,
    commPositiveRows: 0,
    commNegativeRows: 0,
    commDistinctPolicyRaw: 0,
    commDistinctPolicyNormalized: 0,
    commTotalPositive: 0,
    commTotalNegative: 0,
    commSampleRaw: [],
    commSampleParsed: [],
    totalCoveredLives: 0,
    totalCoveredLivesByMonth: Object.fromEntries(coveredMonths.map(m => [m, 0])),
    coveredMonths,
    boActiveCount: 0,
    boExcludedCount: 0,
    boMissingTermDate: 0,
  };

  debug.edePromotedIssuerSubIdFromExchange = promotedCount;

  for (const r of records) {
    if (r.source_type === 'EDE') {
      debug.totalEDE++;
      debug.edeRawTotal++;
      const st = r.status || '';
      debug.edeStatusBreakdown[st || '(empty)'] = (debug.edeStatusBreakdown[st || '(empty)'] || 0) + 1;
      if (r.issuer_subscriber_id) {
        debug.edeWithIssuerSubId++;
      } else {
        debug.edeMissingIssuerSubId++;
        if (r.exchange_subscriber_id) {
          debug.edeMissingIssuerSubIdWithExchange++;
          if (debug.edeMissingIssuerSubIdSamples.length < 10) {
            debug.edeMissingIssuerSubIdSamples.push({
              applicant_name: r.applicant_name || '',
              exchange_subscriber_id: r.exchange_subscriber_id,
              exchange_policy_id: r.exchange_policy_id || '',
              source_file_label: r.source_file_label || '',
            });
          }
        }
      }
      if (debug.edeEffDateSamples.length < 5 && r.effective_date) {
        debug.edeEffDateSamples.push(r.effective_date);
      }
      if (!r.effective_date) {
        debug.edeInvalidDateCount++;
      } else if (isExpectedEDERow(r, sortedCoveredMonths)) {
        debug.edeAfterFilter++;
      }
    } else if (r.source_type === 'BACK_OFFICE') {
      debug.totalBO++;
      if (r.issuer_subscriber_id?.startsWith('u')) debug.boStartingWithU++;
      const termDate = r.policy_term_date || r.paid_through_date;
      if (!termDate) {
        debug.boMissingTermDate++;
        debug.boActiveCount++;
      } else if (isActiveBackOfficeRecord(r, reconcileMonth)) {
        debug.boActiveCount++;
      } else {
        debug.boExcludedCount++;
      }
    } else if (r.source_type === 'COMMISSION') {
      debug.totalComm++;
      debug.commRawRows++;
      if (r.issuer_subscriber_id?.startsWith('u')) debug.commStartingWithU++;
      const amt = r.commission_amount || 0;
      if (amt > 0) { debug.commPositiveRows++; debug.commTotalPositive += amt; }
      else if (amt < 0) { debug.commNegativeRows++; debug.commTotalNegative += amt; }
      if (debug.commSampleRaw.length < 10) {
        const rawVal = r.raw_json?.['Gross Commission'];
        debug.commSampleRaw.push(rawVal === undefined || rawVal === null ? '(empty)' : String(rawVal));
        debug.commSampleParsed.push(amt);
      }
    }
  }

  // Commission policy stats
  const commRecords = records.filter(r => r.source_type === 'COMMISSION');
  const rawPolicies = new Set(commRecords.map(r => r.raw_json?.['Policy Number'] || r.policy_number || '').filter(Boolean));
  const normPolicies = new Set(commRecords.map(r => r.policy_number).filter(Boolean));
  debug.commDistinctPolicyRaw = rawPolicies.size;
  debug.commDistinctPolicyNormalized = normPolicies.size;

  // Step 3: Multi-strategy matching using Union-Find
  //
  // CONFLICT DETECTION (pre-pass): Detect "poison" records — typically Back Office
  // or Commission rows whose IDs cross-link two distinct EDE members. Example:
  // a Back Office row with issuer_subscriber_id=U99015281 (member A) and
  // exchange_subscriber_id=0002650865 (member B). Merging via either ID would
  // collapse A and B into one group. We isolate such rows so they bridge nobody.
  //
  // We use ONLY EDE rows as ground-truth identity sources for this check, since
  // EDE is generated by the exchange and is the most authoritative.
  //
  // We map each EDE id -> the set of EDE record indices it appears on. A
  // non-EDE row is "poison" if its esid and its isid each point to non-empty
  // EDE record sets that are DISJOINT — meaning the two IDs identify two
  // different EDE members. This works even when one EDE row is missing one of
  // the IDs (common when EDE Summary omits issuerSubscriberId), because we
  // compare record-membership rather than requiring both IDs on the same row.
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
  const poisonReasons = new Map<number, string>();
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.source_type === 'EDE') continue; // EDE rows are ground truth
    const myIsid = r.issuer_subscriber_id;
    const myEsid = r.exchange_subscriber_id;
    if (!myIsid || !myEsid) continue;
    const edeIdxForEsid = edeIdxByEsid.get(myEsid);
    const edeIdxForIsid = edeIdxByIsid.get(myIsid);
    if (!edeIdxForEsid || edeIdxForEsid.size === 0) continue;
    if (!edeIdxForIsid || edeIdxForIsid.size === 0) continue;
    // Disjoint EDE record sets => the two IDs identify two different members.
    let overlap = false;
    for (const idx of edeIdxForEsid) {
      if (edeIdxForIsid.has(idx)) { overlap = true; break; }
    }
    if (!overlap) {
      poisonIndices.add(i);
      const esidNames = [...edeIdxForEsid].map(idx => records[idx].applicant_name || '?').join('|');
      const isidNames = [...edeIdxForIsid].map(idx => records[idx].applicant_name || '?').join('|');
      poisonReasons.set(
        i,
        `Cross-linked IDs: exchange_subscriber_id ${myEsid} belongs to EDE member [${esidNames}] but issuer_subscriber_id ${myIsid} belongs to EDE member [${isidNames}].`
      );
    }
  }

  const uf = new UnionFind(records.length, records);

  const skipUnion = (i: number) => poisonIndices.has(i);

  // Strategy A: issuer_subscriber_id match
  const isidIndex = new Map<string, number>();
  for (let i = 0; i < records.length; i++) {
    if (skipUnion(i)) continue;
    const id = records[i].issuer_subscriber_id;
    if (!id) continue;
    const existing = isidIndex.get(id);
    if (existing !== undefined) {
      uf.union(i, existing);
    } else {
      isidIndex.set(id, i);
    }
  }

  // Strategy B: exchange_subscriber_id match
  const esidIndex = new Map<string, number>();
  for (let i = 0; i < records.length; i++) {
    if (skipUnion(i)) continue;
    const id = records[i].exchange_subscriber_id;
    if (!id) continue;
    const existing = esidIndex.get(id);
    if (existing !== undefined) {
      uf.union(i, existing);
    } else {
      esidIndex.set(id, i);
    }
  }

  // Strategy C: policy_number match (base before dash)
  const pnIndex = new Map<string, number>();
  for (let i = 0; i < records.length; i++) {
    if (skipUnion(i)) continue;
    const pn = records[i].policy_number;
    if (!pn) continue;
    const existing = pnIndex.get(pn);
    if (existing !== undefined) {
      uf.union(i, existing);
    } else {
      pnIndex.set(pn, i);
    }
  }

  // Strategy D: Name match (fallback) — only match across different source types
  const nameIndex = new Map<string, number[]>();
  for (let i = 0; i < records.length; i++) {
    if (skipUnion(i)) continue;
    const r = records[i];
    let nm = '';
    if (r.first_name || r.last_name) {
      nm = normalizeName(r.first_name, r.last_name);
    }
    if (!nm) {
      nm = normalizeFullName(r.applicant_name);
    }
    if (!nm || nm.length < 4) continue; // skip very short names
    const arr = nameIndex.get(nm) || [];
    arr.push(i);
    nameIndex.set(nm, arr);
  }
  for (const [, indices] of nameIndex) {
    if (indices.length < 2) continue;
    // Only union if there are different source types in the group
    const types = new Set(indices.map(i => records[i].source_type));
    if (types.size > 1) {
      for (let j = 1; j < indices.length; j++) {
        uf.union(indices[0], indices[j]);
      }
    }
  }

  // Step 4: Build groups from union-find
  const groupMap = new Map<number, number[]>();
  for (let i = 0; i < records.length; i++) {
    const root = uf.find(i);
    const arr = groupMap.get(root) || [];
    arr.push(i);
    groupMap.set(root, arr);
  }

  // Build groups as record arrays and assign member_keys
  const groups = new Map<string, NormalizedRecord[]>();
  let groupIdx = 0;
  for (const [, indices] of groupMap) {
    const recs = indices.map(i => records[i]);
    // Determine best member_key for the group
    let key = '';
    // Prefer issuer_subscriber_id
    for (const r of recs) {
      if (r.issuer_subscriber_id) { key = `issub:${r.issuer_subscriber_id}`; break; }
    }
    if (!key) {
      for (const r of recs) {
        if (r.exchange_subscriber_id) { key = `sub:${r.exchange_subscriber_id}`; break; }
      }
    }
    if (!key) {
      for (const r of recs) {
        if (r.policy_number) { key = `policy:${r.policy_number}`; break; }
      }
    }
    if (!key) {
      for (const r of recs) {
        if (r.applicant_name) { key = `name:${normalizeFullName(r.applicant_name)}`; break; }
      }
    }
    if (!key) key = `grp:${groupIdx}`;
    groupIdx++;

    // Assign member_key to all records in group
    for (const r of recs) r.member_key = key;

    // Merge with existing group if key collision (shouldn't happen but safety)
    const existing = groups.get(key);
    if (existing) {
      existing.push(...recs);
    } else {
      groups.set(key, recs);
    }
  }

  debug.uniqueMemberKeys = groups.size;
  debug.avgRecordsPerKey = records.length > 0 ? Math.round((records.length / groups.size) * 100) / 100 : 0;

  // Count match methods based on what IDs contributed to the group
  for (const [, recs] of groups) {
    const types = new Set(recs.map(r => r.source_type));
    if (types.size <= 1) { debug.matchByFallback++; continue; }
    // Determine which strategy linked them
    const isids = new Set(recs.map(r => r.issuer_subscriber_id).filter(Boolean));
    const esids = new Set(recs.map(r => r.exchange_subscriber_id).filter(Boolean));
    const pns = new Set(recs.map(r => r.policy_number).filter(Boolean));
    // Check if cross-type records share an issuer_subscriber_id
    const typesByIsid = new Map<string, Set<string>>();
    for (const r of recs) {
      if (r.issuer_subscriber_id) {
        const s = typesByIsid.get(r.issuer_subscriber_id) || new Set();
        s.add(r.source_type);
        typesByIsid.set(r.issuer_subscriber_id, s);
      }
    }
    let matched = false;
    for (const [, st] of typesByIsid) {
      if (st.size > 1) { debug.matchByIssuerSubId++; matched = true; break; }
    }
    if (matched) continue;
    // Check exchange_subscriber_id
    const typesByEsid = new Map<string, Set<string>>();
    for (const r of recs) {
      if (r.exchange_subscriber_id) {
        const s = typesByEsid.get(r.exchange_subscriber_id) || new Set();
        s.add(r.source_type);
        typesByEsid.set(r.exchange_subscriber_id, s);
      }
    }
    for (const [, st] of typesByEsid) {
      if (st.size > 1) { debug.matchByExchangeSubId++; matched = true; break; }
    }
    if (matched) continue;
    // Check policy_number
    const typesByPn = new Map<string, Set<string>>();
    for (const r of recs) {
      if (r.policy_number) {
        const s = typesByPn.get(r.policy_number) || new Set();
        s.add(r.source_type);
        typesByPn.set(r.policy_number, s);
      }
    }
    for (const [, st] of typesByPn) {
      if (st.size > 1) { debug.matchByPolicyNumber++; matched = true; break; }
    }
    if (matched) continue;
    // Must be name match
    debug.matchByName++;
  }

  // Count EDE qualified unique keys + sum covered lives
  const edeQualifiedKeys = new Set<string>();
  for (const [key, recs] of groups) {
    let groupCovered = 0;
    let groupMonth = '';
    for (const r of recs) {
      if (!isExpectedEDERow(r, sortedCoveredMonths)) continue;
      edeQualifiedKeys.add(key);
      // Use the first qualified row's covered count + month for the group
      // (one EDE row per member per month is the norm)
      const raw = r.raw_json || {};
      const cmcRaw = raw['coveredMemberCount'] ?? raw['CoveredMemberCount'] ?? raw['covered_member_count'];
      const cmc = cmcRaw != null && String(cmcRaw).trim() !== '' ? parseInt(String(cmcRaw), 10) : NaN;
      const lives = Number.isFinite(cmc) && cmc > 0 ? cmc : 1;
      if (groupCovered === 0) {
        groupCovered = lives;
        groupMonth = r.effective_date ? r.effective_date.substring(0, 7) : '';
      }
    }
    if (groupCovered > 0) {
      debug.totalCoveredLives += groupCovered;
      if (groupMonth) {
        // Allow carryover months outside the batch's covered window so the
        // Dashboard's per-month breakdown can SUM to the total.
        debug.totalCoveredLivesByMonth[groupMonth] =
          (debug.totalCoveredLivesByMonth[groupMonth] ?? 0) + groupCovered;
      }
    }
  }
  debug.edeUniqueKeysAfterFilter = edeQualifiedKeys.size;
  debug.edeQualifiedCount = edeQualifiedKeys.size;

  // Step 5: Calculate avg commission by agent for estimates
  const commByAgent = new Map<string, number[]>();
  const allComm: number[] = [];
  for (const r of records) {
    if (r.source_type === 'COMMISSION' && r.commission_amount != null && r.commission_amount > 0) {
      allComm.push(r.commission_amount);
      const arr = commByAgent.get(r.agent_npn) || [];
      arr.push(r.commission_amount);
      commByAgent.set(r.agent_npn, arr);
    }
  }
  const avgAll = allComm.length > 0 ? allComm.reduce((a, b) => a + b, 0) / allComm.length : DEFAULT_COMMISSION_ESTIMATE;

  // Step 6: Consolidate each group into ONE reconciled member
  const results: ReconciledMember[] = [];

  for (const [memberKey, recs] of groups) {
    const ede = recs.filter(r => r.source_type === 'EDE');
    const bo = recs.filter(r =>
      r.source_type === 'BACK_OFFICE' &&
      isActiveBackOfficeRecord(r, reconcileMonth)
    );
    const comm = recs.filter(r => r.source_type === 'COMMISSION');

    const inEde = ede.length > 0;
    const inBo = bo.length > 0;

    const applicantName = ede[0]?.applicant_name || bo[0]?.applicant_name || comm[0]?.applicant_name || '';
    const dob = ede[0]?.dob || bo[0]?.dob || null;
    const policyNumber = bo[0]?.policy_number || comm[0]?.policy_number || ede[0]?.policy_number || '';
    const exchangeSubId = ede[0]?.exchange_subscriber_id || bo[0]?.exchange_subscriber_id || '';
    const exchangePolId = ede[0]?.exchange_policy_id || '';
    const issuerPolId = ede[0]?.issuer_policy_id || '';
    const issuerSubId = ede[0]?.issuer_subscriber_id || bo[0]?.issuer_subscriber_id || comm[0]?.issuer_subscriber_id || '';
    const agentName = ede[0]?.agent_name || bo[0]?.agent_name || comm[0]?.agent_name || '';
    const agentNpn = ede[0]?.agent_npn || bo[0]?.agent_npn || comm[0]?.agent_npn || '';
    const aorBucket = bo[0]?.aor_bucket || ede[0]?.aor_bucket || comm[0]?.aor_bucket || '';
    const eligible = bo[0]?.eligible_for_commission || '';
    const premium = bo[0]?.premium || ede[0]?.premium || null;
    const netPremium = ede[0]?.net_premium || null;
    const positiveComm = comm.reduce((sum, c) => sum + Math.max(c.commission_amount || 0, 0), 0) || null;
    const clawbackAmt = comm.reduce((sum, c) => { const a = c.commission_amount || 0; return a < 0 ? sum + a : sum; }, 0) || null;
    const actualComm = comm.reduce((sum, c) => sum + (c.commission_amount || 0), 0) || null;
    const hasPositivePayment = comm.some(c => (c.commission_amount || 0) > 0);
    const inComm = hasPositivePayment;
    const actualPayEntity = comm[0]?.pay_entity || '';

    const npnInfo = NPN_MAP[agentNpn as keyof typeof NPN_MAP];
    const expectedPayEntity = npnInfo?.expectedPayEntity || '';

    const shouldBePaid = inEde && inBo && eligible === 'Yes';

    let issueType = 'Fully Matched';
    let issueNotes = '';

    if (!inEde && inComm) {
      issueType = 'Paid but Missing from EDE';
    } else if (!inEde && inBo) {
      issueType = 'Back Office but Missing from EDE';
    } else if (inEde && !inBo) {
      issueType = 'Missing from Back Office';
    } else if (inEde && inBo && eligible !== 'Yes') {
      issueType = 'Not Eligible for Commission';
    } else if (shouldBePaid && !inComm) {
      issueType = 'Missing from Commission';
    } else if (inComm && (agentNpn === '21055210' || agentNpn === '16531877') && actualPayEntity === 'Vix') {
      issueType = 'Wrong Pay Entity';
      issueNotes = `${npnInfo?.name} paid under Vix instead of Coverall`;
    } else if (agentNpn === '21277051' && actualPayEntity === 'Coverall') {
      issueType = 'Erica Paid Under Coverall';
    } else if (agentNpn === '21277051' && actualPayEntity === 'Vix') {
      issueType = 'Erica Paid Under Vix';
    }

    let estMissing: number | null = null;
    if (shouldBePaid && !inComm) {
      const agentComms = commByAgent.get(agentNpn);
      if (agentComms && agentComms.length > 0) {
        estMissing = agentComms.reduce((a, b) => a + b, 0) / agentComms.length;
      } else {
        estMissing = avgAll;
      }
      estMissing = Math.round(estMissing * 100) / 100;
    }

    // Surface poison-isolation as a data-quality note on this member.
    const poisonRecsInGroup = recs
      .map((r, idx) => ({ r, idx: records.indexOf(r) }))
      .filter(x => poisonIndices.has(x.idx));
    if (poisonRecsInGroup.length > 0) {
      const reasons = poisonRecsInGroup
        .map(x => `${x.r.source_file_label}: ${poisonReasons.get(x.idx) || ''}`)
        .filter(Boolean);
      const note = `DATA QUALITY: Cross-linked IDs in source row(s) — refused merge with EDE. ${reasons.join(' | ')}`;
      issueNotes = issueNotes ? `${issueNotes}. ${note}` : note;
    }

    results.push({
      member_key: memberKey,
      carrier: 'Ambetter',
      applicant_name: applicantName,
      dob,
      policy_number: policyNumber,
      exchange_subscriber_id: exchangeSubId,
      exchange_policy_id: exchangePolId,
      issuer_policy_id: issuerPolId,
      issuer_subscriber_id: issuerSubId,
      agent_name: agentName,
      agent_npn: agentNpn,
      aor_bucket: aorBucket,
      expected_pay_entity: expectedPayEntity,
      actual_pay_entity: actualPayEntity,
      in_ede: inEde,
      in_back_office: inBo,
      in_commission: inComm,
      eligible_for_commission: eligible,
      premium,
      net_premium: netPremium,
      actual_commission: actualComm,
      positive_commission: positiveComm,
      clawback_amount: clawbackAmt,
      estimated_missing_commission: estMissing,
      issue_type: issueType,
      issue_notes: issueNotes,
      source_count: recs.length,
      commission_record_count: comm.length,
      has_mixed_sources: new Set(recs.map(r => r.source_type)).size > 1,
      ede_qualified: ede.some(e => isExpectedEDERow(e, sortedCoveredMonths)),
      is_in_expected_ede_universe: ede.some(e => isExpectedEDERow(e, sortedCoveredMonths)),
      expected_ede_effective_month: (() => {
        // The member's actual earliest effective_date month across qualified
        // EDE rows (NOT span-anchored to the batch's covered window). This
        // lets the Dashboard's per-month breakdown attribute each unique
        // member to their real effectuation month so the per-month numbers
        // SUM to the card total. Carryover months from prior to the visible
        // window appear naturally in breakdowns.
        let earliest = '';
        for (const e of ede) {
          if (!isExpectedEDERow(e, sortedCoveredMonths)) continue;
          const m = e.effective_date ? e.effective_date.substring(0, 7) : '';
          if (m && (!earliest || m < earliest)) earliest = m;
        }
        return earliest;
      })(),
    });
  }

  return { members: results, debug };
}
