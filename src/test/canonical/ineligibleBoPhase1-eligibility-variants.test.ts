/**
 * Phase 1 repair — eligibility normalization variants (14 cases).
 *
 * Hardens isActiveBackOfficeRecord against case-insensitive 'no'/'false',
 * numeric 0/1, string '0', boolean false/true, and null/undefined
 * pass-through.
 */
import { describe, it, expect } from 'vitest';
import { isActiveBackOfficeRecord } from '@/lib/canonical/isActiveBackOfficeRecord';

const START = '2026-04-01';
const END = '2026-04-30';

function rec(elig: unknown): any {
  return {
    source_type: 'BACK_OFFICE',
    eligible_for_commission: elig,
    policy_term_date: '2026-12-31',
    paid_through_date: null,
  };
}

describe("Phase 1 repair — eligible_for_commission normalization", () => {
  const ineligible: Array<[string, unknown]> = [
    ["'No' string", 'No'],
    ["'no' lowercase", 'no'],
    ["'NO' uppercase", 'NO'],
    ["'false' string", 'false'],
    ["'FALSE' uppercase", 'FALSE'],
    ["false boolean", false],
    ["0 numeric", 0],
    ["'0' string", '0'],
  ];
  for (const [label, val] of ineligible) {
    it(`${label} → false`, () => {
      expect(isActiveBackOfficeRecord(rec(val), START, END)).toBe(false);
    });
  }

  const eligible: Array<[string, unknown]> = [
    ["'Yes' string", 'Yes'],
    ["'yes' lowercase", 'yes'],
    ["true boolean", true],
    ["1 numeric", 1],
    ["null pass-through", null],
    ["undefined pass-through", undefined],
  ];
  for (const [label, val] of eligible) {
    it(`${label} → true (date checks still apply)`, () => {
      expect(isActiveBackOfficeRecord(rec(val), START, END)).toBe(true);
    });
  }
});
