/**
 * #116 — Keyset pagination for getNormalizedRecords / getAllNormalizedRecords.
 *
 * The previous implementation used OFFSET pagination via .range(from, to)
 * with page size 1000. On a Feb-sized batch (~7.3k rows with `select=*`
 * including the heavy raw_json jsonb payload) this hit PG statement_timeout
 * (57014) in the 4000–5999 offset band and surfaced as a 500 from PostgREST
 * mid-rebuild.
 *
 * The new implementation:
 *   - orders by id asc
 *   - pages with `where id > lastId limit 500`
 *   - terminates when a page returns fewer than the page size
 *
 * Tests pinned here:
 *   1. All rows returned, no duplicates, no misses.
 *   2. Page-boundary correctness when total is an exact multiple of page size.
 *   3. raw_json round-trips intact (we explicitly do NOT exclude raw_json —
 *      reconcile/classifier/aorPicker/expectedEde all read fields from it).
 *   4. The active predicate (staging_status='active' AND superseded_at IS NULL)
 *      is applied — staged rows from an in-flight rebuild are not returned.
 *   5. Pagination uses keyset (`gt('id', ...)`) rather than range/OFFSET on
 *      every page after the first.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

type Row = {
  id: string;
  batch_id: string;
  staging_status: string;
  superseded_at: string | null;
  raw_json: any;
  source_type?: string;
};

let allRows: Row[] = [];
let queryLog: Array<{ filters: Record<string, any>; gtId: string | null; limit: number | null }> = [];

function makeBuilder() {
  const filters: Record<string, any> = {};
  let gtId: string | null = null;
  let limitN: number | null = null;
  let order: { col: string; asc: boolean } | null = null;

  const builder: any = {
    select: (_cols: string) => builder,
    eq: (col: string, val: any) => { filters[`eq:${col}`] = val; return builder; },
    is: (col: string, val: any) => { filters[`is:${col}`] = val; return builder; },
    gt: (col: string, val: any) => { if (col === 'id') gtId = val; return builder; },
    order: (col: string, opts: any) => { order = { col, asc: !!opts?.ascending }; return builder; },
    limit: (n: number) => { limitN = n; return builder; },
    then: (resolve: any, reject: any) => {
      try {
        queryLog.push({ filters: { ...filters }, gtId, limit: limitN });
        let rows = allRows.slice();
        if ('eq:staging_status' in filters) rows = rows.filter(r => r.staging_status === filters['eq:staging_status']);
        if ('is:superseded_at' in filters && filters['is:superseded_at'] === null) rows = rows.filter(r => r.superseded_at === null);
        if ('eq:batch_id' in filters) rows = rows.filter(r => r.batch_id === filters['eq:batch_id']);
        if (order && order.col === 'id') rows.sort((a, b) => order!.asc ? a.id.localeCompare(b.id) : b.id.localeCompare(a.id));
        if (gtId !== null) rows = rows.filter(r => r.id > gtId!);
        if (limitN !== null) rows = rows.slice(0, limitN);
        resolve({ data: rows, error: null });
      } catch (err) {
        if (reject) reject(err); else resolve({ data: null, error: err });
      }
    },
  };
  return builder;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (_table: string) => makeBuilder(),
  },
}));

import { getNormalizedRecords, getAllNormalizedRecords } from '@/lib/persistence';

// id strings are zero-padded so lexicographic order matches numeric order.
function makeRow(n: number, overrides: Partial<Row> = {}): Row {
  return {
    id: `id-${String(n).padStart(6, '0')}`,
    batch_id: 'batch-A',
    staging_status: 'active',
    superseded_at: null,
    raw_json: { idx: n, currentPolicyAOR: `Agent ${n}` },
    source_type: 'EDE',
    ...overrides,
  };
}

beforeEach(() => {
  allRows = [];
  queryLog = [];
});

describe('getNormalizedRecords — keyset pagination (#116)', () => {
  it('returns all rows in order, no duplicates, no misses across pages', async () => {
    // 7,293 ≈ Feb 2026 batch size. With page size 500 → 15 pages.
    const total = 7293;
    allRows = Array.from({ length: total }, (_, i) => makeRow(i + 1));

    const result = await getNormalizedRecords('batch-A');

    expect(result).toHaveLength(total);
    const ids = result.map((r: any) => r.id);
    expect(new Set(ids).size).toBe(total); // no duplicates
    // Order preserved
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i] > ids[i - 1]).toBe(true);
    }
    // Spot check first/last
    expect(ids[0]).toBe('id-000001');
    expect(ids[total - 1]).toBe(`id-${String(total).padStart(6, '0')}`);
  });

  it('handles total == exact multiple of page size without hanging or losing the trailing page', async () => {
    // 1500 = exactly 3 pages of 500. Tricky case: page 3 returns 500 rows
    // (full page), page 4 must return 0 to terminate.
    allRows = Array.from({ length: 1500 }, (_, i) => makeRow(i + 1));
    const result = await getNormalizedRecords('batch-A');
    expect(result).toHaveLength(1500);
  });

  it('uses keyset pagination (gt(id, lastId)) on every page after the first, with limit 500', async () => {
    allRows = Array.from({ length: 1200 }, (_, i) => makeRow(i + 1));
    await getNormalizedRecords('batch-A');

    // 1200 rows / 500 per page = 3 pages: [500, 500, 200]. After 200 < 500 we stop.
    expect(queryLog.length).toBe(3);
    // Every page requests limit 500 (NOT range/offset).
    queryLog.forEach(q => expect(q.limit).toBe(500));
    // Page 1: no gt filter (lastId === null).
    expect(queryLog[0].gtId).toBeNull();
    // Page 2 & 3: gt filter set to last id of previous page.
    expect(queryLog[1].gtId).toBe('id-000500');
    expect(queryLog[2].gtId).toBe('id-001000');
  });

  it('preserves raw_json on every returned row (reconcile depends on it)', async () => {
    allRows = Array.from({ length: 750 }, (_, i) => makeRow(i + 1));
    const result = await getNormalizedRecords('batch-A');
    expect(result).toHaveLength(750);
    // Every row has its raw_json intact, including currentPolicyAOR which
    // classifier.ts/aorPicker.ts/reconcile.ts read directly.
    result.forEach((r: any, i: number) => {
      expect(r.raw_json.idx).toBe(i + 1);
      expect(r.raw_json.currentPolicyAOR).toBe(`Agent ${i + 1}`);
    });
  });

  it('applies the canonical active predicate (excludes staged + superseded rows)', async () => {
    allRows = [
      makeRow(1),
      makeRow(2, { staging_status: 'staged' }),                                    // in-flight rebuild
      makeRow(3),
      makeRow(4, { superseded_at: '2026-01-01T00:00:00Z' }),                       // superseded
      makeRow(5),
      makeRow(6, { batch_id: 'batch-OTHER' }),                                     // wrong batch
    ];
    const result = await getNormalizedRecords('batch-A');
    expect(result.map((r: any) => r.id)).toEqual(['id-000001', 'id-000003', 'id-000005']);
  });

  it('returns empty array when the batch has no rows (no infinite loop)', async () => {
    allRows = [];
    const result = await getNormalizedRecords('batch-A');
    expect(result).toEqual([]);
    expect(queryLog).toHaveLength(1); // single empty page, then stop
  });
});

describe('getAllNormalizedRecords — keyset pagination across batches', () => {
  it('returns rows from every batch, ordered by id, no dups/misses', async () => {
    allRows = [
      ...Array.from({ length: 600 }, (_, i) => makeRow(i + 1, { batch_id: 'b-A' })),
      ...Array.from({ length: 600 }, (_, i) => makeRow(i + 1001, { batch_id: 'b-B' })),
    ];
    const result = await getAllNormalizedRecords();
    expect(result).toHaveLength(1200);
    const batches = new Set(result.map((r: any) => r.batch_id));
    expect(batches).toEqual(new Set(['b-A', 'b-B']));
  });

  it('omits the batch_id filter (no eq:batch_id in any page query)', async () => {
    allRows = Array.from({ length: 200 }, (_, i) => makeRow(i + 1));
    await getAllNormalizedRecords();
    queryLog.forEach(q => {
      expect(q.filters).not.toHaveProperty('eq:batch_id');
      // But active predicate IS still applied:
      expect(q.filters['eq:staging_status']).toBe('active');
      expect(q.filters['is:superseded_at']).toBeNull();
    });
  });
});
