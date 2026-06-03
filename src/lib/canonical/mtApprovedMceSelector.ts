/**
 * MCE Rewire — Phase B Item 4a (v2).
 *
 * Pure MT-approved selector: produces the MCE candidate set for a viewed
 * service month by reproducing the Member Timeline pipeline (the same
 * predicate + classifier the MT screen uses), then filtering to cells where
 * the per-month classifier state is `unpaid`.
 *
 * Design notes (locked by directive):
 *  - Export scope is ALWAYS official-AOR for MCE — uses
 *    `buildIsDueEligibleRecord({ aorScope: 'official', payEntity: scope })`.
 *  - `payEntity: 'All'` here is the official-AOR fleet ("official book across
 *    pay entities"), NOT the MT all-AOR audit mode.
 *  - The returned rows are already MCE-compatible — they carry the full
 *    field set the MCE enrichment/export loop reads (carrier, policy_number,
 *    issuer_subscriber_id, exchange_subscriber_id, expected_ede_effective_
 *    month, agent_npn, expected_pay_entity, actual_pay_entity, effective_
 *    date, issue_type, applicant_name, dob, plus `_mtNetBucket` and
 *    `_mtSourceType` sourced from the MT cell), so the page can drop them
 *    straight into the existing enrichment loop without rewriting column
 *    population.
 *  - Source Type literals come from this truth table on the MT row's flags:
 *      in_back_office===true && in_ede!==true  → 'BO Only'
 *      in_ede===true         && in_back_office!==true → 'EDE Only'
 *      otherwise (both present, or defensive fallback) → 'Matched'
 *  - Overlay grain compatibility is preserved by carrying carrier,
 *    policy_number, issuer_subscriber_id, and expected_ede_effective_month
 *    so `deriveGrainKeyForReconciledRow` still resolves.
 *  - No React hooks; unit-testable.
 */
import type { NormalizedRecord } from '../normalize';
import {
  buildIsDueEligibleRecord,
  buildClassifierContext,
  classifyMember,
  netPremiumForServiceMonth,
} from '../classifier';
import { buildMemberTimeline, type MemberTimelineRow } from '../memberTimeline';
import { buildMonthPickerMapForMember } from './edeMonthPicker';
import {
  latestAuthoritativeBoTermDates,
  makeBoRecency,
} from './latestAuthoritativeBo';
import { NPN_MAP } from '../constants';
import { extractNpnFromAorString } from '../agents';

export type McePayEntityScope = 'Coverall' | 'Vix' | 'All';

export interface MtApprovedMceCandidate {
  // ----- Identity / display -----
  member_key: string;
  applicant_name: string;
  dob: string;
  // ----- Policy identity (drives overlay grain via deriveGrainKeyForReconciledRow) -----
  carrier: string;
  policy_number: string;
  issuer_subscriber_id: string;
  exchange_subscriber_id: string;
  // ----- Service / batch context -----
  batch_id: string | null;
  service_month: string;
  target_service_month: string;
  expected_ede_effective_month: string | null;
  effective_date: string | null;
  // ----- AOR / pay entity -----
  current_policy_aor: string;
  aor_bucket: string;
  agent_npn: string;
  expected_pay_entity: string | null;
  actual_pay_entity: string | null;
  // ----- MCE loop reads -----
  issue_type: string;
  // ----- Cell-derived MT fields (replace breakdown.universe reads) -----
  _mtNetBucket: '+Net' | '0Net' | null;
  _mtSourceType: 'BO Only' | 'EDE Only' | 'Matched';
  // ----- Flags retained for transparency in tests / debugging -----
  in_back_office: boolean;
  in_ede: boolean;
}

export interface MtApprovedMceSelectorArgs {
  /** All-batch normalized records, already merged/identity-resolved
   *  (i.e. mergeRecordsToMemberKeys has been applied). */
  allBatchRecords: NormalizedRecord[];
  /** Inclusive month list spanning the MT classifier window. MUST include
   *  `serviceMonth`. */
  monthList: string[];
  /** Viewed service month (YYYY-MM) — the cell this selector reads. */
  serviceMonth: string;
  /** Official-AOR pay-entity scope. */
  scope: McePayEntityScope;
  /** batch_id → 'YYYY-MM' map; feeds the classifier's per-service-month
   *  net premium picker. */
  batchMonthByBatchId: Record<string, string>;
}

const STRING = (v: unknown): string => (v == null ? '' : String(v));

