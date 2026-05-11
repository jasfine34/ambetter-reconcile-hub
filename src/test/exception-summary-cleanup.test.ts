/**
 * Exception Summary cleanup tests:
 *  - The stale issue cards ('Missing from Commission', 'Paid but Missing from EDE')
 *    are removed from the Dashboard Exception Summary section.
 *  - The retained cards ('Wrong Pay Entity', 'Not Eligible for Commission')
 *    are still listed.
 *  - getIssueTypeLabel('Wrong Pay Entity') renders as 'Paid to Wrong Entity'.
 *
 * The Exception Summary issue list is declared inline in DashboardPage.tsx.
 * Asserting against the source text is sufficient to lock the rendering
 * contract without booting the full page (which requires extensive Supabase
 * mocking already covered by other suites).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getIssueTypeLabel, ISSUE_TYPES } from '@/lib/constants';

const dashboardSource = readFileSync(
  resolve(__dirname, '../pages/DashboardPage.tsx'),
  'utf8',
);

function extractExceptionSummaryBlock(src: string): string {
  const start = src.indexOf('Exception Summary');
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('Clawbacks drilldown', start);
  return src.slice(start, end > -1 ? end : start + 4000);
}

describe('Exception Summary cleanup', () => {
  const block = extractExceptionSummaryBlock(dashboardSource);

  it("does NOT render the 'Missing from Commission' card", () => {
    expect(block).not.toMatch(/issue:\s*'Missing from Commission'/);
  });

  it("does NOT render the 'Paid but Missing from EDE' card", () => {
    expect(block).not.toMatch(/issue:\s*'Paid but Missing from EDE'/);
  });

  it("retains 'Wrong Pay Entity' and 'Not Eligible for Commission' issue_type-driven cards", () => {
    expect(block).toMatch(/issue:\s*'Wrong Pay Entity'/);
    expect(block).toMatch(/issue:\s*'Not Eligible for Commission'/);
  });

  it('preserves underlying issue_type enum values in ISSUE_TYPES (persisted strings unchanged)', () => {
    expect(ISSUE_TYPES).toContain('Missing from Commission');
    expect(ISSUE_TYPES).toContain('Paid but Missing from EDE');
    expect(ISSUE_TYPES).toContain('Wrong Pay Entity');
  });
});

describe("getIssueTypeLabel UI rename", () => {
  it("renders 'Wrong Pay Entity' as 'Paid to Wrong Entity'", () => {
    expect(getIssueTypeLabel('Wrong Pay Entity')).toBe('Paid to Wrong Entity');
  });

  it('leaves other labels intact', () => {
    expect(getIssueTypeLabel('Not Eligible for Commission')).toBe(
      'Not Eligible for Commission',
    );
    expect(getIssueTypeLabel('Missing from Back Office')).toBe(
      'Missing from Back Office',
    );
  });
});

describe('persisted issue_type enum unchanged', () => {
  it('underlying ISSUE_TYPES enum still contains the persisted "Missing from Back Office" string', () => {
    expect(ISSUE_TYPES).toContain('Missing from Back Office');
  });
});
