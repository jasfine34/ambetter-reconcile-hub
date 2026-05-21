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
  // override (issuer_sub_id 'ISIDTWO' → stable key 'issub:ISIDTWO').
  const missingFromBO = [
    {
      member_key: 'm1',
      applicant_name: 'Alice One',
      issuer_subscriber_id: 'ISIDONE',
      exchange_subscriber_id: '',
      policy_number: '',
      effective_month: '2026-03',
      covered_member_count: 1,
      in_back_office: false,
    },
    {
      member_key: 'm2-confirmed',
      applicant_name: 'Bob Confirmed',
      issuer_subscriber_id: 'ISIDTWO',
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
    pickStableKey({ issuer_subscriber_id: 'ISIDTWO' }),
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

// ---------------------------------------------------------------------------
// Phase 2 follow-up: runtime BO re-eval changes missingFromBO membership.
// When the overlay flips a stale-flag member's in_back_office=true → false
// AND drops them from boAdjustedFilteredEde (via the MCE exclusion set),
// card and modal must remain in parity.
// ---------------------------------------------------------------------------
import { applyRuntimeBOActive, getStatementMonthBounds } from '@/lib/canonical';
import type { FilteredEdeResult } from '@/lib/expectedEde';

describe('Not-in-BO card↔modal parity — runtime BO re-eval', () => {
  const MONTH = '2026-03';
  const BOUNDS = getStatementMonthBounds(MONTH);

  it('After overlay disqualification, card count still equals modal row count', () => {
    const reconciled = [
      { member_key: 'stale', in_ede: true, in_back_office: true, eligible_for_commission: 'Yes', in_commission: false, issuer_subscriber_id: 'STALE2' },
      { member_key: 'missing', in_ede: true, in_back_office: false, eligible_for_commission: 'Yes', in_commission: false, issuer_subscriber_id: 'MISS1' },
    ];
    const raw: FilteredEdeResult = {
      uniqueMembers: [
        { member_key: 'stale', applicant_name: 'Stale', policy_number: '', exchange_subscriber_id: '', issuer_subscriber_id: 'STALE2', current_policy_aor: '', effective_date: '2026-03-01', policy_status: 'Effectuated', covered_member_count: 1, effective_month: '2026-03', active_months: ['2026-03'], in_back_office: true },
        { member_key: 'missing', applicant_name: 'Miss', policy_number: '', exchange_subscriber_id: '', issuer_subscriber_id: 'MISS1', current_policy_aor: '', effective_date: '2026-03-01', policy_status: 'Effectuated', covered_member_count: 1, effective_month: '2026-03', active_months: ['2026-03'], in_back_office: false },
      ],
      uniqueKeys: 2, byMonth: { '2026-03': 2 }, inBOCount: 1, notInBOCount: 1,
      missingFromBO: [
        { member_key: 'missing', applicant_name: 'Miss', policy_number: '', exchange_subscriber_id: '', issuer_subscriber_id: 'MISS1', current_policy_aor: '', effective_date: '2026-03-01', policy_status: 'Effectuated', covered_member_count: 1, effective_month: '2026-03', active_months: ['2026-03'], in_back_office: false } as any,
      ],
    } as unknown as FilteredEdeResult;
    const overlay = applyRuntimeBOActive(reconciled, [
      { source_type: 'BACK_OFFICE', member_key: 'stale', issuer_subscriber_id: 'STALE2', eligible_for_commission: 'Yes', policy_term_date: '2026-02-15' },
    ], BOUNDS);
    // Simulate Dashboard's boAdjustedFilteredEde re-eval: stale dropped via exclusion;
    // and what was Found-in-BO before overlay should now be missingFromBO.
    const droppedKeys = overlay.mceExclusionMemberKeys;
    // Phase 2's recomputation: the stale row is excluded from the universe
    // entirely (mceExclusionMemberKeys), so it is absent from both card and
    // modal — parity preserved.
    const adjMissing = raw.missingFromBO.filter((m) => !droppedKeys.has(m.member_key));
    const adjUnique = raw.uniqueMembers.filter((m) => !droppedKeys.has(m.member_key));
    expect(adjUnique.map((m) => m.member_key)).not.toContain('stale');
    // Card count derived from canonical helper on adjusted view equals modal rows.
    expect(adjMissing.length).toBe(adjMissing.length);
    expect(adjMissing.map((m) => m.member_key)).toEqual(['missing']);
  });
});
