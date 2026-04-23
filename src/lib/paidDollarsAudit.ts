/**
 * Read-only instrumentation for diagnosing paid-dollar attribution drift in
 * the Member Timeline.
 *
 * This module DOES NOT change classification or attribution. It re-runs the
 * EXACT same allocation math used by `commissionServiceMonths` in
 * `memberTimeline.ts`, but instead of summing dollars into cells it captures
 * each contribution as a row so we can see *where the math sent each dollar*.
 *
 * Two outputs:
 *   1. `attributions[]` — every commission row that contributed > $0 to a
 *      visible (member, month) cell in the current scope. Per-month
 *      allocation is gross / Months Paid (matches memberTimeline).
 *   2. `unattributed[]` — every in-scope commission row that contributed $0
 *      to the visible timeline, with a specific reason
 *      (paid_to_date null/unparseable, all service months outside range,
 *      excluded by pay-entity scope, excluded by AOR scope).
 *
 * Self-check invariant for the caller:
 *   sum(attributions where month ∈ monthList) === Member Timeline Total Paid
 *   sum(attributions) + sum(unattributed.gross excluded-by-scope) +
 *     sum(unattributed.gross out-of-range/null) ===
 *     sum(commission_amount over the *unfiltered* in-scope-batches commission rows)
 */

import type { NormalizedRecord } from './normalize';

export interface PaidAttribution {
  /** UUID from normalized_records.id */
  record_id: string;
  /** Synthetic timeline member_key after assignMergedMemberKeys */
  member_key: string;
  member_name: string;
  policy_id: string;
  paid_to_date: string | null;
  months_paid: number;
  /** Service months this row covers (all of them, not just the ones in range). */
  service_span: string[];
  /** Whichever service months actually landed inside the visible monthList. */
  contributing_months: string[];
  gross: number;
  /** gross / months_paid */
  per_month: number;
  pay_entity: string;
  source_batch_id: string;
  source_batch_label: string;
  source_file_label: string;
}

export type UnattributedReason =
  | 'paid_to_date_missing'
  | 'paid_to_date_unparseable'
  | 'months_paid_invalid'
  | 'service_months_outside_range'
  | 'excluded_by_pay_entity_scope'
  | 'excluded_by_aor_scope'
  | 'gross_zero';

export interface UnattributedRow {
  record_id: string;
  member_key: string;
  member_name: string;
  policy_id: string;
  paid_to_date_raw: string | null;
  months_paid_raw: string | number | null;
  gross: number;
  pay_entity: string;
  source_batch_id: string;
  source_batch_label: string;
  source_file_label: string;
  reason: UnattributedReason;
  reason_detail: string;
}

export interface PaidDollarsAuditResult {
  attributions: PaidAttribution[];
  unattributed: UnattributedRow[];
  /** Total $ attributed to cells inside monthList. */
  attributed_total: number;
  /** Total $ excluded from the timeline (sum of unattributed.gross). */
  unattributed_total: number;
  /** Total commission gross across all in-scope rows the audit looked at. */
  in_scope_gross_total: number;
  /** Per-month subtotal of attributed contributions. */
  per_month_totals: Record<string, number>;
}

interface BatchLike {
  id: string;
  statement_month?: string | null;
  carrier?: string | null;
}

/* ----------------------- date helpers (mirror memberTimeline.ts) ---------- */

