import { NPN_MAP, DEFAULT_COMMISSION_ESTIMATE } from './constants';
import { cleanId, normalizePolicyStatus } from './normalize';
import type { NormalizedRecord } from './normalize';

// Qualified EDE rows must match user's exact filter, applied to the RAW source
// fields (raw_json) so we replicate the export they validated against.
const QUALIFIED_RAW_STATUSES = new Set([
  'effectuated',
  'pendingeffectuation',
  'pendingtermination',
]);
const EXPECTED_AOR_PREFIXES = ['jason fine', 'erica fine', 'becky shuta'];
const EXPECTED_EFFECTIVE_DATES = new Set(['2026-01-01', '2026-02-01']);

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

function isExpectedEDERow(r: NormalizedRecord): boolean {
  if (r.source_type !== 'EDE') return false;
  if (!r.effective_date || !EXPECTED_EFFECTIVE_DATES.has(r.effective_date)) return false;
  if (!QUALIFIED_RAW_STATUSES.has(rawStatusKey(r))) return false;
  if (!rawIssuerKey(r).includes('ambetter')) return false;
  const aor = rawAorKey(r);
  return EXPECTED_AOR_PREFIXES.some(p => aor.startsWith(p));
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

export function reconcile(records: NormalizedRecord[]): { members: ReconciledMember[]; debug: MatchDebugStats } {
  // Step 1: Re-clean all IDs
  for (const r of records) {
    reclean(r);
  }

  // Step 1b: Promote issuer_subscriber_id for EDE rows that are missing it
  // when a sibling COMMISSION/BACK_OFFICE record (matched by exchange_subscriber_id,
  // exchange_policy_id, or policy_number) carries a valid "U" sub id.
  // This recovers cases where EDE export omitted the issuerSubscriberId column.
  const uSubIdByExchangeSubId = new Map<string, string>();
  const uSubIdByExchangePolId = new Map<string, string>();
  const uSubIdByPolicyNumber = new Map<string, string>();
  for (const r of records) {
    if (r.source_type === 'EDE') continue;
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
      } else if (isExpectedEDERow(r)) {
        debug.edeAfterFilter++;
      }
    } else if (r.source_type === 'BACK_OFFICE') {
      debug.totalBO++;
      if (r.issuer_subscriber_id?.startsWith('u')) debug.boStartingWithU++;
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
  const uf = new UnionFind(records.length);

  // Strategy A: issuer_subscriber_id match
  const isidIndex = new Map<string, number>();
  for (let i = 0; i < records.length; i++) {
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

  // Count EDE qualified unique keys
  const edeQualifiedKeys = new Set<string>();
  for (const [key, recs] of groups) {
    const hasQualifiedEDE = recs.some(r => isExpectedEDERow(r));
    if (hasQualifiedEDE) edeQualifiedKeys.add(key);
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
    const bo = recs.filter(r => r.source_type === 'BACK_OFFICE');
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
      ede_qualified: ede.some(e => isExpectedEDERow(e)),
      is_in_expected_ede_universe: ede.some(e => isExpectedEDERow(e)),
      expected_ede_effective_month: (() => {
        const qualified = ede.find(e => isExpectedEDERow(e));
        if (!qualified || !qualified.effective_date) return '';
        return qualified.effective_date.substring(0, 7); // 'YYYY-MM'
      })(),
    });
  }

  return { members: results, debug };
}
