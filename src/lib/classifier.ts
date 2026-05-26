/**
 * Classification engine — per-cell state machine for (member, carrier, month).
 *
 * Reads normalized records (current + historical snapshots) and produces a
 * classification for each eligible month in the range: Paid / Unpaid / Not
 * Expected / Pending / Manual Review. See §4.3 of ARCHITECTURE_PLAN.md.
 *
 * Phase 2a — this module is the pure computation. It does not read or write
 * to Supabase. Wiring into UI and funnel views arrives in Phase 2b.
 */
import type { NormalizedRecord } from './normalize';
import { addMonths, monthKeyToFirstOfMonth, type MonthKey } from './dateRange';
import { isCoverallAORByName, isCoverallAORByNPN } from './agents';
import { canonicalCarrier } from './carrierCanonical';
import { isActiveBackOfficeRecord } from './canonical/isActiveBackOfficeRecord';
import { getStatementMonthBounds } from './canonical/statementMonthBounds';
import { isEDEQualified } from './canonical/edeQualified';
import { lastActiveMonthForTermDate } from './canonical/termBoundary';
import { NPN_MAP } from './constants';


// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export type ClassificationState =
  | 'paid'
  | 'unpaid'
  | 'not_expected_premium_unpaid'
  | 'not_expected_pre_eligibility'
  | 'not_expected_cancelled'
  | 'not_expected_not_ours'
  | 'pending'
  | 'manual_review';

export type RollupStatus =
  | 'fully_paid'
  | 'mixed'
  | 'fully_unpaid'
  | 'all_not_expected'
  | 'has_pending';

export interface CellClassification {
  month: MonthKey;
  state: ClassificationState;
  /** Human-readable explanation — surfaced in tooltips and manual-review UIs. */
  reason: string;
  /** Commission dollars attributed to this service month from any statement. */
  paid_amount: number;
  /** Raw source presence, independent of state. Drives the E/B/C badges. */
  in_ede: boolean;
  in_back_office: boolean;
  in_commission: boolean;
}

export interface MemberClassification {
  member_key: string;
  applicant_name: string;
  carrier: string;
  agent_npn: string;
  aor_bucket: string;
  /** First month this member is commission-eligible. Null if never eligible. */
  first_eligible_month: MonthKey | null;
  /** Cells for every month in the classifier's requested range. */
  cells: Record<MonthKey, CellClassification>;
  rollup: RollupStatus;
  total_paid: number;
  /** True if any cell is state = manual_review. */
  needs_manual_review: boolean;
}

