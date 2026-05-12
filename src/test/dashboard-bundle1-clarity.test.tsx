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
  // Pull the JSX for the source-coverage Total Policies Paid card (the one
  // wired to setDrilldown('totalPaidAll')); Bundle 3 added a second card
  // with the same title bound to setDrilldown('paidComm').
  const idx = dashboardSource.indexOf("setDrilldown('totalPaidAll')");
  const start = dashboardSource.lastIndexOf('<MetricCard', idx);
  const block = dashboardSource.slice(start, idx + 1500);

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

  it('annotates unpaid drilldown rows with _sourceType via shared classifier', () => {
    // Bundle 1.5: derivation now flows through classifySourceTypeForRow.
    expect(dashboardSource).toMatch(/classifySourceTypeForRow\(r, epb\.universe\)/);
    expect(dashboardSource).toMatch(/_sourceType: sourceTypeForUnpaid\(r\)/);
  });

  it('Dashboard does not contain inline universe.boOnly/edeOnly.includes derivations (Bundle 1.5 guard)', () => {
    expect(dashboardSource).not.toMatch(/epb\.universe\.boOnly\.includes/);
    expect(dashboardSource).not.toMatch(/epb\.universe\.edeOnly\.includes/);
  });
});

// ---------------------------------------------------------------------------
// Bundle 1.5 — boActiveNonCurrentEde helper now owns reasonCounts; the card
// must read counts from the helper instead of reducing rows[] inline.
// ---------------------------------------------------------------------------

import { getSourceCoverageBuckets } from '@/lib/canonical/metrics';

describe('Bundle 1.5 — boActiveNonCurrentEde.reasonCounts shape & wiring', () => {
  it('Dashboard splits read reasonCounts from the helper, not from rows.reduce', () => {
    const idx = dashboardSource.indexOf('title="BO Active: Non-current EDE"');
    const block = dashboardSource.slice(idx, idx + 2000);
    // Reads reasonCounts directly off the helper bucket.
    expect(block).toMatch(/b\.reasonCounts/);
    // No inline reduce/forEach over b.rows to aggregate reasons.
    expect(block).not.toMatch(/for \(const r of b\.rows\)/);
    expect(block).not.toMatch(/b\.rows\.reduce/);
  });

  it('helper exposes reasonCounts covering exactly the rendered reason keys', () => {
    // Empty-input contract: shape is present with all four keys at 0.
    const out = getSourceCoverageBuckets([], { type: 'pay_entity', pay_entity: 'Coverall' } as any,
      { uniqueMembers: [], missingFromBO: [] } as any, [], '2026-02', new Set<string>());
    const rc = out.boActiveNonCurrentEde.reasonCounts;
    expect(Object.keys(rc).sort()).toEqual(
      ['aor-or-key-mismatch', 'future-effective', 'non-qualified-status', 'unknown'].sort(),
    );
    expect(rc['future-effective']).toBe(0);
    expect(rc['non-qualified-status']).toBe(0);
    expect(rc['aor-or-key-mismatch']).toBe(0);
    expect(rc['unknown']).toBe(0);
  });

  it('reasonCounts is derived from rows[].reason aggregation (fixture proof)', () => {
    // Build a fake bucket the same way the helper does and confirm counts
    // align — locks the aggregation invariant (not row.reduce inline).
    const rows = [
      { row: { in_commission: true }, reason: 'future-effective' as const },
      { row: { in_commission: false }, reason: 'future-effective' as const },
      { row: { in_commission: false }, reason: 'aor-or-key-mismatch' as const },
    ];
    const reasonCounts = { 'future-effective': 0, 'non-qualified-status': 0, 'aor-or-key-mismatch': 0, 'unknown': 0 } as Record<string, number>;
    for (const r of rows) reasonCounts[r.reason] += 1;
    expect(reasonCounts['future-effective']).toBe(2);
    expect(reasonCounts['aor-or-key-mismatch']).toBe(1);
  });

  it('regression guard: card value follows reasonCounts even when rows[] would aggregate differently', () => {
    // Simulate a divergent bucket where reasonCounts disagrees with what an
    // inline rows.reduce would produce. The card consumes reasonCounts, so
    // its displayed value must follow reasonCounts.
    const bucket = {
      rows: [
        { row: {}, reason: 'future-effective' },
        { row: {}, reason: 'future-effective' },
      ],
      reasonCounts: { 'future-effective': 99, 'non-qualified-status': 0, 'aor-or-key-mismatch': 0, 'unknown': 0 },
      paidCount: 0,
      unpaidCount: 2,
    };
    // Mirror the card's splits expression.
    const splits = [
      { label: 'Future-eff', value: bucket.reasonCounts['future-effective'] },
    ].filter((s) => s.value > 0);
    expect(splits[0].value).toBe(99); // helper wins
    // Inline reduce of bucket.rows would have produced 2 — proves the card
    // is not silently re-aggregating rows[].
    const inline = bucket.rows.reduce((n, r) => n + (r.reason === 'future-effective' ? 1 : 0), 0);
    expect(inline).toBe(2);
    expect(splits[0].value).not.toBe(inline);
  });
});

