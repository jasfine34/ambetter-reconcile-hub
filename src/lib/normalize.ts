import { NPN_MAP } from './constants';

function stripApostrophe(val: string | undefined | null): string {
  if (!val) return '';
  return val.replace(/^'+/, '').trim();
}

function normalizeDate(val: string | undefined | null): string | null {
  if (!val) return null;
  const v = val.trim();
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().split('T')[0];
}

function normalizeEligible(val: string | undefined | null): string {
  if (!val) return '';
  const v = val.trim().toLowerCase();
  if (v === 'yes' || v === 'y' || v === 'true') return 'Yes';
  if (v === 'no' || v === 'n' || v === 'false') return 'No';
  return '';
}

function parseNum(val: string | undefined | null): number | null {
  if (!val) return null;
  const v = val.replace(/[,$]/g, '').trim();
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

/**
 * Strong normalization for all ID fields used in matching.
 * Strips apostrophes, suffixes, whitespace, non-alphanumeric chars.
 * Preserves leading letters like "U".
 */
export function cleanId(val: string | undefined | null): string {
  if (!val) return '';
  let v = val;
  // strip leading apostrophes
  v = v.replace(/^'+/, '');
  // strip trailing -AR (case insensitive)
  v = v.replace(/-AR$/i, '');
  // strip trailing -X (case insensitive)
  v = v.replace(/-X$/i, '');
  // trim whitespace
  v = v.trim();
  // lowercase
  v = v.toLowerCase();
  // remove all spaces
  v = v.replace(/\s+/g, '');
  // remove non-alphanumeric characters
  v = v.replace(/[^a-z0-9]/g, '');
  return v;
}

function isAmbetterEDE(row: Record<string, string>): boolean {
  const issuer = (row['issuer'] || row['Issuer'] || '').toLowerCase();
  return issuer.includes('ambetter');
}

function isAmbetterCommission(row: Record<string, string>): boolean {
  const db = (row['Database'] || row['database'] || '').toLowerCase();
  if (db.includes('ambetter')) return true;
  const companyId = (row['Company ID'] || '').toLowerCase();
  if (companyId.includes('ambetter')) return true;
  const policyNum = row['Policy Number'] || '';
  if (policyNum.trim()) return true;
  return false;
}

export interface NormalizedRecord {
  source_type: string;
  source_file_label: string;
  carrier: string;
  applicant_name: string;
  first_name: string;
  last_name: string;
  dob: string | null;
  member_id: string;
  policy_number: string;
  exchange_subscriber_id: string;
  exchange_policy_id: string;
  issuer_policy_id: string;
  issuer_subscriber_id: string;
  agent_name: string;
  agent_npn: string;
  aor_bucket: string;
  pay_entity: string;
  status: string;
  effective_date: string | null;
  premium: number | null;
  net_premium: number | null;
  commission_amount: number | null;
  eligible_for_commission: string;
  member_key: string;
  raw_json: Record<string, string>;
}

function buildMemberKey(r: Partial<NormalizedRecord>): string {
  // Priority: issuer_subscriber_id > exchange_subscriber_id > policy_number > exchange_policy_id > name+dob
  const isid = r.issuer_subscriber_id || '';
  if (isid) return `issub:${isid}`;
  const esid = cleanId(r.exchange_subscriber_id);
  if (esid) return `sub:${esid}`;
  const pn = cleanId(r.policy_number);
  if (pn) return `policy:${pn}`;
  const epid = cleanId(r.exchange_policy_id);
  if (epid) return `xpol:${epid}`;
  if (r.applicant_name && r.dob) return `name:${r.applicant_name.toUpperCase()}|${r.dob}`;
  if (r.applicant_name) return `name:${r.applicant_name.toUpperCase()}`;
  return `unk:${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeEDERow(row: Record<string, string>, fileLabel: string): NormalizedRecord | null {
  if (!isAmbetterEDE(row)) return null;
  const first = (row['applicantFirstName'] || '').trim();
  const last = (row['applicantLastName'] || '').trim();
  const r: NormalizedRecord = {
    source_type: 'EDE',
    source_file_label: fileLabel,
    carrier: 'Ambetter',
    applicant_name: (row['applicantName'] || `${first} ${last}`).trim(),
    first_name: first,
    last_name: last,
    dob: normalizeDate(row['dob']),
    member_id: stripApostrophe(row['issuerSubscriberId']),
    policy_number: '',
    exchange_subscriber_id: cleanId(row['exchangeSubscriberId']),
    exchange_policy_id: cleanId(row['exchangePolicyId']),
    issuer_policy_id: cleanId(row['issuerPolicyId']),
    issuer_subscriber_id: cleanId(row['issuerSubscriberId']),
    agent_name: (row['agentName'] || '').trim(),
    agent_npn: stripApostrophe(row['agentNPN']),
    aor_bucket: '',
    pay_entity: '',
    status: (row['policyStatus'] || '').trim(),
    effective_date: normalizeDate(row['effectiveDate']),
    premium: parseNum(row['premium']),
    net_premium: parseNum(row['netPremium']),
    commission_amount: null,
    eligible_for_commission: '',
    member_key: '',
    raw_json: row,
  };
  const npnInfo = NPN_MAP[r.agent_npn as keyof typeof NPN_MAP];
  if (npnInfo) r.aor_bucket = npnInfo.name;
  r.member_key = buildMemberKey(r);
  return r;
}

export function normalizeBackOfficeRow(row: Record<string, string>, fileLabel: string, aorBucket: string): NormalizedRecord {
  const first = (row['Insured First Name'] || '').trim();
  const last = (row['Insured Last Name'] || '').trim();
  const npn = stripApostrophe(row['Broker NPN']);
  const policyNumber = stripApostrophe(row['Policy Number']);
  const r: NormalizedRecord = {
    source_type: 'BACK_OFFICE',
    source_file_label: fileLabel,
    carrier: 'Ambetter',
    applicant_name: `${first} ${last}`.trim(),
    first_name: first,
    last_name: last,
    dob: normalizeDate(row['Member Date Of Birth']),
    member_id: '',
    policy_number: cleanId(policyNumber),
    exchange_subscriber_id: cleanId(row['Exchange Subscriber ID']),
    exchange_policy_id: '',
    issuer_policy_id: '',
    issuer_subscriber_id: cleanId(policyNumber),
    agent_name: (row['Broker Name'] || '').trim(),
    agent_npn: npn,
    aor_bucket: aorBucket,
    pay_entity: '',
    status: (row['Policy Term Date'] || row['Paid Through Date'] || '').trim(),
    effective_date: normalizeDate(row['Policy Effective Date']),
    premium: parseNum(row['Monthly Premium Amount']),
    net_premium: null,
    commission_amount: null,
    eligible_for_commission: normalizeEligible(row['Eligible for Commission']),
    member_key: '',
    raw_json: row,
  };
  r.member_key = buildMemberKey(r);
  return r;
}

export function normalizeCommissionRow(row: Record<string, string>, fileLabel: string, payEntity: string): NormalizedRecord | null {
  if (!isAmbetterCommission(row)) return null;
  let policyNum = stripApostrophe(row['Policy Number'] || '');
  const agentName = (row['Agent Name_1'] || row['Agent Name.1'] || row['Agent Name'] || '').trim();
  let npn = stripApostrophe(row['Writing Agent ID'] || '');
  const r: NormalizedRecord = {
    source_type: 'COMMISSION',
    source_file_label: fileLabel,
    carrier: 'Ambetter',
    applicant_name: (row['Policyholder Name'] || '').trim(),
    first_name: '',
    last_name: '',
    dob: null,
    member_id: '',
    policy_number: cleanId(policyNum),
    exchange_subscriber_id: '',
    exchange_policy_id: '',
    issuer_policy_id: '',
    issuer_subscriber_id: cleanId(policyNum),
    agent_name: agentName,
    agent_npn: cleanId(npn) || npn,
    aor_bucket: '',
    pay_entity: payEntity,
    status: (row['Policy Status'] || '').trim(),
    effective_date: normalizeDate(row['Issue Date']),
    premium: parseNum(row['Commissionable']),
    net_premium: null,
    commission_amount: parseNum(row['Gross Commission']),
    eligible_for_commission: '',
    member_key: '',
    raw_json: row,
  };
  const npnInfo = NPN_MAP[r.agent_npn as keyof typeof NPN_MAP];
  if (npnInfo) r.aor_bucket = npnInfo.name;
  r.member_key = buildMemberKey(r);
  return r;
}
