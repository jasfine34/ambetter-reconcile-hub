/**
 * Bundle 13b — Cross-batch clearing sweep orchestrator.
 */
import { supabase } from '@/integrations/supabase/client';
import { statementMonthKey } from '@/lib/dateRange';
import { isValidMonthKey } from '@/lib/canonical/monthKey';
import { canonicalCarrier } from '@/lib/carrierCanonical';
import { cleanId, cleanSubscriberId } from '@/lib/normalize';
import { derivePolicyIdentityKey } from '@/lib/canonical/policyIdentityKey';
import { deriveCoveredServiceMonths } from '@/lib/canonical/serviceMonth';
import { resolvePolicyStateForCompGrid } from '@/lib/canonical/policyState';
import { resolvePolicyMemberCountForCompGrid } from '@/lib/canonical/policyMemberCount';
import { getExpectedCommissionForClearing } from '@/lib/canonical/expectedCommissionForClearing';
import { classifyPolicyOwnerFromCurrentAor } from '@/lib/canonical/policyOwner';
import { loadCarrierCompRates } from '@/lib/canonical/compGridLoader';
import { isCrossBatchIdentityMatch } from '@/lib/canonical/crossBatchIdentityMatch';
import { evaluateCrossBatchAmountClearing, type AmountClearingCandidate } from '@/lib/canonical/crossBatchAmountClearing';
import { dedupCommissionRows } from '@/lib/canonical/dedupCommissionRows';
import {
  buildResolverRecordIndex,
  buildPolicyStateRecords,
  buildPolicyMemberCountRecords,
  type NormalizedRecordShape,
} from './resolverRecordAdapters';

export type AbortReason =
  | 'stale_generation'
  | 'no_upload_batches'
  | 'upload_batches_load_failed'
  | 'no_valid_batch_months';

export type InputErrorReason =
  | 'target_service_month_unresolved'
  | 'no_identity_keys'
  | 'no_carrier'
  | 'ambiguous_policy_identity_key_before_grain'
  | 'batch_statement_month_unresolved';

export interface InputError {
  reconciled_member_id: string;
  batch_id: string;
  reason: InputErrorReason;
  evidence: Record<string, unknown>;
}

export interface SweepResult {
  run_id: string;
  clearingRowsWritten: number;
  inputErrors: InputError[];
  aborted: boolean;
  abortReason?: AbortReason;
  errorMessage?: string;
}

const PAGE_SIZE = 500;
const IN_CHUNK = 500;
const PROJECTED_NORMALIZED_COLUMNS = [
  'id', 'batch_id', 'source_type', 'carrier', 'pay_entity', 'agent_npn',
  'policy_number', 'issuer_subscriber_id', 'effective_date', 'broker_effective_date',
  'client_state_full', 'commission_amount', 'paid_to_date', 'months_paid',
  'raw_json', 'created_at',
].join(', ');

function genUuid(): string {
  if (typeof crypto !== 'undefined' && (crypto as any).randomUUID) return (crypto as any).randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

async function paginatedIn(
  column: string,
  values: string[],
  extraSourceFilter: 'BO_EDE' | 'COMMISSION',
): Promise<any[]> {
  if (values.length === 0) return [];
  const out: any[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < values.length; i += IN_CHUNK) {
    const chunk = values.slice(i, i + IN_CHUNK);
    let lastId: string | null = null;
    while (true) {
      let q: any = (supabase as any)
        .from('normalized_records')
        .select(PROJECTED_NORMALIZED_COLUMNS)
        .eq('staging_status', 'active')
        .is('superseded_at', null);
      if (extraSourceFilter === 'BO_EDE') q = q.in('source_type', ['BACK_OFFICE', 'EDE']);
      else q = q.eq('source_type', 'COMMISSION');
      q = q.in(column, chunk).order('id', { ascending: true }).limit(PAGE_SIZE);
      if (lastId) q = q.gt('id', lastId);
      const { data, error } = await q;
      if (error) throw error;
      if (!data || data.length === 0) break;
      for (const row of data) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        out.push(row);
      }
      if (data.length < PAGE_SIZE) break;
      lastId = data[data.length - 1].id;
    }
  }
  return out;
}

