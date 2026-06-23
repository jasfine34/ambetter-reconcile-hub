/**
 * Bundle 13e — Shared input-evidence adapter for Dashboard / Agent Summary /
 * Unpaid Recovery / Exceptions surfaces.
 *
 * Produces a Map<member_key, EstMissingInputEvidence> the resolver consumes
 * to look up rate-chart amounts. NEVER fabricates fields from the legacy
 * estimated_missing_commission column — unprovable inputs are returned as
 * null so the resolver surfaces UNSUPPORTED with a concrete reason.
 *
 * policy_year derivation priority (first non-null wins):
 *   1. target_service_month year component
 *   2. expected_ede_effective_month year component
 *   3. effective_date year component
 *   4. null (→ MISSING_POLICY_YEAR)
 */
import type { EstMissingInputEvidence } from './estMissingResolver';
import { deriveAmbetterTxPlanVariant } from './planVariant';

export interface BuildSourceEvidenceOptions {
  /** Default carrier when reconciled row's carrier is missing (Ambetter today). */
  defaultCarrier?: string;
  /** Default months per row when no per-row override is available (1 for monthly). */
  defaultMonths?: number;
}

function yearFromMonthKey(s: unknown): number | null {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (t.length < 4) return null;
  const y = Number(t.substring(0, 4));
  return Number.isFinite(y) && y >= 1900 && y < 2200 ? y : null;
}

function derivePolicyYear(row: any): number | null {
  return (
    yearFromMonthKey(row?.target_service_month) ??
    yearFromMonthKey(row?.expected_ede_effective_month) ??
    yearFromMonthKey(row?.effective_date) ??
    null
  );
}

function parseMatchedPayee(v: unknown): 'Coverall' | 'Vix' | null {
  if (v === 'Coverall' || v === 'Vix') return v;
  return null;
}

function nonNullNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function nonBlankString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

/**
 * Build a per-member evidence Map from reconciled rows. Each entry is the
 * proven, resolver-ready input — null fields mean "we could not prove this
 * input from current sources" and intentionally trigger UNSUPPORTED.
 *
 * Carriers other than Ambetter are out of scope for Bundle 13e; if the row
 * has no carrier we fall back to options.defaultCarrier (defaults to
 * 'Ambetter'). When that fallback is undesired, callers can pass
 * defaultCarrier: undefined and the resolver will surface MISSING_CARRIER.
 */
export function buildSourceEvidenceMap(
  reconciled: readonly any[],
  options: BuildSourceEvidenceOptions = {},
): Map<string, EstMissingInputEvidence> {
  const defaultCarrier = options.defaultCarrier ?? 'Ambetter';
  const defaultMonths = options.defaultMonths ?? 1;
  const out = new Map<string, EstMissingInputEvidence>();
  for (const r of reconciled ?? []) {
    if (!r || !r.member_key) continue;
    const carrierVal = nonBlankString(r.carrier) ?? defaultCarrier ?? null;
    const stateVal = nonBlankString(r.state) ?? nonBlankString(r.bo_state) ?? null;
    const ev: EstMissingInputEvidence = {
      carrier: carrierVal,
      state: stateVal,
      member_count: nonNullNumber(r.member_count) ?? nonNullNumber(r.covered_member_count) ?? null,
      months: defaultMonths,
      policy_year: derivePolicyYear(r),
      plan_variant:
        deriveAmbetterTxPlanVariant({
          carrier: carrierVal,
          state: stateVal,
          sources: [{ raw_json: (r as any)?.raw_json }],
        }) ?? nonBlankString(r.plan_variant),
      current_policy_aor: nonBlankString(r.current_policy_aor),
      matched_payee: parseMatchedPayee(r.actual_pay_entity) ?? parseMatchedPayee(r.matched_payee),
      policy_identity_key: nonBlankString(r.policy_identity_key),
      target_service_month:
        nonBlankString(r.target_service_month) ??
        nonBlankString(r.expected_ede_effective_month),
      member_count_status:
        r.member_count_status === 'resolved' ||
        r.member_count_status === 'manual_review' ||
        r.member_count_status === 'unresolved'
          ? r.member_count_status
          : null,
      member_count_conflicts: Array.isArray(r.member_count_conflicts)
        ? (r.member_count_conflicts as number[])
        : undefined,
    };
    out.set(r.member_key, ev);
  }
  return out;
}

/**
 * Lightweight version counter for useMemo deps — bumps when the input
 * Map identity OR size changes. Wrapping in this helper makes the React
 * memoization contract explicit at call sites.
 */
export function evidenceVersionKey(
  m: Map<string, EstMissingInputEvidence> | undefined,
): string {
  if (!m) return '0';
  return `${m.size}`;
}

export function ratesVersionKey(rateRows: readonly { id?: string }[] | undefined): string {
  if (!rateRows || rateRows.length === 0) return '0';
  let maxId = '';
  for (const r of rateRows) {
    const id = String(r.id ?? '');
    if (id > maxId) maxId = id;
  }
  return `${rateRows.length}:${maxId}`;
}
