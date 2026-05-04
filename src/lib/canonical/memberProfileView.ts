/**
 * Best-Known Member Profile (#104) — read-through canonical helper.
 *
 * Computed live from already-loaded normalized_records + the cross-batch
 * resolver index. NEVER mutates persisted data; produces a per-member
 * `MemberProfile` that consolidates the best-known descriptive/contact
 * fields across all uploaded sources.
 *
 * BO-first walk priority for each enriched field:
 *   1. Same-month Back Office
 *   2. Later Back Office (any later month, prefer most recent)
 *   3. Same-month EDE
 *   4. Later EDE (any later month, prefer most recent)
 *   5. Earlier-month fallback (BO before EDE, recency wins)
 *
 * Within the chosen tier, if multiple non-blank values exist, pick the row
 * with the latest `created_at` upload timestamp and flag `conflict: true`
 * with the rejected values surfaced in `conflict_values`.
 *
 * Sister to {@link mergeRecordsToMemberKeys} from #94 — same pattern (one
 * canonical entry point) but for descriptive fields rather than identity
 * merging. No materialization, no sidecar table, no
 * RECONCILE_LOGIC_VERSION bump (UI/export-only — same precedent as #90).
 */
import type { NormalizedRecord } from '../normalize';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ProfileSourceType = 'back_office' | 'ede' | 'commission' | null;

export interface ProfileFieldProvenance {
  /** Originating record's batch month, e.g. '2026-02' or '' if unknown. */
  source_month: string;
  /** Source CSV label (e.g. 'Jason Back Office', 'EDE Summary'). */
  source_file_label: string;
  /** Normalized record id (for drilldown / debugging). */
  record_id?: string;
}

export interface EnrichedField<T> {
  value: T | null;
  source_type: ProfileSourceType;
  source_month: string;
  source_file_label: string;
  /** True when ≥2 non-blank values were seen in the chosen tier. */
  conflict: boolean;
  /**
   * Rejected (non-winning) candidate values from the chosen tier. Empty when
   * there is no conflict. Each entry mirrors the winner's provenance shape.
   */
  conflict_values: Array<{
    value: T;
    source_type: ProfileSourceType;
    source_month: string;
    source_file_label: string;
  }>;
}

export interface MemberProfile {
  member_key: string;
  /** Best-known applicant name (BO-first; for split into First/Last). */
  applicant_name: EnrichedField<string>;
  address1: EnrichedField<string>;
  city: EnrichedField<string>;
  state: EnrichedField<string>;
  zip: EnrichedField<string>;
  dob: EnrichedField<string>;
  phone: EnrichedField<string>;
  email: EnrichedField<string>;
  /** FFM Application ID (EDE raw_json.ffmAppId). */
  ffm_id: EnrichedField<string>;
}

