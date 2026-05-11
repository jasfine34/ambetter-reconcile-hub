/**
 * Source Funnel — whole-batch diagnostic labeling tests.
 *
 * Pins the Option B2 cleanup:
 *   - Header reads "Source Funnel — Whole Batch Diagnostic".
 *   - Subtitle/tooltip explains it is not scope-filtered.
 *   - Prior covered month renders the carryover label.
 *   - Prior month is NOT suppressed when it has BO-only/commission values.
 *   - Component accepts no payEntityFilter/scope prop.
 *
 * No funnel math is exercised here — just labeling/structure.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { SourceFunnelCard } from '@/components/SourceFunnelCard';

vi.mock('@/contexts/BatchContext', () => ({
  useBatch: () => ({ resolverIndex: { byKey: new Map(), edges: [] } }),
}));

vi.mock('@/lib/classifier', () => ({
  computeFunnelForMonth: (_records: any, month: string) => {
    // Give prior month (2025-12) non-zero BO-only + commission so we can
    // assert it is NOT suppressed.
    if (month === '2025-12') {
      return {
        edeEligible: 0,
        edeAndBo: 0,
        edeAndBoAndCommission: 0,
        edeOnly: 0,
        boOnly: 1805,
        boOnlyPaid: 4,
      };
    }
    return {
      edeEligible: 100,
      edeAndBo: 90,
      edeAndBoAndCommission: 80,
      edeOnly: 10,
      boOnly: 50,
      boOnlyPaid: 40,
    };
  },
}));

vi.mock('@/lib/canonical/memberKeyMerge', () => ({
  mergeRecordsToMemberKeys: () => {},
}));

describe('SourceFunnelCard — whole-batch diagnostic labels', () => {
  const coveredMonths = ['2025-12', '2026-01'];
  const records: any[] = [{ member_key: 'm1' }];

  it('renders the whole-batch diagnostic header', () => {
    render(<SourceFunnelCard normalizedRecords={records} coveredMonths={coveredMonths} />);
    expect(screen.getByText(/Source Funnel — Whole Batch Diagnostic/i)).toBeTruthy();
  });

  it('renders the not-scope-filtered explanatory copy', () => {
    render(<SourceFunnelCard normalizedRecords={records} coveredMonths={coveredMonths} />);
    const subtitle = screen.getByTestId('source-funnel-subtitle');
    expect(subtitle.textContent || '').toMatch(/full batch/i);
    expect(subtitle.textContent || '').toMatch(/not filtered by All \/ Coverall \/ Vix/i);
  });

  it('renders the prior-month carryover label on the prior covered month only', () => {
    render(<SourceFunnelCard normalizedRecords={records} coveredMonths={coveredMonths} />);
    const priorLabel = screen.getByTestId('carryover-label-2025-12');
    expect(priorLabel.textContent || '').toMatch(/Prior month carryover — current batch as-of view/);
    expect(screen.queryByTestId('carryover-label-2026-01')).toBeNull();
  });

  it('does not suppress the prior month even when it has only BO-only/commission values', () => {
    render(<SourceFunnelCard normalizedRecords={records} coveredMonths={coveredMonths} />);
    // Prior-month carryover label appears = the row was rendered.
    expect(screen.getByTestId('carryover-label-2025-12')).toBeTruthy();
    // BO-only count from the mocked prior-month funnel is present in the DOM.
    expect(screen.getByText('1,805')).toBeTruthy();
  });

  it('does not accept or require a payEntityFilter/scope prop', () => {
    // Type-level guard: rendering without any scope prop must compile and
    // produce the diagnostic header. If a scope prop were added, this test
    // would still pass — the static guard below pins the source.
    render(<SourceFunnelCard normalizedRecords={records} coveredMonths={coveredMonths} />);
    expect(screen.getByText(/Whole Batch Diagnostic/i)).toBeTruthy();
  });
});

describe('SourceFunnelCard — scope-blind source guard', () => {
  it('source does not reference payEntityFilter or a scope prop', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/SourceFunnelCard.tsx'),
      'utf8',
    );
    expect(src).not.toMatch(/payEntityFilter/);
    expect(src).not.toMatch(/scope\s*[:?]/);
  });
});
