import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SQL = fs.readFileSync(
  path.join(process.cwd(), 'supabase/migrations/20260514160729_create_cross_batch_clearings.sql'),
  'utf-8',
);

describe('cross_batch_clearings migration (static)', () => {
  it('creates cross_batch_clearings table', () => {
    expect(SQL).toMatch(/CREATE TABLE\s+public\.cross_batch_clearings/);
  });
  it('partial unique index on (policy_identity_key, target_service_month) WHERE active', () => {
    expect(SQL).toMatch(/CREATE UNIQUE INDEX[\s\S]*policy_identity_key,\s*target_service_month[\s\S]*WHERE staging_status = 'active' AND superseded_at IS NULL/);
  });
  it('reconciled_member_id ON DELETE SET NULL', () => {
    expect(SQL).toMatch(/reconciled_member_id uuid REFERENCES[\s\S]*ON DELETE SET NULL/);
  });
  it('clearing_state CHECK has six values', () => {
    expect(SQL).toMatch(/clearing_state IN \([\s\S]*'fully_cleared'[\s\S]*'partially_cleared'[\s\S]*'not_cleared'[\s\S]*'cleared_then_reversed'[\s\S]*'zero_expected_no_payment_required'[\s\S]*'manual_review_required'/);
  });
  it('target_service_month CHECK regex', () => {
    expect(SQL).toMatch(/target_service_month text NOT NULL CHECK \(target_service_month ~ '\^\[0-9\]\{4\}-\(0\[1-9\]\|1\[0-2\]\)\$'\)/);
  });
  it('unpaid_statement_month CHECK regex', () => {
    expect(SQL).toMatch(/unpaid_statement_month text NOT NULL CHECK/);
  });
  it('staging_status CHECK active|superseded', () => {
    expect(SQL).toMatch(/staging_status IN \('active', 'superseded'\)/);
  });
  it('unpaid_batch_ids jsonb NOT NULL DEFAULT []', () => {
    expect(SQL).toMatch(/unpaid_batch_ids jsonb NOT NULL DEFAULT '\[\]'::jsonb/);
  });
  it('payment_batch_ids jsonb NOT NULL DEFAULT []', () => {
    expect(SQL).toMatch(/payment_batch_ids jsonb NOT NULL DEFAULT '\[\]'::jsonb/);
  });
  it('GIN index on unpaid_batch_ids', () => {
    expect(SQL).toMatch(/USING gin \(unpaid_batch_ids\)/);
  });
  it('GIN index on payment_batch_ids', () => {
    expect(SQL).toMatch(/USING gin \(payment_batch_ids\)/);
  });
  it('does not contain superseded_by column', () => {
    expect(SQL).not.toMatch(/superseded_by/);
  });
  it('RLS FOR ALL USING (true) WITH CHECK (true) without TO authenticated', () => {
    expect(SQL).toMatch(/FOR ALL\s+USING \(true\)\s+WITH CHECK \(true\)/);
    expect(SQL).not.toMatch(/TO authenticated/);
  });
  it('RPC uses pg_advisory_xact_lock', () => {
    expect(SQL).toMatch(/pg_advisory_xact_lock/);
  });
  it('RPC supersede sets BOTH columns', () => {
    expect(SQL).toMatch(/SET superseded_at = now\(\),\s*staging_status = 'superseded'/);
  });
  it('RPC uses COALESCE for jsonb columns', () => {
    expect(SQL).toMatch(/COALESCE\(r->'unpaid_batch_ids'/);
  });
});
