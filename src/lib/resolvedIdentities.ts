/**
 * Cross-batch identity resolution (sidecar).
 *
 * Concept: when Jan EDE has an applicant with blank `issuerSubscriberId` but
 * Feb EDE / a later commission file reveals the U-id, we want Jan's matching
 * to benefit from that knowledge WITHOUT mutating Jan's normalized record.
 *
 * Originals stay byte-for-byte intact; resolved values live in the
 * `resolved_identities` sidecar table and are layered in at READ time
 * (Union-Find, Member Timeline display, Not-in-BO drilldown, Commission
 * match) — only when the record's own field is blank.
 *
 * ONLY these three fields are resolved:
 *   - issuer_subscriber_id
 *   - issuer_policy_id
 *   - exchange_policy_id
 *
 * Match keys (preferred order):
 *   1. ffmAppId       (from raw_json on EDE rows; never blank in practice)
 *   2. exchangeSubscriberId (fallback for commission rows that lack ffmAppId)
 *
 * Source priority for picking the winning value:
 *   commission_statement > back_office > later_ede > earlier_ede
 *   tiebreak: more-recent batch statement_month, then created_at.
 *
 * The resolver is idempotent — running twice produces the same upserts.
 */
import { supabase } from '@/integrations/supabase/client';
import { cleanId } from './normalize';

export type ResolvedSourceKind = 'commission' | 'back_office' | 'ede';
export type MatchKeyType = 'ffmAppId' | 'exchangeSubscriberId';

export interface ResolvedIdentityRow {
  id: string;
  match_key_type: MatchKeyType;
  match_key_value: string;
  resolved_issuer_subscriber_id: string | null;
  resolved_issuer_policy_id: string | null;
  resolved_exchange_policy_id: string | null;
  source_batch_id: string | null;
  source_file_id: string | null;
  source_kind: ResolvedSourceKind | null;
  resolved_at: string;
  conflict_count: number;
  conflict_details: any | null;
  reviewed_at: string | null;
  /** Joined client-side from upload_batches.statement_month — 'YYYY-MM' or ''. */
  source_batch_month?: string;
}

export interface ResolverRunSummary {
  resolvedIssuerIds: number;
  resolvedIssuerPolicyIds: number;
  resolvedExchangePolicyIds: number;
  sourceRecordsScanned: number;
  batchesScanned: number;
  groupCount: number;
  conflictCount: number;
  upsertCount: number;
}

interface IdField {
  field: 'issuer_subscriber_id' | 'issuer_policy_id' | 'exchange_policy_id';
  value: string;
  sourcePriority: number;
  batchMonth: string;
  createdAt: string;
  batchId: string | null;
  fileId: string | null;
  sourceKind: ResolvedSourceKind;
}

/** Source priority numeric — higher wins. */
function sourceKindFor(record: any, batchMonthByBatchId: Map<string, string>, currentBatchEffMonth: string): { kind: ResolvedSourceKind; priority: number } {
  const t = String(record.source_type || '').toUpperCase();
  if (t === 'COMMISSION') return { kind: 'commission', priority: 4 };
  if (t === 'BACK_OFFICE') return { kind: 'back_office', priority: 3 };
  // EDE: split by month — later EDE outranks earlier EDE.
  // We score it as 2 (later) vs 1 (earlier) by comparing the row's batch
  // statement_month to the latest batch month seen.
  const m = batchMonthByBatchId.get(record.batch_id) || '';
  if (m && m >= currentBatchEffMonth) return { kind: 'ede', priority: 2 };
  return { kind: 'ede', priority: 1 };
}

function pickField(candidates: IdField[]): IdField | null {
  if (candidates.length === 0) return null;
  return candidates.slice().sort((a, b) => {
    if (a.sourcePriority !== b.sourcePriority) return b.sourcePriority - a.sourcePriority;
    if (a.batchMonth !== b.batchMonth) return a.batchMonth < b.batchMonth ? 1 : -1;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return 0;
  })[0];
}

/** Conflict = ≥2 distinct non-blank values for the same field. */
function detectConflict(candidates: IdField[]): { winner: IdField | null; losers: IdField[]; conflict: boolean } {
  if (candidates.length === 0) return { winner: null, losers: [], conflict: false };
  const winner = pickField(candidates)!;
  const losers = candidates.filter(c => c.value !== winner.value);
  return { winner, losers, conflict: losers.length > 0 };
}

/**
 * Scan ALL normalized records across ALL batches; group by ffmAppId
 * (with exchangeSubscriberId fallback); pick winning IDs per group;
 * upsert into resolved_identities. Idempotent.
 */
