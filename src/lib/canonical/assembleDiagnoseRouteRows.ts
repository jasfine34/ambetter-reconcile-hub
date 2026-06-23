/**
 * C2b-1 — Headless diagnose-and-route production assembler.
 *
 * Pure composition of certified MT/MCE helpers + the C1a blocker-facts
 * layer + the C1b RouteRowInput row shape. NO Supabase, NO React, NO
 * second all-batch fetch, NO per-row DB calls. The caller is responsible
 * for:
 *   - Loading the all-batch projection (mergeRecordsToMemberKeys applied)
 *   - Bounding monthList + serviceMonths (Jan–Apr is NOT hardcoded here)
 *   - Passing pre-loaded rateRows + batchMonthByBatchId
 *   - Calling runDiagnoseCycle(args.rows) on the assembled output
 *
 * Composition (no helper edits — composed verbatim):
 *   1. Once per cycle: latestAuthoritativeBoTermDates + per-member
 *      buildMonthPickerMapForMember.
 *   2. Per requested scope (incl. the opposite of any Coverall/Vix in
 *      targetScopes, so cross-entity classifier cells are available):
 *      buildIsDueEligibleRecord → buildMemberTimeline → buildClassifierContext
 *      → classifyMember (memoized by (scope, member_key)).
 *   3. Per (scope, serviceMonth): a fresh buildSourceEvidenceMap over THAT
 *      month's synthesized row set (the map overwrites by member_key, so
 *      it MUST never be shared across months) + one
 *      createEstMissingResolver(ctx).resolve bound to (scope, serviceMonth).
 *   4. Per member-month-scope cell whose state ∈ {unpaid, paid}:
 *      buildBlockerFacts({ targetCell, pickedEdeForMonth, otherEntityCell,
 *      resolve, today, memberKey, evidenceForResolver }) → assemble
 *      RouteRowInput (CURRENT engine grain: carrier|stableMemberKey|
 *      serviceMonth|targetScope — policy_identity_key is NOT added).
 *
 * Service-month bound: rows are emitted ONLY for caller-supplied
 * serviceMonths, even if monthList carries additional months for the
 * classifier window.
 *
 * Decision-overlay non-interference: this assembler does NOT consult
 * operator_decisions — held member-months still appear in `rows`; the
 * downstream router/cycle is responsible for hold-aware routing.
 *
 * Resolver UNSUPPORTED handling: a row is STILL emitted when the
 * resolver returns UNSUPPORTED / TBD_AMBIGUOUS_PAYEE — the amount fact
 * naturally becomes `indeterminate(reason)` (or `not_applicable` when the
 * target cell is unpaid and not cross-entity-satisfied). The reason is
 * counted in diagnostics.unsupportedResolverReasons.
 */
import { buildBlockerFacts } from './blockerFacts';
import { buildSourceEvidenceMap } from './estMissingEvidenceAdapter';
import {
  createEstMissingResolver,
  type EstMissingInputEvidence,
} from './estMissingResolver';
import {
  buildMonthPickerMapForMember,
} from './edeMonthPicker';
import {
  latestAuthoritativeBoTermDates,
  makeBoRecency,
  type LatestAuthoritativeBoOverlay,
} from './latestAuthoritativeBo';
import {
  buildClassifierContext,
  buildIsDueEligibleRecord,
  classifyMember,
  type CellClassification,
  type ClassifierContext,
  type MemberClassification,
  type PayEntityScope,
} from '../classifier';
import { buildMemberTimeline, type MemberTimelineRow } from '../memberTimeline';
import { canonicalCarrier } from '../carrierCanonical';
import { deriveAmbetterTxPlanVariant } from './planVariant';
import {
  deriveStableMemberKey,
  type DecisionIdentityInput,
  type TargetScope,
} from './operatorDecisions';
import type { RouteRowInput } from './diagnoseAndRoute';
import type { NormalizedRecord } from '../normalize';
import type { CarrierCompRateRow } from './compGrid';
import type { ClearingOverlayMap } from './crossBatchOverlay';
import { buildPolicyMemberCountRecords, buildPolicyStateRecords } from '../sweep/resolverRecordAdapters';
import { resolvePolicyMemberCountForCompGrid } from './policyMemberCount';
import { resolvePolicyStateForCompGrid } from './policyState';

