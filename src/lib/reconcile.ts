import { NPN_MAP, DEFAULT_COMMISSION_ESTIMATE } from './constants';
import { cleanId, isQualifiedEDEStatus, normalizePolicyStatus } from './normalize';
import type { NormalizedRecord } from './normalize';

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
  estimated_missing_commission: number | null;
  issue_type: string;
  issue_notes: string;
  source_count: number;
  commission_record_count: number;
  has_mixed_sources: boolean;
  ede_qualified: boolean;
  is_in_expected_ede_universe: boolean;
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
  // Commission aggregation debug
  commRawRows: number;
  commPositiveRows: number;
  commNegativeRows: number;
  commDistinctPolicyRaw: number;
  commDistinctPolicyNormalized: number;
  commTotalPositive: number;
  commTotalNegative: number;
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
 */
class UnionFind {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    if (this.parent[x] !== x) this.parent[x] = this.find(this.parent[x]);
    return this.parent[x];
  }
  union(a: number, b: number): void {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

export function reconcile(records: NormalizedRecord[]): { members: ReconciledMember[]; debug: MatchDebugStats } {
  // Step 1: Re-clean all IDs
  for (const r of records) {
    reclean(r);
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
    commRawRows: 0,
    commPositiveRows: 0,
    commNegativeRows: 0,
    commDistinctPolicyRaw: 0,
    commDistinctPolicyNormalized: 0,
    commTotalPositive: 0,
    commTotalNegative: 0,
  };

  for (const r of records) {
    if (r.source_type === 'EDE') {
      debug.totalEDE++;
      debug.edeRawTotal++;
      const st = r.status || '';
      debug.edeStatusBreakdown[st || '(empty)'] = (debug.edeStatusBreakdown[st || '(empty)'] || 0) + 1;
      if (r.issuer_subscriber_id) debug.edeWithIssuerSubId++;
      if (debug.edeEffDateSamples.length < 5 && r.effective_date) {
        debug.edeEffDateSamples.push(r.effective_date);
      }
      if (!r.effective_date) {
        debug.edeInvalidDateCount++;
      } else if (isQualifiedEDEStatus(st) && r.effective_date === '2026-01-01') {
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
    const hasQualifiedEDE = recs.some(r => r.source_type === 'EDE' && isQualifiedEDEStatus(r.status || '') && r.effective_date === '2026-01-01');
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
    const inComm = comm.length > 0;

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
    const actualComm = comm.reduce((sum, c) => sum + (c.commission_amount || 0), 0) || null;
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
      estimated_missing_commission: estMissing,
      issue_type: issueType,
      issue_notes: issueNotes,
      source_count: recs.length,
      commission_record_count: comm.length,
      has_mixed_sources: new Set(recs.map(r => r.source_type)).size > 1,
      ede_qualified: ede.some(e => isQualifiedEDEStatus(e.status || '') && e.effective_date === '2026-01-01'),
      is_in_expected_ede_universe: ede.some(e => isQualifiedEDEStatus(e.status || '') && e.effective_date === '2026-01-01'),
    });
  }

  return { members: results, debug };
}
