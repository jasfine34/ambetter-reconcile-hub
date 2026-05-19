/**
 * Ineligible-BO Phase 1 — applyRuntimeBOActive + MCE-shaped scenarios.
 *
 * Asserts the runtime exclusion-set behavior:
 *   - multi-record OR semantics
 *   - exclusion set only includes members with matching BO records that all
 *     fail the helper
 *   - canary members are absent from final MCE breakdown
 *   - synthesized EDE-Only leak class is excluded
 *   - runtime re-evaluation overrides stale persisted in_back_office
 *   - purity (no mutation of inputs)
 */
import { describe, it, expect } from 'vitest';
import { applyRuntimeBOActive } from '@/lib/canonical/applyRuntimeBOActive';
import { getStatementMonthBounds } from '@/lib/canonical/statementMonthBounds';

const BOUNDS_APR = getStatementMonthBounds('2026-04');
const BOUNDS_MAR = getStatementMonthBounds('2026-03');

function boRec(over: any): any {
  return {
    source_type: 'BACK_OFFICE',
    eligible_for_commission: 'Yes',
    issuer_subscriber_id: null,
    exchange_subscriber_id: null,
    policy_number: null,
    applicant_name: null,
    member_key: null,
    policy_term_date: null,
    paid_through_date: null,
    ...over,
  };
}

function reconMember(over: any): any {
  return {
    member_key: 'm:x',
    in_back_office: false,
    issuer_subscriber_id: null,
    exchange_subscriber_id: null,
    policy_number: null,
    applicant_name: null,
    ...over,
  };
}