export interface BuildMemberProfileInput {
  /** All normalized records for the requested member_key, any batch / source. */
  records: NormalizedRecord[];
  /**
   * Reconciliation/Reference batch month ('YYYY-MM'). Used to bucket each
   * candidate into same-month / later / earlier tiers. When omitted we treat
   * every candidate as 'earlier' (no preferred month) — useful for tests.
   */
  referenceMonth?: string;
  /**
   * Map of batch_id → batch statement month ('YYYY-MM'). Used to derive each
   * record's month when the record itself doesn't carry it. Optional; when
   * a record's batch isn't in the map, we fall back to '' which behaves as
   * "earlier" (lowest tier).
   */
  batchMonthByBatchId?: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type EnrichedFieldName =
  | 'applicant_name'
  | 'address1'
  | 'city'
  | 'state'
  | 'zip'
  | 'dob'
  | 'phone'
  | 'email'
  | 'ffm_id';

interface Candidate {
  value: string;
  source_type: ProfileSourceType;
  source_month: string;
  source_file_label: string;
  /** Higher = preferred tier (5 = same-month BO, 1 = earlier fallback). */
  tier: number;
  /** Within-tier recency: ms epoch of source's batch month + created_at. */
  recencyKey: number;
  record_id?: string;
}

/** Extract a candidate string for the named enriched field from a record. */
function extractField(rec: NormalizedRecord & { id?: string }, field: EnrichedFieldName): string {
  const raw = (rec.raw_json || {}) as Record<string, any>;
  const isBO = rec.source_type === 'BACK_OFFICE';
  const isEDE = rec.source_type === 'EDE';
  const get = (s: any) => (s == null ? '' : String(s).trim());

  switch (field) {
    case 'applicant_name':
      return get(rec.applicant_name);
    case 'address1':
      if (isBO) return get(raw['Address']);
      if (isEDE) return get(rec.client_address_1 ?? raw['clientAddress1']);
      return '';
    case 'city':
      if (isBO) return get(raw['City']);
      if (isEDE) return get(rec.client_city ?? raw['clientCity']);
      return '';
    case 'state':
      if (isBO) return get(raw['State']);
      if (isEDE) return get(rec.client_state_full ?? raw['clientState'] ?? raw['state']);
      return '';
    case 'zip':
      if (isBO) return get(raw['ZIP Code'] ?? raw['Zip Code'] ?? raw['Zip']);
      if (isEDE) return get(rec.client_zip ?? raw['clientZipCode'] ?? raw['zipCode']);
      return '';
    case 'dob':
      return get(rec.dob);
    case 'phone':
      if (isBO) return get(raw['Member Phone Number'] ?? raw['Phone']);
      if (isEDE) return get(raw['phone']);
      return '';
    case 'email':
      if (isBO) return get(raw['Member Email'] ?? raw['Email']);
      if (isEDE) return get(raw['email']);
      return '';
    case 'ffm_id':
      // FFM application id only exists on EDE rows.
      if (isEDE) return get(raw['ffmAppId']);
      return '';
  }
}

function sourceTypeOf(rec: NormalizedRecord): ProfileSourceType {
  if (rec.source_type === 'BACK_OFFICE') return 'back_office';
  if (rec.source_type === 'EDE') return 'ede';
  if (rec.source_type === 'COMMISSION') return 'commission';
  return null;
}

/**
 * Tier for a candidate. Tier scale (higher wins):
 *   5 — Same-month BO
 *   4 — Later BO
 *   3 — Same-month EDE
 *   2 — Later EDE
 *   1 — Earlier fallback (BO or EDE before reference month)
 *   0 — Commission rows / unknown source (lowest priority)
 */
function tierFor(srcMonth: string, refMonth: string, srcType: ProfileSourceType): number {
  if (srcType === 'back_office') {
    if (refMonth && srcMonth && srcMonth === refMonth) return 5;
    if (refMonth && srcMonth && srcMonth > refMonth) return 4;
    return 1;
  }
  if (srcType === 'ede') {
    if (refMonth && srcMonth && srcMonth === refMonth) return 3;
    if (refMonth && srcMonth && srcMonth > refMonth) return 2;
    return 1;
  }
  // Commission rows do not participate in profile enrichment (reserved for
  // commission_writing_agent_id which is a row-level field, not enriched).
  return 0;
}

function recencyKey(srcMonth: string, createdAtIso: string | undefined): number {
  // Composite: month carries primary weight, created_at as tiebreak.
  // monthInt = YYYY*100 + MM, e.g. 2026-03 → 202603.
  let monthInt = 0;
  if (srcMonth && /^\d{4}-\d{2}/.test(srcMonth)) {
    monthInt = parseInt(srcMonth.slice(0, 4), 10) * 100 + parseInt(srcMonth.slice(5, 7), 10);
  }
  let createdMs = 0;
  if (createdAtIso) {
    const t = Date.parse(createdAtIso);
    if (!isNaN(t)) createdMs = t;
  }
  // Scale month so it dominates createdMs when present, but never overflows.
  return monthInt * 1e13 + createdMs;
}

function emptyEnriched<T>(): EnrichedField<T> {
  return {
    value: null,
    source_type: null,
    source_month: '',
    source_file_label: '',
    conflict: false,
    conflict_values: [],
  };
}

function pickWinner(candidates: Candidate[]): EnrichedField<string> {
  if (candidates.length === 0) return emptyEnriched<string>();

  // Find highest tier present.
  const topTier = candidates.reduce((m, c) => (c.tier > m ? c.tier : m), -1);
  const inTier = candidates.filter((c) => c.tier === topTier);

  // Sort within-tier by recencyKey desc.
  inTier.sort((a, b) => b.recencyKey - a.recencyKey);
  const winner = inTier[0];

  // Conflict detection: ≥2 distinct non-blank values in the chosen tier.
  const distinct = new Set(inTier.map((c) => c.value));
  const conflict = distinct.size > 1;
  const conflict_values: EnrichedField<string>['conflict_values'] = [];
  if (conflict) {
    const seen = new Set<string>([winner.value]);
    for (const c of inTier) {
      if (seen.has(c.value)) continue;
      seen.add(c.value);
      conflict_values.push({
        value: c.value,
        source_type: c.source_type,
        source_month: c.source_month,
        source_file_label: c.source_file_label,
      });
    }
  }

  return {
    value: winner.value,
    source_type: winner.source_type,
    source_month: winner.source_month,
    source_file_label: winner.source_file_label,
    conflict,
    conflict_values,
  };
}

function gatherCandidates(
  records: Array<NormalizedRecord & { id?: string; created_at?: string; batch_id?: string }>,
  field: EnrichedFieldName,
  refMonth: string,
  batchMonthByBatchId: Map<string, string> | undefined,
): Candidate[] {
  const out: Candidate[] = [];
  for (const r of records) {
    const value = extractField(r, field);
    if (!value) continue;
    const srcType = sourceTypeOf(r);
    const srcMonth = batchMonthByBatchId?.get((r as any).batch_id ?? '') ?? '';
    out.push({
      value,
      source_type: srcType,
      source_month: srcMonth,
      source_file_label: r.source_file_label || '',
      tier: tierFor(srcMonth, refMonth, srcType),
      recencyKey: recencyKey(srcMonth, (r as any).created_at),
      record_id: (r as any).id,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a {@link MemberProfile} for a single member_key from the supplied
 * records. Records may include rows from multiple batches (cross-batch
 * enrichment is the entire point of this helper). Computed live; safe to
 * call on every render.
 */
export function buildMemberProfile(
  memberKey: string,
  input: BuildMemberProfileInput,
): MemberProfile {
  const refMonth = input.referenceMonth ?? '';
  const fields: EnrichedFieldName[] = [
    'applicant_name', 'address1', 'city', 'state', 'zip',
    'dob', 'phone', 'email', 'ffm_id',
  ];
  const profile: any = { member_key: memberKey };
  for (const f of fields) {
    const cands = gatherCandidates(input.records, f, refMonth, input.batchMonthByBatchId);
    profile[f] = pickWinner(cands);
  }
  return profile as MemberProfile;
}

/**
 * Convenience: split a "First [Middle...] Last" name into first/last using
 * the naive "split on last space" rule called out in the #104 spec
 * ('Jane Marie Smith' → First='Jane Marie', Last='Smith'). Returns
 * {first:'', last:''} when the name is blank.
 */
export function splitNameLastSpace(name: string | null | undefined): { first: string; last: string } {
  const s = (name ?? '').trim();
  if (!s) return { first: '', last: '' };
  const idx = s.lastIndexOf(' ');
  if (idx < 0) return { first: '', last: s };
  return { first: s.slice(0, idx).trim(), last: s.slice(idx + 1).trim() };
}

/**
 * Assemble a single-line address from enriched parts: 'Address 1, City, State ZIP'.
 * Skips blank components and trims doubled separators.
 */
export function assembleAddressLine(opts: {
  address1?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}): string {
  const a = (opts.address1 ?? '').trim();
  const c = (opts.city ?? '').trim();
  const s = (opts.state ?? '').trim();
  const z = (opts.zip ?? '').trim();
  const stateZip = [s, z].filter(Boolean).join(' ');
  return [a, c, stateZip].filter(Boolean).join(', ');
}
