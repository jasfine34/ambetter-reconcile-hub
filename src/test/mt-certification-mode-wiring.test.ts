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
 *   comment text cannot satisfy the guard — the regex must match a real call
 *   expression whose argument object includes `batchMonthByBatchId`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('MT certification-mode wiring (named-canary-ledger)', () => {
  it('passes batchMonthByBatchId into getAllNormalizedRecordsForMemberTimeline(...)', () => {
    const src = readFileSync(
      resolve(__dirname, 'named-canary-ledger.test.ts'),
      'utf8',
    );
    // Match: getAllNormalizedRecordsForMemberTimeline(  { ... batchMonthByBatchId ... } ... )
    // Allow multi-line argument object; require the call expression form.
    const callWithDedup =
      /getAllNormalizedRecordsForMemberTimeline\s*\(\s*\{[\s\S]*?batchMonthByBatchId[\s\S]*?\}/;
    expect(src).toMatch(callWithDedup);
  });
});