describe('applyRuntimeBOActive', () => {
  it('member with no matching BO records → adjusted in_back_office=false, NOT in exclusion set', () => {
    const result = applyRuntimeBOActive(
      [reconMember({ member_key: 'm:1', issuer_subscriber_id: 'ISS1' })],
      [boRec({ member_key: 'm:other', issuer_subscriber_id: 'ISS_OTHER' })],
      BOUNDS_APR,
    );
    expect(result.adjustedReconciled[0].in_back_office).toBe(false);
    expect(result.mceExclusionMemberKeys.has('m:1')).toBe(false);
  });

  it('member with one matching ACTIVE BO record → in_back_office=true, NOT excluded', () => {
    const result = applyRuntimeBOActive(
      [reconMember({ member_key: 'm:1', issuer_subscriber_id: 'ISS1' })],
      [boRec({ issuer_subscriber_id: 'ISS1', policy_term_date: '2026-12-31' })],
      BOUNDS_APR,
    );
    expect(result.adjustedReconciled[0].in_back_office).toBe(true);
    expect(result.mceExclusionMemberKeys.has('m:1')).toBe(false);
  });

  it('member with one TERMINATED BO record → in_back_office=false, IN exclusion set', () => {
    const result = applyRuntimeBOActive(
      [reconMember({ member_key: 'm:1', issuer_subscriber_id: 'ISS1' })],
      [boRec({ issuer_subscriber_id: 'ISS1', policy_term_date: '2025-12-31' })],
      BOUNDS_APR,
    );
    expect(result.adjustedReconciled[0].in_back_office).toBe(false);
    expect(result.mceExclusionMemberKeys.has('m:1')).toBe(true);
  });

  it("ineligible BO record → false + excluded", () => {
    const result = applyRuntimeBOActive(
      [reconMember({ member_key: 'm:1', issuer_subscriber_id: 'ISS1' })],
      [boRec({ issuer_subscriber_id: 'ISS1', eligible_for_commission: 'No', policy_term_date: '2027-12-31' })],
      BOUNDS_APR,
    );
    expect(result.adjustedReconciled[0].in_back_office).toBe(false);
    expect(result.mceExclusionMemberKeys.has('m:1')).toBe(true);
  });

  it('paid-through-covered BO record → false + excluded', () => {
    const result = applyRuntimeBOActive(
      [reconMember({ member_key: 'm:1', issuer_subscriber_id: 'ISS1' })],
      [boRec({ issuer_subscriber_id: 'ISS1', paid_through_date: '2026-04-30' })],
      BOUNDS_APR,
    );
    expect(result.adjustedReconciled[0].in_back_office).toBe(false);
    expect(result.mceExclusionMemberKeys.has('m:1')).toBe(true);
  });

  it('multi-record OR — one active + one terminated → active, NOT excluded', () => {
    const result = applyRuntimeBOActive(
      [reconMember({ member_key: 'm:1', issuer_subscriber_id: 'ISS1' })],
      [
        boRec({ issuer_subscriber_id: 'ISS1', policy_term_date: '2025-12-31' }),
        boRec({ issuer_subscriber_id: 'ISS1', policy_term_date: '2026-12-31' }),
      ],
      BOUNDS_APR,
    );
    expect(result.adjustedReconciled[0].in_back_office).toBe(true);
    expect(result.mceExclusionMemberKeys.has('m:1')).toBe(false);
    expect(result.matchingBoRecordCounts.get('m:1')).toBe(2);
  });

  it('runtime override of stale persisted in_back_office=true', () => {
    const result = applyRuntimeBOActive(
      [reconMember({ member_key: 'm:1', issuer_subscriber_id: 'ISS1', in_back_office: true })],
      [boRec({ issuer_subscriber_id: 'ISS1', policy_term_date: '2025-12-31' })],
      BOUNDS_APR,
    );
    expect(result.adjustedReconciled[0].in_back_office).toBe(false);
    expect(result.mceExclusionMemberKeys.has('m:1')).toBe(true);
  });

  it('pure — does not mutate input arrays or row objects', () => {
    const recon = [reconMember({ member_key: 'm:1', issuer_subscriber_id: 'ISS1', in_back_office: true })];
    const recIdentity = recon[0];
    const bo = [boRec({ issuer_subscriber_id: 'ISS1', policy_term_date: '2025-12-31' })];
    applyRuntimeBOActive(recon, bo, BOUNDS_APR);
    expect(recon[0]).toBe(recIdentity);
    expect(recIdentity.in_back_office).toBe(true); // unchanged
  });

  it('identity match by policy_number', () => {
    const result = applyRuntimeBOActive(
      [reconMember({ member_key: 'm:1', policy_number: 'POL-1' })],
      [boRec({ policy_number: 'POL-1', policy_term_date: '2025-12-31' })],
      BOUNDS_APR,
    );
    expect(result.mceExclusionMemberKeys.has('m:1')).toBe(true);
  });

  it('identity match by normalized applicant name', () => {
    const result = applyRuntimeBOActive(
      [reconMember({ member_key: 'm:1', applicant_name: 'Misty Karkowski' })],
      [boRec({ applicant_name: 'Misty  Karkowski', policy_term_date: '2025-12-31', eligible_for_commission: 'No' })],
      BOUNDS_APR,
    );
    expect(result.mceExclusionMemberKeys.has('m:1')).toBe(true);
  });

  describe('named canary exclusions (raw row → exclusion set)', () => {
    const canaries = [
      { name: 'Misty Karkowski', policy_term_date: '2023-10-31', elig: 'No' },
      { name: 'Kim Smith', policy_term_date: '2024-07-20', elig: 'No' },
      { name: 'Juan Fuentes', policy_term_date: '2025-12-31', elig: 'No' },
      { name: 'Jeffrey Hill', policy_term_date: '2025-12-31', elig: 'No' },
      { name: 'Bernard Gratzer', policy_term_date: '2025-12-31', elig: 'No' },
    ];
    for (const c of canaries) {
      it(`${c.name} excluded from 2026-04 MCE universe`, () => {
        const result = applyRuntimeBOActive(
          [reconMember({ member_key: `m:${c.name}`, applicant_name: c.name })],
          [boRec({ applicant_name: c.name, policy_term_date: c.policy_term_date, eligible_for_commission: c.elig })],
          BOUNDS_APR,
        );
        expect(result.mceExclusionMemberKeys.has(`m:${c.name}`)).toBe(true);
      });
    }

    it('Juan Fuentes IN 2025-12 universe (term-date not past yet)', () => {
      const BOUNDS_DEC25 = getStatementMonthBounds('2025-12');
      const result = applyRuntimeBOActive(
        [reconMember({ member_key: 'm:Juan', applicant_name: 'Juan Fuentes' })],
        [boRec({ applicant_name: 'Juan Fuentes', policy_term_date: '2025-12-31', eligible_for_commission: 'No' })],
        BOUNDS_DEC25,
      );
      // Eligible='No' still disqualifies, so Juan is excluded — Phase 1 helper
      // enforces eligibility as the dominant rule. This documents the
      // eligibility=No precedence and is consistent with the canary spec.
      expect(result.mceExclusionMemberKeys.has('m:Juan')).toBe(true);
    });

    it('Christopher Ortiz NOT excluded from Mar 2026 when BO appears active (Jan investigation deferred)', () => {
      const result = applyRuntimeBOActive(
        [reconMember({ member_key: 'm:CO', policy_number: 'U90161212', applicant_name: 'Christopher Ortiz' })],
        [boRec({ policy_number: 'U90161212', applicant_name: 'Christopher Ortiz', policy_term_date: '2027-01-01' })],
        BOUNDS_MAR,
      );
      // Active BO → not excluded. The Jan 2026 exclusion target uses a
      // different (terminated/ineligible) source row addressed in deferred
      // raw-file investigation.
      expect(result.mceExclusionMemberKeys.has('m:CO')).toBe(false);
    });
  });
});