function pickFirst<T>(arr: T[], pred: (x: T) => boolean): T | undefined {
  for (const x of arr) if (pred(x)) return x;
  return undefined;
}

/**
 * For the unpaid cell at `serviceMonth`, pick the best EDE record to source
 * `expected_ede_effective_month`. Prefer an EDE row whose effective_date is
 * ≤ serviceMonth; otherwise the most recent EDE record.
 */
function pickExpectedEdeEffectiveMonth(
  recs: NormalizedRecord[],
  serviceMonth: string,
): string | null {
  const edes = recs.filter((r) => r.source_type === 'EDE' && r.effective_date);
  if (edes.length === 0) return null;
  edes.sort((a, b) =>
    STRING((b as any).effective_date).localeCompare(STRING((a as any).effective_date)),
  );
  const ymOf = (d: string) => d.substring(0, 7);
  // Prefer most-recent EDE whose effective month is ≤ serviceMonth.
  for (const e of edes) {
    const m = ymOf(STRING(e.effective_date));
    if (m && m <= serviceMonth) return m;
  }
  return ymOf(STRING(edes[0].effective_date));
}

function deriveSourceType(
  inBackOffice: boolean,
  inEde: boolean,
): 'BO Only' | 'EDE Only' | 'Matched' {
  if (inBackOffice && !inEde) return 'BO Only';
  if (inEde && !inBackOffice) return 'EDE Only';
  return 'Matched';
}

function lookupExpectedPayEntity(npn: string): string | null {
  const info = (NPN_MAP as any)[String(npn).trim()];
  if (!info) return null;
  const v = info.expectedPayEntity;
  if (v === 'Coverall' || v === 'Vix' || v === 'Coverall_or_Vix') return v;
  return null;
}

/**
 * Build the MCE candidate set for a viewed service month using the
 * MT-approved selector. The returned rows are already MCE-compatible — the
 * page can hand them to its existing enrichment/export loop unchanged.
 */
