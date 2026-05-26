import type { NormalizedRecord } from './normalize';
import type { ClassificationState, RollupStatus } from './classifier';
import { pickCurrentPolicyAor, collectFfmAppIds, buildEdeFfmFallbackIndex } from './aorPicker';
import { isEDEQualified } from './canonical/edeQualified';
import { lastActiveMonthForTermDate } from './canonical/termBoundary';
import { isActiveBackOfficeRecord } from './canonical/isActiveBackOfficeRecord';
import { getStatementMonthBounds } from './canonical/statementMonthBounds';
import { monthKeyToFirstOfMonth } from './dateRange';


export interface MonthCell {
  month: string;                   // 'YYYY-MM'
  in_ede: boolean;
  in_back_office: boolean;
  in_commission: boolean;
  paid_amount: number;             // sum of commission $ attributed to this service month
  payment_count: number;
  due: boolean;                    // active in BO OR qualified EDE this month
  /**
   * Phase 2c — classifier state for this cell (optional so legacy callers
   * still work). Populated by MemberTimelinePage after building the row.
   */
  state?: ClassificationState;
  /** Classifier's human-readable explanation, surfaced in the cell tooltip. */
  state_reason?: string;
  /**
   * MT Stage 2 — unpaid-cell net premium bucket. Only meaningful when
   * state === 'unpaid'. '+Net' = positive service-month premium evidence.
   * '0Net' = zero/null/no-row evidence (collapsed per chip semantics).
   * null otherwise. Stamped in MemberTimelinePage after the classifier +
   * no-current-source override, not derived in buildMemberTimeline().
   */
  netBucket?: '+Net' | '0Net' | null;
}

export interface MemberTimelineRow {
  member_key: string;
  applicant_name: string;
  policy_number: string;
  exchange_subscriber_id: string;
  issuer_subscriber_id: string;
  agent_name: string;
  aor_bucket: string;
  current_policy_aor: string;
  /** Distinct FFM application IDs across this member's normalized records. */
  ffm_app_ids: string[];
  cells: Record<string, MonthCell>;  // keyed by 'YYYY-MM'
  total_paid: number;
  months_due: number;
  months_paid: number;
  months_unpaid: number;
  /** Phase 2c — classifier rollup for the selected month range. */
  rollup?: RollupStatus;
  /** True if any cell in range is state = manual_review. */
  needs_manual_review?: boolean;
  /** MT Stage 2 — member has ≥1 unpaid cell with positive service-month premium evidence. */
  hasUnpaidPlusNet?: boolean;
  /** MT Stage 2 — member has ≥1 unpaid cell with zero/null/no-row premium evidence. */
  hasUnpaidZeroNet?: boolean;
}

// (Local QUALIFIED_EDE_RAW_STATUSES removed — replaced by canonical
// isEDEQualified from src/lib/canonical/edeQualified.ts per Fix 6.)


