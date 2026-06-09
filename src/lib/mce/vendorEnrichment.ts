/**
 * C3a Extraction A — shared vendor-field enrichment for Ambetter Messer-form
 * carrier-facing rows.
 *
 * PURE / HEADLESS. No React, no Supabase, no page imports. Caller passes in
 * already-loaded records + a pre-built profile / resolver / lookup. The
 * MissingCommissionExportPage and the new headless commission-submission
 * assembler both consume this module so the 12 vendor fields + preview
 * estimated-missing-commission stay byte-for-byte identical across the two
 * surfaces.
 *
 * The pure helpers moved verbatim from
 * `src/pages/MissingCommissionExportPage.tsx`:178-423 — semantics are
 * preserved exactly. Existing MCE tests continue to import them from the
 * page (re-exported there) and stay green.
 */
import type { NormalizedRecord } from '@/lib/normalize';
import { extractNpnFromAorString } from '@/lib/agents';
import { isZeroNetPremium } from '@/lib/canonical/metrics';
import {
  buildMemberProfile,
  splitNameLastSpace,
  assembleAddressLine,
  type MemberProfile,
  type EnrichedField,
} from '@/lib/canonical/memberProfileView';
import type { CanonicalScope } from '@/lib/canonical/scope';
import type {
  EstMissingResolution,
  EstMissingStatus,
} from '@/lib/canonical/estMissingResolver';
import type { AdjustedRow } from '@/lib/canonical/crossBatchOverlay';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PremiumBucket = 'all' | 'zero_premium' | 'has_premium';

export interface WritingAgentIdEntry {
  /** Most-recent winning ID (by batch month, then created_at). */
  id: string;
  /** Distinct losing values, if any, for conflict warnings. */
  conflicts: string[];
}

// ---------------------------------------------------------------------------
// Pure helpers — moved verbatim from MissingCommissionExportPage.tsx
// ---------------------------------------------------------------------------

/**
 * Resolve "writing agent name" for the Messer form using the AOR-primary
 * fallback ladder spec'd in #104:
 *   current_policy_aor (display name) → BO Broker Name → Commission
 *   Writing Agent Name → blank.
 */
export function resolveWritingAgentName(opts: {
  currentPolicyAor: string | null | undefined;
  boBrokerName: string | null | undefined;
  commissionWritingAgentName: string | null | undefined;
}): string {
  const aor = String(opts.currentPolicyAor ?? '').trim();
  if (aor) {
    const cleaned = aor.replace(/\s*\(\d+\)\s*$/, '').trim();
    if (cleaned) return cleaned;
  }
  const boName = String(opts.boBrokerName ?? '').trim();
  if (boName) return boName;
  const commName = String(opts.commissionWritingAgentName ?? '').trim();
  if (commName) return commName;
  return '';
}

/** Member ID fallback ladder: issuer_subscriber_id → policy_number → exchange_subscriber_id. */
export function resolveMemberId(opts: {
  issuerSubscriberId: string | null | undefined;
  policyNumber: string | null | undefined;
  exchangeSubscriberId: string | null | undefined;
}): string {
  const i = String(opts.issuerSubscriberId ?? '').trim();
  if (i) return i;
  const p = String(opts.policyNumber ?? '').trim();
  if (p) return p;
  const e = String(opts.exchangeSubscriberId ?? '').trim();
  if (e) return e;
  return '';
}

export function resolvePolicyEffectiveDate(opts: {
  records: any[];
  reconciledEffectiveDate?: string | null;
}): string {
  const recs = opts.records || [];
  for (const r of recs) {
    if (r.source_type === 'EDE' && r.effective_date) return String(r.effective_date);
  }
  for (const r of recs) {
    if (r.source_type === 'EDE') {
      const v = r.raw_json?.effectiveDate;
      if (v) return String(v).trim();
    }
  }
  for (const r of recs) {
    if (r.source_type === 'BACK_OFFICE' && r.effective_date) return String(r.effective_date);
  }
  for (const r of recs) {
    if (r.source_type === 'BACK_OFFICE') {
      const v = r.raw_json?.['Policy Effective Date'];
      if (v) return String(v).trim();
    }
  }
  if (opts.reconciledEffectiveDate) return String(opts.reconciledEffectiveDate);
  for (const r of recs) {
    if (r.source_type === 'BACK_OFFICE' && r.broker_effective_date) return String(r.broker_effective_date);
  }
  return '';
}

