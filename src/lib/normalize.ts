import { NPN_MAP } from './constants';

function stripApostrophe(val: string | undefined | null): string {
  if (!val) return '';
  return val.replace(/^'+/, '').trim();
}

function stripTrailingSuffix(val: string, suffix: string): string {
  if (!val) return '';
  const re = new RegExp(suffix + '$', 'i');
  return val.replace(re, '').trim();
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

function isAmbetterEDE(row: Record<string, string>): boolean {
  const issuer = (row['issuer'] || row['Issuer'] || '').toLowerCase();
  return issuer.includes('ambetter');
}

function isAmbetterCommission(row: Record<string, string>): boolean {
  const db = (row['Database'] || row['database'] || '').toLowerCase();
  return db.includes('ambetter');
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
  if (r.issuer_policy_id) return `IPD:${r.issuer_policy_id}`;
  if (r.policy_number) return `POL:${r.policy_number}`;
  if (r.exchange_subscriber_id) return `ESI:${r.exchange_subscriber_id}`;
  if (r.exchange_policy_id) return `EPI:${r.exchange_policy_id}`;
  if (r.applicant_name && r.dob) return `NAME_DOB:${r.applicant_name.toUpperCase()}|${r.dob}`;
  if (r.applicant_name) return `NAME:${r.applicant_name.toUpperCase()}`;
  return `UNK:${Math.random().toString(36).slice(2, 10)}`;
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
    exchange_subscriber_id: stripApostrophe(row['exchangeSubscriberId']),
    exchange_policy_id: stripApostrophe(row['exchangePolicyId']),
    issuer_policy_id: stripApostrophe(row['issuerPolicyId']),
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
  // Determine aor_bucket from agent_npn
  const npnInfo = NPN_MAP[r.agent_npn as keyof typeof NPN_MAP];
  if (npnInfo) r.aor_bucket = npnInfo.name;
  r.member_key = buildMemberKey(r);
  return r;
}

export function normalizeBackOfficeRow(row: Record<string, string>, fileLabel: string, aorBucket: string): NormalizedRecord {
  const first = (row['Insured First Name'] || '').trim();
  const last = (row['Insured Last Name'] || '').trim();
  const npn = stripApostrophe(row['Broker NPN']);
  const r: NormalizedRecord = {
    source_type: 'BACK_OFFICE',
    source_file_label: fileLabel,
    carrier: 'Ambetter',
    applicant_name: `${first} ${last}`.trim(),
    first_name: first,
    last_name: last,
    dob: normalizeDate(row['Member Date Of Birth']),
    member_id: '',
    policy_number: stripApostrophe(row['Policy Number']),
    exchange_subscriber_id: stripApostrophe(row['Exchange Subscriber ID']),
    exchange_policy_id: '',
    issuer_policy_id: '',
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
  let npn = stripApostrophe(row['Writing Agent ID'] || '');
  npn = stripTrailingSuffix(npn, '-X');
  let policyNum = stripApostrophe(row['Policy Number'] || '');
  policyNum = stripTrailingSuffix(policyNum, '-AR');
  const agentName = (row['Agent Name.1'] || row['Agent Name'] || '').trim();
  const r: NormalizedRecord = {
    source_type: 'COMMISSION',
    source_file_label: fileLabel,
    carrier: 'Ambetter',
    applicant_name: (row['Policyholder Name'] || '').trim(),
    first_name: '',
    last_name: '',
    dob: null,
    member_id: '',
    policy_number: policyNum,
    exchange_subscriber_id: '',
    exchange_policy_id: '',
    issuer_policy_id: '',
    agent_name: agentName,
    agent_npn: npn,
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