export interface SweepOptions {
  generationId: number;
  shouldContinue: () => boolean;
  logic_version?: string;
}

export async function runCrossBatchClearingSweep(opts: SweepOptions): Promise<SweepResult> {
  const run_id = genUuid();
  const logic_version = opts.logic_version ?? 'bundle-13b-v1';
  const inputErrors: InputError[] = [];

  const aborted = (reason: AbortReason, msg: string): SweepResult => ({
    run_id, clearingRowsWritten: 0, inputErrors, aborted: true, abortReason: reason, errorMessage: msg,
  });

  // PHASE A0
  if (!opts.shouldContinue()) return aborted('stale_generation', 'Sweep aborted because a newer rebuild was started.');

  // A1
  const { data: batchData, error: batchErr } = await (supabase as any)
    .from('upload_batches').select('id, statement_month, created_at');
  if (batchErr) return aborted('upload_batches_load_failed', 'Failed to load upload batches; aborting sweep to prevent accidental clearing wipe.');
  if (!batchData || batchData.length === 0) return aborted('no_upload_batches', 'No upload batches loaded; aborting sweep to prevent accidental clearing wipe.');

  // A2
  const batchMonthById: Record<string, string> = {};
  const batchCreatedAtById: Record<string, string> = {};
  for (const row of batchData) {
    const key = statementMonthKey(row.statement_month);
    if (isValidMonthKey(key)) batchMonthById[row.id] = key;
    batchCreatedAtById[row.id] = row.created_at;
  }
  if (Object.keys(batchMonthById).length === 0) {
    return aborted('no_valid_batch_months', 'No upload batches have a valid statement month; aborting sweep to prevent accidental clearing wipe.');
  }

  // A3 — load unpaid reconciled members across all uploaded batches.
  // docs/timeout-risk-register.md "fix on next sweep touch": keyset
  // pagination by id (no offset .range), server-side unpaid filter where
  // null-safe, and explicit column projection — only fields consumed
  // downstream to build Surfacing.
  const RECONCILED_COLS = [
    'id', 'batch_id', 'in_commission', 'expected_ede_effective_month',
    'carrier', 'policy_number', 'issuer_subscriber_id',
    'expected_pay_entity', 'actual_pay_entity', 'agent_npn',
    'current_policy_aor',
  ].join(', ');
  const unpaidRows: any[] = [];
  for (const batchId of batchData.map((b: any) => b.id).filter(Boolean)) {
    let lastId: string | null = null;
    while (true) {
      let q: any = (supabase as any)
        .from('reconciled_members')
        .select(RECONCILED_COLS)
        .eq('batch_id', batchId)
        .order('id', { ascending: true })
        .limit(PAGE_SIZE);
      if (lastId) q = q.gt('id', lastId);
      const { data, error } = await q;
      if (error) throw error;
      if (!data || data.length === 0) break;
      for (const r of data) if (!r.in_commission) unpaidRows.push(r);
      if (data.length < PAGE_SIZE) break;
      lastId = data[data.length - 1].id;
    }
  }

  // A4-A6 per-row
  type Surfacing = {
    reconciled_member_id: string;
    batch_id: string;
    target_service_month: string;
    policy_identity_key: string;
    carrier: string;
    canonicalCarrier: string;
    policy_number_clean: string;
    issuer_subscriber_id_clean: string;
    statement_month: string;
    created_at: string;
    pay_entity: string | null;
    agent_npn: string | null;
    current_policy_aor: string | null;
    actual_pay_entity: string | null;
    raw: any;
  };
  const surfacing: Surfacing[] = [];

  for (const r of unpaidRows) {
    const tsm = r.expected_ede_effective_month;
    if (!isValidMonthKey(tsm)) {
      inputErrors.push({
        reconciled_member_id: r.id, batch_id: r.batch_id,
        reason: 'target_service_month_unresolved',
        evidence: { expected_ede_effective_month: tsm },
      });
      continue;
    }
    const idk = derivePolicyIdentityKey({
      carrier: r.carrier, policy_number: r.policy_number, issuer_subscriber_id: r.issuer_subscriber_id,
    });
    if (idk.status === 'unresolvable') {
      inputErrors.push({
        reconciled_member_id: r.id, batch_id: r.batch_id,
        reason: idk.reason,
        evidence: { carrier: r.carrier, policy_number: r.policy_number, issuer_subscriber_id: r.issuer_subscriber_id },
      });
      continue;
    }
    const sm = batchMonthById[r.batch_id];
    if (!sm) {
      inputErrors.push({
        reconciled_member_id: r.id, batch_id: r.batch_id,
        reason: 'batch_statement_month_unresolved',
        evidence: {},
      });
      continue;
    }
    surfacing.push({
      reconciled_member_id: r.id,
      batch_id: r.batch_id,
      target_service_month: tsm,
      policy_identity_key: idk.key,
      carrier: r.carrier,
      canonicalCarrier: idk.lineage.carrierCanonical,
      policy_number_clean: idk.lineage.policy_number_clean,
      issuer_subscriber_id_clean: idk.lineage.issuer_subscriber_id_clean,
      statement_month: sm,
      created_at: batchCreatedAtById[r.batch_id] ?? '',
      pay_entity: r.expected_pay_entity ?? r.actual_pay_entity ?? null,
      agent_npn: r.agent_npn ?? null,
      current_policy_aor: r.current_policy_aor ?? null,
      actual_pay_entity: r.actual_pay_entity ?? null,
      raw: r,
    });
  }

  // A6.5 — write-time canonicalization of policy-identity keys.
  // A real policy can surface as both <cc>|X (pn-form) and <cc>|sub:X
  // (sub-form) on different members. Without this merge the sweep emits
  // two clearing grains per real policy+month. Carrier + same-value
  // collapse only — sub-only policies (no pn-form sibling anywhere)
  // legitimately keep their `sub:` grain. This is the FIX, not ambiguity,
  // so it runs BEFORE the A8 ambiguity check; payment evidence then
  // computes over the full merged set (no first-wins).
  const pnFormKeys = new Set<string>();
  for (const s of surfacing) {
    if (!/^[^|]+\|sub:/.test(s.policy_identity_key)) pnFormKeys.add(s.policy_identity_key);
  }
  for (const s of surfacing) {
    const m = /^([^|]+)\|sub:(.+)$/.exec(s.policy_identity_key);
    if (!m) continue;
    const canonical = `${m[1]}|${m[2]}`;
    if (pnFormKeys.has(canonical)) {
      s.policy_identity_key = canonical;
      if (!s.policy_number_clean) s.policy_number_clean = m[2];
    }
  }

  // A7 group
  type Grain = {
    policy_identity_key: string;
    target_service_month: string;
    canonical_unpaid_batch_id: string;
    unpaid_batch_ids: string[];
    canonicalCarrier: string;
    carrier: string;
    pay_entity: string | null;
    agent_npn: string | null;
    current_policy_aor: string | null;
    actual_pay_entity: string | null;
    policy_number_clean: string;
    issuer_subscriber_id_clean: string;
    canonical_statement_month: string;
    canonical_reconciled_member_id: string;
    members: Surfacing[];
  };
  const grainMap = new Map<string, Grain>();
  for (const s of surfacing) {
    const key = `${s.policy_identity_key}|${s.target_service_month}`;
    let g = grainMap.get(key);
    if (!g) {
      g = {
        policy_identity_key: s.policy_identity_key,
        target_service_month: s.target_service_month,
        canonical_unpaid_batch_id: s.batch_id,
        unpaid_batch_ids: [s.batch_id],
        canonicalCarrier: s.canonicalCarrier,
        carrier: s.carrier,
        pay_entity: s.pay_entity,
        agent_npn: s.agent_npn,
        current_policy_aor: s.current_policy_aor,
        actual_pay_entity: s.actual_pay_entity,
        policy_number_clean: s.policy_number_clean,
        issuer_subscriber_id_clean: s.issuer_subscriber_id_clean,
        canonical_statement_month: s.statement_month,
        canonical_reconciled_member_id: s.reconciled_member_id,
        members: [s],
      };
      grainMap.set(key, g);
      continue;
    }
    g.members.push(s);
    if (!g.unpaid_batch_ids.includes(s.batch_id)) g.unpaid_batch_ids.push(s.batch_id);
    // Tie-break: earliest statement_month → earliest created_at → smallest id
    const cmp = (() => {
      if (s.statement_month !== g.canonical_statement_month) return s.statement_month < g.canonical_statement_month ? -1 : 1;
      const ac = s.created_at, bc = batchCreatedAtById[g.canonical_unpaid_batch_id] ?? '';
      if (ac !== bc) return ac < bc ? -1 : 1;
      return s.batch_id < g.canonical_unpaid_batch_id ? -1 : 1;
    })();
    if (cmp < 0) {
      g.canonical_unpaid_batch_id = s.batch_id;
      g.canonical_statement_month = s.statement_month;
      g.canonical_reconciled_member_id = s.reconciled_member_id;
      g.current_policy_aor = s.current_policy_aor;
      g.actual_pay_entity = s.actual_pay_entity;
    }
  }

  // A8 cross-field ambiguity
  for (const g of grainMap.values()) {
    const pns = new Set(g.members.map(m => m.policy_number_clean).filter(x => !!x));
    const sids = new Set(g.members.map(m => m.issuer_subscriber_id_clean).filter(x => !!x));
    if (pns.size > 1 || sids.size > 1) {
      for (const m of g.members) {
        inputErrors.push({
          reconciled_member_id: m.reconciled_member_id,
          batch_id: m.batch_id,
          reason: 'ambiguous_policy_identity_key_before_grain',
          evidence: { distinct_policy_numbers: [...pns], distinct_subscriber_ids: [...sids] },
        });
      }
      grainMap.delete(`${g.policy_identity_key}|${g.target_service_month}`);
    }
  }

  // PHASE B — bulk-load BO/EDE
  const policyNums = new Set<string>();
  const subIds = new Set<string>();
  for (const g of grainMap.values()) {
    if (g.policy_number_clean) policyNums.add(g.policy_number_clean);
    if (g.issuer_subscriber_id_clean) subIds.add(g.issuer_subscriber_id_clean);
  }
  const boEdeRows: NormalizedRecordShape[] = [];
  if (policyNums.size > 0) boEdeRows.push(...await paginatedIn('policy_number', [...policyNums], 'BO_EDE'));
  if (subIds.size > 0) {
    const more = await paginatedIn('issuer_subscriber_id', [...subIds], 'BO_EDE');
    const seen = new Set(boEdeRows.map(r => r.id));
    for (const r of more) if (!seen.has(r.id)) boEdeRows.push(r);
  }
  const aliasIndex = buildResolverRecordIndex({ normalizedRecords: boEdeRows });

  // PHASE C — bulk-load commission
  const commPolicy = await paginatedIn('policy_number', [...policyNums], 'COMMISSION');
  const commSub = await paginatedIn('issuer_subscriber_id', [...subIds], 'COMMISSION');
  const commSeen = new Set<string>();
  const commRawRows: any[] = [];
  for (const row of [...commPolicy, ...commSub]) {
    if (commSeen.has(row.id)) continue;
    commSeen.add(row.id);
    commRawRows.push(row);
  }
  // R-PAY-010: collapse exact cross-batch / intra-batch commission duplicates
  // BEFORE evaluateCrossBatchAmountClearing so the May re-listing of April
  // transactions does not double-count toward `actual_net_amount`. Stamp
  // source_type=COMMISSION (PROJECTED_NORMALIZED_COLUMNS omits it) so the
  // dedup helper sees these as commission rows. Raw uploaded rows are not
  // mutated; we operate on the projected copies returned by paginatedIn.
  const commForDedup = commRawRows.map(r => ({ ...r, source_type: 'COMMISSION' as const }));
  const dedupRes = dedupCommissionRows(commForDedup as any, { batchMonthByBatchId: batchMonthById });
  const commissions: AmountClearingCandidate[] & { __extra?: any }[] = [] as any;
  const commByCarrier = new Map<string, Array<AmountClearingCandidate & { carrier: string; policy_number: string | null; issuer_subscriber_id: string | null; raw_json?: any }>>();
  for (const row of dedupRes.rows as any[]) {
    const sm = batchMonthById[row.batch_id];
    if (!sm) continue;
    const cc = canonicalCarrier(row.carrier);
    if (!cc) continue;
    const candidate = {
      id: row.id,
      commission_amount: row.commission_amount == null ? null : Number(row.commission_amount),
      statement_month: sm,
      created_at: row.created_at,
      raw_json: row.raw_json,
      pay_entity: row.pay_entity ?? null,
      carrier: row.carrier,
      policy_number: row.policy_number,
      issuer_subscriber_id: row.issuer_subscriber_id,
      paid_to_date: row.paid_to_date,
      months_paid: row.months_paid,
      batch_id: row.batch_id,
    };
    let bucket = commByCarrier.get(cc);
    if (!bucket) { bucket = []; commByCarrier.set(cc, bucket); }
    bucket.push(candidate as any);
  }

  // Load comp grid once
  let compRates: any[] = [];
  try {
    compRates = await loadCarrierCompRates({ effectiveYear: 2026 });
  } catch {
    compRates = [];
  }

  // PHASE D — per-grain (memory only)
  const clearingRows: any[] = [];
  for (const g of grainMap.values()) {
    if (!opts.shouldContinue()) return aborted('stale_generation', 'Sweep aborted because a newer rebuild was started.');

    const records = (aliasIndex.get(g.policy_identity_key) ?? []).slice();
    // de-dup by id already handled by builder
    const stateRecords = buildPolicyStateRecords({ normalizedRecords: records, batchMonthById });
    const memberRecords = buildPolicyMemberCountRecords({ normalizedRecords: records, batchMonthById });

    const stateRes = resolvePolicyStateForCompGrid({
      records: stateRecords,
      targetBatchMonth: g.canonical_statement_month,
      targetServiceMonths: [g.target_service_month],
    });
    const memberRes = resolvePolicyMemberCountForCompGrid({
      records: memberRecords,
      targetBatchMonth: g.canonical_statement_month,
      targetServiceMonths: [g.target_service_month],
    });

    const evidence = { state: stateRes, memberCount: memberRes };

    let manualReason: string | null = null;
    if (stateRes.status === 'manual_review') manualReason = 'state_manual_review';
    else if (stateRes.status === 'unresolved') manualReason = 'state_unresolved';
    else if (memberRes.status === 'manual_review') manualReason = 'member_count_manual_review';
    else if (memberRes.status === 'unresolved') manualReason = 'member_count_unresolved';

    if (manualReason) {
      clearingRows.push(makeRow(g, {
        clearing_state: 'manual_review_required',
        manual_review_reason: manualReason,
        state_resolution_evidence: evidence,
      }, run_id, logic_version));
      continue;
    }

    // D5 — wrapper call with pre-D5 owner + memberPayee resolution.
    const policyYear = parseInt(g.target_service_month.slice(0, 4), 10);
    const owner = classifyPolicyOwnerFromCurrentAor(g.current_policy_aor);

    // Aggregate concrete actual_pay_entity across ALL grain members.
    const concreteMemberPayees = new Set<'Coverall' | 'Vix'>(
      g.members
        .map(m => m.actual_pay_entity)
        .filter((p): p is 'Coverall' | 'Vix' => p === 'Coverall' || p === 'Vix'),
    );

    if (owner === 'EF' && concreteMemberPayees.size > 1) {
      clearingRows.push(makeRow(g, {
        clearing_state: 'manual_review_required',
        manual_review_reason: 'conflicting_override_payee',
        state_resolution_evidence: evidence,
        member_count: memberRes.memberCount,
        months_covered: 1,
        policy_year: policyYear,
        comp_grid_evidence: {
          reason: 'conflicting concrete actual_pay_entity values across grain members',
          concreteMemberPayees: Array.from(concreteMemberPayees),
        },
      }, run_id, logic_version));
      continue;
    }

    const memberPayee: 'Coverall' | 'Vix' | null =
      owner === 'EF' && concreteMemberPayees.size === 1
        ? Array.from(concreteMemberPayees)[0]
        : null;

    const baseCompArgs = {
      carrier: g.canonicalCarrier,
      state: stateRes.state!,
      members: memberRes.memberCount!,
      months: 1,
      planVariant: null,
      policyYear,
    };

    const expected = getExpectedCommissionForClearing(
      baseCompArgs as any,
      compRates as any,
      {
        current_policy_aor: g.current_policy_aor,
        matched_payee: owner === 'EF' ? memberPayee : null,
        policy_identity_key: g.policy_identity_key,
        target_service_month: g.target_service_month,
      },
    );

    const isEricaWithoutMemberPayee = owner === 'EF' && memberPayee === null;
    let pendingD5FailureRow: any = null;

    if (expected.supportStatus === 'unsupported_v1') {
      const failureRow = makeRow(g, {
        clearing_state: 'manual_review_required',
        manual_review_reason: expected.unsupportedReason ?? 'unsupported_v1',
        state_resolution_evidence: evidence,
        comp_grid_evidence: expected.evidence,
        comp_rate_id: expected.rateRecordId,
        member_count: memberRes.memberCount,
        months_covered: 1,
        policy_year: policyYear,
      }, run_id, logic_version);
      if (isEricaWithoutMemberPayee) {
        pendingD5FailureRow = failureRow;
      } else {
        clearingRows.push(failureRow);
        continue;
      }
    } else if (expected.supportStatus === 'not_found') {
      const failureRow = makeRow(g, {
        clearing_state: 'manual_review_required',
        manual_review_reason: 'carrier_state_not_in_grid',
        state_resolution_evidence: evidence,
        comp_grid_evidence: expected.evidence,
        member_count: memberRes.memberCount,
        months_covered: 1,
        policy_year: policyYear,
      }, run_id, logic_version);
      if (isEricaWithoutMemberPayee) {
        pendingD5FailureRow = failureRow;
      } else {
        clearingRows.push(failureRow);
        continue;
      }
    } else if (expected.expectedAmount === 0) {
      const zeroRow = makeRow(g, {
        clearing_state: 'zero_expected_no_payment_required',
        expected_amount: 0,
        comp_rate_id: expected.rateRecordId,
        comp_grid_evidence: expected.evidence,
        state_resolution_evidence: evidence,
        member_count: memberRes.memberCount,
        months_covered: 1,
        policy_year: policyYear,
      }, run_id, logic_version);
      if (isEricaWithoutMemberPayee) {
        pendingD5FailureRow = zeroRow;
      } else {
        clearingRows.push(zeroRow);
        continue;
      }
    }

    // D6: filter candidates
    const allCarrierCandidates = commByCarrier.get(g.canonicalCarrier) ?? [];
    const candidates = allCarrierCandidates.filter(c => c.statement_month > g.canonical_statement_month);

    // D7
    const idMatch = isCrossBatchIdentityMatch({
      unpaid: { carrier: g.carrier, policy_number: g.policy_number_clean || null, issuer_subscriber_id: g.issuer_subscriber_id_clean || null },
      targetServiceMonth: g.target_service_month,
      candidates: candidates.map(c => ({
        id: c.id, carrier: c.carrier,
        policy_number: c.policy_number, issuer_subscriber_id: c.issuer_subscriber_id,
        paid_to_date: (c as any).paid_to_date, months_paid: (c as any).months_paid,
        raw_json: c.raw_json,
      })),
    });

    if (idMatch.match === 'manual_review_required') {
      clearingRows.push(makeRow(g, {
        clearing_state: 'manual_review_required',
        manual_review_reason: 'conflicting_identity_keys',
        identity_match_evidence: { candidatesConsidered: idMatch.candidatesConsidered },
        expected_amount: expected.expectedAmount,
        comp_rate_id: expected.rateRecordId,
        comp_grid_evidence: expected.evidence,
        state_resolution_evidence: evidence,
        member_count: memberRes.memberCount,
        months_covered: 1,
        policy_year: policyYear,
      }, run_id, logic_version));
      continue;
    }

    // Build matchedCandidates BEFORE D7.5 (single source for D7.5/D7.6/D8).
    const matchedIds = new Set(
      idMatch.match === 'identified' ? idMatch.matchedRows.map(m => m.id) : [],
    );
    const matchedCandidates = candidates.filter(c => matchedIds.has(c.id));

    if (idMatch.match === 'no_match') {
      if (pendingD5FailureRow) {
        clearingRows.push(pendingD5FailureRow);
        continue;
      }
      clearingRows.push(makeRow(g, {
        clearing_state: 'not_cleared',
        reason: idMatch.reason,
        expected_amount: expected.expectedAmount,
        threshold_amount: expected.expectedAmount! * 0.7,
        actual_positive_amount: 0,
        actual_reversal_amount: 0,
        actual_net_amount: 0,
        remainder_owed: expected.expectedAmount,
        comp_rate_id: expected.rateRecordId,
        comp_grid_evidence: expected.evidence,
        state_resolution_evidence: evidence,
        member_count: memberRes.memberCount,
        months_covered: 1,
        policy_year: policyYear,
      }, run_id, logic_version));
      continue;
    }

    // D7.5 — post-D7 candidate-payee refinement.
    let revisedExpected = expected;
    let resolvedPayeeForRow: 'Coverall' | 'Vix' | null = owner === 'EF' ? memberPayee : null;
    let conflictingPayee = false;

    if (owner === 'EF') {
      const candidatePayees = new Set<'Coverall' | 'Vix'>(
        matchedCandidates
          .map(c => c.pay_entity)
          .filter((p): p is 'Coverall' | 'Vix' => p === 'Coverall' || p === 'Vix'),
      );

      if (memberPayee) {
        resolvedPayeeForRow = memberPayee;
        if (candidatePayees.size > 1 || (candidatePayees.size === 1 && !candidatePayees.has(memberPayee))) {
          conflictingPayee = true;
        }
      } else if (candidatePayees.size === 1) {
        resolvedPayeeForRow = Array.from(candidatePayees)[0];
        const candidateResolvedExpected = getExpectedCommissionForClearing(
          baseCompArgs as any,
          compRates as any,
          {
            current_policy_aor: g.current_policy_aor,
            matched_payee: resolvedPayeeForRow,
            policy_identity_key: g.policy_identity_key,
            target_service_month: g.target_service_month,
          },
        );
        if (candidateResolvedExpected.supportStatus === 'supported' && candidateResolvedExpected.expectedAmount != null) {
          revisedExpected = candidateResolvedExpected;
          pendingD5FailureRow = null;
        } else if (pendingD5FailureRow) {
          clearingRows.push(pendingD5FailureRow);
          continue;
        } else {
          revisedExpected = candidateResolvedExpected;
        }
      } else if (candidatePayees.size > 1) {
        conflictingPayee = true;
      } else if (pendingD5FailureRow) {
        clearingRows.push(pendingD5FailureRow);
        continue;
      }

      if (conflictingPayee) {
        clearingRows.push(makeRow(g, {
          clearing_state: 'manual_review_required',
          manual_review_reason: 'conflicting_override_payee',
          expected_amount: revisedExpected.expectedAmount,
          comp_rate_id: revisedExpected.rateRecordId,
          comp_grid_evidence: revisedExpected.evidence,
          state_resolution_evidence: evidence,
          member_count: memberRes.memberCount,
          months_covered: 1,
          policy_year: policyYear,
          identity_match_keys: idMatch.identityKeys,
          matched_paid_record_ids: Array.from(matchedIds),
          payment_batch_ids: Array.from(new Set(matchedCandidates.map((c: any) => c.batch_id))),
        }, run_id, logic_version));
        continue;
      }
    }

    // D8 — evaluateAmountClearing using revisedExpected.
    const amount = evaluateCrossBatchAmountClearing({
      expected_amount: revisedExpected.expectedAmount,
      candidates: matchedCandidates.map(m => ({
        id: m.id, commission_amount: m.commission_amount,
        statement_month: m.statement_month, created_at: m.created_at, raw_json: m.raw_json,
        pay_entity: m.pay_entity ?? null,
      })),
    });

    const paymentBatchIds = Array.from(new Set(matchedCandidates.map((m: any) => m.batch_id)));

    const resolvedPayEntityForRow =
      owner === 'EF' && resolvedPayeeForRow ? resolvedPayeeForRow : g.pay_entity;

    clearingRows.push(makeRow(g, {
      clearing_state: amount.clearing_state,
      reason: amount.reason,
      manual_review_reason: amount.manual_review_reason,
      expected_amount: revisedExpected.expectedAmount,
      threshold_amount: amount.threshold_amount,
      actual_positive_amount: amount.actual_positive_amount,
      actual_reversal_amount: amount.actual_reversal_amount,
      actual_net_amount: amount.actual_net_amount,
      remainder_owed: amount.remainder_owed,
      comp_rate_id: revisedExpected.rateRecordId,
      comp_grid_evidence: revisedExpected.evidence,
      state_resolution_evidence: evidence,
      member_count: memberRes.memberCount,
      months_covered: 1,
      policy_year: policyYear,
      identity_match_keys: idMatch.identityKeys,
      matched_paid_record_ids: amount.matchedPaidRecordIds,
      reversal_record_ids: amount.reversalRecordIds,
      ignored_record_ids: amount.ignoredRecordIds,
      clearing_statement_months: amount.clearingStatementMonths,
      first_full_clear_statement_month: amount.firstFullClearStatementMonth,
      reversed_at_statement_month: amount.reversedAtStatementMonth,
      payment_batch_ids: paymentBatchIds,
      pay_entity: resolvedPayEntityForRow,
    }, run_id, logic_version));
  }

  // PHASE E — client-side chunked supersede + insert.
  // Many small RPC calls so each stays under the 60s gateway cap.
  if (!opts.shouldContinue()) return aborted('stale_generation', 'Sweep aborted because a newer rebuild was started.');

  const RPC_BATCH_SIZE = 500;

  // Strict numeric validation on RPC returns. Treating null/non-numeric as 0
  // would silently terminate the supersede loop or underreport insert success.
  function rpcCount(value: unknown, rpcName: string): number {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    throw new Error(`${rpcName} returned a non-numeric count: ${JSON.stringify(value)}`);
  }

  // E1 — supersede phase: loop until no active rows remain.
  while (true) {
    if (!opts.shouldContinue()) return aborted('stale_generation', 'Sweep aborted because a newer rebuild was started.');
    const { data: superseded, error: superErr } = await (supabase as any).rpc(
      'supersede_active_clearings_batch',
      { p_batch_size: RPC_BATCH_SIZE },
    );
    if (superErr) throw new Error(`supersede_active_clearings_batch failed: ${superErr.message ?? superErr}`);
    const count = rpcCount(superseded, 'supersede_active_clearings_batch');
    if (count === 0) break;
  }

  // E2 — insert phase: chunk clearingRows into RPC_BATCH_SIZE batches.
  let totalInserted = 0;
  for (let i = 0; i < clearingRows.length; i += RPC_BATCH_SIZE) {
    if (!opts.shouldContinue()) return aborted('stale_generation', 'Sweep aborted because a newer rebuild was started.');
    const chunk = clearingRows.slice(i, i + RPC_BATCH_SIZE);
    const { data: inserted, error: insertErr } = await (supabase as any).rpc(
      'insert_clearing_rows',
      { p_run_id: run_id, p_rows: chunk },
    );
    if (insertErr) throw new Error(`insert_clearing_rows failed at chunk ${i / RPC_BATCH_SIZE}: ${insertErr.message ?? insertErr}`);
    totalInserted += rpcCount(inserted, 'insert_clearing_rows');
  }

  return { run_id, clearingRowsWritten: totalInserted, inputErrors, aborted: false };
}

function makeRow(
  g: { policy_identity_key: string; target_service_month: string; canonical_unpaid_batch_id: string; unpaid_batch_ids: string[]; canonical_statement_month: string; canonical_reconciled_member_id: string; carrier: string; pay_entity: string | null; agent_npn: string | null; policy_number_clean: string; issuer_subscriber_id_clean: string },
  fields: Record<string, any>,
  run_id: string,
  logic_version: string,
) {
  return {
    policy_identity_key: g.policy_identity_key,
    target_service_month: g.target_service_month,
    reconciled_member_id: g.canonical_reconciled_member_id,
    unpaid_batch_id: g.canonical_unpaid_batch_id,
    unpaid_batch_ids: g.unpaid_batch_ids,
    payment_batch_ids: fields.payment_batch_ids ?? [],
    unpaid_statement_month: g.canonical_statement_month,
    policy_number: g.policy_number_clean || null,
    issuer_subscriber_id: g.issuer_subscriber_id_clean || null,
    carrier: g.carrier,
    pay_entity: g.pay_entity,
    agent_npn: g.agent_npn,
    run_id,
    logic_version,
    ...fields,
  };
}