// ─────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────

export interface AssembleDiagnoseRouteRowsArgs {
  allBatchRecords: NormalizedRecord[];
  /** Inclusive classifier window (YYYY-MM, chronological). MUST include
   *  every entry in `serviceMonths`. */
  monthList: string[];
  /** Caller-bound service months to emit rows for. NEVER hardcoded here. */
  serviceMonths: string[];
  /** MVP: ['Coverall','Vix']. 'All' is supported but does NOT auto-emit
   *  a third row set when both per-entity scopes are present. */
  targetScopes: TargetScope[];
  /** batch_id → 'YYYY-MM' (drives MT classifier + BO recency). */
  batchMonthByBatchId: Record<string, string>;
  /** 'YYYY-MM-DD' for DMI expiry evaluation. */
  today: string;
  /** Pre-loaded comp rate chart. Pure resolver input. */
  rateRows: CarrierCompRateRow[];
  /** Optional cross-batch clearing overlay (currently unused by the
   *  per-row resolve path; reserved for future PARTIAL_CLEARED feeds). */
  clearingOverlay?: ClearingOverlayMap;
}

export interface AssembleDiagnoseRouteRowsDiagnostics {
  population1Count: number;
  population2Count: number;
  byScope: Record<string, { unpaid: number; paid: number }>;
  unsupportedResolverReasons: Record<string, number>;
}

export interface EvidenceBinding {
  rowKey: string;
  /** The exact MT member_key used at row emit time. Never reverse-derive. */
  memberKey: string;
  serviceMonth: string;
  targetScope: 'Coverall' | 'Vix';
}

export interface ScopeTraceContext {
  /** Per-member, scope-filtered records (what explainCell expects pre-scoped). */
  scopedRecordsByMemberKey: Map<string, NormalizedRecord[]>;
  /** Scope-level base classifier context (NO per-member picker overlay). */
  baseClassifierContext: ClassifierContext;
  mtRowsByMember: Map<string, MemberTimelineRow>;
  classificationByMember: Map<string, MemberClassification>;
}

export interface AssembleDiagnoseRouteRowsResult {
  rows: RouteRowInput[];
  diagnostics: AssembleDiagnoseRouteRowsDiagnostics;
  /** C2c additive — Evidence binding per emitted row (captured AT EMIT TIME). */
  evidenceBindingsByRowKey: Map<string, EvidenceBinding>;
  /** C2c additive — Per-member EDE month-picker map (shared across scopes). */
  pickerMapsByMemberKey: Map<string, Map<string, NormalizedRecord | null>>;
  /** C2c additive — Per-scope trace context (records + base classifier ctx). */
  traceContextByScope: Map<TargetScope, ScopeTraceContext>;
}

// ─────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────

function opposite(scope: TargetScope): 'Coverall' | 'Vix' | null {
  if (scope === 'Coverall') return 'Vix';
  if (scope === 'Vix') return 'Coverall';
  return null;
}

function pickIdentity(recs: NormalizedRecord[]): DecisionIdentityInput {
  const carrierRec = recs.find((r) => !!r.carrier);
  const isidRec = recs.find((r) => !!r.issuer_subscriber_id);
  const esidRec = recs.find((r) => !!r.exchange_subscriber_id);
  const pnRec = recs.find((r) => !!r.policy_number);
  return {
    carrier: carrierRec?.carrier ?? recs[0]?.carrier ?? null,
    issuer_subscriber_id: isidRec?.issuer_subscriber_id ?? null,
    exchange_subscriber_id: esidRec?.exchange_subscriber_id ?? null,
    policy_number: pnRec?.policy_number ?? null,
  };
}

/** Synthesize a resolver-evidence row for a single (member, serviceMonth).
 *  buildSourceEvidenceMap consumes the shape the per-page reconciled rows
 *  expose; we provide an equivalent record-derived shape. */
