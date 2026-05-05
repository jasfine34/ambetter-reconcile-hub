/**
 * ============================================================================
 * AOR semantics in this system (canonical — read before adding a new carrier)
 * ============================================================================
 *
 * `currentPolicyAOR` (sourced from EDE) is the **canonical** Agent-of-Record
 * field. It represents the policyholder's chosen agent on the exchange and is
 * the single source of truth for "is this our member?" scope filtering.
 *
 * `aor_bucket` is **derived from agent_npn** (the writing agent on the
 * back-office / commission feed). It is preserved on every reconciled member
 * for visibility and routing of commission dollars, but it does NOT define
 * ownership. An agent can write a policy whose AOR belongs to someone else,
 * and an agent can hold the AOR on a policy that someone else wrote.
 *
 * Rules for future carrier adapters:
 *   1. Expose the carrier's equivalent of `currentPolicyAOR` (or its closest
 *      analogue, e.g. "Agent of Record" string on the back-office feed) as
 *      the canonical AOR on the normalized record. Use the existing
 *      `current_policy_aor` column on `reconciled_members`.
 *   2. Expose the writing-agent NPN as a separate field (`agent_npn`) and
 *      let the classifier derive `aor_bucket` from it.
 *   3. Never collapse the two into one column — downstream pages
 *      (Agent Summary, Dashboard "Found in BO", Commission Inquiry export)
 *      depend on the distinction.
 *
 * See ARCHITECTURE_PLAN.md § Canonical Definitions for the cross-page
 * contract.
 * ============================================================================
 */
import { NPN_MAP } from './constants';
import { getBackOfficeAdapter } from './carriers';