export interface ClassifierContext {
  /** YYYY-MM keys for months to classify, in chronological order. */
  months: MonthKey[];
  /**
   * Months for which a commission statement has been uploaded (i.e., at
   * least one COMMISSION record exists whose attributed service month set
   * includes this month). Used for the ripeness gate.
   */
  commissionStatementMonths: Set<MonthKey>;
  /**
   * BO snapshot dates available, as YYYY-MM-DD. Needed so the classifier
   * can ask "do we have a BO snapshot dated ≥ M+1?" for premium-paid gating.
   */
  boSnapshotDates: string[];
  /**
   * MT Stage 2 — OPTIONAL map of batch_id -> statement_month YYYY-MM.
   * Absent ⇒ classifyCell() uses legacy member-level latestEdeNetPremium
   * (preserves non-MT consumer behavior). Present (even empty) ⇒ classifyCell
   * routes to per-service-month netPremiumForServiceMonth helper.
   */
  batchMonthByBatchId?: Map<string, string>;
  /**
   * MT Stage 2.1 Slice D — OPTIONAL per-member month-aware EDE picker map.
   * When set, the picker's record for the month is the sole EDE candidate
   * considered by `hasEdeForMonth` and `netPremiumForServiceMonth`. When
   * `pickerEdeByMonth.get(month)` is null, EDE evaluation is skipped
   * entirely (BO fallback for premium; false from hasEdeForMonth). Built
   * per-member by the page and threaded via context spread.
   */
  pickerEdeByMonth?: Map<MonthKey, NormalizedRecord | null>;
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

/** Convert a YYYY-MM-DD date to a YYYY-MM key. */
function dateToMonthKey(date: string | null | undefined): MonthKey {
  if (!date) return '';
  return String(date).substring(0, 7);
}

/** True if the BO row shows one of our NPNs as broker. */
function isBoRecordOurs(r: NormalizedRecord): boolean {
  if (r.source_type !== 'BACK_OFFICE') return false;
  return isCoverallAORByNPN(r.agent_npn) || isCoverallAORByName(r.agent_name);
}

/**
 * True if the EDE row shows one of our NPNs as the CURRENT policy AOR.
 *
 * We intentionally only look at currentPolicyAOR (not the original enroller
 * in r.agent_npn / r.agent_name). For an NPN override case, the original
 * enroller might be ours but current AOR might not be — in which case we're
 * no longer eligible for commission on that policy. This matches the filter
 * used by reconcile.ts's isExpectedEDERow.
 */
function isEdeRecordOurs(r: NormalizedRecord): boolean {
  if (r.source_type !== 'EDE') return false;
  const rawAor = (r.raw_json?.['currentPolicyAOR'] ?? '') as string;
  return isCoverallAORByName(rawAor);
}

const QUALIFIED_EDE_STATUSES = new Set([
  'effectuated',
  'pendingeffectuation',
  'pending effectuated',
  'pendingtermination',
  'pending termination',
]);

function edeStatusKey(r: NormalizedRecord): string {
  const raw = (r.raw_json?.['policyStatus'] ?? r.status ?? '') as string;
  return String(raw).toLowerCase().replace(/\s+/g, '');
}

function isQualifiedEdeStatus(r: NormalizedRecord): boolean {
  return QUALIFIED_EDE_STATUSES.has(edeStatusKey(r));
}

/**
 * Service months a commission record covers. For a statement with Paid-To
 * Date 2026-03-31 and Months Paid = 2, the covered months are 2026-02 and
 * 2026-03 — each getting half the total commission. Falls back to the
 * Paid-To Date month alone if Months Paid is missing.
 */
export function commissionServiceMonths(r: NormalizedRecord): { months: MonthKey[]; perMonth: number } {
  const total = r.commission_amount ?? 0;
  const endMonth = dateToMonthKey(r.paid_to_date);
  if (!endMonth) return { months: [], perMonth: 0 };
  const span = r.months_paid && r.months_paid > 0 ? r.months_paid : 1;
  const months: MonthKey[] = [];
  for (let i = span - 1; i >= 0; i--) {
    months.push(addMonths(endMonth, -i));
  }
  return {
    months,
    perMonth: span > 0 ? total / span : 0,
  };
}

/**
 * Determine the first month a member is commission-eligible.
 *
 * Tier A (BO has broker_effective_date):
 *   - If BED <= PED (or equal) → new enrollment. First-eligible = PED's month.
 *   - If BED > PED → NPN override. First-eligible = month AFTER BED's month.
 * Tier B (no BED in BO, but EDE has our AOR):
 *   - First-eligible = the earliest EDE snapshot month where our AOR appears
 *     with qualifying status and effective_date ≤ that month. For monthly
 *     EDE ingestion this is the month the record first surfaced with us.
 *
 * Returns null if the member was never eligible under our AORs.
 */
export function computeFirstEligibleMonth(records: NormalizedRecord[]): MonthKey | null {
  // Tier A — look for a BO row with both broker_effective_date and
  // policy_effective_date, where the record belongs to us.
  for (const r of records) {
    if (r.source_type !== 'BACK_OFFICE') continue;
    if (!isBoRecordOurs(r)) continue;
    const bedKey = dateToMonthKey(r.broker_effective_date);
    const pedKey = dateToMonthKey(r.effective_date);
    if (!bedKey || !pedKey) continue;

    // New enrollment — broker was on the policy by the effective date
    if (bedKey <= pedKey) return pedKey;
    // NPN override — became broker mid-flight. Per Jason 2026-05-26 +
    // data-dictionary.md:42, first-eligible = BED's month itself (not the
    // month after). Fix 4.
    return bedKey;
  }


  // Tier B — no broker_effective_date available. Fall back to the earliest
  // policy effective date across our BO rows. Good enough for carriers that
  // don't expose BED, given our monthly BO ingestion cadence.
  let earliestBoMonth: MonthKey | null = null;
  for (const r of records) {
    if (r.source_type !== 'BACK_OFFICE') continue;
    if (!isBoRecordOurs(r)) continue;
    const effMonth = dateToMonthKey(r.effective_date);
    if (!effMonth) continue;
    if (!earliestBoMonth || effMonth < earliestBoMonth) earliestBoMonth = effMonth;
  }
  if (earliestBoMonth) return earliestBoMonth;

  // EDE-only: earliest EDE snapshot month where our AOR appears qualified.
  let earliestEdeMonth: MonthKey | null = null;
  for (const r of records) {
    if (r.source_type !== 'EDE') continue;
    if (!isEdeRecordOurs(r)) continue;
    if (!isQualifiedEdeStatus(r)) continue;
    const effMonth = dateToMonthKey(r.effective_date);
    if (!effMonth) continue;
    if (!earliestEdeMonth || effMonth < earliestEdeMonth) earliestEdeMonth = effMonth;
  }
  return earliestEdeMonth;
}

/**
 * True if the member has ANY record tying them to us — BO/EDE AOR, or a
 * commission row whose NPN/aor_bucket says we got paid for them. Without the
 * commission fallback, members who only have a commission record (no
 * EDE/BO presence in the dataset, but we *did* receive money for them)
 * classify as `not_expected_not_ours`, which then drops them from the
 * Member Timeline's `months_due > 0` base filter and from the summary's
 * Total Paid — even though the dollars are real and ours.
 */
function memberBelongsToUs(records: NormalizedRecord[]): boolean {
  return records.some(r => {
    if (isBoRecordOurs(r) || isEdeRecordOurs(r)) return true;
    if (r.source_type === 'COMMISSION') {
      if (isCoverallAORByNPN(r.agent_npn)) return true;
      if (isCoverallAORByName(r.aor_bucket)) return true;
    }
    return false;
  });
}

/** Most recent BO paid-through date across all snapshots, as MonthKey. */
function latestBoPaidThrough(records: NormalizedRecord[]): MonthKey {
  let latest = '';
  for (const r of records) {
    if (r.source_type !== 'BACK_OFFICE') continue;
    const pt = dateToMonthKey(r.paid_through_date);
    if (pt && pt > latest) latest = pt;
  }
  return latest;
}

/** Highest net_premium ever observed for this member across EDE snapshots. */
function latestEdeNetPremium(records: NormalizedRecord[]): number {
  let max = 0;
  for (const r of records) {
    if (r.source_type !== 'EDE') continue;
    if (r.net_premium != null && r.net_premium > max) max = r.net_premium;
  }
  return max;
}

/**
 * MT Stage 2 — service-month-grain net premium selector.
 *
 * Returns the net premium that applies to `serviceMonth` for the given member
 * records, using batch-month preference + active-coverage fallback.
 *
 * Internal bucket parsing on the selected row:
 *   - net_premium > 0 numeric → return that number
 *   - net_premium null / undefined / blank / non-numeric / 0 / negative → 0
 *   - no candidate row exists → null
 *
 * Selection:
 *   1. Candidate filter: source_type === 'EDE', effective_date.month ≤ serviceMonth,
 *      and (no policy_term_date OR serviceMonth < policy_term_date.month).
 *   2. Batch-month preference: prefer candidates whose batch_id maps via
 *      batchMonthByBatchId to a statement_month equal to serviceMonth.
 *   3. Tiebreaker: newest raw_json.lastEDESync, then newest created_at, then id.
 *   4. Fallback: if Step 2 yields no match, tiebreak against Step 1 set.
 *
 * Tolerates empty `batchMonthByBatchId` map (skips Step 2 implicitly).
 * EXPORTED for direct synthetic-test verification. Not consumed by canonical
 * helpers — MT-cell-grain only.
 */
export function netPremiumForServiceMonth(
  records: NormalizedRecord[],
  serviceMonth: string,
  options: {
    batchMonthByBatchId: Map<string, string>;
    pickerEdeByMonth?: Map<string, NormalizedRecord | null>;
  },
): number | null {
  const { batchMonthByBatchId, pickerEdeByMonth } = options;

  // Slice D — picker-aware fast path. When a picker map is provided we limit
  // EDE consideration to the picker's record for this month. Picker → null
  // means "no operative EDE for this month" → skip EDE entirely and let the
  // BO fallback path run. Picker → record means "this is the operative EDE"
  // → use it iff it's in the scoped `records` set AND has positive premium.
  let edeReturned: number | null = null;
  let edeHandled = false;
  if (pickerEdeByMonth) {
    edeHandled = true;
    const picked = pickerEdeByMonth.get(serviceMonth) ?? null;
    if (picked) {
      const pickedId = String((picked as any).id ?? '');
      const inScope = records.some(r => {
        if (r.source_type !== 'EDE') return false;
        const rid = String((r as any).id ?? '');
        return pickedId && rid ? pickedId === rid : r === picked;
      });
      if (inScope) {
        const raw = picked.net_premium;
        if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
        edeReturned = 0;
      }
    }
  }

  if (!edeHandled) {
    const candidates: NormalizedRecord[] = [];
    for (const r of records) {
      if (r.source_type !== 'EDE') continue;
      if (!isEDEQualified(r)) continue;
      const effMonth = dateToMonthKey(r.effective_date);
      if (!effMonth || effMonth > serviceMonth) continue;
      if (r.policy_term_date) {
        const lastActive = lastActiveMonthForTermDate(r.policy_term_date);
        if (lastActive && serviceMonth > lastActive) continue;
      }
      candidates.push(r);
    }
    if (candidates.length > 0) {
      let pool = candidates;
      if (batchMonthByBatchId.size > 0) {
        const preferred = candidates.filter(r => {
          const bid = (r as any).batch_id;
          if (!bid) return false;
          const sm = batchMonthByBatchId.get(String(bid));
          return sm === serviceMonth;
        });
        if (preferred.length > 0) pool = preferred;
      }
      const sortKey = (r: NormalizedRecord): [string, string, string] => {
        const sync = String(r.raw_json?.['lastEDESync'] ?? '');
        const created = String((r as any).created_at ?? '');
        const id = String((r as any).id ?? '');
        return [sync, created, id];
      };
      pool.sort((a, b) => {
        const [as, ac, ai] = sortKey(a);
        const [bs, bc, bi] = sortKey(b);
        if (bs !== as) return bs > as ? 1 : -1;
        if (bc !== ac) return bc > ac ? 1 : -1;
        if (bi !== ai) return bi > ai ? 1 : -1;
        return 0;
      });
      const selected = pool[0];
      const raw = selected.net_premium;
      if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
      return 0;
    }
  }

  // BO fallback (R-PAY-011) — fires when EDE path produced nothing or the
  // picker returned null. Picker-with-record-but-zero-premium short-circuits
  // to its zero value rather than falling through to BO.
  if (edeReturned !== null) return edeReturned;

  const firstOfMonth = monthKeyToFirstOfMonth(serviceMonth);
  const { start: smStart, end: smEnd } = getStatementMonthBounds(firstOfMonth);
  let activeBoFound = false;
  let bestMR: number | null = null;
  for (const r of records) {
    if (r.source_type !== 'BACK_OFFICE') continue;
    if (!isActiveBackOfficeRecord(r, smStart, smEnd)) continue;
    activeBoFound = true;
    const mr = r.member_responsibility;
    if (typeof mr === 'number' && Number.isFinite(mr)) {
      if (bestMR === null || mr > bestMR) bestMR = mr;
    }
  }
  if (!activeBoFound) return null;
  return bestMR ?? 0;
}

