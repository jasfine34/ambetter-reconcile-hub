/**
 * Path B query-shape regression tests for getNormalizedRecordsByMemberKeys.
 *
 * The (member_key, id) WHERE active partial index relies on this exact
 * query shape (IN-list + active predicate + keyset by id, projected list
 * including raw_json). Any drift would silently regress the MCE timeout fix.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

type Row = { id: string; member_key: string; staging_status: string; superseded_at: string | null; raw_json: any };

let allRows: Row[] = [];
let queryLog: Array<{
  selectArg: string | null;
  filters: Record<string, any>;
  inCol: string | null;
  inList: any[] | null;
  gtId: string | null;
  limit: number | null;
  order: { col: string; asc: boolean } | null;
  rangeCalled: boolean;
}> = [];

function makeBuilder() {
  const entry = {
    selectArg: null as string | null,
    filters: {} as Record<string, any>,
    inCol: null as string | null,
    inList: null as any[] | null,
    gtId: null as string | null,
    limit: null as number | null,
    order: null as { col: string; asc: boolean } | null,
    rangeCalled: false,
  };
  const builder: any = {
    select: (cols: string) => { entry.selectArg = cols; return builder; },
    eq: (col: string, val: any) => { entry.filters[`eq:${col}`] = val; return builder; },
    is: (col: string, val: any) => { entry.filters[`is:${col}`] = val; return builder; },
    in: (col: string, list: any[]) => { entry.inCol = col; entry.inList = list; return builder; },
    gt: (col: string, val: any) => { if (col === 'id') entry.gtId = val; return builder; },
    order: (col: string, opts: any) => { entry.order = { col, asc: !!opts?.ascending }; return builder; },
    limit: (n: number) => { entry.limit = n; return builder; },
    range: () => { entry.rangeCalled = true; return builder; },
    then: (resolve: any) => {
      queryLog.push({ ...entry });
      let rows = allRows.slice();
      if (entry.filters['eq:staging_status']) rows = rows.filter(r => r.staging_status === entry.filters['eq:staging_status']);
      if ('is:superseded_at' in entry.filters && entry.filters['is:superseded_at'] === null) rows = rows.filter(r => r.superseded_at === null);
      if (entry.inCol === 'member_key' && entry.inList) rows = rows.filter(r => entry.inList!.includes(r.member_key));
      if (entry.order?.col === 'id') rows.sort((a, b) => entry.order!.asc ? a.id.localeCompare(b.id) : b.id.localeCompare(a.id));
      if (entry.gtId) rows = rows.filter(r => r.id > entry.gtId!);
      if (entry.limit) rows = rows.slice(0, entry.limit);
      resolve({ data: rows, error: null });
    },
  };
  return builder;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: (_t: string) => makeBuilder() },
}));

import { getNormalizedRecordsByMemberKeys } from '@/lib/persistence';

beforeEach(() => {
  allRows = [];
  queryLog = [];
});

describe('getNormalizedRecordsByMemberKeys — query shape', () => {
  it('uses active predicate + IN(member_key) + keyset by id (no range/offset)', async () => {
    allRows = Array.from({ length: 10 }, (_, i) => ({
      id: `id-${String(i + 1).padStart(6, '0')}`,
      member_key: `mk-${i + 1}`,
      staging_status: 'active',
      superseded_at: null,
      raw_json: { idx: i + 1 },
    }));
    await getNormalizedRecordsByMemberKeys(['mk-1', 'mk-2']);
    expect(queryLog.length).toBeGreaterThan(0);
    const q = queryLog[0];
    expect(q.filters['eq:staging_status']).toBe('active');
    expect(q.filters['is:superseded_at']).toBeNull();
    expect(q.inCol).toBe('member_key');
    expect(q.order).toEqual({ col: 'id', asc: true });
    expect(q.limit).toBe(200);
    queryLog.forEach(p => expect(p.rangeCalled).toBe(false));
  });

  it('projects raw_json in the select(...) argument (spy on builder)', async () => {
    allRows = [{ id: 'id-1', member_key: 'mk-1', staging_status: 'active', superseded_at: null, raw_json: {} }];
    await getNormalizedRecordsByMemberKeys(['mk-1']);
    expect(queryLog[0].selectArg).not.toBeNull();
    expect(queryLog[0].selectArg).toContain('raw_json');
    expect(queryLog[0].selectArg).not.toBe('*');
  });

  it('chunks .in(member_key, ...) at 200 (201 keys → two chunks: 200 + 1)', async () => {
    const keys = Array.from({ length: 201 }, (_, i) => `mk-${i + 1}`);
    await getNormalizedRecordsByMemberKeys(keys);
    // Two chunks; each first page; no follow-up pages since data is empty.
    const chunkSizes = queryLog.map(q => q.inList?.length ?? 0);
    expect(chunkSizes).toEqual([200, 1]);
  });

  it('paginates with gt(id, lastId) on subsequent pages within a chunk', async () => {
    allRows = Array.from({ length: 1200 }, (_, i) => ({
      id: `id-${String(i + 1).padStart(6, '0')}`,
      member_key: 'mk-1',
      staging_status: 'active',
      superseded_at: null,
      raw_json: {},
    }));
    await getNormalizedRecordsByMemberKeys(['mk-1']);
    // 1200 / 500 = 3 pages
    expect(queryLog.length).toBe(3);
    expect(queryLog[0].gtId).toBeNull();
    expect(queryLog[1].gtId).toBe('id-000500');
    expect(queryLog[2].gtId).toBe('id-001000');
  });
});
