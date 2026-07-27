import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture calls on the fluent query builder so we can assert wiring.
const calls: Array<{ op: string; args: any[] }> = [];

// Pages of fake data returned from the mocked builder.
let pages: any[][] = [];
let pageIndex = 0;

function makeBuilder() {
  const builder: any = {
    _limit: 1000,
    select: vi.fn((cols: string) => { calls.push({ op: 'select', args: [cols] }); return builder; }),
    eq: vi.fn((k: string, v: any) => { calls.push({ op: 'eq', args: [k, v] }); return builder; }),
    is: vi.fn((k: string, v: any) => { calls.push({ op: 'is', args: [k, v] }); return builder; }),
    order: vi.fn((k: string, opts: any) => { calls.push({ op: 'order', args: [k, opts] }); return builder; }),
    limit: vi.fn((n: number) => { calls.push({ op: 'limit', args: [n] }); return builder; }),
    gt: vi.fn((k: string, v: any) => { calls.push({ op: 'gt', args: [k, v] }); return builder; }),
    range: vi.fn(() => { calls.push({ op: 'range', args: [] }); return builder; }),
    // await path
    then: (resolve: any) => {
      const data = pages[pageIndex] ?? [];
      pageIndex += 1;
      return Promise.resolve({ data, error: null }).then(resolve);
    },
  };
  return builder;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: vi.fn((_t: string) => makeBuilder()),
  },
}));

beforeEach(() => {
  calls.length = 0;
  pages = [];
  pageIndex = 0;
});

async function importLoader() {
  const mod = await import('@/lib/resolvedIdentities');
  return mod;
}

describe('resolver loader wiring (fetchAllNormalizedRecordsForResolver)', () => {
  it('applies canonical-active predicate, keyset order, and slim projection', async () => {
    pages = [[]]; // no rows
    const mod: any = await importLoader();
    // Call resolver — it internally invokes the loader.
    // Provide empty batches page too.
    await mod.runIdentityResolution().catch(() => {}); // may short-circuit; ignore

    // Filter to normalized_records-related select operations.
    const selectCall = calls.find(c => c.op === 'select' && String(c.args[0]).includes('issuer_subscriber_id'));
    expect(selectCall, 'select called for resolver columns').toBeTruthy();
    const cols = String(selectCall!.args[0]);

    // Slim two-key JSON projection — NOT full raw_json.
    expect(cols).toContain('raw_ffm_app_id:raw_json->>ffmAppId');
    expect(cols).toContain('raw_exchange_subscriber_id:raw_json->>exchangeSubscriberId');
    expect(cols.split(',').map(s => s.trim())).not.toContain('raw_json');

    // Canonical-active predicate.
    expect(calls.some(c => c.op === 'eq' && c.args[0] === 'staging_status' && c.args[1] === 'active')).toBe(true);
    expect(calls.some(c => c.op === 'is' && c.args[0] === 'superseded_at' && c.args[1] === null)).toBe(true);

    // Keyset ordering + limit — NOT offset .range().
    expect(calls.some(c => c.op === 'order' && c.args[0] === 'id' && c.args[1]?.ascending === true)).toBe(true);
    expect(calls.some(c => c.op === 'limit' && c.args[0] === 1000)).toBe(true);
    expect(calls.some(c => c.op === 'range')).toBe(false);
  });

  it('paginates with .gt(id, previousLastId) on page 2+', async () => {
    // Page 1 = 1000 rows so loader keeps going; page 2 = 0 to stop.
    const page1 = Array.from({ length: 1000 }, (_, i) => ({
      id: `id-${String(i).padStart(4, '0')}`,
      batch_id: 'b1',
      uploaded_file_id: 'f1',
      source_type: 'EDE',
      issuer_subscriber_id: null,
      issuer_policy_id: null,
      exchange_subscriber_id: null,
      exchange_policy_id: null,
      raw_ffm_app_id: null,
      raw_exchange_subscriber_id: null,
      created_at: '2026-01-01',
    }));
    pages = [page1, []];

    const mod: any = await importLoader();
    await mod.runIdentityResolution().catch(() => {});

    const gt = calls.find(c => c.op === 'gt' && c.args[0] === 'id');
    expect(gt, 'page 2 uses keyset .gt(id, ...)').toBeTruthy();
    expect(gt!.args[1]).toBe('id-0999');
  });
});