function carrierIdLookupKey(carrier: string, payEntity: string, npn: string): string {
  return `${(carrier || '').trim().toLowerCase()}|${(payEntity || '').trim().toLowerCase()}|${(npn || '').trim()}`;
}

export function buildWritingAgentCarrierIdLookup(opts: {
  records: any[];
  batchMonthByBatchId: Map<string, string>;
}): Map<string, WritingAgentIdEntry> {
  const groups = new Map<string, Array<{ id: string; month: string; createdAt: string }>>();
  for (const r of opts.records) {
    if (r.source_type !== 'COMMISSION') continue;
    const id = String(r.writing_agent_carrier_id ?? '').trim();
    if (!id) continue;
    const npn = String(r.agent_npn ?? '').trim();
    if (!npn) continue;
    const key = carrierIdLookupKey(r.carrier ?? '', r.pay_entity ?? '', npn);
    const month = opts.batchMonthByBatchId.get(r.batch_id) || '';
    const arr = groups.get(key);
    const entry = { id, month, createdAt: String(r.created_at ?? '') };
    if (arr) arr.push(entry); else groups.set(key, [entry]);
  }
  const out = new Map<string, WritingAgentIdEntry>();
  for (const [key, rows] of groups) {
    rows.sort((a, b) => {
      if (a.month !== b.month) return a.month < b.month ? 1 : -1;
      return a.createdAt < b.createdAt ? 1 : -1;
    });
    const winner = rows[0].id;
    const losers = Array.from(new Set(rows.slice(1).map((r) => r.id).filter((v) => v !== winner)));
    out.set(key, { id: winner, conflicts: losers });
  }
  return out;
}

export function resolveTargetPayEntity(opts: {
  expectedPayEntity: string | null | undefined;
  actualPayEntity: string | null | undefined;
  scope: CanonicalScope;
  agentNpn: string | null | undefined;
}): string {
  if (opts.scope === 'Coverall') return 'Coverall';
  if (opts.scope === 'Vix') return 'Vix';
  const actual = String(opts.actualPayEntity ?? '').trim();
  if (actual === 'Coverall' || actual === 'Vix') return actual;
  const expected = String(opts.expectedPayEntity ?? '').trim();
  if (expected === 'Coverall' || expected === 'Vix') return expected;
  const npn = String(opts.agentNpn ?? '').trim();
  if (npn === '21055210' || npn === '16531877') return 'Coverall';
  return '';
}

export function resolveWritingAgentCarrierId(opts: {
  records: any[];
  carrier: string;
  payEntity: string;
  agentNpn: string;
  lookup: Map<string, WritingAgentIdEntry>;
}): string {
  const targetPe = String(opts.payEntity || '').trim();
  const npn = String(opts.agentNpn || '').trim();
  if (!targetPe || !npn) return '';
  for (const r of opts.records) {
    if (r.source_type !== 'COMMISSION') continue;
    const id = String(r.writing_agent_carrier_id ?? '').trim();
    if (!id) continue;
    const rowPe = String(r.pay_entity ?? '').trim();
    const rowNpn = String(r.agent_npn ?? '').trim();
    if (rowPe !== targetPe) continue;
    if (rowNpn !== npn) continue;
    return id;
  }
  const hit = opts.lookup.get(carrierIdLookupKey(opts.carrier, targetPe, npn));
  return hit ? hit.id : '';
}

export function classifyNetPremium(row: any): PremiumBucket {
  return isZeroNetPremium(row) ? 'zero_premium' : 'has_premium';
}

// ---------------------------------------------------------------------------
// C3a — single shared enrichment entry point.
//
// Consolidates the 12 vendor fields + preview estimated-missing-commission
// the MCE page builds per row (page :992-1122). Both the MCE page and the
// new commission-submission assembler call this; the parity test in
// `src/test/assemble-commission-submission.test.ts` locks identical output.
// ---------------------------------------------------------------------------

export interface VendorFieldsOutput {
  carrierName: string;
  npn: string;
  writingAgentCarrierId: string;
  writingAgentName: string;
  policyEffectiveDate: string;
  policyNumber: string;
  memberFirstName: string;
  memberLastName: string;
  dob: string;
  ssn: string;
  memberId: string;
  address: string;
  /** Preview only — NEVER a vendor CSV field. */
  estimatedMissingCommission: number | null;
  estMissingStatus: EstMissingStatus | null;
}

