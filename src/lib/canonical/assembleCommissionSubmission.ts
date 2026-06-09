/**
 * C3a — Headless commission-submission assembler (Ambetter, Messer-form).
 *
 * PURE / HEADLESS. No Supabase, no React, NO page imports, no loader calls.
 * Caller pre-loads the all-batch projection, rate rows, batchMonthByBatchId,
 * decision-index loader, and the date-range / scope inputs. This module:
 *
 *  1. Calls `assembleDiagnoseRouteRows({ ...serviceMonths: caller-bound })`
 *     and `projectDiagnoseRoutes({ rows, forceDecisionIndex: true })` to
 *     compute the CHASE inclusion truth — only rows whose final route is
 *     `chase_eligible` are submitted. Held / blocked / satisfied / DMI /
 *     amount-discrepancy / manual-review routes are excluded BY ROUTE.
 *  2. Groups included rows by
 *       (carrier | targetScope | stableMemberKey | policy_identity_key)
 *     using `derivePolicyKeyOrSentinel` so unresolvable policy identity is
 *     a stable sentinel + diagnostic, never silently merged.
 *  3. Enriches via the shared `enrichVendorFields` helper (3-layer rule:
 *     route = inclusion truth; MCE candidate = identity/AOR source; helper
 *     = the 12 vendor fields + dollar). Rows WITHOUT a matching candidate
 *     still emit using the route identity + same helper; the dollar comes
 *     back null + diagnostic.
 *  4. Seeds the operator comment (preview-only) from the classifier
 *     CellClassification.reason + shared `latestBoPaidThrough`. NEVER reads
 *     `internal_note`. NEVER parses dates out of the reason string.
 *  5. Emits diagnostics including the chase-vs-MCE-candidate
 *     set-relationship measure for build/post-sync visibility.
 *
 * NO CSV column edit. NO C0 write. NO DB writes. NO second all-batch fetch.
 * The hard dependency rule (lib never imports page) is asserted by a static
 * test in `src/test/assemble-commission-submission.test.ts`.
 */
import type { NormalizedRecord } from '@/lib/normalize';
import type { CarrierCompRateRow } from './compGrid';
import type { ClearingOverlayMap } from './crossBatchOverlay';
import {
  assembleDiagnoseRouteRows,
} from './assembleDiagnoseRouteRows';
import {
  projectDiagnoseRoutes,
  type RouteRowInput,
} from './diagnoseAndRoute';
import {
  derivePolicyKeyOrSentinel,
  deriveStableMemberKey,
  loadOperatorDecisionIndex,
  type DecisionIdentityInput,
  type OperatorDecisionIndex,
  type TargetScope,
} from './operatorDecisions';
import {
  buildMtApprovedMceCandidates,
  type MtApprovedMceCandidate,
} from './mtApprovedMceSelector';
import {
  createEstMissingResolver,
  type EstMissingStatus,
  type EstMissingResolution,
} from './estMissingResolver';
import { buildSourceEvidenceMap } from './estMissingEvidenceAdapter';
import {
  buildPolicyStateRecords,
  buildPolicyMemberCountRecords,
} from '../sweep/resolverRecordAdapters';
import { resolvePolicyStateForCompGrid } from './policyState';
import { resolvePolicyMemberCountForCompGrid } from './policyMemberCount';
import { canonicalCarrier } from '../carrierCanonical';
import { buildMemberProfile } from './memberProfileView';
import {
  enrichVendorFields,
  buildWritingAgentCarrierIdLookup,
  type WritingAgentIdEntry,
  type VendorFieldsOutput,
} from '../mce/vendorEnrichment';
import { latestBoPaidThrough } from './latestBoPaidThrough';

// ─────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────

export interface AssembleCommissionSubmissionArgs {
  /** Identity-merged all-batch projection (mergeRecordsToMemberKeys applied). */
  allBatchRecords: NormalizedRecord[];
  /** Inclusive classifier window. MUST cover every serviceMonth. */
  monthList: string[];
  /** Caller-bound submission window (chronological YYYY-MM list). */
  serviceMonths: string[];
  /** Per-entity scopes to submit; usually ['Coverall','Vix']. */
  targetScopes: Array<Extract<TargetScope, 'Coverall' | 'Vix'>>;
  /** batch_id → 'YYYY-MM'. */
  batchMonthByBatchId: Record<string, string>;
  today: string;
  rateRows: CarrierCompRateRow[];
  clearingOverlay?: ClearingOverlayMap;
  /** Forced decision-index loader. Defaults to the real one (force:true). */
  loadDecisionIndex?: (force: boolean) => Promise<OperatorDecisionIndex>;
}

