import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Smoke runner loader (getAllNormalizedRecordsForMemberTimeline) needs a
 * partial index on (id) scoped to the active+non-superseded predicate so
 * keyset pagination is O(page_size) instead of O(N_active).
 */
describe('normalized_records active id-only keyset index migration', () => {
  it('declares idx_normalized_active_id with the correct shape', () => {
    const migrationsDir = join(process.cwd(), 'supabase', 'migrations');
    const matching = readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .map(f => readFileSync(join(migrationsDir, f), 'utf8'))
      .filter(sql => /CREATE\s+INDEX[\s\S]*idx_normalized_active_id\b/i.test(sql));
    expect(matching.length).toBeGreaterThan(0);
    const sql = matching[0];
    expect(sql).toMatch(/CONCURRENTLY/i);
    expect(sql).toMatch(/IF\s+NOT\s+EXISTS/i);
    expect(sql).toMatch(/ON\s+public\.normalized_records\s*\(\s*id\s*\)/i);
    expect(sql).toMatch(/WHERE\s+staging_status\s*=\s*'active'\s+AND\s+superseded_at\s+IS\s+NULL/i);
  });
});