export async function runIdentityResolution(): Promise<ResolverRunSummary> {
  // 1. Pull every non-superseded normalized record + every batch's
  //    statement_month for priority comparison.
  const [records, batches] = await Promise.all([
    fetchAllNormalizedRecordsForResolver(),
    fetchAllBatchesWithMonth(),
  ]);

  const batchMonthByBatchId = new Map<string, string>();
  for (const b of batches) {
    const m = b.statement_month ? String(b.statement_month).substring(0, 7) : '';
    batchMonthByBatchId.set(b.id, m);
  }
  // The "later EDE vs earlier EDE" split uses the most recent batch month
  // we've seen; everything at-or-after counts as "later".
  const allMonths = Array.from(batchMonthByBatchId.values()).filter(Boolean).sort();
  const latestMonth = allMonths.length > 0 ? allMonths[allMonths.length - 1] : '';

  // 2. Build groups keyed by ffmAppId, then exchangeSubscriberId fallback.
  const groups = new Map<string, { keyType: MatchKeyType; keyValue: string; records: any[] }>();

  for (const r of records) {
    const raw = (r.raw_json || {}) as Record<string, any>;
    const ffm = String(raw.ffmAppId ?? '').trim();
    const exsub = String(r.exchange_subscriber_id ?? raw.exchangeSubscriberId ?? '').trim();
    let keyType: MatchKeyType | null = null;
    let keyValue = '';
    if (ffm) {
      keyType = 'ffmAppId';
      keyValue = ffm;
    } else if (exsub) {
      keyType = 'exchangeSubscriberId';
      keyValue = cleanId(exsub);
    }
    if (!keyType || !keyValue) continue;
    const groupKey = `${keyType}:${keyValue}`;
    let g = groups.get(groupKey);
    if (!g) {
      g = { keyType, keyValue, records: [] };
      groups.set(groupKey, g);
    }
    g.records.push(r);
  }

  // 3. For each group, collect candidate values per field with provenance.
  type GroupResolution = {
    keyType: MatchKeyType;
    keyValue: string;
    issuerSub: { winner: IdField | null; losers: IdField[]; conflict: boolean };
    issuerPol: { winner: IdField | null; losers: IdField[]; conflict: boolean };
    exchangePol: { winner: IdField | null; losers: IdField[]; conflict: boolean };
  };
  const resolutions: GroupResolution[] = [];

  for (const g of groups.values()) {
    if (g.records.length < 2) continue; // Single-batch members skip silently
    const issuerSubCands: IdField[] = [];
    const issuerPolCands: IdField[] = [];
    const exchangePolCands: IdField[] = [];
    for (const r of g.records) {
      const { kind, priority } = sourceKindFor(r, batchMonthByBatchId, latestMonth);
      const batchMonth = batchMonthByBatchId.get(r.batch_id) || '';
      const createdAt = r.created_at || '';
      const baseProv = { batchMonth, createdAt, batchId: r.batch_id || null, fileId: r.uploaded_file_id || null, sourceKind: kind, sourcePriority: priority };
      const isid = String(r.issuer_subscriber_id ?? '').trim();
      if (isid) issuerSubCands.push({ field: 'issuer_subscriber_id', value: isid, ...baseProv });
      const ipid = String(r.issuer_policy_id ?? '').trim();
      if (ipid) issuerPolCands.push({ field: 'issuer_policy_id', value: ipid, ...baseProv });
      const epid = String(r.exchange_policy_id ?? '').trim();
      if (epid) exchangePolCands.push({ field: 'exchange_policy_id', value: epid, ...baseProv });
    }
    const issuerSub = detectConflict(issuerSubCands);
    const issuerPol = detectConflict(issuerPolCands);
    const exchangePol = detectConflict(exchangePolCands);
    if (!issuerSub.winner && !issuerPol.winner && !exchangePol.winner) continue;
    resolutions.push({
      keyType: g.keyType,
      keyValue: g.keyValue,
      issuerSub,
      issuerPol,
      exchangePol,
    });
  }

  // 4. Upsert (idempotent on UNIQUE (match_key_type, match_key_value)).
  let resolvedIssuerIds = 0, resolvedIssuerPolicyIds = 0, resolvedExchangePolicyIds = 0;
  let conflictCount = 0;
  const rows = resolutions.map(g => {
    const conflicts: any[] = [];
    if (g.issuerSub.conflict) {
      conflictCount++;
      conflicts.push({ field: 'issuer_subscriber_id', winner: serializeField(g.issuerSub.winner!), losers: g.issuerSub.losers.map(serializeField) });
    }
    if (g.issuerPol.conflict) {
      conflictCount++;
      conflicts.push({ field: 'issuer_policy_id', winner: serializeField(g.issuerPol.winner!), losers: g.issuerPol.losers.map(serializeField) });
    }
    if (g.exchangePol.conflict) {
      conflictCount++;
      conflicts.push({ field: 'exchange_policy_id', winner: serializeField(g.exchangePol.winner!), losers: g.exchangePol.losers.map(serializeField) });
    }
    if (g.issuerSub.winner) resolvedIssuerIds++;
    if (g.issuerPol.winner) resolvedIssuerPolicyIds++;
    if (g.exchangePol.winner) resolvedExchangePolicyIds++;
    // Source provenance points to whichever winner exists (prefer issuerSub).
    const provSrc = g.issuerSub.winner || g.issuerPol.winner || g.exchangePol.winner!;
    return {
      match_key_type: g.keyType,
      match_key_value: g.keyValue,
      resolved_issuer_subscriber_id: g.issuerSub.winner?.value ?? null,
      resolved_issuer_policy_id: g.issuerPol.winner?.value ?? null,
      resolved_exchange_policy_id: g.exchangePol.winner?.value ?? null,
      source_batch_id: provSrc.batchId,
      source_file_id: provSrc.fileId,
      source_kind: provSrc.sourceKind,
      resolved_at: new Date().toISOString(),
      conflict_count: conflicts.length,
      conflict_details: conflicts.length > 0 ? conflicts : null,
    };
  });

  // Upsert in chunks. The UNIQUE (match_key_type, match_key_value) makes this
  // idempotent — re-running produces the same rows.
  let upsertCount = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await (supabase as any)
      .from('resolved_identities')
      .upsert(chunk, { onConflict: 'match_key_type,match_key_value' });
    if (error) throw error;
    upsertCount += chunk.length;
  }

  return {
    resolvedIssuerIds,
    resolvedIssuerPolicyIds,
    resolvedExchangePolicyIds,
    sourceRecordsScanned: records.length,
    batchesScanned: batches.length,
    groupCount: groups.size,
    conflictCount,
    upsertCount,
  };
}

