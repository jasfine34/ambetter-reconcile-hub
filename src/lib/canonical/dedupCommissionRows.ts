/**
 * Canonical read-side commission deduplication.
 *
 * The May commission statement wholesale re-listed April's transactions
 * (1,565 exact duplicate groups, 1,495 members, +$38,054 inflation). This
 * helper collapses exact duplicates so every downstream consumer sees each
 * transaction once. Raw uploaded rows are never mutated; this is read-side.
 *
 * Dedup key (FULL exact tuple — never TXN alone):
 *   carrier | pay_entity | transaction_id | commission_amount
 *   | paid_to_date | months_paid
 *
 * transaction_id is extracted from raw_json['Transaction ID'] — there is no
 * typed column. Rows with no TXN id are never deduped.
 *
 * Survivor (in order):
 *   1) earliest valid batch statement month (via batchMonthByBatchId)
 *   2) earliest created_at
 *   3) stable row id / source order
 *
 * If a group's batch_id can't resolve to a statement month, the group is
 * passed through untouched and surfaced via `unresolvedBatchMonthIds`. We
 * never silently tie-break by UUID when the statement month is missing.
 */
import type { NormalizedRecord } from '@/lib/normalize';

export type DedupInputRow = NormalizedRecord & {
  id?: string;
  batch_id?: string;
  created_at?: string;
};

export interface DedupOptions {
  /** Map from batch_id → statement month key (e.g. "2026-04"). */
  batchMonthByBatchId?: Record<string, string | null | undefined>;
}

export interface DroppedDuplicate {
  key: string;
  survivor_id: string | null;
  dropped_id: string | null;
  dropped_batch_id: string | null;
  dropped_created_at: string | null;
}

export interface DedupResult<T extends DedupInputRow> {
  rows: T[];
  dropped: DroppedDuplicate[];
  droppedCount: number;
  groupCount: number;
  unresolvedBatchMonthIds: string[];
}

function txnId(row: DedupInputRow): string {
  const raw = (row.raw_json ?? {}) as Record<string, unknown>;
  const v = raw['Transaction ID'];
  if (v == null) return '';
  return String(v).trim();
}

function dedupKey(row: DedupInputRow, txn: string): string {
  return [
    row.carrier ?? '',
    row.pay_entity ?? '',
    txn,
    row.commission_amount == null ? '' : String(row.commission_amount),
    row.paid_to_date ?? '',
    row.months_paid == null ? '' : String(row.months_paid),
  ].join('|');
}

/**
 * Compare two rows for survivor selection. Negative = a wins.
 * Returns null if the month is unresolved for either side (caller must
 * surface diagnostic and pass the group through untouched).
 */
function compareSurvivor(
  a: DedupInputRow,
  b: DedupInputRow,
  monthOf: (batchId: string | undefined) => string | undefined,
): number | null {
  const ma = monthOf(a.batch_id);
  const mb = monthOf(b.batch_id);
  if (!ma || !mb) return null;
  if (ma !== mb) return ma < mb ? -1 : 1;
  const ca = a.created_at ?? '';
  const cb = b.created_at ?? '';
  if (ca !== cb) return ca < cb ? -1 : 1;
  const ia = a.id ?? '';
  const ib = b.id ?? '';
  if (ia !== ib) return ia < ib ? -1 : 1;
  return 0;
}

export function dedupCommissionRows<T extends DedupInputRow>(
  records: ReadonlyArray<T>,
  options: DedupOptions = {},
): DedupResult<T> {
  const batchMonthByBatchId = options.batchMonthByBatchId ?? {};
  const monthOf = (batchId: string | undefined): string | undefined => {
    if (!batchId) return undefined;
    const v = batchMonthByBatchId[batchId];
    return v == null || v === '' ? undefined : v;
  };

  // Group commission rows by key; pass-through everything else.
  const groups = new Map<string, { indices: number[] }>();
  const passThroughIdx: number[] = [];
  const dedupableIdx: number[] = [];

  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.source_type !== 'COMMISSION') {
      passThroughIdx.push(i);
      continue;
    }
    const txn = txnId(r);
    if (!txn) {
      // Never dedup rows without a transaction ID.
      passThroughIdx.push(i);
      continue;
    }
    const key = dedupKey(r, txn);
    let g = groups.get(key);
    if (!g) {
      g = { indices: [] };
      groups.set(key, g);
    }
    g.indices.push(i);
    dedupableIdx.push(i);
  }

  const keepIdx = new Set<number>(passThroughIdx);
  const dropped: DroppedDuplicate[] = [];
  const unresolvedBatchMonthIds = new Set<string>();
  let groupCount = 0;

  for (const [key, g] of groups) {
    if (g.indices.length === 1) {
      keepIdx.add(g.indices[0]);
      continue;
    }
    groupCount++;

    // Check resolvability for every member of the group.
    const unresolved = g.indices.filter((i) => {
      const bid = records[i].batch_id;
      return !bid || !monthOf(bid);
    });
    if (unresolved.length > 0) {
      // Pass group through untouched; surface diagnostic.
      for (const i of g.indices) {
        keepIdx.add(i);
        const bid = records[i].batch_id;
        if (bid) unresolvedBatchMonthIds.add(bid);
      }
      continue;
    }

    // Pick survivor.
    let survivorIdx = g.indices[0];
    for (let k = 1; k < g.indices.length; k++) {
      const cand = g.indices[k];
      const cmp = compareSurvivor(records[cand], records[survivorIdx], monthOf);
      if (cmp != null && cmp < 0) survivorIdx = cand;
    }
    keepIdx.add(survivorIdx);
    for (const i of g.indices) {
      if (i === survivorIdx) continue;
      dropped.push({
        key,
        survivor_id: records[survivorIdx].id ?? null,
        dropped_id: records[i].id ?? null,
        dropped_batch_id: records[i].batch_id ?? null,
        dropped_created_at: records[i].created_at ?? null,
      });
    }
  }

  const rows: T[] = [];
  for (let i = 0; i < records.length; i++) {
    if (keepIdx.has(i)) rows.push(records[i]);
  }

  return {
    rows,
    dropped,
    droppedCount: dropped.length,
    groupCount,
    unresolvedBatchMonthIds: Array.from(unresolvedBatchMonthIds),
  };
}
