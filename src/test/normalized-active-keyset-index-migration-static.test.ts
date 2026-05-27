import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Phase 4 rebuild reader (getNormalizedRecords) requires a partial composite
 * index matching the keyset query's predicate + ordering. Without it Feb
 * 2026-sized active batches hit Postgres 57014 statement_timeout because the
 * planner picks an inefficient path.
 */
describe('normalized_records active keyset index migration', () => {
  it('declares idx_normalized_active_batch_id_id with the correct partial predicate', () => {
    const migrationsDir = join(process.cwd(), 'supabase', 'migrations');
    const files = readdirSync(migrationsDir);
    const matchingFiles = files.filter(f => f.endsWith('.sql'))
      .map(f => readFileSync(join(migrationsDir, f), 'utf8'))
      .filter(sql => /CREATE\s+INDEX[\s\S]*idx_normalized_active_batch_id_id/i.test(sql));
    expect(matchingFiles.length).toBeGreaterThan(0);
    const sql = matchingFiles[0];
    expect(sql).toMatch(/ON\s+public\.normalized_records\s*\(\s*batch_id\s*,\s*id\s*\)/i);
    expect(sql).toMatch(/WHERE\s+staging_status\s*=\s*'active'\s+AND\s+superseded_at\s+IS\s+NULL/i);
  });
});
