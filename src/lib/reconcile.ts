import { NPN_MAP, DEFAULT_COMMISSION_ESTIMATE } from './constants';
import { cleanId } from './normalize';
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
  matchByFallback: number;
}

/**
 * Re-clean IDs on DB records (which may have been stored with older normalization).
 */
function reclean(r: NormalizedRecord): void {
  r.issuer_subscriber_id = cleanId(r.issuer_subscriber_id);
  r.exchange_subscriber_id = cleanId(r.exchange_subscriber_id);
  r.exchange_policy_id = cleanId(r.exchange_policy_id);
  r.issuer_policy_id = cleanId(r.issuer_policy_id);
  r.policy_number = cleanId(r.policy_number);
}

/**
 * Build a canonical member_key from cleaned fields.
 */
function buildMemberKey(r: NormalizedRecord): string {
  if (r.issuer_subscriber_id) return `issub:${r.issuer_subscriber_id}`;
  if (r.exchange_subscriber_id) return `sub:${r.exchange_subscriber_id}`;
  if (r.policy_number) return `policy:${r.policy_number}`;
  if (r.exchange_policy_id) return `xpol:${r.exchange_policy_id}`;
  if (r.applicant_name && r.dob) return `name:${r.applicant_name.toUpperCase()}|${r.dob}`;
  if (r.applicant_name) return `name:${r.applicant_name.toUpperCase()}`;
  return `unk:${Math.random().toString(36).slice(2, 10)}`;
}

export function reconcile(records: NormalizedRecord[]): { members: ReconciledMember[]; debug: MatchDebugStats } {
  // Step 1: Re-clean all IDs and rebuild member_keys
  for (const r of records) {
    reclean(r);
    r.member_key = buildMemberKey(r);
  }

  // Step 2: Count raw stats
  const debug: MatchDebugStats = {
    totalEDE: 0, totalBO: 0, totalComm: 0,
    totalRawRecords: records.length,
    uniqueMemberKeys: 0, avgRecordsPerKey: 0,
    edeWithIssuerSubId: 0, boStartingWithU: 0, commStartingWithU: 0,
    matchByIssuerSubId: 0, matchByExchangeSubId: 0, matchByPolicyNumber: 0, matchByFallback: 0,
  };

  for (const r of records) {
    if (r.source_type === 'EDE') {
      debug.totalEDE++;
      if (r.issuer_subscriber_id) debug.edeWithIssuerSubId++;
    } else if (r.source_type === 'BACK_OFFICE') {
      debug.totalBO++;
      if (r.issuer_subscriber_id?.startsWith('u')) debug.boStartingWithU++;
    } else if (r.source_type === 'COMMISSION') {
      debug.totalComm++;
      if (r.issuer_subscriber_id?.startsWith('u')) debug.commStartingWithU++;
    }
  }

  // Step 3: Unify member_keys by issuer_subscriber_id
  const isidMap = new Map<string, string>();
  for (const r of records) {
    if (!r.issuer_subscriber_id) continue;
    const existing = isidMap.get(r.issuer_subscriber_id);
    if (!existing) {
      isidMap.set(r.issuer_subscriber_id, r.member_key);
    } else if (existing !== r.member_key) {
      const better = r.member_key.startsWith('issub:') ? r.member_key : existing;
      isidMap.set(r.issuer_subscriber_id, better);
    }
  }
  for (const r of records) {
    if (r.issuer_subscriber_id && isidMap.has(r.issuer_subscriber_id)) {
      r.member_key = isidMap.get(r.issuer_subscriber_id)!;
    }
  }

  // Step 4: Unify member_keys by exchange_subscriber_id
  const esidMap = new Map<string, string>();
  for (const r of records) {
    if (!r.exchange_subscriber_id) continue;
    const existing = esidMap.get(r.exchange_subscriber_id);
    if (!existing) {
      esidMap.set(r.exchange_subscriber_id, r.member_key);
    } else if (existing !== r.member_key) {
      const better = r.member_key.startsWith('issub:') ? r.member_key :
                     r.member_key.startsWith('sub:') ? r.member_key : existing;
      esidMap.set(r.exchange_subscriber_id, better);
    }
  }
  for (const r of records) {
    if (r.exchange_subscriber_id && esidMap.has(r.exchange_subscriber_id)) {
      r.member_key = esidMap.get(r.exchange_subscriber_id)!;
    }
  }

  // Step 5: Group by member_key
  const groups = new Map<string, NormalizedRecord[]>();
  for (const r of records) {
    const arr = groups.get(r.member_key) || [];
    arr.push(r);
    groups.set(r.member_key, arr);
  }

  debug.uniqueMemberKeys = groups.size;
  debug.avgRecordsPerKey = records.length > 0 ? Math.round((records.length / groups.size) * 100) / 100 : 0;

  // Count match methods
  for (const [key] of groups) {
    if (key.startsWith('issub:')) debug.matchByIssuerSubId++;
    else if (key.startsWith('sub:')) debug.matchByExchangeSubId++;
    else if (key.startsWith('policy:') || key.startsWith('xpol:')) debug.matchByPolicyNumber++;
    else debug.matchByFallback++;
  }

  // Step 6: Calculate avg commission by agent for estimates
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

  // Step 7: Consolidate each group into exactly ONE reconciled member
  const results: ReconciledMember[] = [];

  for (const [memberKey, recs] of groups) {
    const ede = recs.filter(r => r.source_type === 'EDE');
    const bo = recs.filter(r => r.source_type === 'BACK_OFFICE');
    const comm = recs.filter(r => r.source_type === 'COMMISSION');

    const inEde = ede.length > 0;
    const inBo = bo.length > 0;
    const inComm = comm.length > 0;

    // Merge attributes: prefer EDE > BO > COMM for identity fields
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
    
    // eligible_for_commission: take from BACK_OFFICE record
    const eligible = bo[0]?.eligible_for_commission || '';
    
    const premium = bo[0]?.premium || ede[0]?.premium || null;
    const netPremium = ede[0]?.net_premium || null;
    
    // actual_commission: SUM of all commission records for this member
    const actualComm = comm.reduce((sum, c) => sum + (c.commission_amount || 0), 0) || null;
    
    // actual_pay_entity: from commission records
    const actualPayEntity = comm[0]?.pay_entity || '';

    const npnInfo = NPN_MAP[agentNpn as keyof typeof NPN_MAP];
    const expectedPayEntity = npnInfo?.expectedPayEntity || '';

    const shouldBePaid = inEde && inBo && eligible === 'Yes';

    // Classify issue
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

    // Estimate missing commission
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
    });
  }

  return { members: results, debug };
}
