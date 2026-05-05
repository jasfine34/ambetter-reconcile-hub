/**
 * Ambetter Back Office adapter.
 *
 * Encapsulates Ambetter-specific knowledge of the BO CSV schema, so that
 * adding Molina / Cigna / etc. later means dropping in a sibling adapter
 * rather than branching inside normalize.ts. See §3 of ARCHITECTURE_PLAN.md
 * for the adapter pattern.
 *
 * Ambetter is a Tier A carrier (§4.3): `Broker Effective Date` is present,
 * which lets the classifier determine first-eligible month from a single row
 * without reaching back into EDE snapshot history.
 *
 * Column reference (Ambetter BO headers, April 2026):
 *   A  Broker Name            (agent_name)
 *   B  Broker NPN             (agent_npn)
 *   C  Policy Number          (policy_number / issuer_subscriber_id)
 *   D  Plan Name
 *   E  Insured First Name     (first_name)
 *   F  Insured Last Name      (last_name)
 *   G  Broker Effective Date  (broker_effective_date) ← Tier A signal
 *   H  Broker Term Date       (broker_term_date; '12/31/9999' = active)
 *   I  Policy Effective Date  (effective_date)
 *   J  Policy Term Date       (policy_term_date)
 *   K  Paid Through Date      (paid_through_date)
 *   L  Member Responsibility  (member_responsibility) — member-owed premium
 *   M  Monthly Premium Amount (premium)
 *   P  On/Off Exchange        (on_off_exchange)
 *   Q  Exchange Subscriber ID (exchange_subscriber_id)
 *   T  Member Date Of Birth   (dob)
 *   V  Eligible for Commission(eligible_for_commission)
 */
import type { NormalizedRecord } from '../../normalize';
import {
  cleanId,
  cleanSubscriberId,
  stripApostrophe,
  normalizeDate,
  normalizeEligible,
  parseNum,
  buildMemberKey,
  applyNpnBucket,
} from '../../normalize';

export const AMBETTER_CARRIER = 'Ambetter';

/**
 * Detect an Ambetter BO file from its CSV headers. Used by the upload schema
 * check to confirm the user picked the right slot.
 */
export function detectAmbetterBackOfficeSchema(headers: string[]): boolean {
  const set = new Set(headers.map(h => h.trim()));
  // Distinctive columns for Ambetter BO specifically
  return set.has('Broker NPN') && set.has('Policy Number') && set.has('Broker Effective Date');
}

export function normalizeAmbetterBackOfficeRow(
  row: Record<string, string>,
  fileLabel: string,
  aorBucket: string,
): NormalizedRecord {
  const first = (row['Insured First Name'] || '').trim();
  const last = (row['Insured Last Name'] || '').trim();
  const npn = stripApostrophe(row['Broker NPN']);
  const policyNumber = stripApostrophe(row['Policy Number']);
  const termRaw = (row['Broker Term Date'] || '').trim();
  // Carrier convention: 12/31/9999 means "no term, still active"
  const brokerTerm = termRaw === '12/31/9999' ? null : normalizeDate(termRaw);

  const r: NormalizedRecord = {
    source_type: 'BACK_OFFICE',
    source_file_label: fileLabel,
    carrier: AMBETTER_CARRIER,
    applicant_name: `${first} ${last}`.trim(),
    first_name: first,
    last_name: last,
    dob: normalizeDate(row['Member Date Of Birth']),
    member_id: '',
    policy_number: cleanId(policyNumber),
    exchange_subscriber_id: cleanSubscriberId(row['Exchange Subscriber ID']),
    exchange_policy_id: '',
    issuer_policy_id: '',
    // Ambetter BO carries the U-subscriber-id in the Policy Number column;
    // when used as issuer_subscriber_id we route through the subscriber-id
    // cleaner so leading-zero asymmetry between EDE and BO collapses
    // (Feb #115). The policy_number field above keeps cleanId() because it
    // is still being used as a policy number.
    issuer_subscriber_id: cleanSubscriberId(policyNumber),
    agent_name: (row['Broker Name'] || '').trim(),
    agent_npn: npn,
    aor_bucket: aorBucket,
    pay_entity: '',
    status: (row['Policy Status'] || '').trim(),
    effective_date: normalizeDate(row['Policy Effective Date']),
    premium: parseNum(row['Monthly Premium Amount']),
    net_premium: null,
    commission_amount: null,
    eligible_for_commission: normalizeEligible(row['Eligible for Commission']),
    policy_term_date: normalizeDate(row['Policy Term Date']),
    paid_through_date: normalizeDate(row['Paid Through Date']),
    // Phase 1b typed columns
    broker_effective_date: normalizeDate(row['Broker Effective Date']),
    broker_term_date: brokerTerm,
    member_responsibility: parseNum(row['Member Responsibility']),
    on_off_exchange: (row['On/Off Exchange'] || '').trim(),
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
    raw_json: row,
  };

  applyNpnBucket(r);
  r.member_key = buildMemberKey(r);
  return r;
}
