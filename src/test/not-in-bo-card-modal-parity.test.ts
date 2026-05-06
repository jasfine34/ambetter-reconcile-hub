/**
 * PR1 regression test (B1 follow-up to #129).
 *
 * Bug shape: the Dashboard "Not in Back Office" card subtracted confirmed
 * weak-match overrides from `filteredEde.missingFromBO` while the drilldown
 * modal pulled rows directly from `filteredEde.missingFromBO`. With even a
 * single confirmed override present, card count < modal row count AND the
 * confirmed member appeared in the modal (a member the operator already
 * resolved as in-BO).
 *
 * Fix: both card and modal consume from the canonical helper
 * `getNotInBackOfficeRows`, which removes confirmed-override rows up front.
 *
 * This fixture would FAIL on main before the fix lands: the modal row count
 * (raw missingFromBO) would be 2 while the card count (override-aware) would
 * be 1, and m2-confirmed would still appear in the modal rows.
 */
import { describe, it, expect } from 'vitest';
import {
  getNotInBackOffice,
  getNotInBackOfficeRows,
} from '@/lib/canonical';
import { pickStableKey } from '@/lib/weakMatch';
import type { FilteredEdeResult } from '@/lib/expectedEde';

function makeFixture(): FilteredEdeResult {
  // Two EE-universe members missing from BO. m2 has a confirmed weak-match
  // override (issuer_sub_id 'ISID-2' → stable key 'issub:ISID-2').
  const missingFromBO = [
    {
      member_key: 'm1',
      applicant_name: 'Alice One',
      issuer_subscriber_id: 'ISID-1',
      exchange_subscriber_id: '',
      policy_number: '',
      effective_month: '2026-03',
      covered_member_count: 1,
      in_back_office: false,
    },
    {
      member_key: 'm2-confirmed',
      applicant_name: 'Bob Confirmed',
      issuer_subscriber_id: 'ISID-2',
      exchange_subscriber_id: '',
      policy_number: '',
      effective_month: '2026-03',
      covered_member_count: 1,
      in_back_office: false,
    },
  ] as unknown as FilteredEdeResult['missingFromBO'];

  return {
    uniqueKeys: 2,
    uniqueMembers: missingFromBO,
    inBOCount: 0,
    notInBOCount: 2,
    missingFromBO,
    byMonth: { '2026-03': 2 },
  } as unknown as FilteredEdeResult;
}

describe('Not-in-BO card↔modal parity', () => {
  const filteredEde = makeFixture();
  const confirmed = new Set<string>([
    pickStableKey({ issuer_subscriber_id: 'ISID-2' }),
  ]);

  it('card count equals modal row count', () => {
    const cardCount = getNotInBackOffice(filteredEde, confirmed, pickStableKey);
    const modalRows = getNotInBackOfficeRows(filteredEde, confirmed, pickStableKey);
    expect(cardCount).toBe(modalRows.length);
    expect(cardCount).toBe(1);
  });

  it('confirmed override member is absent from modal rows', () => {
    const modalRows = getNotInBackOfficeRows(filteredEde, confirmed, pickStableKey);
    const keys = modalRows.map((r) => r.member_key);
    expect(keys).not.toContain('m2-confirmed');
    expect(keys).toContain('m1');
  });

  it('with no overrides, card and modal include all missing rows', () => {
    const empty = new Set<string>();
    expect(getNotInBackOffice(filteredEde, empty, pickStableKey)).toBe(2);
    expect(getNotInBackOfficeRows(filteredEde, empty, pickStableKey)).toHaveLength(2);
  });
});