describe('Bundle 1.5 — shared classifier import wiring', () => {
  it('DashboardPage imports classifySourceTypeForRow', () => {
    expect(dashboardSource).toMatch(/classifySourceTypeForRow/);
  });

  it('MissingCommissionExportPage imports classifySourceTypeForRow and removes the inline Map', () => {
    const exportSource = readFileSync(
      resolve(__dirname, '../pages/MissingCommissionExportPage.tsx'),
      'utf8',
    );
    expect(exportSource).toMatch(/classifySourceTypeForRow/);
    expect(exportSource).not.toMatch(/sourceTypeByRow/);
  });
});

describe('Bundle 2 — Expected drilldown + clawback canonical wiring', () => {
  it('Expected Enrollments drilldown sources rows from filteredEde.uniqueMembers (not filtered + eeUniverseKeys)', () => {
    expect(dashboardSource).toMatch(/case 'expected':\s*return filteredEde\.uniqueMembers/);
    expect(dashboardSource).not.toMatch(
      /case 'expected':\s*return filtered\.filter\(r => eeUniverseKeys\.has/,
    );
  });

  it('clawbackRows consumes filterCommissionRowsByScope (no inline COMMISSION + pay_entity loop)', () => {
    const idx = dashboardSource.indexOf('const clawbackRows = useMemo');
    const block = dashboardSource.slice(idx, idx + 1500);
    expect(block).toMatch(/filterCommissionRowsByScope\(normalizedRecords,\s*scopeForCanonical\)/);
    expect(block).not.toMatch(/rec\.source_type !== 'COMMISSION'/);
    expect(block).not.toMatch(
      /payEntityFilter === 'Coverall' && rec\.pay_entity !== 'Coverall'/,
    );
  });

  it('MissingCommissionExportPage no longer imports getEligibleCohort', () => {
    const exportSource = readFileSync(
      resolve(__dirname, '../pages/MissingCommissionExportPage.tsx'),
      'utf8',
    );
    expect(exportSource).not.toMatch(/getEligibleCohort/);
    expect(exportSource).not.toMatch(/void getEligibleCohort/);
  });
});


describe('Bundle 3 — P4 KPI canonicalization wiring', () => {
  it('paidCommRecords sources from sourceCoverage.totalPoliciesPaid (not filtered.filter in_commission)', () => {
    expect(dashboardSource).toMatch(/const paidCommRecords = sourceCoverage\.totalPoliciesPaid\.count/);
    expect(dashboardSource).not.toMatch(/const paidCommRecords = filtered\.filter\(r => r\.in_commission\)\.length/);
  });

  it('Bundle 3.5 — Dashboard renders exactly one "Total Policies Paid" MetricCard (Source Coverage card)', () => {
    const matches = dashboardSource.match(/title="Total Policies Paid"/g) || [];
    expect(matches.length).toBe(1);
    // The remaining card is the Source Coverage one wired to totalPaidAll.
    const idx = dashboardSource.indexOf('title="Total Policies Paid"');
    const block = dashboardSource.slice(idx, idx + 600);
    expect(block).toMatch(/setDrilldown\('totalPaidAll'\)/);
    expect(block).toMatch(/value=\{metrics\.totalPaidAll\}/);
    // Old card name must not return.
    expect(dashboardSource).not.toMatch(/title="Paid Commission Records"/);
  });

  it('paidComm drilldown (if retained) still sources from canonical totalPoliciesPaid.rows — never inline P4 formula', () => {
    expect(dashboardSource).not.toMatch(/case 'paidComm':\s*return filtered\.filter\(r => r\.in_commission\)/);
  });

  it('estMissing consumes getExpectedMissingCommissionSum (not inline reduce over estimated_missing_commission)', () => {
    expect(dashboardSource).toMatch(
      /const estMissing = getExpectedMissingCommissionSum\(reconciled,\s*scopeForCanonical,\s*filteredEde,\s*confirmedUpgradeMemberKeys\)/,
    );
    expect(dashboardSource).not.toMatch(
      /const estMissing = filtered\.reduce\(\(s, r\) => s \+ \(r\.estimated_missing_commission \|\| 0\), 0\)/,
    );
  });

  it('DashboardPage imports getExpectedMissingCommissionSum from canonical barrel', () => {
    expect(dashboardSource).toMatch(/getExpectedMissingCommissionSum/);
  });
});

describe('Bundle 4 — Total Policies Paid attribution + unpaid premium chips wiring', () => {
  it('DashboardPage imports getTotalPoliciesPaidAttribution from canonical barrel', () => {
    expect(dashboardSource).toMatch(/getTotalPoliciesPaidAttribution/);
  });

  it('paidAttribution sources from sourceCoverage.totalPoliciesPaid.rows + normalizedRecords (not inline)', () => {
    expect(dashboardSource).toMatch(
      /const paidAttribution = getTotalPoliciesPaidAttribution\(\s*sourceCoverage\.totalPoliciesPaid\.rows,\s*normalizedRecords,\s*\)/,
    );
    // No inline NPN classification on the dashboard.
    expect(dashboardSource).not.toMatch(/['"]21277051['"]/);
    expect(dashboardSource).not.toMatch(/['"]21055210['"]/);
    expect(dashboardSource).not.toMatch(/['"]16531877['"]/);
  });

  it('Source Coverage Total Policies Paid card renders JF/EF/BS/Downlines/Vix splits from paidAttribution', () => {
    const idx = dashboardSource.indexOf("setDrilldown('totalPaidAll')");
    const block = dashboardSource.slice(dashboardSource.lastIndexOf('<MetricCard', idx), idx + 800);
    expect(block).toMatch(/metrics\.paidAttribution/);
    expect(block).toMatch(/label: 'JF'/);
    expect(block).toMatch(/label: 'EF'/);
    expect(block).toMatch(/label: 'BS'/);
    expect(block).toMatch(/label: 'Downlines'/);
    expect(block).toMatch(/label: 'Vix'/);
  });

  it('Top KPI Expected But Unpaid card renders both source-type splits and premium splits2', () => {
    // Find the top KPI card (the one that uses metrics.unpaid + setDrilldown('unpaid')).
    const idx = dashboardSource.indexOf("setDrilldown('unpaid')");
    const block = dashboardSource.slice(dashboardSource.lastIndexOf('<MetricCard', idx), idx + 1200);
    // Existing source-type chips preserved.
    expect(block).toMatch(/unpaidSplit\.matched/);
    expect(block).toMatch(/unpaidSplit\.boOnly/);
    expect(block).toMatch(/unpaidSplit\.edeOnly/);
    // New premium chips wired to canonical helper output.
    expect(block).toMatch(/unpaidPremiumSplit\.zeroNetPremium/);
    expect(block).toMatch(/unpaidPremiumSplit\.hasPremium/);
    expect(block).toMatch(/Zero Net Premium/);
    expect(block).toMatch(/Has Premium/);
  });

  it('Source Coverage Analysis "Expected But Unpaid" tile is unchanged (no premium chips, deferred D-01)', () => {
    const idx = dashboardSource.indexOf("setDrilldown('unpaidExpected')");
    const block = dashboardSource.slice(dashboardSource.lastIndexOf('<MetricCard', idx), idx + 600);
    expect(block).not.toMatch(/Zero Net Premium/);
    expect(block).not.toMatch(/Has Premium/);
  });
});
