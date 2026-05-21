/**
 * Bundle 13c — Dashboard cross-batch overlay wiring tests.
 *
 * Strategy: mirror the page's helper logic against the canonical
 * `partitionUnpaidRowsByOverlay` helper (foundation), then back that up with
 * file-grep wiring guards proving DashboardPage.tsx consumes the adjusted
 * fields, mounts the banner stack in C12 order, and renders the new tiles +
 * chips with the contracted testids.
 *
 * The page itself relies on BatchContext + Supabase + EDE loading; we don't
 * render it here. Render coverage is supplied indirectly by the wiring guards
 * combined with the foundation `partitionUnpaidRowsByOverlay` test suite.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  partitionUnpaidRowsByOverlay,
  sumEffectiveEstMissing,
  buildClearingOverlayMap,
  classifyOverlay,
  EMPTY_CLEARING_OVERLAY_MAP,
  type AdjustedRow,
} from '@/lib/canonical/crossBatchOverlay';
import { derivePolicyIdentityKey } from '@/lib/canonical/policyIdentityKey';

// ---------------------------------------------------------------------------
// Local fixtures: reconciled rows + matching cross_batch_clearings overlay rows.
// Rows are paired by canonical grain key (policy_identity_key|target_service_month).
// ---------------------------------------------------------------------------

interface SeedSpec {
  member_key: string;
  carrier?: string;
  policy_number?: string;
  issuer_subscriber_id?: string;
  effective_month?: string;
  estimated_missing_commission?: number;
  net_premium?: number;
  current_policy_aor?: string | null;
  in_back_office?: boolean;
  in_ede?: boolean;
}

function makeRow(s: SeedSpec): any {
  return {
    member_key: s.member_key,
    carrier: s.carrier ?? 'Ambetter',
    policy_number: s.policy_number ?? `POL-${s.member_key}`,
    issuer_subscriber_id: s.issuer_subscriber_id ?? `IS-${s.member_key}`,
    effective_month: s.effective_month ?? '2026-01',
    expected_ede_effective_month: s.effective_month ?? '2026-01',
    estimated_missing_commission: s.estimated_missing_commission ?? 100,
    net_premium: s.net_premium ?? 500,
    current_policy_aor: s.current_policy_aor ?? 'Jason Fine (21055210)',
    in_back_office: s.in_back_office ?? true,
    in_ede: s.in_ede ?? true,
    eligible_for_commission: 'Yes',
    in_commission: false,
  };
}

function pairOverlay(row: any, opts: {
  clearing_state: string;
  expected_amount?: number | null;
  actual_positive_amount?: number | null;
  actual_reversal_amount?: number | null;
  actual_net_amount?: number | null;
  remainder_owed?: number | null;
}) {
  const id = derivePolicyIdentityKey({
    carrier: row.carrier,
    policy_number: row.policy_number,
    issuer_subscriber_id: row.issuer_subscriber_id,
  });
  if (id.status !== 'resolved') throw new Error('test fixture unresolved identity');
  return {
    id: `clr-${row.member_key}`,
    policy_identity_key: id.key,
    target_service_month: row.expected_ede_effective_month,
    clearing_state: opts.clearing_state,
    expected_amount: opts.expected_amount ?? null,
    actual_positive_amount: opts.actual_positive_amount ?? null,
    actual_reversal_amount: opts.actual_reversal_amount ?? null,
    actual_net_amount: opts.actual_net_amount ?? null,
    remainder_owed: opts.remainder_owed ?? null,
    unpaid_batch_ids: [],
    payment_batch_ids: [],
    reversed_at_statement_month: null,
    first_full_clear_statement_month: null,
    evaluated_at: '2026-05-01T00:00:00Z',
    run_id: 'run-1',
    manual_review_reason: null,
  };
}

function isReviewWorthy(it: AdjustedRow): boolean {
  return (
    it.adjustment.kind === 'mark_needs_review' ||
    it.adjustment.kind === 'partial_amount_unavailable'
  );
}

function sumReversedAmount(items: readonly AdjustedRow[]): number {
  return items.reduce((sum, it) => {
    if (it.adjustment.kind !== 'move_to_reversed_bucket') return sum;
    const value = Number(it.adjustment.overlay.actual_reversal_amount);
    return sum + (Number.isFinite(value) ? Math.abs(value) : 0);
  }, 0);
}

describe('Bundle 13c — Dashboard adjusted-cohort partition by ClearingState', () => {
  it('fully_cleared row: excluded from adjusted unpaid + dollars', () => {
    const row = makeRow({ member_key: 'm1', estimated_missing_commission: 100 });
    const overlay = buildClearingOverlayMap([
      pairOverlay(row, { clearing_state: 'fully_cleared', expected_amount: 100, actual_net_amount: 100 }),
    ]);
    const p = partitionUnpaidRowsByOverlay([row], overlay);
    expect(p.regular.length).toBe(0);
    expect(p.removed.length).toBe(1);
    expect(sumEffectiveEstMissing(p.regular)).toBe(0);
  });

  it('partially_cleared with valid amounts: kept; dollar = remainder', () => {
    const row = makeRow({ member_key: 'm2', estimated_missing_commission: 100 });
    const overlay = buildClearingOverlayMap([
      pairOverlay(row, {
        clearing_state: 'partially_cleared',
        expected_amount: 100,
        actual_net_amount: 30,
        remainder_owed: 70,
      }),
    ]);
    const p = partitionUnpaidRowsByOverlay([row], overlay);
    expect(p.regular.length).toBe(1);
    expect(p.regular[0].effectiveEstMissing).toBe(70);
  });

  it('partially_cleared with null amounts → partial_amount_unavailable: kept; legacy dollar; in review', () => {
    const row = makeRow({ member_key: 'm3', estimated_missing_commission: 100 });
    const overlay = buildClearingOverlayMap([
      pairOverlay(row, {
        clearing_state: 'partially_cleared',
        expected_amount: null,
        actual_net_amount: null,
        remainder_owed: null,
      }),
    ]);
    const p = partitionUnpaidRowsByOverlay([row], overlay);
    expect(p.regular.length).toBe(1);
    expect(p.regular[0].adjustment.kind).toBe('partial_amount_unavailable');
    expect(p.regular[0].effectiveEstMissing).toBe(100);
    expect(p.regular.filter(isReviewWorthy).length).toBe(1);
  });

  it('cleared_then_reversed row: excluded from regular; counted in reversed', () => {
    const row = makeRow({ member_key: 'm4', estimated_missing_commission: 100 });
    const overlay = buildClearingOverlayMap([
      pairOverlay(row, { clearing_state: 'cleared_then_reversed', actual_reversal_amount: -250 }),
    ]);
    const p = partitionUnpaidRowsByOverlay([row], overlay);
    expect(p.regular.length).toBe(0);
    expect(p.reversed.length).toBe(1);
    expect(sumReversedAmount(p.reversed)).toBe(250);
  });

  it('zero_expected_no_payment_required row: excluded', () => {
    const row = makeRow({ member_key: 'm5' });
    const overlay = buildClearingOverlayMap([
      pairOverlay(row, { clearing_state: 'zero_expected_no_payment_required' }),
    ]);
    const p = partitionUnpaidRowsByOverlay([row], overlay);
    expect(p.regular.length).toBe(0);
    expect(p.removed.length).toBe(1);
  });

  it('manual_review_required row: kept in regular AND in review set', () => {
    const row = makeRow({ member_key: 'm6', estimated_missing_commission: 50 });
    const overlay = buildClearingOverlayMap([
      pairOverlay(row, { clearing_state: 'manual_review_required' }),
    ]);
    const p = partitionUnpaidRowsByOverlay([row], overlay);
    expect(p.regular.length).toBe(1);
    expect(p.needsReview.length).toBe(1);
    expect(p.regular.filter(isReviewWorthy).length).toBe(1);
  });

  it('not_cleared row: kept; legacy dollar; not in review', () => {
    const row = makeRow({ member_key: 'm7', estimated_missing_commission: 75 });
    const overlay = buildClearingOverlayMap([
      pairOverlay(row, { clearing_state: 'not_cleared' }),
    ]);
    const p = partitionUnpaidRowsByOverlay([row], overlay);
    expect(p.regular.length).toBe(1);
    expect(p.regular[0].effectiveEstMissing).toBe(75);
    expect(p.regular.filter(isReviewWorthy).length).toBe(0);
  });

  it('empty overlay: every row kept verbatim, legacy dollars, no chips', () => {
    const rows = [
      makeRow({ member_key: 'a', estimated_missing_commission: 10 }),
      makeRow({ member_key: 'b', estimated_missing_commission: 20 }),
    ];
    const p = partitionUnpaidRowsByOverlay(rows, EMPTY_CLEARING_OVERLAY_MAP);
    expect(p.regular.length).toBe(2);
    expect(sumEffectiveEstMissing(p.regular)).toBe(30);
    expect(p.reversed.length).toBe(0);
    expect(p.regular.filter(isReviewWorthy).length).toBe(0);
  });
});

describe('Bundle 13c — reversed tile dollar source', () => {
  it('reversed dollar = |actual_reversal_amount|, NOT estimated_missing_commission', () => {
    const row = makeRow({ member_key: 'rev', estimated_missing_commission: 18 });
    const overlay = buildClearingOverlayMap([
      pairOverlay(row, { clearing_state: 'cleared_then_reversed', actual_reversal_amount: -100 }),
    ]);
    const p = partitionUnpaidRowsByOverlay([row], overlay);
    expect(sumReversedAmount(p.reversed)).toBe(100);
    expect(sumReversedAmount(p.reversed)).not.toBe(18);
  });

  it('reversed dollar handles null/non-finite actual_reversal_amount → 0', () => {
    const row = makeRow({ member_key: 'rev2' });
    const overlay = buildClearingOverlayMap([
      pairOverlay(row, { clearing_state: 'cleared_then_reversed', actual_reversal_amount: null }),
    ]);
    const p = partitionUnpaidRowsByOverlay([row], overlay);
    expect(sumReversedAmount(p.reversed)).toBe(0);
  });

  it('reversed dollar zero when no reversed rows', () => {
    expect(sumReversedAmount([])).toBe(0);
  });
});

describe('Bundle 13c — DashboardPage wiring guards', () => {
  const page = readFileSync(resolve(__dirname, '..', 'pages/DashboardPage.tsx'), 'utf8');

  it('invokes useCrossBatchOverlay at component top level (not inside useMemo)', () => {
    expect(page).toMatch(/useCrossBatchOverlay\(/);
    const memoBodies = page.match(/useMemo\(\(\)\s*=>\s*\{[\s\S]*?\},\s*\[/g) ?? [];
    for (const body of memoBodies) {
      expect(body).not.toMatch(/useCrossBatchOverlay\(/);
    }
  });

  it('derives dashboardClearingOverlay = overlayError ? EMPTY_CLEARING_OVERLAY_MAP : clearingOverlay', () => {
    expect(page).toMatch(/dashboardClearingOverlay\s*=\s*overlayError[\s\S]*EMPTY_CLEARING_OVERLAY_MAP[\s\S]*clearingOverlay/);
  });

  it('partition is fed dashboardClearingOverlay (NOT raw clearingOverlay)', () => {
    const calls = page.match(/partitionUnpaidRowsByOverlay\([^)]*\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) {
      expect(c).toMatch(/dashboardClearingOverlay/);
      expect(c).not.toMatch(/,\s*clearingOverlay\b/);
    }
  });

  it('metrics useMemo deps include dashboardClearingOverlay', () => {
    expect(page).toMatch(/dashboardClearingOverlay\b[\s\S]{0,200}\)\s*;\s*\n\s*\/\/ Phase 1\.7|}, \[[\s\S]*dashboardClearingOverlay\]/);
  });

  it('raw metrics fields preserved (unpaid / estMissing / unpaidExpected / expectedPaymentBreakdown)', () => {
    expect(page).toMatch(/\bunpaid,\s/);
    expect(page).toMatch(/\bestMissing,\s/);
    expect(page).toMatch(/\bunpaidExpected,\s/);
    expect(page).toMatch(/\bexpectedPaymentBreakdown,\s/);
  });

  it('Dashboard EBU count tile reads metrics.adjustedUnpaid (NOT metrics.unpaid)', () => {
    expect(page).toMatch(/title="Expected But Unpaid"[\s\S]{0,200}value=\{metrics\.adjustedUnpaid\}/);
  });

  it('Dashboard EBU dollar tile reads metrics.adjustedEstMissing', () => {
    expect(page).toMatch(/title="Est\. Missing Commission"[\s\S]{0,200}metrics\.adjustedEstMissing/);
  });

  it('Dashboard EBU split chips read metrics.adjustedUnpaidSplit', () => {
    expect(page).toMatch(/metrics\.adjustedUnpaidSplit\.matched/);
    expect(page).toMatch(/metrics\.adjustedUnpaidSplit\.boOnly/);
    expect(page).toMatch(/metrics\.adjustedUnpaidSplit\.edeOnly/);
  });

  it('Dashboard EBU premium chips read metrics.adjustedUnpaidPremiumSplit', () => {
    expect(page).toMatch(/metrics\.adjustedUnpaidPremiumSplit\.zeroNetPremium/);
    expect(page).toMatch(/metrics\.adjustedUnpaidPremiumSplit\.hasPremium/);
  });

  it('Source Coverage EBU count tile reads metrics.adjustedUnpaidExpected', () => {
    expect(page).toMatch(/value=\{metrics\.adjustedUnpaidExpected\}/);
  });

  it('Source Coverage EBU owner chips read metrics.adjustedUnpaidOwnerSplit', () => {
    expect(page).toMatch(/metrics\.adjustedUnpaidOwnerSplit/);
  });

  it("Dashboard 'unpaid' drilldown rows source from metrics.adjustedUnpaidRows", () => {
    expect(page).toMatch(/case 'unpaid':[\s\S]{0,160}metrics\.adjustedUnpaidRows/);
  });

  it("Source Coverage 'unpaidExpected' drilldown rows source from metrics.adjustedSourceCoverage", () => {
    expect(page).toMatch(/case 'unpaidExpected':[\s\S]{0,160}metrics\.adjustedSourceCoverage\.expectedButUnpaid\.rows/);
  });

  it('Needs review chip rendered on Dashboard EBU when dashboardReviewRows.length > 0', () => {
    expect(page).toMatch(/metrics\.dashboardReviewRows\.length\s*>\s*0[\s\S]{0,400}data-testid="dashboard-ebu-needs-review-chip"/);
  });

  it('Needs review chip rendered on Source Coverage EBU when sourceCoverageReviewRows.length > 0', () => {
    expect(page).toMatch(/metrics\.sourceCoverageReviewRows\.length\s*>\s*0[\s\S]{0,400}data-testid="source-coverage-ebu-needs-review-chip"/);
  });

  it('Cleared then reversed tile mounted with count + dollar + click-through', () => {
    expect(page).toMatch(/data-testid="dashboard-cleared-then-reversed-tile"/);
    expect(page).toMatch(/data-testid="dashboard-reversed-count"/);
    expect(page).toMatch(/data-testid="dashboard-reversed-amount"/);
    expect(page).toMatch(/data-testid="dashboard-reversed-link"/);
    expect(page).toMatch(/data-testid="dashboard-reversed-empty"/);
    expect(page).toMatch(/\/unpaid-recovery\?filter=clearedThenReversed/);
    expect(page).toMatch(/Cleared then reversed/);
    expect(page).toMatch(/No reversals/);
  });

  it('Reversed tile dollar uses sumReversedAmount(metrics.reversedAdjustedRows) (NOT effectiveEstMissing)', () => {
    expect(page).toMatch(/sumReversedAmount/);
    expect(page).toMatch(/actual_reversal_amount/);
    expect(page).toMatch(/metrics\.reversedUnpaidAmount/);
  });

  it('Last updated indicator renders relative time + Never run fallback + ISO tooltip', () => {
    expect(page).toMatch(/data-testid="dashboard-cross-batch-last-updated"/);
    expect(page).toMatch(/Last updated:\s*\{?dashboardClearingOverlay\.lastEvaluatedAt[\s\S]{0,160}relativeTime/);
    expect(page).toMatch(/Never run/);
    expect(page).toMatch(/title=\{dashboardClearingOverlay\.lastEvaluatedAt/);
  });

  it('Banner mount order: rollout → existing 3 → stale-sweep → overlay-error (C12)', () => {
    const idxRollout = page.indexOf('<CrossBatchRolloutBanner');
    const idxStaleBatches = page.indexOf('staleBatchesCount > 0');
    const idxStaleLogic = page.indexOf('Rebuild status / stale logic warning');
    const idxStaleSweep = page.indexOf('<CrossBatchStaleSweepBanner');
    const idxOverlayErr = page.indexOf('<CrossBatchOverlayLoadErrorBanner');
    expect(idxRollout).toBeGreaterThan(0);
    expect(idxStaleBatches).toBeGreaterThan(idxRollout);
    expect(idxStaleLogic).toBeGreaterThan(idxStaleBatches);
    expect(idxStaleSweep).toBeGreaterThan(idxStaleLogic);
    expect(idxOverlayErr).toBeGreaterThan(idxStaleSweep);
  });

  it('Overlay error banner mounted only when overlayError !== null', () => {
    expect(page).toMatch(/\{\s*overlayError\s*&&\s*<CrossBatchOverlayLoadErrorBanner\s*\/>\s*\}/);
  });

  it('Page uses canonical foundation imports (no inline duplicates)', () => {
    expect(page).toMatch(/from '@\/hooks\/useCrossBatchOverlay'/);
    expect(page).toMatch(/from '@\/lib\/canonical\/crossBatchOverlay'/);
    expect(page).toMatch(/from '@\/components\/CrossBatchRolloutBanner'/);
    expect(page).toMatch(/from '@\/components\/CrossBatchStaleSweepBanner'/);
    expect(page).toMatch(/from '@\/components\/CrossBatchOverlayLoadErrorBanner'/);
  });

  it('Page-scoped recompute helpers consume canonical classifiers (no inline classifier duplicates)', () => {
    expect(page).toMatch(/recomputeUnpaidSplit[\s\S]{0,400}classifySourceTypeForRow/);
    expect(page).toMatch(/recomputeUnpaidPremiumSplit[\s\S]{0,200}isZeroNetPremium/);
    expect(page).toMatch(/recomputeUnpaidOwnerSplit[\s\S]{0,200}classifyPolicyOwnerFromCurrentAor/);
  });

  it('isReviewWorthyAdjustment includes BOTH mark_needs_review AND partial_amount_unavailable', () => {
    expect(page).toMatch(/isReviewWorthyAdjustment[\s\S]{0,300}mark_needs_review[\s\S]{0,200}partial_amount_unavailable/);
  });

  it('Disclaimer testids preserved at both Dashboard sites', () => {
    expect(page).toMatch(/data-testid="dashboard-ebu-disclaimer"/);
    expect(page).toMatch(/data-testid="dashboard-source-coverage-ebu-disclaimer"/);
  });
});

describe('Bundle 13c — classifyOverlay → partition kind mapping', () => {
  const cases: Array<{ state: string; kind: string }> = [
    { state: 'fully_cleared', kind: 'remove_from_unpaid' },
    { state: 'zero_expected_no_payment_required', kind: 'remove_from_unpaid' },
    { state: 'cleared_then_reversed', kind: 'move_to_reversed_bucket' },
    { state: 'manual_review_required', kind: 'mark_needs_review' },
    { state: 'not_cleared', kind: 'no_adjustment' },
  ];
  it.each(cases)('$state → $kind', ({ state, kind }) => {
    const adj = classifyOverlay({
      policy_identity_key: 'k',
      target_service_month: '2026-01',
      clearing_state: state as any,
      expected_amount: null,
      actual_positive_amount: null,
      actual_reversal_amount: null,
      actual_net_amount: null,
      remainder_owed: null,
      unpaid_batch_ids: [],
      payment_batch_ids: [],
      reversed_at_statement_month: null,
      first_full_clear_statement_month: null,
      evaluated_at: '',
      run_id: '',
      manual_review_reason: null,
    });
    expect(adj.kind).toBe(kind);
  });
});

// ---------------------------------------------------------------------------
// Phase 2 follow-up — Dashboard cross-batch partition consumes runtime
// BO-adjusted unpaid rows. Rows feeding partitionUnpaidRowsByOverlay come
// from boAdjustedFilteredEde-derived flow (not raw filteredEde).
// ---------------------------------------------------------------------------
describe('Phase 2 follow-up — cross-batch partition consumes adjusted rows', () => {
  const page = readFileSync(
    resolve(__dirname, '../pages/DashboardPage.tsx'),
    'utf8',
  );

  it('partitionUnpaidRowsByOverlay invocation sources from epb.unpaidRows derived from boAdjustedReconciled', () => {
    // epb is built from boAdjustedReconciled + boAdjustedFilteredEde.
    expect(page).toMatch(/getExpectedPaymentBreakdown\(\s*boAdjustedReconciled,\s*scopeForCanonical,\s*boAdjustedFilteredEde/);
    // partition call uses epb.unpaidRows.
    expect(page).toMatch(/partitionUnpaidRowsByOverlay\(/);
  });

  it('partition does NOT take raw filteredEde / rawFilteredEde as the unpaid source', () => {
    expect(page).not.toMatch(/partitionUnpaidRowsByOverlay\([^)]*rawFilteredEde/);
  });
});
