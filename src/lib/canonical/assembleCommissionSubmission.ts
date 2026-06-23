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
  type EstMissingInputEvidence,
} from './estMissingResolver';
import {
  buildPolicyStateRecords,
  buildPolicyMemberCountRecords,
} from '../sweep/resolverRecordAdapters';
import { resolvePolicyStateForCompGrid } from './policyState';
import { resolvePolicyMemberCountForCompGrid } from './policyMemberCount';
import { canonicalCarrier } from '../carrierCanonical';
import { deriveAmbetterTxPlanVariant } from './planVariant';
import { buildMemberProfile } from './memberProfileView';
import {
  enrichVendorFields,
  buildWritingAgentCarrierIdLookup,
  type WritingAgentIdEntry,
  type VendorFieldsOutput,
} from '../mce/vendorEnrichment';
import { latestBoPaidThrough } from './latestBoPaidThrough';
import { derivePolicyIdentityKey } from './policyIdentityKey';

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
  /** Row-month dollar resolutions using resolved policy-grain evidence. */
  previewDollarPolicyGrainCount: number;
  /** Row-month dollar resolutions using member fallback for unresolved policy identities. */
  previewDollarMemberFallbackCount: number;
  /** Output rows whose dollar evidence used the unresolved-policy member fallback. */
  previewDollarUnresolvedPolicyRows: number;
  /** Set-relationship over (member,month,scope): chase ∩ MCE-candidate. */
  setRelationship: {
    chaseRows: number;
    chaseWithMceCandidate: number;
    chaseWithoutMceCandidate: number;
  };
  /** C3 Vix statement-leg guard: groups dropped because the member has no
   *  Vix commission statement appearance in args.allBatchRecords. */
  vixScopeExcludedRows: number;
  vixScopeExcludedMembers: number;
  /** Sorted list of stable member keys excluded by the Vix statement-leg guard. */
  vixScopeExcludedMemberList: string[];
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
  if (!opts.paidThrough) {
    return `Commission not received for ${monthsLabel}.`;
  }
  const ptLabel = MONTH_LABEL(opts.paidThrough);
  return `Back office affirmed paid-through ${ptLabel} covering the service month; commission not received for ${monthsLabel}.`;
}

function chronoSort(months: string[]): string[] {
  return Array.from(new Set(months)).sort();
}

function policyIdentityKeyForRecord(r: NormalizedRecord): string | null {
  const id = derivePolicyIdentityKey({
    carrier: r.carrier ?? null,
    policy_number: r.policy_number ?? null,
    issuer_subscriber_id: r.issuer_subscriber_id ?? null,
  });
  return id.status === 'resolved' ? id.key : null;
}

/**
 * C3-grain-fix: Two-pass canonicalization helper.
 *
 * Given a raw policy_identity_key (possibly the sub-form `cc|sub:<sid>`) and
 * a precomputed set of pn-form keys (`cc|<pn>`) seen across the same
 * (member, scope), remap the sub-form key onto its same-value pn-form key
 * when present. Otherwise return the raw key unchanged (preserves legitimate
 * sub-only / unresolved / pn keys).
 */
function canonicalizePolicyKey(rawKey: string, pnKeySet: Set<string>): string {
  if (!rawKey) return rawKey;
  // Match `<carrier>|sub:<sid>`; require a non-empty carrier segment.
  const idx = rawKey.indexOf('|sub:');
  if (idx <= 0) return rawKey;
  const cc = rawKey.slice(0, idx);
  const sid = rawKey.slice(idx + '|sub:'.length);
  if (!cc || !sid) return rawKey;
  const pnForm = `${cc}|${sid}`;
  return pnKeySet.has(pnForm) ? pnForm : rawKey;
}

/** Pn-form keys (`cc|<pn>`) derived from records whose policy identity used
 *  `policy_number` or `aliased` lineage. Used by canonicalizePolicyKey. */
function collectPnFormKeys(recs: Iterable<NormalizedRecord>): Set<string> {
  const out = new Set<string>();
  for (const r of recs) {
    const id = derivePolicyIdentityKey({
      carrier: r.carrier ?? null,
      policy_number: r.policy_number ?? null,
      issuer_subscriber_id: r.issuer_subscriber_id ?? null,
    });
    if (id.status !== 'resolved') continue;
    if (id.lineage.used === 'policy_number' || id.lineage.used === 'aliased') {
      out.add(id.key);
    }
  }
  return out;
}