export interface CandidateLike {
  member_key: string;
  applicant_name?: string | null;
  dob?: string | null;
  policy_number?: string | null;
  issuer_subscriber_id?: string | null;
  exchange_subscriber_id?: string | null;
  current_policy_aor?: string | null;
  agent_npn?: string | null;
  expected_pay_entity?: string | null;
  actual_pay_entity?: string | null;
  effective_date?: string | null;
  batch_id?: string | null;
}

export interface EnrichVendorFieldsArgs {
  candidate: CandidateLike;
  /** All member records used by buildMemberProfile + identity walks. */
  records: NormalizedRecord[];
  /** Already-built profile (BO-first walk). */
  profile: MemberProfile;
  /** Cross-batch commission records for the Tier-1 direct WAC-ID lookup. */
  commissionTripleRecords: NormalizedRecord[];
  scope: CanonicalScope;
  writingAgentIdLookup: Map<string, WritingAgentIdEntry>;
  /** Optional resolver — when omitted, estimated-missing comes back null/UNRESOLVED. */
  resolveEstMissing?: (input: { row: any; adjustedRow?: AdjustedRow }) => EstMissingResolution;
  adjustedRow?: AdjustedRow;
}

/**
 * Pure helper. Produces the 12 vendor fields + preview est-missing for one
 * (candidate, scope, profile) tuple. Caller is responsible for assembling
 * the per-month grouping / `missingMonths` / seededComment around it.
 */
export function enrichVendorFields(args: EnrichVendorFieldsArgs): VendorFieldsOutput {
  const { candidate: m, records, profile, commissionTripleRecords, scope, writingAgentIdLookup } = args;

  const nameVal = profile.applicant_name.value || m.applicant_name || '';
  const { first, last } = splitNameLastSpace(nameVal);

  const aor = String(m.current_policy_aor ?? '').trim();
  const aorNpn = extractNpnFromAorString(aor);
  const npn = aorNpn || String(m.agent_npn ?? '').trim();

  const commRec = records.find((r) => r.source_type === 'COMMISSION' && r.writing_agent_carrier_id);
  const targetPayEntity = resolveTargetPayEntity({
    expectedPayEntity: m.expected_pay_entity,
    actualPayEntity: m.actual_pay_entity,
    scope,
    agentNpn: npn,
  });
  const writingAgentCarrierId = resolveWritingAgentCarrierId({
    records: [...records, ...commissionTripleRecords],
    carrier: 'Ambetter',
    payEntity: targetPayEntity,
    agentNpn: npn,
    lookup: writingAgentIdLookup,
  });

  const boRec = records.find((r) => r.source_type === 'BACK_OFFICE' && r.agent_name);
  const writingAgentName = resolveWritingAgentName({
    currentPolicyAor: aor,
    boBrokerName: boRec?.agent_name,
    commissionWritingAgentName: (commRec as any)?.agent_name,
  });

  const memberId = resolveMemberId({
    issuerSubscriberId: m.issuer_subscriber_id,
    policyNumber: m.policy_number,
    exchangeSubscriberId: m.exchange_subscriber_id,
  });

  const address = assembleAddressLine({
    address1: profile.address1.value,
    city: profile.city.value,
    state: profile.state.value,
    zip: profile.zip.value,
  });

  const policyEffectiveDate = resolvePolicyEffectiveDate({
    records,
    reconciledEffectiveDate: (m as any).effective_date ?? null,
  });

  let estimatedMissingCommission: number | null = null;
  let estMissingStatus: EstMissingStatus | null = null;
  if (args.resolveEstMissing) {
    try {
      const resolution = args.resolveEstMissing({ row: m as any, adjustedRow: args.adjustedRow });
      estimatedMissingCommission = resolution.amount;
      estMissingStatus = resolution.status;
    } catch {
      estimatedMissingCommission = null;
      estMissingStatus = null;
    }
  }

  return {
    carrierName: 'Ambetter',
    npn,
    writingAgentCarrierId,
    writingAgentName,
    policyEffectiveDate,
    policyNumber: String(m.policy_number ?? '') || '',
    memberFirstName: first,
    memberLastName: last,
    dob: profile.dob.value || (m.dob ? String(m.dob) : ''),
    ssn: '',
    memberId,
    address,
    estimatedMissingCommission,
    estMissingStatus,
  };
}

// Re-export profile types so consumers don't double-import.
export type { MemberProfile, EnrichedField };
export { buildMemberProfile, splitNameLastSpace, assembleAddressLine };