export function buildMtApprovedMceCandidates(
  args: MtApprovedMceSelectorArgs,
): MtApprovedMceCandidate[] {
  const { allBatchRecords, monthList, serviceMonth, scope, batchMonthByBatchId } = args;
  if (!serviceMonth || monthList.length === 0) return [];

  // ----- Mirror MemberTimelinePage’s pipeline parameterized for MCE -----
  const isDueEligibleRecord = buildIsDueEligibleRecord({
    aorScope: 'official',
    payEntity: scope,
  });

  // Scoped records drive the classifier (same gate MT uses for displayed
  // cells). The full record set drives Member Timeline’s assembly (so CR /
  // identity / FFM fallback still resolve correctly).
  const scopedRecords = allBatchRecords.filter(isDueEligibleRecord);

  // Per-member maps used by buildMemberTimeline + classifier.
  const rawRecordsByMemberKey = new Map<string, NormalizedRecord[]>();
  for (const r of allBatchRecords) {
    const k = (r.member_key as string) || (r.applicant_name as string) || 'unknown';
    let arr = rawRecordsByMemberKey.get(k);
    if (!arr) {
      arr = [];
      rawRecordsByMemberKey.set(k, arr);
    }
    arr.push(r);
  }
  const pickerMapsByMemberKey = new Map<string, Map<string, NormalizedRecord | null>>();
  for (const [k, recs] of rawRecordsByMemberKey) {
    pickerMapsByMemberKey.set(k, buildMonthPickerMapForMember(recs, monthList));
  }

  const batchMonthMap = new Map<string, string>(Object.entries(batchMonthByBatchId));

  // Phase B — cross-batch BO termination supersession overlay. Built from
  // the SAME all-batch record set used to drive the classifier so MT and
  // MCE share recency. Per-policy-identity grain.
  const recency = makeBoRecency({ batchMonthByBatchId: batchMonthMap });
  const latestAuthoritativeBoOverlay = latestAuthoritativeBoTermDates(
    allBatchRecords,
    recency,
  );

  const rows = buildMemberTimeline(scopedRecords, monthList, isDueEligibleRecord, {
    rawRecordsByMemberKey,
    pickerMapsByMemberKey,
    selectedAorScope: 'official',
    payEntity: scope,
    latestAuthoritativeBoOverlay,
  });

  // Classifier per member — same setup as MemberTimelinePage.
  const baseContext = buildClassifierContext(scopedRecords as any, monthList, [], {
    batchMonthByBatchId: batchMonthMap,
    latestAuthoritativeBoOverlay,
  });

  const scopedByMember = new Map<string, NormalizedRecord[]>();
  for (const r of scopedRecords) {
    const k = (r.member_key as string) || (r.applicant_name as string) || 'unknown';
    let arr = scopedByMember.get(k);
    if (!arr) {
      arr = [];
      scopedByMember.set(k, arr);
    }
    arr.push(r);
  }

  const out: MtApprovedMceCandidate[] = [];
  for (const row of rows as MemberTimelineRow[]) {
    const recs = scopedByMember.get(row.member_key) ?? [];
    if (recs.length === 0) continue;
    const pickerForMember = pickerMapsByMemberKey.get(row.member_key);
    const ctx = { ...baseContext, pickerEdeByMonth: pickerForMember };
    const classification = classifyMember(recs as any, ctx);
    const cls = classification.cells[serviceMonth];
    if (!cls || cls.state !== 'unpaid') continue;

    // Source-type from cell flags (truth table).
    const sourceType = deriveSourceType(!!cls.in_back_office, !!cls.in_ede);

    // Net bucket — same rule as MT: > 0 positive premium evidence → +Net.
    const np = netPremiumForServiceMonth(recs as any, serviceMonth, {
      batchMonthByBatchId: batchMonthMap,
      pickerEdeByMonth: pickerForMember,
      latestAuthoritativeBoOverlay,
    });
    const netBucket: '+Net' | '0Net' | null = np === null ? '0Net' : np > 0 ? '+Net' : '0Net';

    // Field harvest from the member’s normalized records for the MCE loop.
    const allRecs = rawRecordsByMemberKey.get(row.member_key) ?? recs;
    const carrierRec = pickFirst(allRecs, (r) => !!r.carrier);
    const policyRec = pickFirst(allRecs, (r) => !!r.policy_number);
    const isidRec = pickFirst(allRecs, (r) => !!r.issuer_subscriber_id);
    const esidRec = pickFirst(allRecs, (r) => !!r.exchange_subscriber_id);
    const npnRec = pickFirst(allRecs, (r) => !!r.agent_npn);
    const dobRec = pickFirst(allRecs, (r) => !!(r as any).dob);
    const batchRec =
      pickFirst(allRecs, (r) => r.source_type === 'BACK_OFFICE' && !!(r as any).batch_id) ??
      pickFirst(allRecs, (r) => !!(r as any).batch_id);
    const edeForEffective = pickFirst(allRecs, (r) => r.source_type === 'EDE' && !!r.effective_date);
    const boForEffective = pickFirst(allRecs, (r) => r.source_type === 'BACK_OFFICE' && !!r.effective_date);
    const commissionRecForPay = pickFirst(allRecs, (r) => r.source_type === 'COMMISSION' && !!(r as any).pay_entity);

    const aor = row.current_policy_aor || '';
    const aorNpn = extractNpnFromAorString(aor);
    const agentNpn = aorNpn || STRING(npnRec?.agent_npn);
    const expectedPayEntity = lookupExpectedPayEntity(agentNpn);
    const actualPayEntity = STRING((commissionRecForPay as any)?.pay_entity) || null;

    const candidate: MtApprovedMceCandidate = {
      member_key: row.member_key,
      applicant_name: row.applicant_name || '',
      dob: STRING((dobRec as any)?.dob),
      carrier: STRING(carrierRec?.carrier) || 'Ambetter',
      policy_number: STRING(policyRec?.policy_number),
      issuer_subscriber_id: STRING(isidRec?.issuer_subscriber_id),
      exchange_subscriber_id: STRING(esidRec?.exchange_subscriber_id),
      batch_id: (batchRec as any)?.batch_id ?? null,
      service_month: serviceMonth,
      target_service_month: serviceMonth,
      expected_ede_effective_month: pickExpectedEdeEffectiveMonth(allRecs, serviceMonth),
      effective_date:
        STRING((edeForEffective as any)?.effective_date) ||
        STRING((boForEffective as any)?.effective_date) ||
        null,
      current_policy_aor: aor,
      aor_bucket: row.aor_bucket || '',
      agent_npn: agentNpn,
      expected_pay_entity: expectedPayEntity,
      actual_pay_entity: actualPayEntity,
      issue_type: sourceType === 'BO Only' ? 'Missing from Commission' : 'Missing from Commission',
      _mtNetBucket: netBucket,
      _mtSourceType: sourceType,
      in_back_office: !!cls.in_back_office,
      in_ede: !!cls.in_ede,
    };
    out.push(candidate);
  }
  return out;
}