/** Generate inclusive list of YYYY-MM strings between start and end. */
export function buildMonthList(startYM: string, endYM: string): string[] {
  const out: string[] = [];
  const [sy, sm] = startYM.split('-').map(Number);
  const [ey, em] = endYM.split('-').map(Number);
  let y = sy, m = sm;
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

function ymOf(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null;
  const s = String(dateStr).trim();
  // ISO YYYY-MM-DD or YYYY-MM
  const iso = s.match(/^(\d{4})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}`;
  // MM/DD/YYYY
  const slash = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (slash) {
    let yr = parseInt(slash[3]);
    if (yr < 100) yr += 2000;
    return `${yr}-${slash[1].padStart(2, '0')}`;
  }
  return null;
}

/** Add n months to a YYYY-MM string. */
function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number);
  let total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

// (Local rawStatusKey / rawIssuerKey / isEDEQualified removed — replaced
// by canonical isEDEQualified per Fix 6.)


/**
 * For a Back Office record, return the inclusive [startYM, endYM] active range.
 *
 * - start = max(effective_date month, broker_effective_date month).
 *   Fix 5: BED-aware. Before BED the broker isn't tied to the policy, so
 *   the BO row should NOT support pre-BED months.
 * - end   = lastActiveMonthForTermDate(policy_term_date) — day-aware per
 *   R-INELIG-001 (Fix 2). Term on day 1 → previous month; term on day 2+ →
 *   term month itself.
 *
 * Fix 1 / R-INELIG-002: paid_through_date is NOT used as a range bound.
 * paid_through is the MEMBER's premium-paid-through date, not a commission
 * disqualifier.
 */
function backOfficeActiveRange(r: NormalizedRecord): { start: string | null; end: string | null } {
  const pedYM = ymOf(r.effective_date);
  const bedYM = ymOf(r.broker_effective_date);
  let start = pedYM;
  if (bedYM && (!start || bedYM > start)) start = bedYM;
  const end = r.policy_term_date ? lastActiveMonthForTermDate(r.policy_term_date) : null;
  return { start, end };
}


/**
 * Distribute a commission row's gross amount across the months it covers.
 * Uses the normalized `paid_to_date` column as the END of the covered period
 * and `Months Paid` (from raw_json) as the span.
 *
 * STRICT: if `paid_to_date` is missing or unparseable, this row contributes
 * ZERO to any month. Older logic fell back to Issue Date / effective_date,
 * which silently bled non-service-month commissions into whatever month
 * happened to fit — over-attributing totals to (e.g.) January.
 */
function commissionServiceMonths(r: NormalizedRecord): { months: string[]; per: number; total: number } {
  const total = r.commission_amount ?? 0;
  if (total === 0) return { months: [], per: 0, total: 0 };

  // Use the typed normalized column only. If it's missing, do not fall back to
  // raw string parsing here — classification already relies on the typed date,
  // and keeping one source of truth avoids attribution drift.
  const paidToYM = ymOf(r.paid_to_date);

  if (!paidToYM) {
    // No identifiable service month — do NOT guess from Issue Date.
    return { months: [], per: 0, total };
  }

  const monthsPaidRaw = r.raw_json?.['Months Paid'];
  const monthsPaid = monthsPaidRaw ? Math.max(1, parseInt(String(monthsPaidRaw)) || 1) : 1;

  const months: string[] = [];
  for (let i = monthsPaid - 1; i >= 0; i--) {
    months.push(addMonths(paidToYM, -i));
  }
  return { months, per: total / months.length, total };
}

function emptyCell(month: string): MonthCell {
  return {
    month,
    in_ede: false,
    in_back_office: false,
    in_commission: false,
    paid_amount: 0,
    payment_count: 0,
    due: false,
  };
}

/**
 * Optional per-record predicate. When provided, a record only contributes
 * "due" months when this returns true — used to scope due-counting to records
 * whose AOR/pay-entity for that month belongs to us. Records still contribute
 * to source presence (E/B/C badges) and paid amounts regardless, so the
 * timeline cells remain informative for context.
 */
export type DueRecordPredicate = (r: NormalizedRecord) => boolean;

export function buildMemberTimeline(
  records: NormalizedRecord[],
  monthList: string[],
  isDueEligibleRecord?: DueRecordPredicate
): MemberTimelineRow[] {
  const monthSet = new Set(monthList);
  const byMember = new Map<string, NormalizedRecord[]>();
  for (const r of records) {
    const key = r.member_key || r.applicant_name || 'unknown';
    let arr = byMember.get(key);
    if (!arr) { arr = []; byMember.set(key, arr); }
    arr.push(r);
  }

  // Class-A FFM ID fallback index: built from the full records pool so a
  // member whose same-key recs carry no `ffmAppId` can still surface one
  // from an EDE row under a different member_key but the same subscriber id
  // within the same batch. Display/export only — does not feed reconcile.
  const ffmFallbackIndex = buildEdeFfmFallbackIndex(records);

  const rows: MemberTimelineRow[] = [];

  for (const [key, recs] of byMember) {
    const cells: Record<string, MonthCell> = {};
    for (const m of monthList) cells[m] = emptyCell(m);

    // Identity: prefer EDE/BO record with most info
    const sample = recs.find(r => r.applicant_name) || recs[0];
    const groupBatchId = (recs.find(r => (r as any).batch_id) as any)?.batch_id;
    const groupCarrier = recs.find(r => r.carrier)?.carrier;
    const groupEsid = recs.find(r => r.exchange_subscriber_id)?.exchange_subscriber_id;
    const groupIsid = recs.find(r => r.issuer_subscriber_id)?.issuer_subscriber_id;
    const fallbackFfmCandidates = ffmFallbackIndex.lookup({
      batch_id: groupBatchId,
      carrier: groupCarrier,
      exchange_subscriber_id: groupEsid,
      issuer_subscriber_id: groupIsid,
    });
    const row: MemberTimelineRow = {
      member_key: key,
      applicant_name: sample?.applicant_name || '',
      policy_number: recs.find(r => r.policy_number)?.policy_number || '',
      exchange_subscriber_id: recs.find(r => r.exchange_subscriber_id)?.exchange_subscriber_id || '',
      issuer_subscriber_id: recs.find(r => r.issuer_subscriber_id)?.issuer_subscriber_id || '',
      agent_name: recs.find(r => r.agent_name)?.agent_name || '',
      aor_bucket: recs.find(r => r.aor_bucket)?.aor_bucket || '',
      current_policy_aor: pickCurrentPolicyAor(recs),
      ffm_app_ids: collectFfmAppIds(recs, fallbackFfmCandidates),
      cells,
      total_paid: 0,
      months_due: 0,
      months_paid: 0,
      months_unpaid: 0,
    };

    for (const r of recs) {
      const eligibleForDue = isDueEligibleRecord ? isDueEligibleRecord(r) : true;
      if (r.source_type === 'EDE') {
        // AUDIT FIX (2026-04): An Effectuated EDE record represents an ongoing
        // enrollment, not a single-month event. Previously we only marked
        // in_ede / due for the effective_date month, which caused widespread
        // false "missing from EDE" flags on Feb/Mar cells for members who
        // appeared in every monthly EDE batch. Now we span [effective_date,
        // expiration_date or open] to mirror backOfficeActiveRange. Multiple
        // EDE records for the same member naturally union via the per-cell
        // boolean. Cancelled rows are still excluded from `due` via
        // isEDEQualified.
        const start = ymOf(r.effective_date);
        if (!start) continue;
        // Fix 6 — day-aware term-boundary via canonical helper.
        const end = r.policy_term_date ? lastActiveMonthForTermDate(r.policy_term_date) : null;
        const edeQualified = isEDEQualified(r);
        // FOLLOWUP FIX: gate in_ede with the same predicates as `due` so the
        // E badge respects AOR scope + qualifying status.
        if (!eligibleForDue || !edeQualified) continue;
        for (const m of monthList) {
          if (m < start) continue;
          if (end && m > end) continue;
          cells[m].in_ede = true;
          cells[m].due = true;
        }
      } else if (r.source_type === 'BACK_OFFICE') {
        const { start, end } = backOfficeActiveRange(r);
        if (!start) continue;
        for (const m of monthList) {
          if (m < start) continue;
          if (end && m > end) continue;
          // Fix 7 (per Codex v3 C2 Option A + v4 C1) — gate per-month
          // stamping on canonical predicate AND scope. R-SRC-004 requires
          // IN-SCOPE active source support; off-scope active BO must NOT
          // stamp source flags. Range alone misses broker_term,
          // eligibility, and BED-future disqualifiers — those live only
          // in isActiveBackOfficeRecord.
          const firstOfMonth = monthKeyToFirstOfMonth(m);
          const { start: smStart, end: smEnd } = getStatementMonthBounds(firstOfMonth);
          if (!isActiveBackOfficeRecord(r, smStart, smEnd)) continue;
          if (!eligibleForDue) continue;
          cells[m].in_back_office = true;
          cells[m].due = true;
        }

      } else if (r.source_type === 'COMMISSION') {
        // Honor the eligibility predicate for commissions too. Without this
        // gate, a Vix commission row would still pump $ into a member's cells
        // even when the user has filtered to "Coverall only", inflating Total
        // Paid above what the underlying data supports.
        if (!eligibleForDue) continue;
        const { months, per } = commissionServiceMonths(r);
        for (const m of months) {
          if (!monthSet.has(m)) continue;
          cells[m].in_commission = true;
          cells[m].paid_amount += per;
          cells[m].payment_count += 1;
        }
      }
    }

    // Totals
    for (const m of monthList) {
      const c = cells[m];
      row.total_paid += c.paid_amount;
      if (c.due) row.months_due += 1;
      if (c.due && c.paid_amount > 0.0001) row.months_paid += 1;
      if (c.due && c.paid_amount <= 0.0001) row.months_unpaid += 1;
    }

    rows.push(row);
  }

  // Sort: most months_unpaid first, then by name
  rows.sort((a, b) => {
    if (b.months_unpaid !== a.months_unpaid) return b.months_unpaid - a.months_unpaid;
    return a.applicant_name.localeCompare(b.applicant_name);
  });

  return rows;
}

export function formatMonthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1, 1);
  return d.toLocaleString('en-US', { month: 'short', year: '2-digit' });
}

/**
 * Map a classifier-stamped MonthCell to its export status string so the CSV
 * matches the visible page rendering. Falls back to legacy due+paid logic for
 * cells that have no classifier state (older callers / tests).
 */
/**
 * Assembly-layer no-source invariant guard. If the displayed/exported source
 * flags are all false and there is no paid amount, this cell cannot be
 * UNPAID / PENDING / MANUAL_REVIEW / premium_unpaid regardless of what the
 * classifier's internal record set inferred — there is no current evidence
 * the member is ours for this month. Force not_expected_cancelled and clear
 * `due` so downstream counts and the cell tooltip both reflect the override.
 */
export function applyNoSourceInvariantToMonthCell(cell: MonthCell): MonthCell {
  if (
    cell.paid_amount === 0 &&
    !cell.in_ede &&
    !cell.in_back_office &&
    !cell.in_commission
  ) {
    return {
      ...cell,
      due: false,
      state: 'not_expected_cancelled',
      state_reason:
        'No current EDE, canonically-active Back Office, or commission source supports this month.',
    };
  }
  return cell;
}

export function exportStatusForMonthCell(c: MonthCell): string {
  const sources = [c.in_ede && 'EDE', c.in_back_office && 'BO', c.in_commission && 'COM']
    .filter(Boolean).join('+');
  switch (c.state) {
    case 'paid': return 'PAID';
    case 'unpaid': return 'UNPAID';
    case 'pending': return 'PENDING';
    case 'manual_review': return 'REVIEW';
    case 'not_expected_premium_unpaid':
    case 'not_expected_pre_eligibility':
    case 'not_expected_cancelled':
    case 'not_expected_not_ours':
      return sources ? 'N/A' : '';
    default:
      // Legacy fallback for cells without a classifier state.
      return c.due ? (c.paid_amount > 0.0001 ? 'PAID' : 'UNPAID') : (sources ? 'PRESENT' : '');
  }
}

export function buildMemberTimelineExportRows(
  rows: MemberTimelineRow[],
  monthList: string[],
): Record<string, unknown>[] {
  return rows.map(r => {
    const base: Record<string, unknown> = {
      ffm_app_id: (r.ffm_app_ids ?? []).join('; '),
      member: r.applicant_name,
      policy_number: r.policy_number,
      exchange_subscriber_id: r.exchange_subscriber_id,
      issuer_subscriber_id: r.issuer_subscriber_id,
      agent_name: r.agent_name,
      aor_bucket: r.aor_bucket,
      months_due: r.months_due,
      months_paid: r.months_paid,
      months_unpaid: r.months_unpaid,
      total_paid: r.total_paid.toFixed(2),
    };
    for (const m of monthList) {
      const c = r.cells[m];
      const sources = [c.in_ede && 'EDE', c.in_back_office && 'BO', c.in_commission && 'COM']
        .filter(Boolean).join('+');
      base[`${m}_status`] = exportStatusForMonthCell(c);
      base[`${m}_paid`] = c.paid_amount.toFixed(2);
      base[`${m}_sources`] = sources;
    }
    return base;
  });
}