  // Step 3 — tiebreaker
  const sortKey = (r: NormalizedRecord): [string, string, string] => {
    const sync = String(r.raw_json?.['lastEDESync'] ?? '');
    const created = String((r as any).created_at ?? '');
    const id = String((r as any).id ?? '');
    return [sync, created, id];
  };
  pool.sort((a, b) => {
    const [as, ac, ai] = sortKey(a);
    const [bs, bc, bi] = sortKey(b);
    if (bs !== as) return bs > as ? 1 : -1;
    if (bc !== ac) return bc > ac ? 1 : -1;
    if (bi !== ai) return bi > ai ? 1 : -1;
    return 0;
  });
  const selected = pool[0];
  const raw = selected.net_premium;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  return 0;
}

/**
 * Service-month payment evaluation (EXPORTED — shared by classifier and MCE).
 *
 * Returns whether at least one commission row attributes a positive paid
 * amount (`> 0.0001`) to `serviceMonth`, the sum of those amounts, and the
 * distinct pay_entities of contributing rows.
 *
 * `targetPayEntity`:
 *   - 'Coverall' | 'Vix' → only commission rows whose `pay_entity` matches.
 *   - 'All' | null | undefined → any pay_entity counts (matches the legacy
 *     private `paidForMonth` default).
 */
