/**
 * Assembly-layer no-source invariant tests (v4).
 *
 * Covers the 4 new canaries (Charlton Howard, Gina Huckstead, Marc Hodges,
 * Mary Williams) where the classifier-internal source view found enough
 * evidence to mark a cell unpaid/pending/premium_unpaid, but the
 * displayed/exported source flags (in_ede/in_back_office/in_commission) are
 * all false. The fix in src/lib/memberTimeline.ts exposes
 * applyNoSourceInvariantToMonthCell() which the page-level merge loop calls
 * after copying classifier state onto each displayed MonthCell.
 */
import { describe, it, expect } from 'vitest';
import {
  applyNoSourceInvariantToMonthCell,
  exportStatusForMonthCell,
  type MonthCell,
} from '@/lib/memberTimeline';
import type { ClassificationState } from '@/lib/classifier';

function cell(overrides: Partial<MonthCell>): MonthCell {
  return {
    month: '2026-01',
    in_ede: false,
    in_back_office: false,
    in_commission: false,
    paid_amount: 0,
    payment_count: 0,
    due: false,
    ...overrides,
  };
}

const POISONED_STATES: ClassificationState[] = [
  'unpaid',
  'pending',
  'not_expected_premium_unpaid',
];

describe('applyNoSourceInvariantToMonthCell — assembly-layer guard', () => {
  it('clears state AND due when all displayed source flags are false', () => {
    for (const state of POISONED_STATES) {
      const c = cell({ state, due: true });
      const out = applyNoSourceInvariantToMonthCell(c);
      expect(out.state).toBe('not_expected_cancelled');
      expect(out.due).toBe(false);
      expect(out.state_reason).toMatch(/No current EDE/);
      // Export status must NOT be UNPAID/PENDING/REVIEW
      expect(['UNPAID', 'PENDING', 'REVIEW']).not.toContain(
        exportStatusForMonthCell(out),
      );
      // No source flags → exporter returns blank for not_expected_* states
      expect(exportStatusForMonthCell(out)).toBe('');
    }
  });

  it('preserves state when in_back_office=true (active BO regression guard)', () => {
    const c = cell({ state: 'unpaid', due: true, in_back_office: true });
    const out = applyNoSourceInvariantToMonthCell(c);
    expect(out.state).toBe('unpaid');
    expect(out.due).toBe(true);
  });

  it('preserves state when in_ede=true (active EDE regression guard)', () => {
    const c = cell({ state: 'pending', due: true, in_ede: true });
    const out = applyNoSourceInvariantToMonthCell(c);
    expect(out.state).toBe('pending');
    expect(out.due).toBe(true);
  });

  it('preserves state when in_commission=true with paid_amount > 0', () => {
    const c = cell({
      state: 'paid',
      due: true,
      in_commission: true,
      paid_amount: 42.5,
    });
    const out = applyNoSourceInvariantToMonthCell(c);
    expect(out.state).toBe('paid');
    expect(out.paid_amount).toBe(42.5);
  });

  it('mixed-source: only the all-false month gets overridden', () => {
    const cellWithSource = cell({
      month: '2026-03',
      state: 'paid',
      in_commission: true,
      paid_amount: 100,
      due: true,
    });
    const cellEmpty = cell({
      month: '2026-04',
      state: 'pending',
      due: true,
    });
    expect(applyNoSourceInvariantToMonthCell(cellWithSource).state).toBe('paid');
    expect(applyNoSourceInvariantToMonthCell(cellEmpty).state).toBe(
      'not_expected_cancelled',
    );
  });

  it('Charlton Howard pattern — premium_unpaid then pending, all sources empty → all not_expected_cancelled', () => {
    const months = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05'];
    const states: ClassificationState[] = [
      'not_expected_premium_unpaid',
      'not_expected_premium_unpaid',
      'not_expected_premium_unpaid',
      'pending',
      'pending',
    ];
    let monthsDue = 0;
    for (let i = 0; i < months.length; i++) {
      const out = applyNoSourceInvariantToMonthCell(
        cell({ month: months[i], state: states[i], due: states[i] === 'pending' }),
      );
      expect(out.state).toBe('not_expected_cancelled');
      expect(out.due).toBe(false);
      if (out.state === 'pending' || out.state === 'unpaid' || out.state === 'manual_review' || out.state === 'paid') {
        monthsDue++;
      }
    }
    expect(monthsDue).toBe(0);
  });

  it('Gina Huckstead pattern — single Jan unpaid with empty sources → not_expected_cancelled', () => {
    const out = applyNoSourceInvariantToMonthCell(
      cell({ month: '2026-01', state: 'unpaid', due: true }),
    );
    expect(out.state).toBe('not_expected_cancelled');
    expect(out.due).toBe(false);
    expect(exportStatusForMonthCell(out)).toBe('');
  });

  it('Marc Hodges / Mary Williams pattern — same as Charlton', () => {
    const out = applyNoSourceInvariantToMonthCell(
      cell({ month: '2026-04', state: 'pending', due: true }),
    );
    expect(out.state).toBe('not_expected_cancelled');
    expect(out.due).toBe(false);
  });

  it('static invariant — for any all-false-source MonthCell, post-guard state is not UNPAID/PENDING/REVIEW', () => {
    for (const state of POISONED_STATES) {
      const out = applyNoSourceInvariantToMonthCell(cell({ state, due: true }));
      expect(out.state.startsWith('not_expected')).toBe(true);
      const exp = exportStatusForMonthCell(out);
      expect(['UNPAID', 'PENDING', 'REVIEW']).not.toContain(exp);
    }
  });

  it('idempotent — applying twice yields same result', () => {
    const c = cell({ state: 'unpaid', due: true });
    const once = applyNoSourceInvariantToMonthCell(c);
    const twice = applyNoSourceInvariantToMonthCell(once);
    expect(twice).toEqual(once);
  });

  it('does not touch cells already classified as not_expected_* with no sources', () => {
    const c = cell({ state: 'not_expected_cancelled', due: false });
    const out = applyNoSourceInvariantToMonthCell(c);
    expect(out.state).toBe('not_expected_cancelled');
    expect(out.due).toBe(false);
  });
});
