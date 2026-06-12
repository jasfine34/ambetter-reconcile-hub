import { describe, it, expect } from 'vitest';
import {
  buildClearingOverlayMap,
  siblingPolicyGrainKey,
  adjustmentForReconciledRow,
  partitionUnpaidRowsByOverlay,
} from '@/lib/canonical/crossBatchOverlay';

function makeClearingRow(over: Partial<any>) {
  return {
    policy_identity_key: 'ambetter|u70031361',
    target_service_month: '2026-01',
    clearing_state: 'fully_cleared',
    expected_amount: 68,
    actual_positive_amount: 68,
    actual_reversal_amount: 0,
    actual_net_amount: 68,
    remainder_owed: 0,
    unpaid_batch_ids: [],
    payment_batch_ids: [],
    reversed_at_statement_month: null,
    first_full_clear_statement_month: null,
    evaluated_at: '2026-06-10T00:00:00Z',
    run_id: 'r1',
    manual_review_reason: null,
    ...over,
  };
}

describe('siblingPolicyGrainKey', () => {
  it('transforms pn-form → sub-form (policy segment only)', () => {
    expect(siblingPolicyGrainKey('ambetter|u70031361|2026-01'))
      .toBe('ambetter|sub:u70031361|2026-01');
  });
  it('transforms sub-form → pn-form', () => {
    expect(siblingPolicyGrainKey('ambetter|sub:u72898936|2026-01'))
      .toBe('ambetter|u72898936|2026-01');
  });
  it('never alters the month segment', () => {
    const sib = siblingPolicyGrainKey('ambetter|u70031361|2026-01')!;
    expect(sib.endsWith('|2026-01')).toBe(true);
  });
  it('returns null for malformed keys', () => {
    expect(siblingPolicyGrainKey('not-a-grain-key')).toBeNull();
    expect(siblingPolicyGrainKey('ambetter|u1')).toBeNull();
  });
});

describe('adjustmentForReconciledRow alias-safe lookup', () => {
  it('exact-key hit returns the exact overlay (preferred over sibling)', () => {
    const map = buildClearingOverlayMap([
      makeClearingRow({ policy_identity_key: 'ambetter|u70031361', clearing_state: 'fully_cleared' }),
    ]);
    const row = { carrier: 'Ambetter', policy_number: 'U70031361', issuer_subscriber_id: null, expected_ede_effective_month: '2026-01' };
    const res = adjustmentForReconciledRow(row, map);
    expect(res.adjustment.kind).toBe('remove_from_unpaid');
    expect(map.diagnostics.aliasSiblingProbeHitCount).toBe(0);
  });

  it('sibling-miss recovery: sub-form row resolves to stored pn-form overlay', () => {
    const map = buildClearingOverlayMap([
      makeClearingRow({ policy_identity_key: 'ambetter|u72898936', clearing_state: 'fully_cleared' }),
    ]);
    const row = { carrier: 'Ambetter', policy_number: null, issuer_subscriber_id: 'U72898936', expected_ede_effective_month: '2026-01' };
    const res = adjustmentForReconciledRow(row, map);
    expect(res.adjustment.kind).toBe('remove_from_unpaid');
    expect(map.diagnostics.aliasSiblingProbeHitCount).toBe(1);
  });

  it('inverse sibling-miss recovery: pn-form row resolves to stored sub-form overlay', () => {
    const map = buildClearingOverlayMap([
      makeClearingRow({ policy_identity_key: 'ambetter|sub:u70396792', clearing_state: 'fully_cleared' }),
    ]);
    const row = { carrier: 'Ambetter', policy_number: 'U70396792', issuer_subscriber_id: null, expected_ede_effective_month: '2026-01' };
    const res = adjustmentForReconciledRow(row, map);
    expect(res.adjustment.kind).toBe('remove_from_unpaid');
    expect(map.diagnostics.aliasSiblingProbeHitCount).toBe(1);
  });

  it('month isolation: never probes another month', () => {
    const map = buildClearingOverlayMap([
      makeClearingRow({ policy_identity_key: 'ambetter|u70031361', target_service_month: '2026-02' }),
    ]);
    const row = { carrier: 'Ambetter', policy_number: 'U70031361', issuer_subscriber_id: null, expected_ede_effective_month: '2026-01' };
    const res = adjustmentForReconciledRow(row, map);
    expect(res.adjustment.kind).toBe('no_overlay');
    expect(map.diagnostics.aliasSiblingProbeHitCount).toBe(0);
  });

  it('legacy split pair (both forms persisted): dual-hit increments and exact preferred', () => {
    const map = buildClearingOverlayMap([
      makeClearingRow({ policy_identity_key: 'ambetter|u70031361', clearing_state: 'fully_cleared', actual_net_amount: 68, remainder_owed: 0 }),
      makeClearingRow({ policy_identity_key: 'ambetter|sub:u70031361', clearing_state: 'not_cleared', actual_net_amount: 0, remainder_owed: 68 }),
    ]);
    const row = { carrier: 'Ambetter', policy_number: 'U70031361', issuer_subscriber_id: null, expected_ede_effective_month: '2026-01' };
    const res = adjustmentForReconciledRow(row, map);
    expect(res.adjustment.kind).toBe('remove_from_unpaid');
    expect(map.diagnostics.aliasSiblingDualHitCount).toBe(1);
    expect(map.diagnostics.aliasSiblingProbeHitCount).toBe(0);
  });
});

describe('partitionUnpaidRowsByOverlay regression', () => {
  it('exact-key fixtures classify identically', () => {
    const map = buildClearingOverlayMap([
      makeClearingRow({ policy_identity_key: 'ambetter|aaa', clearing_state: 'fully_cleared' }),
      makeClearingRow({ policy_identity_key: 'ambetter|bbb', clearing_state: 'not_cleared' }),
    ]);
    const rows = [
      { carrier: 'Ambetter', policy_number: 'aaa', expected_ede_effective_month: '2026-01', estimated_missing_commission: 50 },
      { carrier: 'Ambetter', policy_number: 'bbb', expected_ede_effective_month: '2026-01', estimated_missing_commission: 30 },
    ];
    const part = partitionUnpaidRowsByOverlay(rows, map);
    expect(part.removed).toHaveLength(1);
    expect(part.regular).toHaveLength(1);
  });
});
