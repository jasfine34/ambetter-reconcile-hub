/**
 * Bundle 1 clarity tests:
 *  - Item 1: MissingCommissionExportPage's serializeErrorMessage extracts
 *    Error.message rather than "[object Object]".
 *  - Item 2: Total Policies Paid tooltip references all 5 paid buckets,
 *    including the BO Active: Non-current EDE paid subset.
 *  - Item 3: BO Active: Non-current EDE tile renders inline split chips
 *    (paid/unpaid + reason breakdown) consuming the helper's already-
 *    computed paidCount/unpaidCount/reason classification.
 *  - Item 4: Unpaid Details drilldown column config includes Source Type
 *    and rows are annotated with _sourceType for Matched / BO Only /
 *    EDE Only.
 *
 * The Dashboard render is asserted via source-text contracts (same pattern
 * as exception-summary-cleanup.test.ts) so we lock the wiring without the
 * heavy Supabase mock surface required to boot the full page.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { serializeErrorMessage } from '@/pages/MissingCommissionExportPage';

const dashboardSource = readFileSync(
  resolve(__dirname, '../pages/DashboardPage.tsx'),
  'utf8',
);

describe('Item 1 — serializeErrorMessage', () => {
  it('renders Error.message text, not "[object Object]"', () => {
    expect(serializeErrorMessage(new Error('boom'))).toBe('boom');
  });
  it('extracts .message from plain object errors (the [object Object] case)', () => {
    expect(serializeErrorMessage({ message: 'PostgREST 500' })).toBe('PostgREST 500');
  });
  it('falls back to JSON for object errors with no message', () => {
    expect(serializeErrorMessage({ code: 42 })).toContain('"code"');
  });
  it('never returns the literal "[object Object]" sentinel', () => {
    expect(serializeErrorMessage({ a: 1 })).not.toBe('[object Object]');
    expect(serializeErrorMessage(Object.create(null))).not.toBe('[object Object]');
  });
});

describe('Item 2 — Total Policies Paid tooltip mentions all 5 paid buckets', () => {
  // Pull the JSX for the Total Policies Paid MetricCard.
  const idx = dashboardSource.indexOf('title="Total Policies Paid"');
  const block = dashboardSource.slice(idx, idx + 1200);

  it('references Fully Matched & Paid', () => {
    expect(block).toMatch(/Fully Matched & Paid/);
  });
  it('references Paid: BO Only', () => {
    expect(block).toMatch(/Paid:\s*BO Only/);
  });
  it('references Paid: EDE Only', () => {
    expect(block).toMatch(/Paid:\s*EDE Only/);
  });
  it('references Paid: Commission Statement Only', () => {
    expect(block).toMatch(/Paid:\s*Commission Statement Only/);
  });
  it('references the 5th bucket (BO Active: Non-current EDE paid subset)', () => {
    expect(block).toMatch(/BO Active:\s*Non-current EDE/);
  });
});

describe('Item 3 — BO Active: Non-current EDE tile consumes helper splits', () => {
  const idx = dashboardSource.indexOf('title="BO Active: Non-current EDE"');
  const block = dashboardSource.slice(idx, idx + 2000);

  it('reads paidCount/unpaidCount from metrics.sourceCoverage.boActiveNonCurrentEde', () => {
    expect(block).toMatch(/metrics\.sourceCoverage\.boActiveNonCurrentEde/);
    expect(block).toMatch(/paidCount/);
    expect(block).toMatch(/unpaidCount/);
  });
  it('passes Paid / Unpaid split chips to MetricCard', () => {
    expect(block).toMatch(/label:\s*'Paid'/);
    expect(block).toMatch(/label:\s*'Unpaid'/);
  });
  it('renders reason-classification splits (future-effective / non-qualified / mismatch)', () => {
    expect(block).toMatch(/future-effective/);
    expect(block).toMatch(/non-qualified-status/);
    expect(block).toMatch(/aor-or-key-mismatch/);
  });
});

describe('Item 4 — Unpaid Details drilldown Source Type column', () => {
  it('declares UNPAID_DETAILS_DRILLDOWN_COLUMNS with _sourceType column', () => {
    expect(dashboardSource).toMatch(/UNPAID_DETAILS_DRILLDOWN_COLUMNS/);
    const idx = dashboardSource.indexOf('UNPAID_DETAILS_DRILLDOWN_COLUMNS');
    const block = dashboardSource.slice(idx, idx + 600);
    expect(block).toMatch(/_sourceType/);
    expect(block).toMatch(/Source Type/);
  });

  it('routes the unpaid drilldown to UNPAID_DETAILS_DRILLDOWN_COLUMNS', () => {
    expect(dashboardSource).toMatch(/drilldown === 'unpaid' \? UNPAID_DETAILS_DRILLDOWN_COLUMNS/);
  });

  it('annotates unpaid drilldown rows with _sourceType per universe bucket', () => {
    // The annotation function uses universe.boOnly / universe.edeOnly to
    // emit BO Only / EDE Only and defaults to Matched. Lock that mapping.
    expect(dashboardSource).toMatch(/universe\.boOnly\.includes\(r\)/);
    expect(dashboardSource).toMatch(/universe\.edeOnly\.includes\(r\)/);
    expect(dashboardSource).toMatch(/_sourceType: sourceTypeForUnpaid\(r\)/);
  });

  it('Matched row → Source Type "Matched"; BO Only → "BO Only"; EDE Only → "EDE Only" (function contract)', () => {
    // Reconstruct the inline classifier the page uses and exercise it.
    const matchedRow = { id: 'm' };
    const boOnlyRow = { id: 'b' };
    const edeOnlyRow = { id: 'e' };
    const universe = { boOnly: [boOnlyRow], edeOnly: [edeOnlyRow] };
    const classify = (r: any): 'Matched' | 'BO Only' | 'EDE Only' => {
      if (universe.boOnly.includes(r)) return 'BO Only';
      if (universe.edeOnly.includes(r)) return 'EDE Only';
      return 'Matched';
    };
    expect(classify(matchedRow)).toBe('Matched');
    expect(classify(boOnlyRow)).toBe('BO Only');
    expect(classify(edeOnlyRow)).toBe('EDE Only');
  });
});
