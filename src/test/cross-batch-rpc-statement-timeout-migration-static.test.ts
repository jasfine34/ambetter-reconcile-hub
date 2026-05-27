import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * insert_clearing_rows and supersede_active_clearings_batch must have a
 * function-level statement_timeout=120s, or they run under the role's 8s
 * default and time out on heavy chunks. See docs/timeout-risk-register.md
 * for the pattern these fixes implement.
 */
describe('cross-batch RPC statement_timeout migration', () => {
  const migrationsDir = join(process.cwd(), 'supabase', 'migrations');
  const allMigrations = readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .map(f => readFileSync(join(migrationsDir, f), 'utf8'));

  it('sets statement_timeout=120s on insert_clearing_rows', () => {
    const matching = allMigrations.filter(sql =>
      /ALTER\s+FUNCTION\s+public\.insert_clearing_rows[\s\S]*SET\s+statement_timeout\s*=\s*'120s'/i.test(sql)
    );
    expect(matching.length).toBeGreaterThan(0);
  });

  it('sets statement_timeout=120s on supersede_active_clearings_batch', () => {
    const matching = allMigrations.filter(sql =>
      /ALTER\s+FUNCTION\s+public\.supersede_active_clearings_batch[\s\S]*SET\s+statement_timeout\s*=\s*'120s'/i.test(sql)
    );
    expect(matching.length).toBeGreaterThan(0);
  });
});
