/**
 * MT certification-mode wiring — static guard.
 *
 * WHY THIS TEST EXISTS:
 *   Per the MT Payment-Display Regression Triage verdict (Jason, 2026-06-05):
 *   current-batch mode is a SELECTED-STATEMENT INSPECTION view; All-batches is
 *   the CERTIFIED CROSS-STATEMENT SURFACE. The named-canary ledger smoke is
 *   the cross-statement certification harness — it MUST thread the
 *   commission-dedup context (batchMonthByBatchId) into
 *   getAllNormalizedRecordsForMemberTimeline so it matches the production
 *   all-batches path. A refactor that drops the threaded argument would
 *   silently regress canary classification (e.g. Dannielle Coe Jan 2026
 *   flipping back to "unpaid").
 *
 *   We parse the source rather than asserting bare string presence so leftover
 *   comment text cannot satisfy the guard — the assertion must match a real call
 *   expression whose argument object includes `batchMonthByBatchId`.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import { resolve } from 'path';

function extractCallArgs(source: string, fnName: string): string {
  const start = source.indexOf(fnName + '(');
  if (start === -1) return '';
  let depth = 0;
  let end = -1;
  for (let j = start + fnName.length; j < source.length; j++) {
    const ch = source[j];
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) { end = j; break; } }
  }
  return end === -1 ? '' : source.slice(start + fnName.length + 1, end);
}

const CANARY_TEST_PATH = resolve(__dirname, 'named-canary-ledger.test.ts');

describe('MT certification-mode wiring (named-canary-ledger)', () => {
  it('passes batchMonthByBatchId into getAllNormalizedRecordsForMemberTimeline(...)', () => {
    const src = fs.readFileSync(CANARY_TEST_PATH, 'utf8');
    const args = extractCallArgs(src, 'getAllNormalizedRecordsForMemberTimeline');
    expect(args.length).toBeGreaterThan(0); // the call must exist
    expect(args).toContain('batchMonthByBatchId'); // dedup ctx must be threaded INSIDE the call
  });
});