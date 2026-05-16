import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SQL = fs.readFileSync(
  path.join(
    process.cwd(),
    'supabase/migrations/20260516221634_9fa92538-5f88-488a-a43b-40d03df9b89d.sql',
  ),
  'utf-8',
);

describe('replace_reconciled_members_for_batch statement_timeout migration (static)', () => {
  it('alters the exact function signature (uuid, jsonb, jsonb)', () => {
    expect(SQL).toMatch(
      /ALTER FUNCTION\s+public\.replace_reconciled_members_for_batch\s*\(\s*uuid\s*,\s*jsonb\s*,\s*jsonb\s*\)/,
    );
  });

  it("sets statement_timeout = '120s' using the sibling-RPC = form", () => {
    expect(SQL).toMatch(/SET\s+statement_timeout\s*=\s*'120s'/);
  });

  it('does not use RESET or role-specific overrides', () => {
    expect(SQL).not.toMatch(/RESET\s+statement_timeout/i);
    expect(SQL).not.toMatch(/IN\s+ROLE/i);
  });
});