function synthesizeEvidenceRow(
  memberKey: string,
  recs: NormalizedRecord[],
  serviceMonth: string,
  scope: TargetScope,
  batchMonthByBatchId: Record<string, string>,
  pickedEdeForMonth: NormalizedRecord | null,
): { row: Record<string, unknown>; memberCountResolution: { status: 'resolved' | 'unresolved' | 'manual_review'; conflicts?: number[] } } {
  const sample =
    recs.find((r) => r.source_type === 'BACK_OFFICE') ??
    recs.find((r) => r.source_type === 'EDE') ??
    recs.find((r) => r.source_type === 'COMMISSION') ??
    recs[0];
  // C2b-1 AMOUNT-EVIDENCE FIX: canonicalize carrier so rate-grid lookups
  // key on the same canonical form as the rate chart (e.g. "Ambetter" →
  // "ambetter"). NO display-text fallback — an uncanonicalizable carrier
  // must MISS truthfully (downstream resolver reports MISSING_CARRIER /
  // carrier_state_not_in_grid) instead of pretending to key on display text.
  const carrierCanonicalEvidence =
    canonicalCarrier(sample?.carrier ?? '') || null;
  // C2b-1 NO_RATE_ROW corrective: route the scoped member's records through
  // the canonical state resolver so rate lookups key on normalized state
  // (e.g. "Florida" → "FL") just like MCE. Locking targetBatchMonth to the
  // row's serviceMonth prevents latest-month bleed across service months.
  // unresolved / manual_review → null → resolver reports MISSING_STATE
  // truthfully instead of false NO_RATE_ROW.
  const stateRecords = buildPolicyStateRecords({
    normalizedRecords: recs as any,
    batchMonthById: batchMonthByBatchId,
  });
  const stateRes = resolvePolicyStateForCompGrid({
    records: stateRecords,
    targetBatchMonth: serviceMonth,
    targetServiceMonths: [serviceMonth],
  });
  const state = stateRes.status === 'resolved' ? stateRes.state : null;
  // C2b-1 member-count corrective (R-CARR-007): route the scoped member's
  // records through the canonical adapter + resolver. targetBatchMonth is
  // LOCKED to the row's serviceMonth — never the latest month — so a Feb
  // assembler row never inherits Mar's count from the all-batch cache.
  // No default-to-1; an unresolved/manual_review result emits null so the
  // resolver reports MISSING_MEMBER_COUNT legitimately. Stage 2 surfaces
  // the conflict (manual_review) on facts.memberCount for the engine.
  const countRecords = buildPolicyMemberCountRecords({
    normalizedRecords: recs as any,
    batchMonthById: batchMonthByBatchId,
  });
  const memberCountRes = resolvePolicyMemberCountForCompGrid({
    records: countRecords,
    targetBatchMonth: serviceMonth,
    targetServiceMonths: [serviceMonth],
  });
  const memberCount = memberCountRes.status === 'resolved' ? memberCountRes.memberCount : null;
  const commissionRec = recs.find(
    (r) => r.source_type === 'COMMISSION' && !!(r as any).pay_entity,
  );
  // C2b-1 AMOUNT-EVIDENCE FIX: AOR sourced from the service-month picked EDE
  // (same picker the facts loop uses). Controlled fallback only across scoped
  // EDE rows — NEVER fall back to the BO-first sample (BO is from latest BO
  // batch and would mask Erica overrides on terminated/recreated policies,
  // producing the wrong dollar via the regular grid instead of the $0.50/$4.50
  // override).
  let currentPolicyAor: string | null =
    ((pickedEdeForMonth as any)?.raw_json?.['currentPolicyAOR'] as string | undefined) ?? null;
  if (!currentPolicyAor) {
    for (const r of recs) {
      if (r.source_type !== 'EDE') continue;
      const v = (r as any)?.raw_json?.['currentPolicyAOR'] as string | undefined;
      if (v) {
        currentPolicyAor = v;
        break;
      }
    }
  }
  return {
    row: {
      member_key: memberKey,
      carrier: carrierCanonicalEvidence,
      state,
      member_count: memberCount,
      target_service_month: serviceMonth,
      expected_ede_effective_month: serviceMonth,
      effective_date: sample?.effective_date ?? null,
      current_policy_aor: currentPolicyAor,
      actual_pay_entity:
        (commissionRec as any)?.pay_entity ??
        (scope === 'All' ? null : scope),
      matched_payee: scope === 'All' ? null : scope,
      policy_identity_key: null,
      plan_variant:
        deriveAmbetterTxPlanVariant({
          carrier: carrierCanonicalEvidence,
          state,
          sources: recs.map((r) => ({
            raw_json: (r as any)?.raw_json,
            source_type: r.source_type,
          })),
        }) ??
        ((sample as any)?.raw_json?.['plan_variant'] as string | undefined) ??
        null,
      member_count_status: memberCountRes.status,
      member_count_conflicts: memberCountRes.conflicts,
    },
    memberCountResolution: {
      status: memberCountRes.status,
      conflicts: memberCountRes.conflicts,
    },
  };
}



