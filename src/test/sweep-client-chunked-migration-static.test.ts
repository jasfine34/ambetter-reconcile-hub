import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SQL = fs.readFileSync(
  path.join(process.cwd(), 'supabase/migrations/20260516161543_2269af84-724f-4f5d-97f4-9d17d9c80c5a.sql'),
  'utf-8',
);

describe('sweep client-chunked migration (static)', () => {
  it('drops old replace_cross_batch_clearings_for_run RPC', () => {
    expect(SQL).toMatch(/DROP FUNCTION IF EXISTS public\.replace_cross_batch_clearings_for_run/);
  });
  it('creates supersede_active_clearings_batch with clamp', () => {
    expect(SQL).toMatch(/CREATE OR REPLACE FUNCTION public\.supersede_active_clearings_batch/);
    expect(SQL).toMatch(/LEAST\(GREATEST\(COALESCE\(p_batch_size, 500\), 1\), 500\)/);
  });
  it('creates insert_clearing_rows with 500-row cap', () => {
    expect(SQL).toMatch(/CREATE OR REPLACE FUNCTION public\.insert_clearing_rows/);
    expect(SQL).toMatch(/jsonb_array_length\(COALESCE\(p_rows, '\[\]'::jsonb\)\) > 500/);
    expect(SQL).toMatch(/insert_clearing_rows supports at most 500 rows per call/);
  });
  it('sweep TS no longer references old RPC', () => {
    const ts = fs.readFileSync(
      path.join(process.cwd(), 'src/lib/sweep/crossBatchClearingSweep.ts'),
      'utf-8',
    );
    expect(ts).not.toMatch(/replace_cross_batch_clearings_for_run/);
    expect(ts).toMatch(/supersede_active_clearings_batch/);
    expect(ts).toMatch(/insert_clearing_rows/);
  });
});
