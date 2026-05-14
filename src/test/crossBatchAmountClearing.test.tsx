import { describe, it, expect } from 'vitest';
import { evaluateCrossBatchAmountClearing } from '@/lib/canonical/crossBatchAmountClearing';

const c = (id: string, amt: number, sm: string, raw: any = {}) => ({
  id, commission_amount: amt, statement_month: sm, created_at: '2026-01-01', raw_json: raw,
});

describe('evaluateCrossBatchAmountClearing', () => {
  it('zero expected → zero_expected_no_payment_required', () => {
    const r = evaluateCrossBatchAmountClearing({ expected_amount: 0, candidates: [] });
    expect(r.clearing_state).toBe('zero_expected_no_payment_required');
  });
  it('null expected → manual_review', () => {
    const r = evaluateCrossBatchAmountClearing({ expected_amount: null, candidates: [] });
    expect(r.clearing_state).toBe('manual_review_required');
    expect(r.manual_review_reason).toBe('expected_amount_unresolvable');
  });
  it('no candidates → not_cleared no_payment_found', () => {
    const r = evaluateCrossBatchAmountClearing({ expected_amount: 100, candidates: [] });
    expect(r.clearing_state).toBe('not_cleared');
    expect(r.reason).toBe('no_payment_found');
  });
  it('only ignored zero rows → no_positive_payment_found', () => {
    const r = evaluateCrossBatchAmountClearing({ expected_amount: 100, candidates: [c('a', 0, '2026-03')] });
    expect(r.clearing_state).toBe('not_cleared');
    expect(r.reason).toBe('no_positive_payment_found');
  });
  it('only reversals → manual_review reversal_without_prior_full_clear', () => {
    const r = evaluateCrossBatchAmountClearing({ expected_amount: 100, candidates: [c('a', -50, '2026-03')] });
    expect(r.clearing_state).toBe('manual_review_required');
    expect(r.manual_review_reason).toBe('reversal_without_prior_full_clear');
  });
  it('positive >= 70% threshold → fully_cleared', () => {
    const r = evaluateCrossBatchAmountClearing({ expected_amount: 100, candidates: [c('a', 70, '2026-03')] });
    expect(r.clearing_state).toBe('fully_cleared');
    expect(r.firstFullClearStatementMonth).toBe('2026-03');
  });
  it('positive < 70% → partially_cleared', () => {
    const r = evaluateCrossBatchAmountClearing({ expected_amount: 100, candidates: [c('a', 50, '2026-03')] });
    expect(r.clearing_state).toBe('partially_cleared');
    expect(r.remainder_owed).toBe(50);
  });
  it('cleared then reversed terminal', () => {
    const r = evaluateCrossBatchAmountClearing({
      expected_amount: 100,
      candidates: [c('a', 80, '2026-03'), c('b', -80, '2026-04')],
    });
    expect(r.clearing_state).toBe('cleared_then_reversed');
    expect(r.reversedAtStatementMonth).toBe('2026-04');
  });
  it('cleared_then_reversed terminal even if later positive', () => {
    const r = evaluateCrossBatchAmountClearing({
      expected_amount: 100,
      candidates: [c('a', 80, '2026-03'), c('b', -80, '2026-04'), c('c', 90, '2026-05')],
    });
    expect(r.clearing_state).toBe('cleared_then_reversed');
  });
  it('threshold is exact 70% match', () => {
    const r = evaluateCrossBatchAmountClearing({ expected_amount: 100, candidates: [c('a', 70, '2026-03')] });
    expect(r.threshold_amount).toBe(70);
    expect(r.clearing_state).toBe('fully_cleared');
  });
  it('actual_positive_amount sums positives', () => {
    const r = evaluateCrossBatchAmountClearing({ expected_amount: 100, candidates: [c('a', 40, '2026-03'), c('b', 40, '2026-04')] });
    expect(r.actual_positive_amount).toBe(80);
  });
  it('matchedPaidRecordIds tracks ids', () => {
    const r = evaluateCrossBatchAmountClearing({ expected_amount: 100, candidates: [c('a', 80, '2026-03')] });
    expect(r.matchedPaidRecordIds).toEqual(['a']);
  });
  it('reversalRecordIds tracks reversals', () => {
    const r = evaluateCrossBatchAmountClearing({ expected_amount: 100, candidates: [c('a', 80, '2026-03'), c('b', -10, '2026-04')] });
    expect(r.reversalRecordIds).toEqual(['b']);
  });
  it('ignoredRecordIds tracks zero rows', () => {
    const r = evaluateCrossBatchAmountClearing({ expected_amount: 100, candidates: [c('a', 80, '2026-03'), c('b', 0, '2026-04')] });
    expect(r.ignoredRecordIds).toEqual(['b']);
  });
  it('classifies via raw_json transaction_type clawback', () => {
    const r = evaluateCrossBatchAmountClearing({
      expected_amount: 100,
      candidates: [c('a', 80, '2026-03'), c('b', 80, '2026-04', { transaction_type: 'clawback' })],
    });
    expect(r.reversalRecordIds).toContain('b');
  });
  it('clearingStatementMonths sorted unique', () => {
    const r = evaluateCrossBatchAmountClearing({ expected_amount: 100, candidates: [c('a', 80, '2026-03'), c('b', 10, '2026-03')] });
    expect(r.clearingStatementMonths).toEqual(['2026-03']);
  });
});