export function paidForServiceMonth(
  records: NormalizedRecord[],
  serviceMonth: MonthKey,
  options?: { targetPayEntity?: 'Coverall' | 'Vix' | 'All' | null },
): { paid: boolean; amount: number; payEntities: string[] } {
  const target = options?.targetPayEntity ?? null;
  const matchPe = target && target !== 'All';
  let amount = 0;
  const payEntities = new Set<string>();
  for (const r of records) {
    if (r.source_type !== 'COMMISSION') continue;
    if (matchPe) {
      const pe = String((r as any).pay_entity ?? '').trim();
      if (pe !== target) continue;
    }
    const { months, perMonth } = commissionServiceMonths(r);
    if (!months.includes(serviceMonth)) continue;
    amount += perMonth;
    const pe = String((r as any).pay_entity ?? '').trim();
    if (pe) payEntities.add(pe);
  }
  return { paid: amount > 0.0001, amount, payEntities: Array.from(payEntities) };
}

/** Sum of commission attributed to this specific service month (legacy). */
function paidForMonth(records: NormalizedRecord[], month: MonthKey): number {
  return paidForServiceMonth(records, month).amount;
}

/**
 * Any qualified, active-date EDE record in this member's set that covers the
 * given month. Fix 6 — uses canonical isEDEQualified + day-aware term-
 * boundary. Cancelled/terminated/non-Ambetter rows no longer light in_ede.
 */