export interface RowMonthAnchor {
  serviceMonth: string;
  rowKey: string;
}

export interface SubmissionRowGrainKey {
  carrier: string;
  targetScope: 'Coverall' | 'Vix';
  stableMemberKey: string;
  policy_identity_key: string;
  /** Non-null when the policy identity was unresolvable — sentinel reason. */
  policy_identity_unresolved_reason: string | null;
}

export interface SubmissionRow extends VendorFieldsOutput {
  /** Chronological de-duped raw YYYY-MM list of chase-eligible months. */
  missingMonths: string[];
  seededComment: string;
  rowMonthAnchors: RowMonthAnchor[];
  /** Sum of per-month estimatedMissingCommission. Null when every month
   *  was null/UNRESOLVED. Preview only — NEVER a CSV column. */
  previewEstimatedTotal: number | null;
  previewEstimatedStatus: EstMissingStatus | null;
  grainKey: SubmissionRowGrainKey;
}

export interface CommissionSubmissionDiagnostics {
  memberCount: number;
  rowCount: number;
  monthCount: number;
  /** Members that split into >1 submission row due to multiple policies. */
  multiPolicySplits: number;
  /** Rows whose policy_identity_key fell back to the sentinel. */
  unresolvedPolicySplits: number;
  /** Rows where the enrichment helper could not resolve a dollar. */
  unresolvedEnrichment: number;
  /** Set-relationship over (member,month,scope): chase ∩ MCE-candidate. */
  setRelationship: {
    chaseRows: number;
    chaseWithMceCandidate: number;
    chaseWithoutMceCandidate: number;
  };
}

export interface CommissionSubmissionPreview {
  rows: SubmissionRow[];
  diagnostics: CommissionSubmissionDiagnostics;
}

// ─────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────

const MONTH_LABEL = (m: string) => {
  const [y, mo] = m.split('-').map(Number);
  if (!y || !mo) return m;
  const d = new Date(Date.UTC(y, mo - 1, 1));
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
};

function joinMonthList(months: string[]): string {
  const labels = months.map(MONTH_LABEL);
  if (labels.length === 0) return '';
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
}

/** Seed-comment templates. NEVER reads internal_note, NEVER parses dates
 *  from the reason string. paid-through comes from the shared helper. */
export function buildSeededComment(opts: {
  reason: string;
  paidThrough: string; // 'YYYY-MM' or ''
  missingMonths: string[];
  isZeroNetPremium: boolean;
}): string {
  const monthsLabel = joinMonthList(opts.missingMonths);
  if (opts.isZeroNetPremium) {
    return `Zero-net-premium / fully-subsidized plan; commission not received for ${monthsLabel}.`;
  }
  const ptLabel = opts.paidThrough ? MONTH_LABEL(opts.paidThrough) : 'unknown';
  return `Back office affirmed paid-through ${ptLabel} covering the service month; commission not received for ${monthsLabel}.`;
}

function chronoSort(months: string[]): string[] {
  return Array.from(new Set(months)).sort();
}

// ─────────────────────────────────────────────────────────────────────────
// Public entry
// ─────────────────────────────────────────────────────────────────────────

