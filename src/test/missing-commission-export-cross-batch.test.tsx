/**
 * Bundle 13c — MCE cross-batch overlay wiring tests.
 *
 * Strategy: mirror the page's helper logic against the canonical
 * `partitionUnpaidRowsByOverlay` helper, then back it up with source-grep
 * wiring guards proving MissingCommissionExportPage.tsx consumes the adjusted
 * fields, mounts the banner, awaits the overlay at Run Report, and keeps the
 * MESSER_COLUMNS contract intact. Render coverage is supplied indirectly
 * (same pattern as the Dashboard slice).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  partitionUnpaidRowsByOverlay,
  buildClearingOverlayMap,
  EMPTY_CLEARING_OVERLAY_MAP,
  type AdjustedRow,
} from '@/lib/canonical/crossBatchOverlay';
import { derivePolicyIdentityKey } from '@/lib/canonical/policyIdentityKey';
import {
  isReviewWorthyAdjustment,
  buildMesserCsv,
} from '@/pages/MissingCommissionExportPage';
import { EBU_BATCH_SCOPE_DISCLAIMER } from '@/lib/constants';
import { OVERLAY_LOAD_ERROR_MESSAGE } from '@/components/CrossBatchOverlayLoadErrorBanner';
import Papa from 'papaparse';

// ---------------------------------------------------------------------------
// Local fixtures (mirror Dashboard test shape so the partition behavior is
// proven against identical seeds).
// ---------------------------------------------------------------------------

interface SeedSpec {
  member_key: string;
  carrier?: string;
  policy_number?: string;
  issuer_subscriber_id?: string;
  effective_month?: string;
  estimated_missing_commission?: number;
}

function makeRow(s: SeedSpec): any {
  return {
    member_key: s.member_key,
    carrier: s.carrier ?? 'Ambetter',
    policy_number: s.policy_number ?? `POL-${s.member_key}`,
    issuer_subscriber_id: s.issuer_subscriber_id ?? `IS-${s.member_key}`,
    expected_ede_effective_month: s.effective_month ?? '2026-01',
    estimated_missing_commission: s.estimated_missing_commission ?? 100,
    net_premium: 500,
    current_policy_aor: 'Jason Fine (21055210)',
    in_back_office: true,
    in_ede: true,
    eligible_for_commission: 'Yes',
    in_commission: false,
  };
}

function pairOverlay(row: any, opts: {
  clearing_state: string;
  expected_amount?: number | null;
  actual_net_amount?: number | null;
  actual_reversal_amount?: number | null;
  remainder_owed?: number | null;
}) {
  const id = derivePolicyIdentityKey({
    carrier: row.carrier,
    policy_number: row.policy_number,
    issuer_subscriber_id: row.issuer_subscriber_id,
  });
  if (id.status !== 'resolved') throw new Error('test fixture unresolved');
  return {
    id: `clr-${row.member_key}`,
    policy_identity_key: id.key,
    target_service_month: row.expected_ede_effective_month,
    clearing_state: opts.clearing_state,
    expected_amount: opts.expected_amount ?? null,
    actual_positive_amount: null,
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

const page = readFileSync(
  resolve(__dirname, '..', 'pages/MissingCommissionExportPage.tsx'),
  'utf8',
);

// ---------------------------------------------------------------------------
// C6 — exclusion / keep behavior (mirrors how MCE will materialize missingMembers).
// ---------------------------------------------------------------------------

describe('Bundle 13c — MCE C6 partition: exclude cleared/reversed, keep still-owed', () => {
  it('fully_cleared row excluded from missingMembers', () => {
    const row = makeRow({ member_key: 'fc' });
    const ov = buildClearingOverlayMap([pairOverlay(row, {
      clearing_state: 'fully_cleared', expected_amount: 100, actual_net_amount: 100,
    })]);
    const p = partitionUnpaidRowsByOverlay([row], ov);
    expect(p.regular.length).toBe(0);
    expect(p.removed.length).toBe(1);
  });

  it('zero_expected_no_payment_required row excluded', () => {
    const row = makeRow({ member_key: 'ze' });
    const ov = buildClearingOverlayMap([pairOverlay(row, { clearing_state: 'zero_expected_no_payment_required' })]);
    const p = partitionUnpaidRowsByOverlay([row], ov);
    expect(p.regular.length).toBe(0);
  });

  it('cleared_then_reversed row excluded from missingMembers (goes to reversed bucket)', () => {
    const row = makeRow({ member_key: 'rev' });
    const ov = buildClearingOverlayMap([pairOverlay(row, { clearing_state: 'cleared_then_reversed', actual_reversal_amount: -50 })]);
    const p = partitionUnpaidRowsByOverlay([row], ov);
    expect(p.regular.length).toBe(0);
    expect(p.reversed.length).toBe(1);
  });

  it('not_cleared row kept; no chip; legacy dollar', () => {
    const row = makeRow({ member_key: 'nc', estimated_missing_commission: 75 });
    const ov = buildClearingOverlayMap([pairOverlay(row, { clearing_state: 'not_cleared' })]);
    const p = partitionUnpaidRowsByOverlay([row], ov);
    expect(p.regular.length).toBe(1);
    expect(p.regular[0].effectiveEstMissing).toBe(75);
    expect(isReviewWorthyAdjustment(p.regular[0])).toBe(false);
  });

  it('no_overlay row (no matching grain) kept; no chip; legacy dollar', () => {
    const row = makeRow({ member_key: 'no', estimated_missing_commission: 42 });
    const p = partitionUnpaidRowsByOverlay([row], EMPTY_CLEARING_OVERLAY_MAP);
    expect(p.regular.length).toBe(1);
    expect(p.regular[0].adjustment.kind).toBe('no_overlay');
    expect(p.regular[0].effectiveEstMissing).toBe(42);
    expect(isReviewWorthyAdjustment(p.regular[0])).toBe(false);
  });
});

describe('Bundle 13c — MCE partial_amount_unavailable + partially_cleared semantics', () => {
  it('partially_cleared with valid amounts: kept; dollar = remainder', () => {
    const row = makeRow({ member_key: 'pc', estimated_missing_commission: 100 });
    const ov = buildClearingOverlayMap([pairOverlay(row, {
      clearing_state: 'partially_cleared', expected_amount: 100, actual_net_amount: 30, remainder_owed: 70,
    })]);
    const p = partitionUnpaidRowsByOverlay([row], ov);
    expect(p.regular.length).toBe(1);
    expect(p.regular[0].effectiveEstMissing).toBe(70);
    expect(isReviewWorthyAdjustment(p.regular[0])).toBe(false);
  });

  it('partially_cleared with null amounts → partial_amount_unavailable: kept; legacy dollar; review-worthy', () => {
    const row = makeRow({ member_key: 'pu', estimated_missing_commission: 100 });
    const ov = buildClearingOverlayMap([pairOverlay(row, { clearing_state: 'partially_cleared' })]);
    const p = partitionUnpaidRowsByOverlay([row], ov);
    expect(p.regular.length).toBe(1);
    expect(p.regular[0].adjustment.kind).toBe('partial_amount_unavailable');
    expect(p.regular[0].effectiveEstMissing).toBe(100);
    expect(isReviewWorthyAdjustment(p.regular[0])).toBe(true);
  });

  it('manual_review_required row: kept once in regular (NOT duplicated)', () => {
    const row = makeRow({ member_key: 'mr' });
    const ov = buildClearingOverlayMap([pairOverlay(row, { clearing_state: 'manual_review_required' })]);
    const p = partitionUnpaidRowsByOverlay([row], ov);
    expect(p.regular.length).toBe(1);
    expect(p.needsReview.length).toBe(1);
    const missing = p.regular.map((it) => it.row);
    expect(missing.length).toBe(1);
    expect(missing[0]).toBe(row);
  });
});

describe('Bundle 13c — MESSER_COLUMNS stability + CSV-only export', () => {
  it('Generated CSV header does NOT contain "Clearing"', () => {
    const csv = buildMesserCsv([]);
    expect(csv).not.toContain('Clearing');
  });

  it('CSV header is the locked 12-column Messer set in order', () => {
    const csv = buildMesserCsv([]);
    const parsed = Papa.parse(csv.trim(), { header: false });
    expect((parsed.data as string[][])[0]).toEqual([
      'Carrier Name',
      'NPN',
      'Writing Agent Carrier ID',
      'Writing Agent Name',
      'Policy Effective Date',
      'Policy #',
      'Member First Name',
      'Member Last Name',
      'DOB',
      'SSN',
      'Member ID',
      'Address (Street, City, State, Zip)',
    ]);
  });

  it('source: MESSER_COLUMNS array is unchanged + lacks _clearingStatus', () => {
    expect(page).toMatch(/const MESSER_COLUMNS[\s\S]*?'Address[\s\S]*?\];/);
    const messerBlock = page.match(/const MESSER_COLUMNS[\s\S]*?\];/)?.[0] ?? '';
    expect(messerBlock).not.toMatch(/_clearingStatus/);
  });

  it("source: INTERNAL_COLUMNS includes _clearingStatus with label 'Clearing'", () => {
    const internalBlock = page.match(/const INTERNAL_COLUMNS[\s\S]*?\];/)?.[0] ?? '';
    expect(internalBlock).toMatch(/_clearingStatus[\s\S]*Clearing/);
  });
});

describe('Bundle 13c — MissingCommissionExportPage wiring guards', () => {
  it('invokes useCrossBatchOverlay at component top level (not inside useMemo)', () => {
    expect(page).toMatch(/useCrossBatchOverlay\(/);
    const memoBodies = page.match(/useMemo\(\(\)=>[\s\S]*?\},\s*\[/g) ?? [];
    for (const body of memoBodies) {
      expect(body).not.toMatch(/useCrossBatchOverlay\(/);
    }
  });

  it('derives mceClearingOverlay = overlayError ? EMPTY_CLEARING_OVERLAY_MAP : clearingOverlay', () => {
    expect(page).toMatch(/mceClearingOverlay\s*=\s*overlayError[\s\S]*EMPTY_CLEARING_OVERLAY_MAP[\s\S]*clearingOverlay/);
  });

  it('declares page-local waitForOverlayIdle (NOT a hook API change)', () => {
    expect(page).toMatch(/function\s+waitForOverlayIdle/);
    expect(page).toMatch(/overlayStateRef/);
    expect(page).toMatch(/overlayWaitersRef/);
  });

  it('handleRunReport awaits the overlay via waitForOverlayIdle before partitioning', () => {
    expect(page).toMatch(/await\s+waitForOverlayIdle\(/);
    expect(page).toMatch(/partitionUnpaidRowsByOverlay\(\s*breakdown\.unpaidRows/);
  });

  it('C7: on overlay error/loading-after-wait, falls back to EMPTY_CLEARING_OVERLAY_MAP + toast uses OVERLAY_LOAD_ERROR_MESSAGE', () => {
    expect(page).toMatch(/overlayState\.loading\s*\|\|\s*overlayState\.error[\s\S]{0,400}OVERLAY_LOAD_ERROR_MESSAGE/);
    expect(page).toMatch(/overlayForRun\s*=\s*EMPTY_CLEARING_OVERLAY_MAP/);
  });

  it('C7 toast shape matches Bundle 12.7 (no variant: destructive)', () => {
    const toastBlock = page.match(/toast\(\{[^}]*OVERLAY_LOAD_ERROR_MESSAGE[^}]*\}\)/)?.[0] ?? '';
    expect(toastBlock).toMatch(/title:/);
    expect(toastBlock).toMatch(/description:/);
    expect(toastBlock).not.toMatch(/variant:\s*['"]destructive['"]/);
  });

  it('missingMembers = partition.regular.map (NOT [...regular, ...needsReview])', () => {
    expect(page).toMatch(/missingMembers\s*=\s*partition\.regular\.map/);
    expect(page).not.toMatch(/\[\s*\.\.\.partition\.regular\s*,\s*\.\.\.partition\.needsReview/);
  });

  it('_estimatedMissingCommission branches on adj.adjustment.kind === "reduce_dollars"', () => {
    expect(page).toMatch(/adj\.adjustment\.kind\s*===\s*'reduce_dollars'[\s\S]{0,160}effectiveEstMissing/);
  });

  it('ExportRow build loop derives clearingStatus + clearingNeedsReview from adj while m in scope', () => {
    expect(page).toMatch(/const adj = adjustedByRow\.get\(m\)/);
    expect(page).toMatch(/_clearingStatus:\s*clearingStatus/);
    expect(page).toMatch(/_clearingNeedsReview:\s*clearingNeedsReview/);
  });

  it('Cell render reads row._clearingStatus / row._clearingNeedsReview (NOT adjustedByRow.get(m))', () => {
    const cellBlock = page.match(/c\.key\s*===\s*'_clearingStatus'[\s\S]{0,800}TableCell/)?.[0] ?? '';
    expect(cellBlock).toMatch(/row\._clearingStatus/);
    expect(cellBlock).toMatch(/row\._clearingNeedsReview/);
    expect(cellBlock).toMatch(/<ClearingStatusChip\s+state=\{row\._clearingStatus\}/);
    expect(cellBlock).toMatch(/data-testid="mce-needs-review-badge"/);
    expect(cellBlock).not.toMatch(/adjustedByRow\.get\(m\)/);
  });

  it('Overlay-load-error banner mounted only when overlayError !== null', () => {
    expect(page).toMatch(/\{\s*overlayError\s*&&\s*<CrossBatchOverlayLoadErrorBanner\s*\/>\s*\}/);
  });

  it('Bundle 12.7 non-fatal commission fallback preserved (commissionTripleFallbackFailed toast)', () => {
    expect(page).toMatch(/commissionTripleFallbackFailed[\s\S]{0,600}Report completed with limited commission history/);
  });

  it('Page uses canonical foundation imports (no inline duplicates)', () => {
    expect(page).toMatch(/from '@\/hooks\/useCrossBatchOverlay'/);
    expect(page).toMatch(/from '@\/lib\/canonical\/crossBatchOverlay'/);
    expect(page).toMatch(/from '@\/components\/CrossBatchOverlayLoadErrorBanner'/);
    expect(page).toMatch(/from '@\/components\/ClearingStatusChip'/);
    expect(page).toMatch(/OVERLAY_LOAD_ERROR_MESSAGE/);
    expect(page).not.toMatch(/"Cross-batch payment clearings couldn't be loaded/);
  });

  it('isReviewWorthyAdjustment covers BOTH mark_needs_review AND partial_amount_unavailable', () => {
    expect(page).toMatch(/isReviewWorthyAdjustment[\s\S]{0,400}mark_needs_review[\s\S]{0,200}partial_amount_unavailable/);
  });

  it('Disclaimer constant contains "cross-batch payment clearings" parity phrase', () => {
    expect(EBU_BATCH_SCOPE_DISCLAIMER.toLowerCase()).toContain('cross-batch payment clearings');
    expect(page).toMatch(/\{EBU_BATCH_SCOPE_DISCLAIMER\}/);
  });

  it('OVERLAY_LOAD_ERROR_MESSAGE constant is the single source for the C7 warning', () => {
    expect(OVERLAY_LOAD_ERROR_MESSAGE).toMatch(/cross-batch payment clearings/i);
  });
});