export function stripApostrophe(val: string | undefined | null): string {
  if (!val) return '';
  return val.replace(/^'+/, '').trim();
}

export function normalizeDate(val: string | undefined | null): string | null {
  if (!val) return null;
  const v = val.trim();
  if (!v) return null;
  // Try ISO format first (YYYY-MM-DD) — no timezone conversion needed
  const isoMatch = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  // Try M/D/YYYY or MM/DD/YYYY or M-D-YYYY
  const slashMatch = v.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (slashMatch) {
    const [, m, d, y] = slashMatch;
    let yr = parseInt(y, 10);
    if (yr < 100) yr += 2000;
    return `${yr}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return null;
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

export function normalizeEligible(val: string | undefined | null): string {
  if (!val) return '';
  const v = val.trim().toLowerCase();
  if (v === 'yes' || v === 'y' || v === 'true') return 'Yes';
  if (v === 'no' || v === 'n' || v === 'false') return 'No';
  return '';
}

export function parseNum(val: string | undefined | null): number | null {
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

function parseBool(val: string | undefined | null): boolean | null {
  if (val === null || val === undefined) return null;
  const v = String(val).trim().toLowerCase();
  if (!v) return null;
  if (v === 'true' || v === 'yes' || v === 'y' || v === '1') return true;
  if (v === 'false' || v === 'no' || v === 'n' || v === '0') return false;
  return null;
}

function parseInteger(val: string | undefined | null): number | null {
  if (val === null || val === undefined) return null;
  const v = String(val).trim();
  if (!v) return null;
  const n = parseInt(v, 10);
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

/**
 * Subscriber-ID-specific cleaner. Use ONLY for ESID/ISID-class fields:
 *   - exchange_subscriber_id
 *   - issuer_subscriber_id (incl. the commission policy_number → issuer_sub
 *     alias in normalizeCommissionRow, where the value is being used as a
 *     subscriber id, not as a policy number)
 *   - resolver sidecar overlay assignments for resolved_issuer_subscriber_id
 *     / resolved_exchange_subscriber_id
 *   - buildMemberKey ESID/ISID branches
 *   - weakMatch.ts ESID/ISID lookups
 *
 * This wraps cleanId() and additionally strips leading zeros for purely
 * numeric values (e.g. "0023487406" → "23487406") to fix the Feb #115
 * defect where EDE Summary emits stripped ESIDs but Jason BO emits padded
 * ESIDs, causing union-find conflict refusals.
 *
 * Preserved as-is (regex /^0+[1-9]\d*$/ deliberately requires a non-zero
 * digit after the run of zeros):
 *   - alphanumeric IDs like "u00012345", "u0"  → leading "u" prevents match
 *   - pure-zero values "0" / "0000"            → no non-zero tail, no strip
 *
 * NEVER use for policy_number-as-policy_number, exchange_policy_id,
 * issuer_policy_id, agent_npn, or writing_agent_carrier_id — those may
 * carry meaningful leading zeros for future carrier adapters.
 */
export function cleanSubscriberId(val: string | undefined | null): string {
  const c = cleanId(val);
  if (/^0+[1-9]\d*$/.test(c)) return c.replace(/^0+/, '');
  return c;
}

function isAmbetterEDE(row: Record<string, string>): boolean {
  const issuer = (row['issuer'] || row['Issuer'] || '').toLowerCase();
  return issuer.includes('ambetter');
}

function isAmbetterCommission(row: Record<string, string>): boolean {
  // Check Database column
  const db = (row['Database'] || row['database'] || '').toLowerCase();
  if (db.includes('ambetter')) return true;
  // Check Company ID column
  const companyId = (row['Company ID'] || '').toLowerCase();
  if (companyId.includes('ambetter')) return true;
  // Check if policy number starts with "U" — Ambetter's policy number format
  // Do NOT include all non-empty policy numbers — that pulls in non-Ambetter rows
  const policyNum = (row['Policy Number'] || '').trim();
  if (policyNum.toUpperCase().startsWith('U')) return true;
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
  // Phase 1b typed columns — populated when the source file provides the
  // signal; null/empty otherwise. See ARCHITECTURE_PLAN.md §2.1.
  broker_effective_date: string | null;
  broker_term_date: string | null;
  member_responsibility: number | null;
  on_off_exchange: string;
  auto_renewal: boolean | null;
  ede_policy_origin_type: string;
  ede_bucket: string;
  policy_modified_date: string | null;
  client_address_1: string;
  client_address_2: string;
  client_city: string;
  client_state_full: string;
  client_zip: string;
  paid_to_date: string | null;
  months_paid: number | null;
  writing_agent_carrier_id: string;
  member_key: string;
  raw_json: Record<string, string>;
}

export function buildMemberKey(r: Partial<NormalizedRecord>): string {
  // Priority: issuer_subscriber_id > exchange_subscriber_id > policy_number > exchange_policy_id > name+dob
  // ESID/ISID branches use cleanSubscriberId so that leading-zero-padded
  // numeric values collapse to the same key whether the upstream feed
  // emitted "0023487406" (Feb Jason BO) or "23487406" (Feb EDE Summary).
  const isid = cleanSubscriberId(r.issuer_subscriber_id);
  if (isid) return `issub:${isid}`;
  const esid = cleanSubscriberId(r.exchange_subscriber_id);
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
 * Map an agent NPN to the canonical AOR bucket (Jason / Erica / Becky).
 * Mutates the record in place; no-op if NPN isn't one of ours.
 */
export function applyNpnBucket(r: NormalizedRecord): void {
  const npnInfo = NPN_MAP[r.agent_npn as keyof typeof NPN_MAP];
  if (npnInfo) r.aor_bucket = npnInfo.name;
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

/** Factory for a blank record — ensures new fields are always initialised. */
function newRecord(partial: Partial<NormalizedRecord>): NormalizedRecord {
  return {
    source_type: '',
    source_file_label: '',
    carrier: '',
    applicant_name: '',
    first_name: '',
    last_name: '',
    dob: null,
    member_id: '',
    policy_number: '',
    exchange_subscriber_id: '',
    exchange_policy_id: '',
    issuer_policy_id: '',
    issuer_subscriber_id: '',
    agent_name: '',
    agent_npn: '',
    aor_bucket: '',
    pay_entity: '',
    status: '',
    effective_date: null,
    premium: null,
    net_premium: null,
    commission_amount: null,
    eligible_for_commission: '',
    policy_term_date: null,
    paid_through_date: null,
    broker_effective_date: null,
    broker_term_date: null,
    member_responsibility: null,
    on_off_exchange: '',
    auto_renewal: null,
    ede_policy_origin_type: '',
    ede_bucket: '',
    policy_modified_date: null,
    client_address_1: '',
    client_address_2: '',
    client_city: '',
    client_state_full: '',
    client_zip: '',
    paid_to_date: null,
    months_paid: null,
    writing_agent_carrier_id: '',
    member_key: '',
    raw_json: {},
    ...partial,
  };
}

export function normalizeEDERow(row: Record<string, string>, fileLabel: string): NormalizedRecord | null {
  if (!isAmbetterEDE(row)) return null;
  const first = (row['applicantFirstName'] || '').trim();
  const last = (row['applicantLastName'] || '').trim();
  const issuerSubIdRaw = resolveIssuerSubscriberId(row);

  const r = newRecord({
    source_type: 'EDE',
    source_file_label: fileLabel,
    carrier: 'Ambetter',
    applicant_name: (row['applicantName'] || `${first} ${last}`).trim(),
    first_name: first,
    last_name: last,
    // EDE's `dob` column is present but universally empty in MyMFG exports —
    // DOB is sourced from the carrier back office instead (§2.1).
    dob: normalizeDate(row['dob']),
    member_id: issuerSubIdRaw,
    exchange_subscriber_id: cleanSubscriberId(row['exchangeSubscriberId']),
    exchange_policy_id: cleanId(row['exchangePolicyId']),
    issuer_policy_id: cleanId(row['issuerPolicyId']),
    issuer_subscriber_id: cleanSubscriberId(issuerSubIdRaw),
    agent_name: (row['agentName'] || '').trim(),
    agent_npn: stripApostrophe(row['agentNPN']),
    status: normalizePolicyStatus(row['policyStatus']),
    effective_date: normalizeDate(row['effectiveDate']),
    premium: parseNum(row['premium']),
    net_premium: parseNum(row['netPremium']),
    // Phase 1b: EDE enrichment columns
    auto_renewal: parseBool(row['autoRenewal']),
    ede_policy_origin_type: (row['edePolicyOriginType'] || '').trim(),
    ede_bucket: (row['bucket'] || '').trim(),
    policy_modified_date: normalizeDate(row['policyModifiedDate']),
    client_address_1: (row['clientAddress1'] || '').trim(),
    client_address_2: (row['clientAddress2'] || '').trim(),
    client_city: (row['clientCity'] || '').trim(),
    client_state_full: (row['clientState'] || '').trim(),
    client_zip: (row['clientZipCode'] || '').trim(),
    raw_json: row,
  });

  applyNpnBucket(r);
  r.member_key = buildMemberKey(r);
  return r;
}

/**
 * Back Office normalization dispatches to the registered carrier adapter.
 * Today only Ambetter is registered; adding Molina / Cigna / etc. is a new
 * file under src/lib/carriers/<name>/ plus a registry entry.
 */
export function normalizeBackOfficeRow(
  row: Record<string, string>,
  fileLabel: string,
  aorBucket: string,
): NormalizedRecord {
  const adapter = getBackOfficeAdapter('Ambetter');
  return adapter.normalizeRow(row, fileLabel, aorBucket);
}

export function normalizeCommissionRow(row: Record<string, string>, fileLabel: string, payEntity: string): NormalizedRecord | null {
  if (!isAmbetterCommission(row)) return null;
  const policyNum = stripApostrophe(row['Policy Number'] || '');
  const agentName = (row['Agent Name_1'] || row['Agent Name.1'] || row['Agent Name'] || '').trim();
  const npn = stripApostrophe(row['Writing Agent ID'] || '');
  // Messer commission statements carry two identifiers for the writing
  // agent: a carrier-specific "Agent ID" and an FMO "eACID". Prefer eACID
  // when present (it's the cross-carrier identifier Messer uses); fall back
  // to Agent ID for backwards compat.
  const writingAgentCarrierId = (row['eACID'] || row['Agent ID'] || '').toString().trim();

  const r = newRecord({
    source_type: 'COMMISSION',
    source_file_label: fileLabel,
    carrier: 'Ambetter',
    applicant_name: (row['Policyholder Name'] || '').trim(),
    policy_number: cleanId(policyNum),
    // Commission rows alias policy_number into issuer_subscriber_id because
    // Ambetter commission feeds carry the U-id in the Policy Number column
    // and reconcile keys subscribers off issuer_subscriber_id. At THIS point
    // the value is being used as a subscriber id, so it gets the
    // subscriber-id cleaner (strip leading zeros for purely numeric).
    // The policy_number field above keeps its untouched cleanId() because
    // it's still being used as a policy number — leading zeros there may
    // be meaningful for future carrier adapters.
    issuer_subscriber_id: cleanSubscriberId(policyNum),
    agent_name: agentName,
    agent_npn: cleanId(npn) || npn,
    pay_entity: payEntity,
    status: (row['Policy Status'] || '').trim(),
    effective_date: normalizeDate(row['Issue Date']),
    premium: parseNum(row['Commissionable']),
    commission_amount: parseMoney(row['Gross Commission']),
    // Phase 1b: cross-month attribution + per-state writing agent id
    paid_to_date: normalizeDate(row['Paid-To Date']),
    months_paid: parseInteger(row['Months Paid']),
    writing_agent_carrier_id: writingAgentCarrierId,
    raw_json: row,
  });

  applyNpnBucket(r);
  r.member_key = buildMemberKey(r);
  return r;
}
