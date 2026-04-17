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

const VALID_EDE_STATUSES = new Set(['effectuated', 'pending effectuated', 'pending termination']);
const EXCLUDED_EDE_STATUSES = new Set(['cancelled', 'terminated', 'expired']);

export function normalizePolicyStatus(val: string | undefined | null): string {
  if (!val) return '';
  let v = val.trim().toLowerCase().replace(/\s+/g, ' ');
  if (v === 'pendingeffectuation' || v === 'pending effectuation') v = 'pending effectuated';
  if (v === 'pendingtermination') v = 'pending termination';
  if (v === 'pendingeffectuated') v = 'pending effectuated';
  return v;
}

export function isQualifiedEDEStatus(status: string): boolean {
  return VALID_EDE_STATUSES.has(status) && !EXCLUDED_EDE_STATUSES.has(status);
}

function normalizeEligible(val: string | undefined | null): string {
  if (!val) return '';
  const v = val.trim().toLowerCase();
  if (v === 'yes' || v === 'y' || v === 'true') return 'Yes';
  if (v === 'no' || v === 'n' || v === 'false') return 'No';
  return '';
}

function parseNum(val: string | undefined | null): number | null {
  if (val === null || val === undefined) return null;
  let v = String(val).trim();
  if (!v) return null;
  // handle parentheses for negatives e.g. "(1,234.56)"
  if (v.startsWith('(') && v.endsWith(')')) {
    v = '-' + v.slice(1, -1);
  }
  // remove dollar signs, commas, and whitespace
  v = v.replace(/[$,\s]/g, '');
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

export function parseMoney(value: unknown): number {
  if (value === null || value === undefined) return 0;
  let v = String(value).trim();
  if (!v) return 0;
  if (v.startsWith('(') && v.endsWith(')')) {
    v = '-' + v.slice(1, -1);
  }
  v = v.replace(/[$,\s]/g, '');
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
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
  // trim whitespace
  v = v.trim();
  // take only the part before the first dash (e.g. U12345-01 → U12345)
  const dashIdx = v.indexOf('-');
  if (dashIdx > 0) v = v.substring(0, dashIdx);
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
  policy_term_date: string | null;
  paid_through_date: string | null;
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

/**
 * Resolve issuerSubscriberId from a row, tolerating column-name variants
 * (different casing / snake_case) seen across EDE export formats.
 */
export function resolveIssuerSubscriberId(row: Record<string, string>): string {
  const raw =
    row['issuerSubscriberId'] ??
    row['IssuerSubscriberId'] ??
    row['issuerSubscriberID'] ??
    row['IssuerSubscriberID'] ??
    row['issuer_subscriber_id'] ??
    row['Issuer Subscriber ID'] ??
    row['Issuer Subscriber Id'] ??
    '';
  return stripApostrophe(raw);
}

/** True if the value looks like a valid issuer sub id (contains "U" + digits). */
export function isValidIssuerSubId(val: string | undefined | null): boolean {
  if (!val) return false;
  const v = String(val).trim();
  return /u/i.test(v) && /\d/.test(v);
}

export function normalizeEDERow(row: Record<string, string>, fileLabel: string): NormalizedRecord | null {
  if (!isAmbetterEDE(row)) return null;
  const first = (row['applicantFirstName'] || '').trim();
  const last = (row['applicantLastName'] || '').trim();
  const issuerSubIdRaw = resolveIssuerSubscriberId(row);
  const r: NormalizedRecord = {
    source_type: 'EDE',
    source_file_label: fileLabel,
    carrier: 'Ambetter',
    applicant_name: (row['applicantName'] || `${first} ${last}`).trim(),
    first_name: first,
    last_name: last,
    dob: normalizeDate(row['dob']),
    member_id: issuerSubIdRaw,
    policy_number: '',
    exchange_subscriber_id: cleanId(row['exchangeSubscriberId']),
    exchange_policy_id: cleanId(row['exchangePolicyId']),
    issuer_policy_id: cleanId(row['issuerPolicyId']),
    issuer_subscriber_id: cleanId(issuerSubIdRaw),
    agent_name: (row['agentName'] || '').trim(),
    agent_npn: stripApostrophe(row['agentNPN']),
    aor_bucket: '',
    pay_entity: '',
    status: normalizePolicyStatus(row['policyStatus']),
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
    commission_amount: parseMoney(row['Gross Commission']),
    eligible_for_commission: '',
    policy_term_date: null,
    paid_through_date: null,
    member_key: '',
    raw_json: row,
  };
  const npnInfo = NPN_MAP[r.agent_npn as keyof typeof NPN_MAP];
  if (npnInfo) r.aor_bucket = npnInfo.name;
  r.member_key = buildMemberKey(r);
  return r;
}
