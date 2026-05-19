import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SQL = fs.readFileSync(
  path.join(
    process.cwd(),
    'supabase/migrations/20260516211341_698fa6cc-9c9c-4281-80c2-224acd46153c.sql',
  ),
  'utf-8',
);

describe('MCE source-records partial composite index migration (static)', () => {
  it('creates the index with IF NOT EXISTS and correct name', () => {
    expect(SQL).toMatch(
      /CREATE INDEX IF NOT EXISTS\s+normalized_records_active_member_key_id_idx/,
    );
  });
  it('targets public.normalized_records', () => {
    expect(SQL).toMatch(/ON\s+public\.normalized_records/);
  });
  it('columns are (member_key, id) in order', () => {
    expect(SQL).toMatch(/\(\s*member_key\s*,\s*id\s*\)/);
  });
  it('partial predicate is the canonical active predicate', () => {
    expect(SQL).toMatch(
      /WHERE\s+staging_status\s*=\s*'active'\s+AND\s+superseded_at\s+IS\s+NULL/,
    );
  });
});

describe('persistence.ts hotfix scope discipline (static)', () => {
  const TS = fs.readFileSync(
    path.join(process.cwd(), 'src/lib/persistence.ts'),
    'utf-8',
  );
  it('MCE_ENRICHMENT_COLUMNS still includes raw_json', () => {
    const m = TS.match(/const MCE_ENRICHMENT_COLUMNS\s*=\s*([\s\S]*?);/);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/raw_json/);
  });
  it("getNormalizedRecords still uses select('*')", () => {
    const start = TS.indexOf('export async function getNormalizedRecords');
    expect(start).toBeGreaterThanOrEqual(0);
    const nextExport = TS.indexOf('export async function', start + 1);
    const body = TS.slice(start, nextExport === -1 ? undefined : nextExport);
    expect(body).toMatch(/\.select\(\s*['"]\*['"]\s*\)/);
  });
});
