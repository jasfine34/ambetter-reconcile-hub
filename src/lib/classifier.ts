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
    // Override — became broker mid-flight; eligible starts the month AFTER
    return addMonths(bedKey, 1);
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

/** Sum of commission attributed to this specific service month. */
function paidForMonth(records: NormalizedRecord[], month: MonthKey): number {
  let total = 0;
  for (const r of records) {
    if (r.source_type !== 'COMMISSION') continue;
    const { months, perMonth } = commissionServiceMonths(r);
    if (months.includes(month)) total += perMonth;
  }
  return total;
}

/** Any EDE record in this member's set that covers the given month. */
function hasEdeForMonth(records: NormalizedRecord[], month: MonthKey): boolean {
  return records.some(r => r.source_type === 'EDE' && dateToMonthKey(r.effective_date) <= month);
}

/**
 * Any BO record active during the given month — effective_date ≤ month-start
 * AND (policy_term_date is null or > month-start).
 */
function hasActiveBoForMonth(records: NormalizedRecord[], month: MonthKey): boolean {
  const firstOfMonth = monthKeyToFirstOfMonth(month);
  return records.some(r => {
    if (r.source_type !== 'BACK_OFFICE') return false;
    const eff = r.effective_date || '';
    if (eff && eff > firstOfMonth) return false;
    const term = r.policy_term_date || '';
    if (term && term <= firstOfMonth) return false;
    return true;
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

  // Rule 2: Pending (not ripe)
  if (!isMonthRipe(month, context)) {
    return {
      ...base,
      state: 'pending',
      reason: 'Not ripe: commission statement or next-month BO snapshot not yet uploaded.',
    };
  }

  // From here, we're ripe and no commission was received.
  const netPremium = latestEdeNetPremium(records);
  const paidThrough = latestBoPaidThrough(records);
  const monthEnd = monthKeyToFirstOfMonth(addMonths(month, 1)); // exclusive
  const paidThroughCoversMonth = paidThrough && paidThrough >= month;
  const paidThroughShowsUnpaid = paidThrough && paidThrough < month;

  // Rule 3 (eligible cells — Unpaid disputable): premium paid or zero-premium plan
  if (netPremium === 0 || paidThroughCoversMonth) {
    return {
      ...base,
      state: 'unpaid',
      reason: netPremium === 0
        ? 'Zero net premium plan with no commission received — dispute candidate.'
        : `BO shows paid-through ${paidThrough} but no commission received.`,
    };
  }

  // Rule 4 (non-disputable): premium unambiguously unpaid
  if (netPremium > 0 && paidThroughShowsUnpaid) {
    return {
      ...base,
      state: 'not_expected_premium_unpaid',
      reason: `Net premium $${netPremium.toFixed(2)} due but BO paid-through ${paidThrough} < ${month} start.`,
    };
  }

  // Rule 5: signals inconclusive — hand off to human
  return {
    ...base,
    state: 'manual_review',
    reason: `No commission, net premium $${netPremium.toFixed(2)}, paid-through "${paidThrough || 'none'}" — signals insufficient.`,
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
): ClassifierContext {
  const commissionStatementMonths = new Set<MonthKey>();
  for (const r of records) {
    if (r.source_type !== 'COMMISSION') continue;
    for (const m of commissionServiceMonths(r).months) {
      commissionStatementMonths.add(m);
    }
  }
  return { months, commissionStatementMonths, boSnapshotDates };
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
        const eff = r.effective_date || '';
        if (eff && eff > firstOfMonth) return false;
        // Canonical BO active predicate (#29 Phase 1) — checks policy term,
        // broker term (with 9999-* sentinel), and eligible_for_commission.
        return isActiveBackOfficeRecord(r, firstOfMonth);
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