function recordsForPolicyIdentity(recs: NormalizedRecord[], policyIdentityKey: string): NormalizedRecord[] {
  return recs.filter((r) => policyIdentityKeyForRecord(r) === policyIdentityKey);
}

/** C3-grain-fix R2: record membership honors the CANONICAL key. */
function recordsForCanonicalPolicyIdentity(
  recs: NormalizedRecord[],
  canonicalKey: string,
  pnKeySet: Set<string>,
): NormalizedRecord[] {
  return recs.filter((r) => {
    const raw = policyIdentityKeyForRecord(r);
    if (!raw) return false;
    return canonicalizePolicyKey(raw, pnKeySet) === canonicalKey;
  });
}

export function buildEstMissingInputEvidence(opts: {
  memberKey: string;
  records: NormalizedRecord[];
  serviceMonth: string;
  scope: Extract<TargetScope, 'Coverall' | 'Vix'>;
  batchMonthByBatchId: Record<string, string>;
  policyIdentityKey: string;
}): EstMissingInputEvidence {
  const sample =
    opts.records.find((r) => r.source_type === 'BACK_OFFICE') ??
    opts.records.find((r) => r.source_type === 'EDE') ??
    opts.records[0];
  const stateRecords = buildPolicyStateRecords({
    normalizedRecords: opts.records as any,
    batchMonthById: opts.batchMonthByBatchId,
  });
  const countRecords = buildPolicyMemberCountRecords({
    normalizedRecords: opts.records as any,
    batchMonthById: opts.batchMonthByBatchId,
  });
  const stateRes = resolvePolicyStateForCompGrid({
    records: stateRecords,
    targetBatchMonth: opts.serviceMonth,
    targetServiceMonths: [opts.serviceMonth],
  });
  const countRes = resolvePolicyMemberCountForCompGrid({
    records: countRecords,
    targetBatchMonth: opts.serviceMonth,
    targetServiceMonths: [opts.serviceMonth],
  });
  const edeWithAor = opts.records.find((r) => r.source_type === 'EDE' && (r as any)?.raw_json?.currentPolicyAOR);
  const policyYear = Number(opts.serviceMonth.substring(0, 4));
  const carrierCanonical = canonicalCarrier(sample?.carrier ?? '') || null;
  const stateVal = stateRes.status === 'resolved' ? stateRes.state : null;
  return {
    carrier: carrierCanonical,
    state: stateVal,
    member_count: countRes.status === 'resolved' ? countRes.memberCount : null,
    months: 1,
    policy_year: Number.isFinite(policyYear) ? policyYear : null,
    plan_variant:
      deriveAmbetterTxPlanVariant({
        carrier: carrierCanonical,
        state: stateVal,
        sources: opts.records.map((r) => ({
          raw_json: (r as any)?.raw_json,
          source_type: r.source_type,
        })),
      }) ??
      ((sample as any)?.raw_json?.plan_variant as string | undefined) ??
      null,
    current_policy_aor: ((edeWithAor as any)?.raw_json?.currentPolicyAOR as string | undefined) ?? null,
    matched_payee: opts.scope,
    policy_identity_key: opts.policyIdentityKey,
    target_service_month: opts.serviceMonth,
    member_count_status: countRes.status,
    member_count_conflicts: countRes.conflicts,
  };
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

  // C3-grain-fix Pass 1: per (scope, stableMemberKey) collect the pn-form
  // policy_identity_key set so a sub-form key on a sibling record can be
  // remapped onto the same-value pn-form key (Pass 2).
  const EMPTY_PN_SET: ReadonlySet<string> = new Set<string>();
  const pnKeySetByScopeStable = new Map<string, Set<string>>();
  for (const scope of args.targetScopes) {
    const trace = assembled.traceContextByScope.get(scope);
    if (!trace) continue;
    for (const recs of trace.scopedRecordsByMemberKey.values()) {
      for (const r of recs) {
        const identity: DecisionIdentityInput = {
          carrier: r.carrier ?? null,
          issuer_subscriber_id: r.issuer_subscriber_id ?? null,
          exchange_subscriber_id: r.exchange_subscriber_id ?? null,
          policy_number: r.policy_number ?? null,
        };
        const stable = deriveStableMemberKey(identity);
        if (!stable) continue;
        const id = derivePolicyIdentityKey({
          carrier: r.carrier ?? null,
          policy_number: r.policy_number ?? null,
          issuer_subscriber_id: r.issuer_subscriber_id ?? null,
        });
        if (id.status !== 'resolved') continue;
        if (id.lineage.used !== 'policy_number' && id.lineage.used !== 'aliased') continue;
        const mk = `${scope}|${stable}`;
        let set = pnKeySetByScopeStable.get(mk);
        if (!set) { set = new Set(); pnKeySetByScopeStable.set(mk, set); }
        set.add(id.key);
      }
    }
  }
  const getPnSet = (scope: string, stable: string): Set<string> =>
    (pnKeySetByScopeStable.get(`${scope}|${stable}`) ?? EMPTY_PN_SET) as Set<string>;

  // 3. Build MCE-candidate index per (scope, serviceMonth, stableMemberKey,
  //    CANONICAL policy_identity_key) for the enrichment join.
  type CandIdxKey = string;
  const candidateIndex = new Map<CandIdxKey, MtApprovedMceCandidate>();
  const candidatesByScopeMonthStable = new Map<string, MtApprovedMceCandidate[]>();
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
        const canonicalPolKey = canonicalizePolicyKey(pol.policy_identity_key, getPnSet(scope, stable));
        const k = `${scope}|${serviceMonth}|${stable}|${canonicalPolKey}`;
        candidateIndex.set(k, c);
        const listKey = `${scope}|${serviceMonth}|${stable}`;
        const list = candidatesByScopeMonthStable.get(listKey);
        if (list) list.push(c); else candidatesByScopeMonthStable.set(listKey, [c]);
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

  // 6. Per (scope, serviceMonth) resolver shell. Submission rows pass explicit
  //    row-grain evidence; no silent member-map fallback for resolved policies.
  type ResolverFn = (memberKey: string, inputEvidence: EstMissingInputEvidence) => EstMissingResolution;
  const resolverByScopeMonth = new Map<string, ResolverFn>();
  for (const scope of args.targetScopes) {
    for (const serviceMonth of args.serviceMonths) {
      const { resolve } = createEstMissingResolver({
        rateRows: args.rateRows,
        batchMonth: serviceMonth,
        scope,
        overlayMap: args.clearingOverlay,
      });
      resolverByScopeMonth.set(`${scope}|${serviceMonth}`, (memberKey, inputEvidence) => {
        return resolve({ row: { member_key: memberKey }, inputEvidence });
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
    const siblingCandidates = candidatesByScopeMonthStable.get(`${row.targetScope}|${row.serviceMonth}|${row.stableMemberKey}`) ?? [];
    const splitCandidates = siblingCandidates;
    if (splitCandidates.length > 0) setRelationship.chaseWithMceCandidate += 1;
    else setRelationship.chaseWithoutMceCandidate += 1;

    const rowMemberKey = assembled.evidenceBindingsByRowKey.get(row.rowKey)?.memberKey ?? stableToMemberKey.get(row.stableMemberKey) ?? row.stableMemberKey;
    const scopedForRow = assembled.traceContextByScope.get(row.targetScope)?.scopedRecordsByMemberKey.get(rowMemberKey)
      ?? recordsByMemberKey.get(rowMemberKey)
      ?? [];
    // C3-grain-fix Pass 2: canonicalize each record's raw key against the
    // (scope, stable) pn-form set, then enumerate grains from CANONICAL keys.
    // Prefer an identity that carries `policy_number` so the downstream
    // derivePolicyKeyOrSentinel emits the pn-form key (full vendor fields).
    const pnKeySet = getPnSet(row.targetScope, row.stableMemberKey);
    const policyIdentities = new Map<string, DecisionIdentityInput>();
    for (const rec of scopedForRow) {
      const identity: DecisionIdentityInput = {
        carrier: rec.carrier ?? null,
        issuer_subscriber_id: rec.issuer_subscriber_id ?? null,
        exchange_subscriber_id: rec.exchange_subscriber_id ?? null,
        policy_number: rec.policy_number ?? null,
      };
      if (deriveStableMemberKey(identity) !== row.stableMemberKey) continue;
      const rawKey = policyIdentityKeyForRecord(rec);
      if (!rawKey) continue;
      const canonical = canonicalizePolicyKey(rawKey, pnKeySet);
      const existing = policyIdentities.get(canonical);
      if (!existing) {
        policyIdentities.set(canonical, identity);
      } else if (!existing.policy_number && identity.policy_number) {
        policyIdentities.set(canonical, identity);
      }
    }

    const grains = policyIdentities.size > 0
      ? Array.from(policyIdentities.values()).map((identity) => ({ identity, memberKey: rowMemberKey }))
      : splitCandidates.length > 0
      ? splitCandidates.map((c) => {
          const identity: DecisionIdentityInput = {
            carrier: c.carrier || row.identity.carrier,
            issuer_subscriber_id: c.issuer_subscriber_id || null,
            exchange_subscriber_id: c.exchange_subscriber_id || null,
            policy_number: c.policy_number || null,
          };
          return { identity, memberKey: c.member_key };
        })
      : [{ identity: row.identity, memberKey: rowMemberKey }];

    for (const grain of grains) {
      const grainPol = derivePolicyKeyOrSentinel(grain.identity, row.stableMemberKey);
      const canonicalPolicyKey = canonicalizePolicyKey(grainPol.policy_identity_key, pnKeySet);
      const carrier = canonicalCarrier(grain.identity.carrier ?? '') || row.carrier;
      const grainKey: SubmissionRowGrainKey = {
        carrier,
        targetScope: row.targetScope as 'Coverall' | 'Vix',
        stableMemberKey: row.stableMemberKey,
        policy_identity_key: canonicalPolicyKey,
        policy_identity_unresolved_reason: grainPol.unresolved_reason,
      };
      const groupKey = `${grainKey.carrier}|${grainKey.targetScope}|${grainKey.stableMemberKey}|${grainKey.policy_identity_key}`;
      let group = groups.get(groupKey);
      if (!group) {
        group = {
          grainKey,
          months: new Set(),
          anchors: [],
          identity: grain.identity,
          memberKey: grain.memberKey,
        };
        groups.set(groupKey, group);
      }
      group.months.add(row.serviceMonth);
      if (!group.anchors.some((a) => a.rowKey === row.rowKey)) {
        group.anchors.push({ serviceMonth: row.serviceMonth, rowKey: row.rowKey });
      }
    }
  }

  // C3 Vix statement-leg guard: a member may appear in the Vix section ONLY
  // if they have ≥1 record with source_type === 'COMMISSION' && pay_entity
  // === 'Vix' anywhere in args.allBatchRecords. NO AOR logic here.
  const vixStatementMembers = new Set<string>();
  for (const r of args.allBatchRecords) {
    if (r.source_type !== 'COMMISSION') continue;
    if (((r as any).pay_entity ?? '') !== 'Vix') continue;
    const identity: DecisionIdentityInput = {
      carrier: r.carrier ?? null,
      issuer_subscriber_id: r.issuer_subscriber_id ?? null,
      exchange_subscriber_id: r.exchange_subscriber_id ?? null,
      policy_number: r.policy_number ?? null,
    };
    const stable = deriveStableMemberKey(identity);
    if (stable) vixStatementMembers.add(stable);
  }

  // Filter Vix-scoped groups for members lacking Vix statement history BEFORE
  // diagnostics aggregation. Coverall/non-Vix groups untouched.
  const emittedGroups = new Map<string, Group>();
  const vixExcludedMembers = new Set<string>();
  let vixExcludedRowsCount = 0;
  for (const [k, g] of groups) {
    if (
      g.grainKey.targetScope === 'Vix' &&
      !vixStatementMembers.has(g.grainKey.stableMemberKey)
    ) {
      vixExcludedRowsCount += 1;
      vixExcludedMembers.add(g.grainKey.stableMemberKey);
      continue;
    }
    emittedGroups.set(k, g);
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
    previewDollarPolicyGrainCount: 0,
    previewDollarMemberFallbackCount: 0,
    previewDollarUnresolvedPolicyRows: 0,
    setRelationship,
    vixScopeExcludedRows: vixExcludedRowsCount,
    vixScopeExcludedMembers: vixExcludedMembers.size,
    vixScopeExcludedMemberList: Array.from(vixExcludedMembers).sort(),
  };

  const groupsByStableMember = new Map<string, number>();
  for (const g of emittedGroups.values()) {
    groupsByStableMember.set(
      g.grainKey.stableMemberKey,
      (groupsByStableMember.get(g.grainKey.stableMemberKey) ?? 0) + 1,
    );
  }

  // For seededComment: per-scope CellClassification.reason at the first
  // missing month (deterministic).
  const traceByScope = assembled.traceContextByScope;

  for (const group of emittedGroups.values()) {
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

    const trace = traceByScope.get(group.grainKey.targetScope);
    const scopedMemberRecords = trace?.scopedRecordsByMemberKey.get(memberKey) ?? memberRecords;
    const baseEvidenceRecords = scopedMemberRecords.length > 0 ? scopedMemberRecords : memberRecords;
    const isResolvedPolicyGrain = group.grainKey.policy_identity_unresolved_reason == null;
    // C3-grain-fix R2: membership uses the CANONICAL key so both pn-form and
    // sub-form records belonging to the same real policy are retained.
    const groupPnKeySet = getPnSet(group.grainKey.targetScope, group.grainKey.stableMemberKey);
    const seedPaidThroughRecords = isResolvedPolicyGrain
      ? recordsForCanonicalPolicyIdentity(baseEvidenceRecords, group.grainKey.policy_identity_key, groupPnKeySet)
      : baseEvidenceRecords;

    // Per-month resolver pass → sum.
    let runningTotal = 0;
    let anyResolved = false;
    let lastStatus: EstMissingStatus | null = null;
    let unresolvedThisRow = false;
    const evidenceByMonth = new Map<string, EstMissingInputEvidence>();
    for (const sm of months) {
      const fn = resolverByScopeMonth.get(`${group.grainKey.targetScope}|${sm}`);
      if (!fn) { unresolvedThisRow = true; continue; }
      const evidenceRecords = isResolvedPolicyGrain
        ? recordsForCanonicalPolicyIdentity(baseEvidenceRecords, group.grainKey.policy_identity_key, groupPnKeySet)
        : baseEvidenceRecords;
      const inputEvidence = buildEstMissingInputEvidence({
        memberKey,
        records: evidenceRecords,
        serviceMonth: sm,
        scope: group.grainKey.targetScope,
        batchMonthByBatchId: args.batchMonthByBatchId,
        policyIdentityKey: group.grainKey.policy_identity_key,
      });
      evidenceByMonth.set(sm, inputEvidence);
      if (isResolvedPolicyGrain) diagnostics.previewDollarPolicyGrainCount += 1;
      else diagnostics.previewDollarMemberFallbackCount += 1;
      const res = fn(memberKey, inputEvidence);
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
    const earliestEvidence = earliest ? evidenceByMonth.get(earliest) : undefined;
    const fields = enrichVendorFields({
      candidate: candidateLike,
      records: memberRecords,
      profile,
      commissionTripleRecords: [],
      scope: group.grainKey.targetScope,
      writingAgentIdLookup,
      resolveEstMissing: earliestFn && earliestEvidence
        ? (input) => earliestFn(memberKey, earliestEvidence) ?? ({ amount: null, status: 'UNSUPPORTED', evidence: {} as any } as EstMissingResolution)
        : undefined,
    });

    if (unresolvedThisRow && !anyResolved) {
      diagnostics.unresolvedEnrichment += 1;
    }

    // Seeded comment from the classifier reason + shared paid-through.
    const classification = trace?.classificationByMember.get(memberKey);
    const firstMonthCell = classification?.cells[earliest ?? ''];
    const reason = firstMonthCell?.reason ?? '';
    const isZero =
      pickedCandidate?._mtNetBucket === '0Net' ||
      (pickedCandidate?._mtNetBucket == null && /zero[- ]net/i.test(reason));
    const paidThrough = latestBoPaidThrough(seedPaidThroughRecords);
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
      diagnostics.previewDollarUnresolvedPolicyRows += 1;
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