function hasEdeForMonth(records: NormalizedRecord[], month: MonthKey): boolean {
  return records.some(r => {
    if (r.source_type !== 'EDE') return false;
    if (!isEDEQualified(r)) return false;
    const eff = dateToMonthKey(r.effective_date);
    if (!eff || eff > month) return false;
    if (r.policy_term_date) {
      const lastActive = lastActiveMonthForTermDate(r.policy_term_date);
      if (lastActive && month > lastActive) return false;
    }
    return true;
  });
}


/**
 * Any BO record active during the given month — effective_date ≤ month-start
 * AND (policy_term_date is null or > month-start).
 */
function hasActiveBoForMonth(records: NormalizedRecord[], month: MonthKey): boolean {
  const firstOfMonth = monthKeyToFirstOfMonth(month);
  const { end } = getStatementMonthBounds(firstOfMonth);
  return records.some(r => {
    if (r.source_type !== 'BACK_OFFICE') return false;
    const eff = r.effective_date || '';
    if (eff && eff > firstOfMonth) return false;
    // Delegate active-window + eligibility + term + paid_through checks.
    return isActiveBackOfficeRecord(r, firstOfMonth, end);
  });
}

/** Any commission record attributed to this month. */
function hasCommissionForMonth(records: NormalizedRecord[], month: MonthKey): boolean {
  return records.some(r => {
    if (r.source_type !== 'COMMISSION') return false;
    return commissionServiceMonths(r).months.includes(month);
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Ripeness
// ──────────────────────────────────────────────────────────────────────────

/**
 * Month M is ripe when:
 *   1. A commission statement whose service-month set includes M has been
 *      uploaded (some commission row has paid_to_date falling in M), AND
 *   2. When snapshot dates are plumbed through, a BO snapshot dated on or
 *      after first-of-(M+1) has been uploaded.
 *
 * Condition 1 tells us the commission run for month M has happened, so we
 * can distinguish "paid" from "expected and missing." Condition 2 gives the
 * premium-paid gate a snapshot that could reflect M-end paid-through status.
 *
 * Today, snapshot dates aren't plumbed onto records, so when the caller
 * passes an empty boSnapshotDates, we treat condition 2 as satisfied and
 * rely solely on commission-statement presence. This makes ripeness align
 * with the user's mental model: "did the statement that pays for M arrive?"
 */
export function isMonthRipe(month: MonthKey, context: ClassifierContext): boolean {
  if (!context.commissionStatementMonths.has(month)) return false;
  if (context.boSnapshotDates.length === 0) return true;
  const nextMonthStart = monthKeyToFirstOfMonth(addMonths(month, 1));
  return context.boSnapshotDates.some(d => d >= nextMonthStart);
}

// ──────────────────────────────────────────────────────────────────────────
// Per-cell classifier
// ──────────────────────────────────────────────────────────────────────────

function classifyCell(
  records: NormalizedRecord[],
  month: MonthKey,
  firstEligible: MonthKey | null,
  context: ClassifierContext,
): CellClassification {
  const in_ede = hasEdeForMonth(records, month);
  const in_back_office = hasActiveBoForMonth(records, month);
  const in_commission = hasCommissionForMonth(records, month);
  const paid_amount = paidForMonth(records, month);

  const base = { month, paid_amount, in_ede, in_back_office, in_commission };

  // Rule 1: Paid
  // Empirical payment must override all a-priori eligibility predictions.
  // Some valid commission rows look "not ours" or "pre-eligibility" on paper,
  // but the statement itself proves the service month was paid and should stay
  // visible in the timeline.
  if (paid_amount > 0.0001) {
    return { ...base, state: 'paid', reason: `Commission of $${paid_amount.toFixed(2)} received for this service month.` };
  }

  // Rule 3 (non-eligible): not ours at all
  if (!memberBelongsToUs(records)) {
    return { ...base, state: 'not_expected_not_ours', reason: 'Member never tied to one of our NPNs.' };
  }

  // Rule 3 (non-eligible): before first-eligible month
  if (firstEligible && month < firstEligible) {
    return {
      ...base,
      state: 'not_expected_pre_eligibility',
      reason: `Member first becomes commission-eligible in ${firstEligible}.`,
    };
  }
  if (!firstEligible) {
    return {
      ...base,
      state: 'not_expected_not_ours',
      reason: 'Could not establish a first-eligible month for this member.',
    };
  }

  // Rule 3 (non-eligible): cancelled or transferred away by this month
  const activeTermBy = records
    .filter(r => r.source_type === 'BACK_OFFICE')
    .map(r => r.broker_term_date || '')
    .filter(Boolean);
  const firstOfMonth = monthKeyToFirstOfMonth(month);
  const brokerTerminated = activeTermBy.length > 0 && activeTermBy.every(t => t <= firstOfMonth);
  if (brokerTerminated) {
    return { ...base, state: 'not_expected_cancelled', reason: 'Broker term date is in the past as of this month.' };
  }

  // Stale-source guard: member was historically ours (passed not_ours / pre-eligibility
  // / firstEligible / brokerTerminated checks), but NO current source supports this
  // month. Without this guard, stale historical BO evidence would let the cell fall
  // through to pending/unpaid/manual_review even though the source badges are empty.
  if (paid_amount === 0 && !in_ede && !in_back_office && !in_commission) {
    return {
      ...base,
      state: 'not_expected_cancelled',
      reason: 'No current EDE, canonically-active Back Office, or commission source supports this month.',
    };
  }

  // Rule 2: Pending (not ripe)
  if (!isMonthRipe(month, context)) {
    return {
      ...base,
      state: 'pending',
      reason: 'Not ripe: commission statement or next-month BO snapshot not yet uploaded.',
    };
  }

  // From here, we're ripe and no commission was received.
  // MT Stage 2 gate: when ClassifierContext carries batchMonthByBatchId,
  // use service-month-grain premium. Otherwise fall back to legacy
  // member-level max (preserves non-MT consumer behavior).
  const hasBatchMonthContext = context.batchMonthByBatchId !== undefined;
  const batchMonthByBatchId = context.batchMonthByBatchId ?? new Map<string, string>();
  const netPremium: number | null = hasBatchMonthContext
    ? netPremiumForServiceMonth(records, month, { batchMonthByBatchId })
    : latestEdeNetPremium(records);
  const paidThrough = latestBoPaidThrough(records);
  const paidThroughCoversMonth = paidThrough && paidThrough >= month;
  const paidThroughShowsUnpaid = paidThrough && paidThrough < month;
  const noPositiveServiceMonthPremium = hasBatchMonthContext
    ? netPremium === null || netPremium === 0
    : netPremium === 0;

  // Rule 3 (eligible cells — Unpaid disputable): premium paid or zero-premium plan
  if (noPositiveServiceMonthPremium || paidThroughCoversMonth) {
    return {
      ...base,
      state: 'unpaid',
      reason: netPremium === 0
        ? 'Zero net premium plan with no commission received — dispute candidate.'
        : netPremium === null
        ? 'No positive service-month EDE premium evidence and no commission received — dispute candidate.'
        : `BO shows paid-through ${paidThrough || 'none'} but no commission received.`,
    };
  }

  // Rule 4 (non-disputable): premium unambiguously unpaid
  if (netPremium !== null && netPremium > 0 && paidThroughShowsUnpaid) {
    return {
      ...base,
      state: 'not_expected_premium_unpaid',
      reason: `Net premium $${netPremium.toFixed(2)} due but BO paid-through ${paidThrough || 'none'} < ${month} start.`,
    };
  }

  // Rule 5: signals inconclusive — hand off to human
  return {
    ...base,
    state: 'manual_review',
    reason: netPremium === null
      ? `No service-month EDE premium evidence, paid-through "${paidThrough || 'none'}" — signals insufficient.`
      : `No commission, net premium $${netPremium.toFixed(2)}, paid-through "${paidThrough || 'none'}" — signals insufficient.`,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Per-member + rollup
// ──────────────────────────────────────────────────────────────────────────

function computeRollup(cells: Record<MonthKey, CellClassification>): RollupStatus {
  const values = Object.values(cells);
  if (values.length === 0) return 'all_not_expected';
  const eligible = values.filter(c => !c.state.startsWith('not_expected'));
  if (eligible.length === 0) return 'all_not_expected';
  if (eligible.some(c => c.state === 'pending')) return 'has_pending';
  const paid = eligible.filter(c => c.state === 'paid').length;
  const unpaid = eligible.filter(c => c.state === 'unpaid').length;
  if (paid === eligible.length) return 'fully_paid';
  if (unpaid === eligible.length) return 'fully_unpaid';
  return 'mixed';
}

/** Classify a single member across all months in the context's range. */
export function classifyMember(
  records: NormalizedRecord[],
  context: ClassifierContext,
): MemberClassification {
  const firstEligible = computeFirstEligibleMonth(records);

  const cells: Record<MonthKey, CellClassification> = {};
  for (const m of context.months) {
    cells[m] = classifyCell(records, m, firstEligible, context);
  }

  const total_paid = Object.values(cells).reduce((sum, c) => sum + c.paid_amount, 0);
  const needs_manual_review = Object.values(cells).some(c => c.state === 'manual_review');
  const rollup = computeRollup(cells);

  // Identity: prefer BO (most accurate) then EDE then commission
  const sample =
    records.find(r => r.source_type === 'BACK_OFFICE') ??
    records.find(r => r.source_type === 'EDE') ??
    records.find(r => r.source_type === 'COMMISSION');

  return {
    member_key: records[0]?.member_key ?? '',
    applicant_name: sample?.applicant_name ?? '',
    carrier: sample?.carrier ?? '',
    agent_npn: sample?.agent_npn ?? '',
    aor_bucket: sample?.aor_bucket ?? '',
    first_eligible_month: firstEligible,
    cells,
    rollup,
    total_paid,
    needs_manual_review,
  };
}

/** Classify an entire batch. Records are assumed already grouped by member_key. */
export function classifyBatch(
  recordsByMember: Map<string, NormalizedRecord[]>,
  context: ClassifierContext,
): MemberClassification[] {
  const out: MemberClassification[] = [];
  for (const [, records] of recordsByMember) {
    out.push(classifyMember(records, context));
  }
  return out;
}

/**
 * Build a ClassifierContext from a list of records. Derives the set of months
 * for which commission statements have been uploaded (based on attributed
 * service months) and the BO snapshot dates available. `coveredMonths` is the
 * months the classifier will produce cells for — usually the dateRange helper
 * `getCoveredMonths(statement_month)` extended for the timeline view.
 */
export function buildClassifierContext(
  records: NormalizedRecord[],
  months: MonthKey[],
  boSnapshotDates: string[] = [],
  options?: { batchMonthByBatchId?: Map<string, string> },
): ClassifierContext {
  const commissionStatementMonths = new Set<MonthKey>();
  for (const r of records) {
    if (r.source_type !== 'COMMISSION') continue;
    for (const m of commissionServiceMonths(r).months) {
      commissionStatementMonths.add(m);
    }
  }
  return {
    months,
    commissionStatementMonths,
    boSnapshotDates,
    batchMonthByBatchId: options?.batchMonthByBatchId,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Funnel (§4.5)
// ──────────────────────────────────────────────────────────────────────────

export interface FunnelCounts {
  /** EDE-eligible: has our AOR qualified EDE record with effective_date ≤ month-start. */
  edeEligible: number;
  /** Of those, also appear in the month-M BO snapshot with our AOR. */
  edeAndBo: number;
  /** Of those, received commission for month M. */
  edeAndBoAndCommission: number;
  /** Gap: EDE eligible but not in BO. Feeds BO Attribution Recon (§5b). */
  edeOnly: number;
  /** BO-only eligible: in BO with our AOR but not in EDE. */
  boOnly: number;
  /** Of BO-only, paid commission. */
  boOnlyPaid: number;
}

/** True if a record belongs to the given canonical carrier (e.g. 'ambetter'). */
function recordMatchesCarrier(r: NormalizedRecord, canonical: string): boolean {
  if (!canonical) return true;
  // EDE stores the raw issuer in raw_json; BO/Commission populate r.carrier
  const rawIssuer = (r.raw_json?.['issuer'] ?? r.carrier ?? '') as string;
  return canonicalCarrier(rawIssuer) === canonical;
}

/**
 * Compute the source funnel for a specific month.
 *
 * `canonicalCarrierKey` restricts to a single carrier (e.g. 'ambetter'). Pass
 * '' to include every carrier. Aligns with dashboard's Expected Enrollments
 * semantics which is Ambetter-only today.
 */
export function computeFunnelForMonth(
  recordsByMember: Map<string, NormalizedRecord[]>,
  month: MonthKey,
  canonicalCarrierKey: string = '',
): FunnelCounts {
  const funnel: FunnelCounts = {
    edeEligible: 0,
    edeAndBo: 0,
    edeAndBoAndCommission: 0,
    edeOnly: 0,
    boOnly: 0,
    boOnlyPaid: 0,
  };

  for (const [, records] of recordsByMember) {
    if (!memberBelongsToUs(records)) continue;

    // SPAN SEMANTIC (2026-04-26): an Effectuated EDE row is active from its
    // effective_date through (policy_term_date - 1 month) — same convention
    // as memberTimeline.ts and BO. Previously this matched only on
    // effective_date === month, which under-reported later months in the
    // funnel (e.g. Mar 2026 EDE eligible was 371 instead of ~1,597).
    const edeMatch = records.some(r => {
      if (r.source_type !== 'EDE') return false;
      if (!isEdeRecordOurs(r)) return false;
      if (!isQualifiedEdeStatus(r)) return false;
      if (!recordMatchesCarrier(r, canonicalCarrierKey)) return false;
      const effMonth = dateToMonthKey(r.effective_date);
      if (!effMonth || effMonth > month) return false;
      const termMonth = r.policy_term_date ? dateToMonthKey(r.policy_term_date) : '';
      // term_date is exclusive — active through the prior month
      if (termMonth && termMonth <= month) return false;
      return true;
    });
    const boMatch = records
      .filter(r => isBoRecordOurs(r) && recordMatchesCarrier(r, canonicalCarrierKey))
      .some(r => {
        const firstOfMonth = monthKeyToFirstOfMonth(month);
        const { end } = getStatementMonthBounds(firstOfMonth);
        const eff = r.effective_date || '';
        if (eff && eff > firstOfMonth) return false;
        // Canonical BO active predicate — Ineligible-BO Phase 1.
        return isActiveBackOfficeRecord(r, firstOfMonth, end);
      });
    const commissionMatch = records.some(r => {
      if (r.source_type !== 'COMMISSION') return false;
      if (!recordMatchesCarrier(r, canonicalCarrierKey)) return false;
      return commissionServiceMonths(r).months.includes(month);
    });

    if (edeMatch) {
      funnel.edeEligible++;
      if (boMatch) {
        funnel.edeAndBo++;
        if (commissionMatch) funnel.edeAndBoAndCommission++;
      } else {
        funnel.edeOnly++;
      }
    } else if (boMatch) {
      funnel.boOnly++;
      if (commissionMatch) funnel.boOnlyPaid++;
    }
  }

  return funnel;
}

// ──────────────────────────────────────────────────────────────────────────
// Cross-surface helpers (shared by classifier + MCE + Member Timeline page)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Thin one-month classifier wrapper. Returns the existing cell
 * {@link ClassificationState} for the single viewed `month`. No new states
 * introduced — callers derive any rollup from existing `not_expected_*`
 * states at the consumption site.
 *
 * Builds a minimal ClassifierContext from `records` so the caller doesn't
 * have to. Pass `boSnapshotDates` if available (otherwise ripeness defers
 * to commission-statement presence per `isMonthRipe` rules).
 */
export function classifyMemberForMonth(
  records: NormalizedRecord[],
  month: MonthKey,
  options?: { boSnapshotDates?: string[] },
): ClassificationState {
  const ctx = buildClassifierContext(records, [month], options?.boSnapshotDates ?? []);
  const member = classifyMember(records, ctx);
  return member.cells[month]?.state ?? 'manual_review';
}

export type AorScope = 'official' | 'all';
export type PayEntityScope = 'Coverall' | 'Vix' | 'All';

/**
 * Build the per-record "does this record belong to the viewed AOR /
 * pay-entity scope?" predicate. Extracted from MemberTimelinePage so the
 * MCE consumer can apply the SAME scope semantics the classifier uses for
 * Member Timeline cells.
 *
 * COMMISSION records skip the AOR check (they are scoped by upload slot,
 * not writing-agent identity) and pay-entity match strictly on `pay_entity`.
 * EDE/BO records honor AOR scope via `isCoverallAORByName` and pay-entity
 * via the NPN_MAP expected_pay_entity (with 'Coverall_or_Vix' permissive).
 */
export function buildIsDueEligibleRecord(opts: {
  aorScope: AorScope;
  payEntity: PayEntityScope;
}): (r: any) => boolean {
  const { aorScope, payEntity } = opts;
  return (r: any): boolean => {
    const isCommission = r?.source_type === 'COMMISSION';
    if (aorScope === 'official' && !isCommission) {
      const aorMatch =
        isCoverallAORByName(r?.aor_bucket) ||
        isCoverallAORByName(r?.raw_json?.['currentPolicyAOR'] as string | undefined) ||
        isCoverallAORByName(
          (r?.raw_json?.['Broker Name'] as string | undefined) ??
          (r?.raw_json?.['broker_name'] as string | undefined),
        );
      if (!aorMatch) return false;
    }
    if (payEntity !== 'All') {
      if (isCommission) {
        const recPayEntity = String(r?.pay_entity || '').trim();
        if (recPayEntity !== payEntity) return false;
      } else {
        const npn = String(r?.agent_npn || '').trim();
        const info = (NPN_MAP as any)[npn];
        if (!info) return false;
        if (info.expectedPayEntity !== payEntity && info.expectedPayEntity !== 'Coverall_or_Vix') {
          return false;
        }
      }
    }
    return true;
  };
}
