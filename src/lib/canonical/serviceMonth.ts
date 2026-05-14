/**
 * Bundle 13b — derive covered service months from paid_to_date + months_paid.
 */
import { addMonths, statementMonthKey } from '@/lib/dateRange';
import { isValidMonthKey } from './monthKey';

export type CoveredMonthsResult =
  | { status: 'resolved'; months: string[] }
  | { status: 'unresolvable'; reason: 'service_month_unresolvable'; missing: string[] };

export function deriveCoveredServiceMonths(args: {
  paid_to_date: string | Date | null | undefined;
  months_paid: number | string | null | undefined;
}): CoveredMonthsResult {
  const missing: string[] = [];
  const ptd = args.paid_to_date == null ? '' : String(args.paid_to_date);
  const lastKey = statementMonthKey(ptd);
  if (!isValidMonthKey(lastKey)) missing.push('paid_to_date');
  let mp: number | null = null;
  if (args.months_paid == null || args.months_paid === '') {
    missing.push('months_paid');
  } else {
    const n = typeof args.months_paid === 'number' ? args.months_paid : Number(args.months_paid);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) missing.push('months_paid');
    else mp = n;
  }
  if (missing.length > 0) return { status: 'unresolvable', reason: 'service_month_unresolvable', missing };
  const months: string[] = [];
  for (let i = mp! - 1; i >= 0; i--) {
    months.push(addMonths(lastKey, -i));
  }
  return { status: 'resolved', months };
}