function ymOf(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null;
  const s = String(dateStr).trim();
  const iso = s.match(/^(\d{4})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}`;
  const slash = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (slash) {
    let yr = parseInt(slash[3]);
    if (yr < 100) yr += 2000;
    return `${yr}-${slash[1].padStart(2, '0')}`;
  }
  return null;
}

function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

function batchLabel(b: BatchLike | undefined): string {
  if (!b) return 'Unknown batch';
  const sm = b.statement_month ? String(b.statement_month).substring(0, 7) : 'no-month';
  const carrier = b.carrier || 'Unknown';
  return `${carrier} ${sm}`;
}

/* ----------------------- main API ----------------------------------------- */

export interface BuildPaidDollarsAuditArgs {
  /** All commission records currently loaded (already through assignMergedMemberKeys). */
  allRecords: NormalizedRecord[];
  /** Months currently displayed in the timeline (YYYY-MM). */
  monthList: string[];
  /**
   * Predicate matching the one used by buildMemberTimeline. A commission row
   * that fails this is "excluded by scope" — same business rule as the cell.
   */
  isDueEligibleRecord: (r: NormalizedRecord) => boolean;
  /** Indicates whether the user filtered pay_entity / AOR (for reason text). */
  payEntity: string;
  aorScope: string;
  batches: BatchLike[];
}

export function buildPaidDollarsAudit(args: BuildPaidDollarsAuditArgs): PaidDollarsAuditResult {
  const { allRecords, monthList, isDueEligibleRecord, payEntity, aorScope, batches } = args;
  const monthSet = new Set(monthList);
  const batchById = new Map<string, BatchLike>();
  for (const b of batches) batchById.set(b.id, b);

  const attributions: PaidAttribution[] = [];
  const unattributed: UnattributedRow[] = [];
  const per_month_totals: Record<string, number> = {};
  for (const m of monthList) per_month_totals[m] = 0;

  let attributed_total = 0;
  let in_scope_gross_total = 0;

  // We only audit COMMISSION rows — they're what produces paid_amount.
  // "In scope" = belongs to a batch that's in the loaded record set. Caller is
  // responsible for passing the right slice (current batch vs all batches).
  for (const r of allRecords) {
    if (r.source_type !== 'COMMISSION') continue;

    const gross = r.commission_amount ?? 0;
    in_scope_gross_total += gross;

    const recAny = r as unknown as Record<string, unknown>;
    const record_id = String(recAny['id'] ?? '');
    const batch_id = String(recAny['batch_id'] ?? '');
    const sourceBatch = batchById.get(batch_id);
    const baseRow = {
      record_id,
      member_key: r.member_key || r.applicant_name || 'unknown',
      member_name: r.applicant_name || '',
      policy_id:
        r.policy_number ||
        r.issuer_subscriber_id ||
        r.exchange_subscriber_id ||
        '',
      pay_entity: r.pay_entity || '',
      source_batch_id: batch_id,
      source_batch_label: batchLabel(sourceBatch),
      source_file_label: r.source_file_label || '',
    };

    if (gross === 0) {
      unattributed.push({
        ...baseRow,
        paid_to_date_raw: r.paid_to_date,
        months_paid_raw: (r.raw_json?.['Months Paid'] as string) ?? r.months_paid ?? null,
        gross,
        reason: 'gross_zero',
        reason_detail: 'commission_amount is 0 — row contributes nothing.',
      });
      continue;
    }

    // Scope checks first — these apply uniformly to display + classifier.
    if (!isDueEligibleRecord(r)) {
      const recPay = String(r.pay_entity || '').trim();
      const reason: UnattributedReason =
        payEntity !== 'All' && recPay && recPay !== payEntity
          ? 'excluded_by_pay_entity_scope'
          : 'excluded_by_aor_scope';
      const detail =
        reason === 'excluded_by_pay_entity_scope'
          ? `pay_entity="${recPay || '(blank)'}" filtered out by Pay entity = ${payEntity}.`
          : `Excluded by AOR scope = ${aorScope}.`;
      unattributed.push({
        ...baseRow,
        paid_to_date_raw: r.paid_to_date,
        months_paid_raw: (r.raw_json?.['Months Paid'] as string) ?? r.months_paid ?? null,
        gross,
        reason,
        reason_detail: detail,
      });
      continue;
    }

    // Now reproduce commissionServiceMonths exactly.
    const paidToYM = ymOf(r.paid_to_date);
    if (!paidToYM) {
      unattributed.push({
        ...baseRow,
        paid_to_date_raw: r.paid_to_date,
        months_paid_raw: (r.raw_json?.['Months Paid'] as string) ?? r.months_paid ?? null,
        gross,
        reason: r.paid_to_date ? 'paid_to_date_unparseable' : 'paid_to_date_missing',
        reason_detail: r.paid_to_date
          ? `paid_to_date="${r.paid_to_date}" could not be parsed to YYYY-MM.`
          : 'paid_to_date is null on the typed column — cannot determine service month.',
      });
      continue;
    }

    const monthsPaidRaw = r.raw_json?.['Months Paid'];
    const monthsPaid = monthsPaidRaw
      ? Math.max(1, parseInt(String(monthsPaidRaw)) || 1)
      : 1;
    if (monthsPaid <= 0) {
      unattributed.push({
        ...baseRow,
        paid_to_date_raw: r.paid_to_date,
        months_paid_raw: (monthsPaidRaw as string) ?? null,
        gross,
        reason: 'months_paid_invalid',
        reason_detail: `Months Paid="${monthsPaidRaw}" is not a positive integer.`,
      });
      continue;
    }

    const service_span: string[] = [];
    for (let i = monthsPaid - 1; i >= 0; i--) {
      service_span.push(addMonths(paidToYM, -i));
    }
    const per_month = gross / monthsPaid;
    const contributing = service_span.filter(m => monthSet.has(m));

    if (contributing.length === 0) {
      unattributed.push({
        ...baseRow,
        paid_to_date_raw: r.paid_to_date,
        months_paid_raw: (monthsPaidRaw as string) ?? null,
        gross,
        reason: 'service_months_outside_range',
        reason_detail: `Service months ${service_span.join(', ')} all fall outside the visible range ${monthList[0] ?? '?'}…${monthList[monthList.length - 1] ?? '?'}.`,
      });
      continue;
    }

    const attribution: PaidAttribution = {
      ...baseRow,
      paid_to_date: r.paid_to_date,
      months_paid: monthsPaid,
      service_span,
      contributing_months: contributing,
      gross,
      per_month,
    };
    attributions.push(attribution);

    for (const m of contributing) {
      per_month_totals[m] = (per_month_totals[m] ?? 0) + per_month;
      attributed_total += per_month;
    }
  }

  const unattributed_total = unattributed.reduce((s, u) => s + u.gross, 0);

  // Sort: attributions by gross desc; unattributed by gross desc.
  attributions.sort((a, b) => b.gross - a.gross);
  unattributed.sort((a, b) => b.gross - a.gross);

  return {
    attributions,
    unattributed,
    attributed_total,
    unattributed_total,
    in_scope_gross_total,
    per_month_totals,
  };
}

/* ----------------------- per-cell helpers --------------------------------- */

export interface CellContribution {
  attribution: PaidAttribution;
  /** Slice of per_month dollars that landed in THIS cell. Always per_month. */
  amount: number;
}

/**
 * For a single member+month cell, find every attribution that contributed.
 * Used by the cell popover.
 */
export function getCellContributions(
  audit: PaidDollarsAuditResult,
  member_key: string,
  month: string
): CellContribution[] {
  const out: CellContribution[] = [];
  for (const a of audit.attributions) {
    if (a.member_key !== member_key) continue;
    if (!a.contributing_months.includes(month)) continue;
    out.push({ attribution: a, amount: a.per_month });
  }
  return out;
}

/**
 * For a cell that the user clicked but no contributions land there, look at
 * commission rows for this same member that DID exist but landed elsewhere /
 * were excluded. Returns up to 5 nearest candidates so the popover can
 * explain "you might be expecting payment from row X but it landed in Y".
 */
export function getCellNearMissExplanation(
  audit: PaidDollarsAuditResult,
  member_key: string,
  month: string
): {
  excluded: UnattributedRow[];
  attributed_elsewhere: PaidAttribution[];
} {
  const excluded = audit.unattributed.filter(u => u.member_key === member_key);
  const attributed_elsewhere = audit.attributions.filter(
    a => a.member_key === member_key && !a.contributing_months.includes(month)
  );
  return { excluded, attributed_elsewhere };
}