interface ScopeContext {
  scope: TargetScope;
  predicate: (r: NormalizedRecord) => boolean;
  mtRowsByMember: Map<string, MemberTimelineRow>;
  classificationByMember: Map<string, MemberClassification>;
  scopedByMember: Map<string, NormalizedRecord[]>;
  baseClassifierContext: ClassifierContext;
}

function buildScopeContext(
  scope: TargetScope,
  args: AssembleDiagnoseRouteRowsArgs,
  rawRecordsByMemberKey: Map<string, NormalizedRecord[]>,
  pickerMapsByMemberKey: Map<string, Map<string, NormalizedRecord | null>>,
  batchMonthMap: Map<string, string>,
  overlay: LatestAuthoritativeBoOverlay,
): ScopeContext {
  const payEntity: PayEntityScope = scope; // 'Coverall'|'Vix'|'All' all valid
  const predicate = buildIsDueEligibleRecord({
    aorScope: 'official',
    payEntity,
  });
  const scopedRecords = args.allBatchRecords.filter(predicate);

  const mtRows = buildMemberTimeline(
    scopedRecords,
    args.monthList,
    predicate,
    {
      rawRecordsByMemberKey,
      pickerMapsByMemberKey,
      selectedAorScope: 'official',
      payEntity,
      latestAuthoritativeBoOverlay: overlay,
    },
  ) as MemberTimelineRow[];

  const baseContext = buildClassifierContext(
    scopedRecords as any,
    args.monthList,
    [],
    {
      batchMonthByBatchId: batchMonthMap,
      latestAuthoritativeBoOverlay: overlay,
    },
  );

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

  const mtRowsByMember = new Map<string, MemberTimelineRow>();
  const classificationByMember = new Map<string, MemberClassification>();
  for (const row of mtRows) {
    mtRowsByMember.set(row.member_key, row);
    const recs = scopedByMember.get(row.member_key) ?? [];
    if (recs.length === 0) continue;
    const pickerForMember = pickerMapsByMemberKey.get(row.member_key);
    const ctx = { ...baseContext, pickerEdeByMonth: pickerForMember };
    classificationByMember.set(row.member_key, classifyMember(recs as any, ctx));
  }

  return {
    scope,
    predicate,
    mtRowsByMember,
    classificationByMember,
    scopedByMember,
    baseClassifierContext: baseContext,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Public entry
// ─────────────────────────────────────────────────────────────────────────

export function assembleDiagnoseRouteRows(
  args: AssembleDiagnoseRouteRowsArgs,
): AssembleDiagnoseRouteRowsResult {
  const diagnostics: AssembleDiagnoseRouteRowsDiagnostics = {
    population1Count: 0,
    population2Count: 0,
    byScope: {},
    unsupportedResolverReasons: {},
  };
  const rows: RouteRowInput[] = [];
  const evidenceBindingsByRowKey = new Map<string, EvidenceBinding>();
  const pickerMapsByMemberKey = new Map<string, Map<string, NormalizedRecord | null>>();
  const traceContextByScope = new Map<TargetScope, ScopeTraceContext>();

  if (
    args.allBatchRecords.length === 0 ||
    args.serviceMonths.length === 0 ||
    args.targetScopes.length === 0
  ) {
    return { rows, diagnostics, evidenceBindingsByRowKey, pickerMapsByMemberKey, traceContextByScope };
  }

  const serviceMonthSet = new Set(args.serviceMonths);
  const batchMonthMap = new Map<string, string>(
    Object.entries(args.batchMonthByBatchId),
  );

  // 1. Latest-BO overlay (once per cycle).
  const overlay = latestAuthoritativeBoTermDates(
    args.allBatchRecords,
    makeBoRecency({ batchMonthByBatchId: batchMonthMap }),
  );

  // 1b. Per-member raw record groups + picker maps (shared across scopes).
  const rawRecordsByMemberKey = new Map<string, NormalizedRecord[]>();
  for (const r of args.allBatchRecords) {
    const k = (r.member_key as string) || (r.applicant_name as string) || 'unknown';
    let arr = rawRecordsByMemberKey.get(k);
    if (!arr) {
      arr = [];
      rawRecordsByMemberKey.set(k, arr);
    }
    arr.push(r);
  }
  for (const [k, recs] of rawRecordsByMemberKey) {
    pickerMapsByMemberKey.set(k, buildMonthPickerMapForMember(recs, args.monthList));
  }

  // 2. Required scopes = targetScopes ∪ {opposite(scope)} so cross-entity
  //    cells are available for the C1a D2 fact (otherEntityCell).
  const requiredScopes = new Set<TargetScope>(args.targetScopes);
  for (const s of args.targetScopes) {
    const o = opposite(s);
    if (o) requiredScopes.add(o);
  }
  const scopeCtxByScope = new Map<TargetScope, ScopeContext>();
  for (const s of requiredScopes) {
    const built = buildScopeContext(
      s,
      args,
      rawRecordsByMemberKey,
      pickerMapsByMemberKey,
      batchMonthMap,
      overlay,
    );
    scopeCtxByScope.set(s, built);
    // C2c additive — surface scope trace context for evidence drawer (NO behavior change).
    traceContextByScope.set(s, {
      scopedRecordsByMemberKey: built.scopedByMember,
      baseClassifierContext: built.baseClassifierContext,
      mtRowsByMember: built.mtRowsByMember,
      classificationByMember: built.classificationByMember,
    });
  }

  // 3. Per (scope, serviceMonth) — build evidence map + resolver fresh
  //    (the evidence map overwrites by member_key; never share across months).
  for (const scope of args.targetScopes) {
    diagnostics.byScope[scope] = diagnostics.byScope[scope] ?? { unpaid: 0, paid: 0 };
    const ctx = scopeCtxByScope.get(scope);
    if (!ctx) continue;
    const otherScope = opposite(scope);
    const otherCtx = otherScope ? scopeCtxByScope.get(otherScope) ?? null : null;

    for (const serviceMonth of args.serviceMonths) {
      if (!serviceMonthSet.has(serviceMonth)) continue; // defensive

      // Build per-month synthesized evidence-row set ONLY for members whose
      // target-scope cell exists this month.
      const monthEvidenceRows: Array<Record<string, unknown>> = [];
      const memberCountResByMember = new Map<string, { status: 'resolved' | 'unresolved' | 'manual_review'; conflicts?: number[] }>();
      for (const [memberKey, classification] of ctx.classificationByMember) {
        const cell: CellClassification | undefined = classification.cells[serviceMonth];
        if (!cell) continue;
        if (cell.state !== 'unpaid' && cell.state !== 'paid') continue;
        const recs = ctx.scopedByMember.get(memberKey) ?? [];
        const pickedEdeForMonth =
          pickerMapsByMemberKey.get(memberKey)?.get(serviceMonth) ?? null;
        const synth = synthesizeEvidenceRow(memberKey, recs, serviceMonth, scope, args.batchMonthByBatchId, pickedEdeForMonth);
        monthEvidenceRows.push(synth.row);
        memberCountResByMember.set(memberKey, synth.memberCountResolution);
      }
      const sourceEvidenceByMemberKey: Map<string, EstMissingInputEvidence> =
        buildSourceEvidenceMap(monthEvidenceRows);


      const resolverScope = scope; // 'Coverall'|'Vix'|'All'
      const { resolve } = createEstMissingResolver({
        rateRows: args.rateRows,
        batchMonth: serviceMonth,
        scope: resolverScope,
        overlayMap: args.clearingOverlay,
        sourceEvidenceByMemberKey,
      });

      // 4. Per member-month-scope cell → BlockerFacts → RouteRowInput.
      for (const [memberKey, classification] of ctx.classificationByMember) {
        const targetCell = classification.cells[serviceMonth];
        if (!targetCell) continue;
        if (targetCell.state !== 'unpaid' && targetCell.state !== 'paid') continue;

        const population: 1 | 2 = targetCell.state === 'unpaid' ? 1 : 2;
        if (population === 1) {
          diagnostics.population1Count += 1;
          diagnostics.byScope[scope].unpaid += 1;
        } else {
          diagnostics.population2Count += 1;
          diagnostics.byScope[scope].paid += 1;
        }

        const recs = ctx.scopedByMember.get(memberKey) ?? [];
        const allRecsForMember = rawRecordsByMemberKey.get(memberKey) ?? recs;
        const identity = pickIdentity(allRecsForMember);
        const carrierCanonical = canonicalCarrier(identity.carrier ?? recs[0]?.carrier ?? '');
        if (!carrierCanonical) continue; // un-canonicalizable → skip (cannot key decisions)
        const stableMemberKey = deriveStableMemberKey(identity);
        if (!stableMemberKey) continue;

        const pickedEdeForMonth =
          pickerMapsByMemberKey.get(memberKey)?.get(serviceMonth) ?? null;

        let otherEntityCell:
          | { payEntity: 'Coverall' | 'Vix'; state: CellClassification['state']; paid_amount: number }
          | null = null;
        if (otherCtx && otherScope) {
          const otherClassification = otherCtx.classificationByMember.get(memberKey);
          const otherCell = otherClassification?.cells[serviceMonth];
          if (otherCell) {
            otherEntityCell = {
              payEntity: otherScope,
              state: otherCell.state,
              paid_amount: otherCell.paid_amount,
            };
          }
        }

        const evidenceForResolver = sourceEvidenceByMemberKey.get(memberKey);
        const memberCountResolution = memberCountResByMember.get(memberKey);

        const facts = buildBlockerFacts({
          targetScope: scope,
          targetCell,
          pickedEdeForMonth,
          today: args.today,
          otherEntityCell,
          evidenceForResolver,
          resolve: (call) => resolve({ row: { member_key: call.member_key }, inputEvidence: call.inputEvidence }),
          memberKey,
          memberCountResolution,
        });


        // Diagnostics: count resolver UNSUPPORTED reasons (one probe per
        // emitted row that actually exercises the resolver — either target
        // is paid, or cross-entity satisfaction triggers an other-side
        // resolve). For visibility we probe once per row whose amount
        // ended indeterminate due to a resolver failure.
        if (
          facts.amount.kind === 'indeterminate' &&
          facts.amount.reason !== 'NO_EXPECTED_BASIS'
        ) {
          const k = facts.amount.reason;
          diagnostics.unsupportedResolverReasons[k] =
            (diagnostics.unsupportedResolverReasons[k] ?? 0) + 1;
        } else if (
          facts.crossEntitySatisfied.amountStatus.kind === 'indeterminate' &&
          facts.crossEntitySatisfied.amountStatus.reason !== 'NO_EXPECTED_BASIS'
        ) {
          const k = facts.crossEntitySatisfied.amountStatus.reason;
          diagnostics.unsupportedResolverReasons[k] =
            (diagnostics.unsupportedResolverReasons[k] ?? 0) + 1;
        }

        const mtRow = ctx.mtRowsByMember.get(memberKey);
        const crFlag = Boolean(mtRow?.cells?.[serviceMonth]?.carrier_recognition);

        const rowKey = `${scope}|${stableMemberKey}|${serviceMonth}`;
        rows.push({
          rowKey,
          carrier: carrierCanonical,
          stableMemberKey,
          identity,
          serviceMonth,
          targetScope: scope,
          facts,
          crFlag,
          population,
        });
        // C2c additive — capture binding AT EMIT TIME (never reverse-derive).
        // scope here is one of args.targetScopes; the assembler currently
        // emits only 'Coverall' | 'Vix' (the per-entity rows). Cast is safe.
        evidenceBindingsByRowKey.set(rowKey, {
          rowKey,
          memberKey,
          serviceMonth,
          targetScope: scope as 'Coverall' | 'Vix',
        });
      }
    }
  }

  return { rows, diagnostics, evidenceBindingsByRowKey, pickerMapsByMemberKey, traceContextByScope };
}
