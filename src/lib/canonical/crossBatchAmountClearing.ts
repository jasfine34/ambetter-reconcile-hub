/**
 * Bundle 13b — evaluate cross-batch amount clearing.
 */

export interface AmountClearingCandidate {
  id: string;
  commission_amount: number | null;
  statement_month: string;
  created_at?: string | null;
  raw_json?: any;
  /** Bundle 13d — concrete pay_entity used by sweep-side override resolution.
   *  Not consumed by evaluateCrossBatchAmountClearing itself. */
  pay_entity?: string | null;
}

export type AmountClearingResult = {
  clearing_state:
    | 'fully_cleared'
    | 'partially_cleared'
    | 'not_cleared'
    | 'cleared_then_reversed'
    | 'zero_expected_no_payment_required'
    | 'manual_review_required';
  reason?: string;
  manual_review_reason?: string;
  threshold_amount: number | null;
  actual_positive_amount: number;
  actual_reversal_amount: number;
  actual_net_amount: number;
  remainder_owed: number | null;
  matchedPaidRecordIds: string[];
  reversalRecordIds: string[];
  ignoredRecordIds: string[];
  clearingStatementMonths: string[];
  firstFullClearStatementMonth?: string | null;
  reversedAtStatementMonth?: string | null;
};

function classify(c: AmountClearingCandidate): 'positive' | 'reversal' | 'ignored' {
  const amt = c.commission_amount;
  const txn = String(c.raw_json?.transaction_type ?? c.raw_json?.statement_type ?? '').toLowerCase();
  const clawbackHint = txn.includes('clawback') || txn.includes('reversal') || txn.includes('chargeback');
  if (clawbackHint && amt != null && amt !== 0) return 'reversal';
  if (amt == null || amt === 0) return 'ignored';
  if (amt < 0) return 'reversal';
  return 'positive';
}

export function evaluateCrossBatchAmountClearing(args: {
  expected_amount: number | null | undefined;
  candidates: AmountClearingCandidate[];
}): AmountClearingResult {
  const empty: AmountClearingResult = {
    clearing_state: 'not_cleared',
    threshold_amount: null,
    actual_positive_amount: 0,
    actual_reversal_amount: 0,
    actual_net_amount: 0,
    remainder_owed: null,
    matchedPaidRecordIds: [],
    reversalRecordIds: [],
    ignoredRecordIds: [],
    clearingStatementMonths: [],
  };

  if (args.expected_amount === 0) {
    return { ...empty, clearing_state: 'zero_expected_no_payment_required', threshold_amount: 0 };
  }
  if (args.expected_amount == null) {
    return { ...empty, clearing_state: 'manual_review_required', manual_review_reason: 'expected_amount_unresolvable' };
  }

  const positives: AmountClearingCandidate[] = [];
  const reversals: AmountClearingCandidate[] = [];
  const ignored: AmountClearingCandidate[] = [];
  for (const c of args.candidates) {
    const k = classify(c);
    if (k === 'positive') positives.push(c);
    else if (k === 'reversal') reversals.push(c);
    else ignored.push(c);
  }

  const positivesSum = positives.reduce((s, p) => s + Math.abs(p.commission_amount ?? 0), 0);
  const reversalsAbsSum = reversals.reduce((s, r) => s + Math.abs(r.commission_amount ?? 0), 0);
  const totalNet = positivesSum - reversalsAbsSum;

  const threshold = args.expected_amount * 0.7;
  const baseState = {
    threshold_amount: threshold,
    matchedPaidRecordIds: positives.map(p => p.id),
    reversalRecordIds: reversals.map(r => r.id),
    ignoredRecordIds: ignored.map(i => i.id),
  };

  if (positives.length === 0 && reversals.length === 0 && ignored.length > 0) {
    return {
      ...empty,
      ...baseState,
      clearing_state: 'not_cleared',
      reason: 'no_positive_payment_found',
      remainder_owed: args.expected_amount,
    };
  }
  if (positives.length === 0 && reversals.length === 0 && ignored.length === 0) {
    return {
      ...empty,
      ...baseState,
      clearing_state: 'not_cleared',
      reason: 'no_payment_found',
      remainder_owed: args.expected_amount,
    };
  }

  const signedRows = [
    ...positives.map(p => ({ ...p, _signed: Math.abs(p.commission_amount ?? 0) })),
    ...reversals.map(r => ({ ...r, _signed: -Math.abs(r.commission_amount ?? 0) })),
  ].sort((a, b) => {
    if (a.statement_month !== b.statement_month) return a.statement_month < b.statement_month ? -1 : 1;
    const ac = a.created_at ?? '';
    const bc = b.created_at ?? '';
    return ac < bc ? -1 : ac > bc ? 1 : 0;
  });

  const clearingStatementMonths = Array.from(
    new Set(signedRows.map(r => r.statement_month))
  ).sort();

  let net = 0;
  let firstFullClear: string | null = null;
  let reversedAt: string | null = null;
  let reachedThresholdEver = false;

  for (const r of signedRows) {
    const isReversal = r._signed < 0;

    if (isReversal && !reachedThresholdEver) {
      return {
        ...baseState,
        clearing_state: 'manual_review_required',
        manual_review_reason: 'reversal_without_prior_full_clear',
        actual_positive_amount: positivesSum,
        actual_reversal_amount: reversalsAbsSum,
        actual_net_amount: totalNet,
        remainder_owed: args.expected_amount,
        clearingStatementMonths,
      };
    }

    net += r._signed;

    if (net >= threshold) reachedThresholdEver = true;

    if (firstFullClear == null && net >= threshold) {
      firstFullClear = r.statement_month;
    } else if (firstFullClear != null && reversedAt == null && net < threshold) {
      reversedAt = r.statement_month;
    }
  }

  const remainder = Math.max(0, args.expected_amount - totalNet);

  if (reversedAt) {
    return {
      ...baseState,
      clearing_state: 'cleared_then_reversed',
      actual_positive_amount: positivesSum,
      actual_reversal_amount: reversalsAbsSum,
      actual_net_amount: totalNet,
      remainder_owed: remainder,
      clearingStatementMonths,
      firstFullClearStatementMonth: firstFullClear,
      reversedAtStatementMonth: reversedAt,
    };
  }
  if (firstFullClear) {
    return {
      ...baseState,
      clearing_state: 'fully_cleared',
      actual_positive_amount: positivesSum,
      actual_reversal_amount: reversalsAbsSum,
      actual_net_amount: totalNet,
      remainder_owed: remainder,
      clearingStatementMonths,
      firstFullClearStatementMonth: firstFullClear,
    };
  }
  return {
    ...baseState,
    clearing_state: 'partially_cleared',
    actual_positive_amount: positivesSum,
    actual_reversal_amount: reversalsAbsSum,
    actual_net_amount: totalNet,
    remainder_owed: remainder,
    clearingStatementMonths,
  };
}