export async function assembleCommissionSubmission(
  args: AssembleCommissionSubmissionArgs,
): Promise<CommissionSubmissionPreview> {
  const targetScopes: TargetScope[] = args.targetScopes.slice();

  // 1. Run the headless diagnose assembler over the caller-bound window.
  const assembled = assembleDiagnoseRouteRows({
    allBatchRecords: args.allBatchRecords,
    monthList: args.monthList,
    serviceMonths: args.serviceMonths,
    targetScopes,
    batchMonthByBatchId: args.batchMonthByBatchId,
    today: args.today,
    rateRows: args.rateRows,
    clearingOverlay: args.clearingOverlay,
  });

  // 2. Project routes (read-only) with FORCED decision-index reload.
  const projection = await projectDiagnoseRoutes({
    rows: assembled.rows,
    loadDecisionIndex: args.loadDecisionIndex ?? loadOperatorDecisionIndex,
    forceDecisionIndex: true,
  });

  const chaseSet = new Set(projection.chaseEligible);
  const chaseRows: RouteRowInput[] = assembled.rows.filter((r) => chaseSet.has(r.rowKey));

  // 3. Build MCE-candidate index per (scope, serviceMonth, stableMemberKey,
  //    policy_identity_key) for the enrichment join.
  type CandIdxKey = string;
  const candidateIndex = new Map<CandIdxKey, MtApprovedMceCandidate>();
  for (const scope of args.targetScopes) {
    for (const serviceMonth of args.serviceMonths) {
      const candidates = buildMtApprovedMceCandidates({
        allBatchRecords: args.allBatchRecords,
        monthList: args.monthList,
        serviceMonth,
        scope,
        batchMonthByBatchId: args.batchMonthByBatchId,
      });
      for (const c of candidates) {
        const identity: DecisionIdentityInput = {
          carrier: c.carrier || 'Ambetter',
          issuer_subscriber_id: c.issuer_subscriber_id || null,
          exchange_subscriber_id: c.exchange_subscriber_id || null,
          policy_number: c.policy_number || null,
        };
        const stable = deriveStableMemberKey(identity);
        if (!stable) continue;
        const pol = derivePolicyKeyOrSentinel(identity, stable);
        const k = `${scope}|${serviceMonth}|${stable}|${pol.policy_identity_key}`;
        candidateIndex.set(k, c);
      }
    }
  }

  // 4. Per-member raw record groups (for profile + enrichment helper).
  const recordsByMemberKey = new Map<string, NormalizedRecord[]>();
  for (const r of args.allBatchRecords) {
    const k = (r.member_key as string) || (r.applicant_name as string) || 'unknown';
    const arr = recordsByMemberKey.get(k);
    if (arr) arr.push(r); else recordsByMemberKey.set(k, [r]);
  }

  // 5. Writing-agent-carrier-id lookup (cross-batch).
  const batchMonthMap = new Map(Object.entries(args.batchMonthByBatchId));
  const writingAgentIdLookup: Map<string, WritingAgentIdEntry> =
    buildWritingAgentCarrierIdLookup({
      records: args.allBatchRecords,
      batchMonthByBatchId: batchMonthMap,
    });

  // 6. Per (scope, serviceMonth) resolver — mirrors the diagnose-route
  //    assembler's evidence synthesis so dollars match the route fact.
  type ResolverFn = (memberKey: string) => EstMissingResolution | null;
  const resolverByScopeMonth = new Map<string, ResolverFn>();
  for (const scope of args.targetScopes) {
    for (const serviceMonth of args.serviceMonths) {
      const evidenceRows: Array<Record<string, unknown>> = [];
      for (const [memberKey, recs] of recordsByMemberKey) {
        const stateRecords = buildPolicyStateRecords({
          normalizedRecords: recs as any,
          batchMonthById: args.batchMonthByBatchId,
        });
        const countRecords = buildPolicyMemberCountRecords({
          normalizedRecords: recs as any,
          batchMonthById: args.batchMonthByBatchId,
        });
        const stateRes = resolvePolicyStateForCompGrid({
          records: stateRecords,
          targetBatchMonth: serviceMonth,
          targetServiceMonths: [serviceMonth],
        });
        const countRes = resolvePolicyMemberCountForCompGrid({
          records: countRecords,
          targetBatchMonth: serviceMonth,
          targetServiceMonths: [serviceMonth],
        });
        const sample = recs.find((r) => r.source_type === 'BACK_OFFICE') ?? recs[0];
        evidenceRows.push({
          member_key: memberKey,
          carrier: canonicalCarrier(sample?.carrier ?? '') || null,
          state: stateRes.status === 'resolved' ? stateRes.state : null,
          member_count: countRes.status === 'resolved' ? countRes.memberCount : null,
          target_service_month: serviceMonth,
          expected_ede_effective_month: serviceMonth,
          effective_date: sample?.effective_date ?? null,
          current_policy_aor:
            ((sample as any)?.raw_json?.['currentPolicyAOR'] as string | undefined) ?? null,
          actual_pay_entity: scope,
          matched_payee: scope,
          policy_identity_key: null,
          plan_variant:
            ((sample as any)?.raw_json?.['plan_variant'] as string | undefined) ?? null,
        });
      }
      const evidenceMap = buildSourceEvidenceMap(evidenceRows);
      const { resolve } = createEstMissingResolver({
        rateRows: args.rateRows,
        batchMonth: serviceMonth,
        scope,
        overlayMap: args.clearingOverlay,
        sourceEvidenceByMemberKey: evidenceMap,
      });
      resolverByScopeMonth.set(`${scope}|${serviceMonth}`, (memberKey) => {
        return resolve({ row: { member_key: memberKey } });
      });
    }
  }

  // 7. Group chase rows by (carrier|targetScope|stableMemberKey|policy_identity_key).
  interface Group {
    grainKey: SubmissionRowGrainKey;
    months: Set<string>;
    /** rowKey ↔ serviceMonth anchors. */
    anchors: RowMonthAnchor[];
    /** Sample identity for fallback enrichment when no candidate exists. */
    identity: DecisionIdentityInput;
    /** memberKey from the underlying assembler row (volatile but stable
     *  enough within one pass). */
    memberKey: string;
  }
  const groups = new Map<string, Group>();
  const setRelationship = { chaseRows: 0, chaseWithMceCandidate: 0, chaseWithoutMceCandidate: 0 };

  // We need the underlying member_key for chase rows; derive from
  // identity via stableMemberKey → memberKey lookup. Build a reverse map
  // from stableMemberKey to a representative member_key.
  const stableToMemberKey = new Map<string, string>();
  for (const [memberKey, recs] of recordsByMemberKey) {
    for (const r of recs) {
      const id: DecisionIdentityInput = {
        carrier: r.carrier ?? null,
        issuer_subscriber_id: r.issuer_subscriber_id ?? null,
        exchange_subscriber_id: r.exchange_subscriber_id ?? null,
        policy_number: r.policy_number ?? null,
      };
      const s = deriveStableMemberKey(id);
      if (s && !stableToMemberKey.has(s)) stableToMemberKey.set(s, memberKey);
    }
  }

  for (const row of chaseRows) {
    setRelationship.chaseRows += 1;
    const pol = derivePolicyKeyOrSentinel(row.identity, row.stableMemberKey);
    const carrier = canonicalCarrier(row.identity.carrier ?? '') || row.carrier;
    const grainKey: SubmissionRowGrainKey = {
      carrier,
      targetScope: row.targetScope as 'Coverall' | 'Vix',
      stableMemberKey: row.stableMemberKey,
      policy_identity_key: pol.policy_identity_key,
      policy_identity_unresolved_reason: pol.unresolved_reason,
    };
    const groupKey = `${grainKey.carrier}|${grainKey.targetScope}|${grainKey.stableMemberKey}|${grainKey.policy_identity_key}`;
    let group = groups.get(groupKey);
    if (!group) {
      const memberKey = stableToMemberKey.get(row.stableMemberKey) ?? row.stableMemberKey;
      group = {
        grainKey,
        months: new Set(),
        anchors: [],
        identity: row.identity,
        memberKey,
      };
      groups.set(groupKey, group);
    }
    group.months.add(row.serviceMonth);
    group.anchors.push({ serviceMonth: row.serviceMonth, rowKey: row.rowKey });

    // Set-relationship measure.
    const candKey = `${row.targetScope}|${row.serviceMonth}|${row.stableMemberKey}|${pol.policy_identity_key}`;
    if (candidateIndex.has(candKey)) setRelationship.chaseWithMceCandidate += 1;
    else setRelationship.chaseWithoutMceCandidate += 1;
  }

  // 8. Build submission rows.
  const submissionRows: SubmissionRow[] = [];
  const diagnostics: CommissionSubmissionDiagnostics = {
    memberCount: 0,
    rowCount: 0,
    monthCount: 0,
    multiPolicySplits: 0,
    unresolvedPolicySplits: 0,
    unresolvedEnrichment: 0,
    setRelationship,
  };

  const groupsByStableMember = new Map<string, number>();
  for (const g of groups.values()) {
    groupsByStableMember.set(
      g.grainKey.stableMemberKey,
      (groupsByStableMember.get(g.grainKey.stableMemberKey) ?? 0) + 1,
    );
  }

  // For seededComment: per-scope CellClassification.reason at the first
  // missing month (deterministic).
  const traceByScope = assembled.traceContextByScope;

  for (const group of groups.values()) {
    const months = chronoSort(Array.from(group.months));
    // Pick the candidate from the earliest month if present, else any.
    let pickedCandidate: MtApprovedMceCandidate | null = null;
    for (const sm of months) {
      const k = `${group.grainKey.targetScope}|${sm}|${group.grainKey.stableMemberKey}|${group.grainKey.policy_identity_key}`;
      const c = candidateIndex.get(k);
      if (c) { pickedCandidate = c; break; }
    }

    const memberKey = pickedCandidate?.member_key ?? group.memberKey;
    const memberRecords = recordsByMemberKey.get(memberKey) ?? [];
    const profile = buildMemberProfile(memberKey, {
      records: memberRecords,
      referenceMonth: months[0] ?? '',
      batchMonthByBatchId: batchMonthMap,
      fallbackFfmCandidates: [],
    });

    // Synthesize a CandidateLike when there is no MCE candidate, using the
    // route identity + sample records (chase preserved).
    const candidateLike = pickedCandidate ?? {
      member_key: memberKey,
      applicant_name: profile.applicant_name.value ?? '',
      dob: profile.dob.value ?? '',
      policy_number: group.identity.policy_number ?? '',
      issuer_subscriber_id: group.identity.issuer_subscriber_id ?? '',
      exchange_subscriber_id: group.identity.exchange_subscriber_id ?? '',
      current_policy_aor: null,
      agent_npn: '',
      expected_pay_entity: null,
      actual_pay_entity: group.grainKey.targetScope,
      effective_date: null,
      batch_id: null,
    };

    // Per-month resolver pass → sum.
    let runningTotal = 0;
    let anyResolved = false;
    let lastStatus: EstMissingStatus | null = null;
    let unresolvedThisRow = false;
    for (const sm of months) {
      const fn = resolverByScopeMonth.get(`${group.grainKey.targetScope}|${sm}`);
      if (!fn) { unresolvedThisRow = true; continue; }
      const res = fn(memberKey);
      if (!res) { unresolvedThisRow = true; continue; }
      lastStatus = res.status;
      if (typeof res.amount === 'number' && Number.isFinite(res.amount)) {
        runningTotal += res.amount;
        anyResolved = true;
      } else {
        unresolvedThisRow = true;
      }
    }

    // Enrich vendor fields using shared helper (single dollar probe at the
    // EARLIEST missing month — totals come from the loop above).
    const earliest = months[0];
    const earliestFn = earliest
      ? resolverByScopeMonth.get(`${group.grainKey.targetScope}|${earliest}`)
      : null;
    const fields = enrichVendorFields({
      candidate: candidateLike,
      records: memberRecords,
      profile,
      commissionTripleRecords: [],
      scope: group.grainKey.targetScope,
      writingAgentIdLookup,
      resolveEstMissing: earliestFn
        ? (input) => earliestFn(memberKey) ?? ({ amount: null, status: 'UNSUPPORTED', evidence: {} as any } as EstMissingResolution)
        : undefined,
    });

    if (unresolvedThisRow && !anyResolved) {
      diagnostics.unresolvedEnrichment += 1;
    }

    // Seeded comment from the classifier reason + shared paid-through.
    const trace = traceByScope.get(group.grainKey.targetScope);
    const classification = trace?.classificationByMember.get(memberKey);
    const firstMonthCell = classification?.cells[earliest ?? ''];
    const reason = firstMonthCell?.reason ?? '';
    const isZero =
      pickedCandidate?._mtNetBucket === '0Net' ||
      (pickedCandidate?._mtNetBucket == null && /zero[- ]net/i.test(reason));
    const paidThrough = latestBoPaidThrough(memberRecords);
    const seededComment = buildSeededComment({
      reason,
      paidThrough,
      missingMonths: months,
      isZeroNetPremium: !!isZero,
    });

    submissionRows.push({
      ...fields,
      missingMonths: months,
      seededComment,
      rowMonthAnchors: group.anchors.slice().sort((a, b) =>
        a.serviceMonth < b.serviceMonth ? -1 : a.serviceMonth > b.serviceMonth ? 1 : 0,
      ),
      previewEstimatedTotal: anyResolved ? runningTotal : null,
      previewEstimatedStatus: lastStatus,
      grainKey: group.grainKey,
    });

    if (group.grainKey.policy_identity_unresolved_reason) {
      diagnostics.unresolvedPolicySplits += 1;
    }
  }

  // Multi-policy splits = members with >1 group.
  for (const count of groupsByStableMember.values()) {
    if (count > 1) diagnostics.multiPolicySplits += 1;
  }

  diagnostics.rowCount = submissionRows.length;
  diagnostics.memberCount = groupsByStableMember.size;
  const allMonths = new Set<string>();
  for (const r of submissionRows) for (const m of r.missingMonths) allMonths.add(m);
  diagnostics.monthCount = allMonths.size;

  return { rows: submissionRows, diagnostics };
}