function serializeField(f: IdField) {
  return {
    value: f.value,
    source_kind: f.sourceKind,
    batch_month: f.batchMonth,
    batch_id: f.batchId,
    file_id: f.fileId,
  };
}

async function fetchAllBatchesWithMonth(): Promise<Array<{ id: string; statement_month: string | null }>> {
  const { data, error } = await supabase
    .from('upload_batches')
    .select('id, statement_month');
  if (error) throw error;
  return (data || []).map((b: any) => ({ id: b.id, statement_month: b.statement_month }));
}

/** Page through every non-superseded normalized record across all batches. */
async function fetchAllNormalizedRecordsForResolver(): Promise<any[]> {
  const all: any[] = [];
  let from = 0;
  const pageSize = 1000;
  // Trim payload — we only need the columns the resolver looks at.
  const cols = 'id,batch_id,uploaded_file_id,source_type,issuer_subscriber_id,issuer_policy_id,exchange_subscriber_id,exchange_policy_id,raw_json,created_at';
  while (true) {
    const { data, error } = await supabase
      .from('normalized_records')
      .select(cols)
      .is('superseded_at', null)
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

// ============================================================================
// Read-through API: load the sidecar table and apply it to records on demand.
// ============================================================================

export interface ResolverIndex {
  byFfmApp: Map<string, ResolvedIdentityRow>;
  byExchangeSub: Map<string, ResolvedIdentityRow>;
  /** Total rows in the sidecar (info badge in UI). */
  totalRows: number;
}

const EMPTY_INDEX: ResolverIndex = {
  byFfmApp: new Map(),
  byExchangeSub: new Map(),
  totalRows: 0,
};

let _cachedIndex: ResolverIndex | null = null;
let _cacheLoadedAt = 0;
const CACHE_TTL_MS = 60_000;

/** Drop the cached resolver index — call after a successful resolver run. */
export function invalidateResolverCache(): void {
  _cachedIndex = null;
  _cacheLoadedAt = 0;
}

/** Load resolved_identities into an in-memory lookup index (cached). */
export async function loadResolverIndex(force = false): Promise<ResolverIndex> {
  if (!force && _cachedIndex && Date.now() - _cacheLoadedAt < CACHE_TTL_MS) {
    return _cachedIndex;
  }
  const all: any[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await (supabase as any)
      .from('resolved_identities')
      .select('*')
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) {
      // Sidecar table may not exist yet (very first run) — return empty.
      return EMPTY_INDEX;
    }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  // Join statement_month from upload_batches so the UI badge tooltip can show
  // "Resolved from ede Feb 2026" without a second round-trip per badge.
  const batchIds = Array.from(new Set(all.map(r => r.source_batch_id).filter(Boolean)));
  const monthByBatch = new Map<string, string>();
  if (batchIds.length > 0) {
    const { data: batchRows } = await supabase
      .from('upload_batches')
      .select('id, statement_month')
      .in('id', batchIds as string[]);
    for (const b of (batchRows || []) as any[]) {
      monthByBatch.set(b.id, b.statement_month ? String(b.statement_month).substring(0, 7) : '');
    }
  }
  const idx: ResolverIndex = {
    byFfmApp: new Map(),
    byExchangeSub: new Map(),
    totalRows: all.length,
  };
  for (const r of all) {
    const enriched: ResolvedIdentityRow = {
      ...r,
      source_batch_month: r.source_batch_id ? monthByBatch.get(r.source_batch_id) ?? '' : '',
    };
    if (enriched.match_key_type === 'ffmAppId') idx.byFfmApp.set(enriched.match_key_value, enriched);
    else if (enriched.match_key_type === 'exchangeSubscriberId') idx.byExchangeSub.set(enriched.match_key_value, enriched);
  }
  _cachedIndex = idx;
  _cacheLoadedAt = Date.now();
  return idx;
}

/**
 * Find the resolved_identities row that applies to a record (if any),
 * preferring ffmAppId then falling back to exchangeSubscriberId.
 */
export function lookupResolved(record: any, idx: ResolverIndex): ResolvedIdentityRow | null {
  if (!idx || idx.totalRows === 0) return null;
  const raw = (record.raw_json || {}) as Record<string, any>;
  const ffm = String(raw.ffmAppId ?? '').trim();
  if (ffm) {
    const hit = idx.byFfmApp.get(ffm);
    if (hit) return hit;
  }
  const exsub = String(record.exchange_subscriber_id ?? raw.exchangeSubscriberId ?? '').trim();
  if (exsub) {
    const cleaned = cleanId(exsub);
    const hit = idx.byExchangeSub.get(cleaned) || idx.byExchangeSub.get(exsub);
    if (hit) return hit;
  }
  return null;
}

/**
 * Apply resolved values to a record's three ID fields IF the record's own
 * field is blank. Returns a NEW object — never mutates the input. Also
 * returns a `_resolved_fields` map indicating which fields were filled in
 * from the sidecar (drives the blue "resolved" badge in the UI).
 */
export function applyResolvedToRecord<T extends Record<string, any>>(
  record: T,
  idx: ResolverIndex,
): T & { _resolved_fields?: Record<string, ResolvedIdentityRow> } {
  const hit = lookupResolved(record, idx);
  if (!hit) return record;
  const out: any = { ...record };
  const resolvedFields: Record<string, ResolvedIdentityRow> = {};
  if (!String(record.issuer_subscriber_id ?? '').trim() && hit.resolved_issuer_subscriber_id) {
    out.issuer_subscriber_id = hit.resolved_issuer_subscriber_id;
    resolvedFields.issuer_subscriber_id = hit;
  }
  if (!String(record.issuer_policy_id ?? '').trim() && hit.resolved_issuer_policy_id) {
    out.issuer_policy_id = hit.resolved_issuer_policy_id;
    resolvedFields.issuer_policy_id = hit;
  }
  if (!String(record.exchange_policy_id ?? '').trim() && hit.resolved_exchange_policy_id) {
    out.exchange_policy_id = hit.resolved_exchange_policy_id;
    resolvedFields.exchange_policy_id = hit;
  }
  if (Object.keys(resolvedFields).length > 0) {
    out._resolved_fields = resolvedFields;
  }
  return out;
}

/**
 * Apply resolved values to an array of records. Cheap — same one-pass shape
 * as applyResolvedToRecord but spares callers the per-row hit overhead when
 * the sidecar is empty.
 */
export function applyResolvedToRecords<T extends Record<string, any>>(
  records: T[],
  idx: ResolverIndex,
): Array<T & { _resolved_fields?: Record<string, ResolvedIdentityRow> }> {
  if (!idx || idx.totalRows === 0) return records as any;
  return records.map(r => applyResolvedToRecord(r, idx));
}

/** Fetch all conflict rows for the Exceptions page. */
export async function getResolverConflicts(): Promise<ResolvedIdentityRow[]> {
  const { data, error } = await (supabase as any)
    .from('resolved_identities')
    .select('*')
    .gt('conflict_count', 0)
    .order('resolved_at', { ascending: false });
  if (error) return [];
  return (data || []) as ResolvedIdentityRow[];
}

/** Mark a conflict reviewed (sets reviewed_at). */
export async function markResolverConflictReviewed(id: string): Promise<void> {
  const { error } = await (supabase as any)
    .from('resolved_identities')
    .update({ reviewed_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}
