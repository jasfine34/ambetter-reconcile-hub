/**
 * C2a Stage 4 — secondary-surface latest-BO alignment page tests.
 *
 * Strategy: follow the established Dashboard / Unpaid Recovery test pattern —
 * exercise the same canonical helpers the pages consume against fixtures
 * carrying the named canaries (Josie Martinez u96466529, Syania) on
 * terminated policies, then back the behavior with file-grep wiring guards
 * that pin the page → hook → filter → partition call chain.
 *
 * The pages themselves (Dashboard / Agent Summary / Unpaid Recovery) depend
 * on BatchContext + Supabase + the EDE loader, so we do NOT render them here
 * — Bundle 13c chose the same coverage strategy. The end-to-end behavior is
 * pinned by:
 *   1. running filterLatestBoTerminatedOwedRows + partitionUnpaidRowsByOverlay
 *      over fixtures that mirror what each page passes (Josie + Syania
 *      terminated, no commission evidence) and asserting suppression;
 *   2. grepping the three page files to prove the filter is invoked
 *      upstream of partition, that the loading testids and disabled-export
 *      affordances exist, and that raw fields / Should Be Paid /
 *      Expected Payments Received are NOT routed through the filter.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  filterLatestBoTerminatedOwedRows,
  latestAuthoritativeBoTermDates,
  makeBoRecency,
} from '@/lib/canonical/latestAuthoritativeBo';
import {
  partitionUnpaidRowsByOverlay,
  buildClearingOverlayMap,
  EMPTY_CLEARING_OVERLAY_MAP,
  sumEffectiveEstMissing,
} from '@/lib/canonical/crossBatchOverlay';
import { derivePolicyIdentityKey } from '@/lib/canonical/policyIdentityKey';
import { buildUnpaidRecoveryCsv } from '@/pages/UnpaidRecoveryPage';

// ---------------------------------------------------------------------------
// Canary fixtures — Josie Martinez u96466529 + Syania, both on terminated
// policies whose policy_term_date falls BEFORE the selected statement-month
// start, with NO commission evidence (in_commission=false,
// commission_record_count=0). These are the names the directive calls out.
// ---------------------------------------------------------------------------
const CARRIER = 'ambetter';
const BATCH = 'B-FEB-2026';
const STATEMENT_MONTH = '2026-02';
const STATEMENT_MONTH_START_ISO = '2026-02-01';

const JOSIE = {
  policy_number: 'POLJOSIE001',
  issuer_subscriber_id: 'u96466529',
  applicant_name: 'Josie Martinez',
};
const SYANIA = {
  policy_number: 'POLSYANIA002',
  issuer_subscriber_id: 'SYAN77231',
  applicant_name: 'Syania Example',
};
const LIVE = {
  policy_number: 'POLLIVE003',
  issuer_subscriber_id: 'LIVE99001',
  applicant_name: 'Live Member',
};
const LIVE_PARTIAL = {
  policy_number: 'POLLIVEPARTIAL004',
  issuer_subscriber_id: 'LIVEPART99002',
  applicant_name: 'Partial Cleared Live',
};
const TERMED_CLAWBACK = {
  policy_number: 'POLCLAW005',
  issuer_subscriber_id: 'CLAW99003',
  applicant_name: 'Terminated With Clawback',
};

const boRecords = [
  // Josie: terminated 2026-01-15 (before Feb start) → suppression candidate.
  {
    id: 'bo-josie', batch_id: BATCH, source_type: 'BACK_OFFICE', carrier: CARRIER,
    policy_number: JOSIE.policy_number, issuer_subscriber_id: JOSIE.issuer_subscriber_id,
    policy_term_date: '2026-01-15', broker_term_date: null,
  },
  // Syania: terminated 2026-01-20 → suppression candidate.
  {
    id: 'bo-syania', batch_id: BATCH, source_type: 'BACK_OFFICE', carrier: CARRIER,
    policy_number: SYANIA.policy_number, issuer_subscriber_id: SYANIA.issuer_subscriber_id,
    policy_term_date: '2026-01-20', broker_term_date: null,
  },
  // Live: not terminated → preserved.
  {
    id: 'bo-live', batch_id: BATCH, source_type: 'BACK_OFFICE', carrier: CARRIER,
    policy_number: LIVE.policy_number, issuer_subscriber_id: LIVE.issuer_subscriber_id,
    policy_term_date: null, broker_term_date: null,
  },
  // Live partial: not terminated → preserved (T8 partial-cleared canary).
  {
    id: 'bo-live-partial', batch_id: BATCH, source_type: 'BACK_OFFICE', carrier: CARRIER,
    policy_number: LIVE_PARTIAL.policy_number, issuer_subscriber_id: LIVE_PARTIAL.issuer_subscriber_id,
    policy_term_date: null, broker_term_date: null,
  },
  // Terminated WITH commission record (T7 reversal-protection canary).
  {
    id: 'bo-clawback', batch_id: BATCH, source_type: 'BACK_OFFICE', carrier: CARRIER,
    policy_number: TERMED_CLAWBACK.policy_number, issuer_subscriber_id: TERMED_CLAWBACK.issuer_subscriber_id,
    policy_term_date: '2026-01-10', broker_term_date: null,
  },
];

const batchMonthByBatchId = new Map<string, string>([[BATCH, STATEMENT_MONTH]]);
const overlay = latestAuthoritativeBoTermDates(boRecords as any[], makeBoRecency({ batchMonthByBatchId }));

function makeUnpaidRow(spec: { policy_number: string; issuer_subscriber_id: string; applicant_name: string },
                      over: Record<string, any> = {}): any {
  return {
    member_key: `mk-${spec.issuer_subscriber_id}`,
    carrier: CARRIER,
    policy_number: spec.policy_number,
    issuer_subscriber_id: spec.issuer_subscriber_id,
    exchange_subscriber_id: `ES-${spec.issuer_subscriber_id}`,
    applicant_name: spec.applicant_name,
    expected_ede_effective_month: STATEMENT_MONTH,
    effective_month: STATEMENT_MONTH,
    effective_date: `${STATEMENT_MONTH}-01`,
    in_back_office: true,
    in_ede: true,
    in_commission: false,
    commission_record_count: 0,
    eligible_for_commission: 'Yes',
    pay_entity: 'Coverall',
    net_premium: 500,
    current_policy_aor: 'Jason Fine (21055210)',
    agent_npn: '21055210',
    estimated_missing_commission: 100,
    status: 'Effectuated',
    issue_type: 'Missing from Commission',
    ...over,
  };
}

function pairOverlay(row: any, opts: {
  clearing_state: string;
  expected_amount?: number | null;
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
    actual_positive_amount: null,
    actual_reversal_amount: null,
    actual_net_amount: opts.actual_net_amount ?? null,
    remainder_owed: opts.remainder_owed ?? null,
    unpaid_batch_ids: [],
    payment_batch_ids: [],
    reversed_at_statement_month: null,
    first_full_clear_statement_month: null,
    evaluated_at: '2026-02-15T00:00:00Z',
    run_id: 'run-c2a',
    manual_review_reason: null,
  };
}

// ---------------------------------------------------------------------------
// T2 — Dashboard: Josie/Syania suppressed from EBU; shouldPay / expectedReceived
// untouched (the helper acts ONLY on unpaidRows; breakdown.shouldPay /
// expectedReceived are derived from filteredEde upstream of the filter).
// ---------------------------------------------------------------------------
describe('C2a T2 — Dashboard: Josie + Syania suppressed from EBU; shouldPay/expectedReceived untouched', () => {
  const rawUnpaid = [makeUnpaidRow(JOSIE), makeUnpaidRow(SYANIA), makeUnpaidRow(LIVE)];

  it('Josie + Syania (terminated, no commission evidence) dropped by filterLatestBoTerminatedOwedRows', () => {
    const filtered = filterLatestBoTerminatedOwedRows(rawUnpaid, overlay, STATEMENT_MONTH_START_ISO);
    const ids = filtered.map((r) => r.issuer_subscriber_id);
    expect(ids).not.toContain(JOSIE.issuer_subscriber_id);
    expect(ids).not.toContain(SYANIA.issuer_subscriber_id);
    expect(ids).toEqual([LIVE.issuer_subscriber_id]);
  });

  it('Dashboard EBU partition fed by filtered rows excludes Josie + Syania', () => {
    const filtered = filterLatestBoTerminatedOwedRows(rawUnpaid, overlay, STATEMENT_MONTH_START_ISO);
    const partition = partitionUnpaidRowsByOverlay(filtered, EMPTY_CLEARING_OVERLAY_MAP);
    const drilldownIds = partition.regular.map((it) => (it.row as any).issuer_subscriber_id);
    expect(drilldownIds).not.toContain(JOSIE.issuer_subscriber_id);
    expect(drilldownIds).not.toContain(SYANIA.issuer_subscriber_id);
    expect(partition.regular.length).toBe(1);
  });

  it('Source-Coverage EBU partition mirrors the Dashboard EBU partition (same filter, same rows)', () => {
    const filtered = filterLatestBoTerminatedOwedRows(rawUnpaid, overlay, STATEMENT_MONTH_START_ISO);
    const partition = partitionUnpaidRowsByOverlay(filtered, EMPTY_CLEARING_OVERLAY_MAP);
    expect(partition.regular.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// T3 — Agent Summary: Josie + Syania contribute 0 to unpaid / review / dollars.
// ---------------------------------------------------------------------------
describe('C2a T3 — Agent Summary: terminated canaries contribute 0 to unpaid/review/dollars', () => {
  const rawUnpaid = [
    makeUnpaidRow(JOSIE, { estimated_missing_commission: 222 }),
    makeUnpaidRow(SYANIA, { estimated_missing_commission: 333 }),
    makeUnpaidRow(LIVE, { estimated_missing_commission: 50 }),
  ];

  it('post-filter partition contributes only the live row to JF owner bucket', () => {
    const filtered = filterLatestBoTerminatedOwedRows(rawUnpaid, overlay, STATEMENT_MONTH_START_ISO);
    const partition = partitionUnpaidRowsByOverlay(filtered, EMPTY_CLEARING_OVERLAY_MAP);
    // unpaid_count for Jason bucket — all three rows carry JF AOR; only LIVE survives.
    expect(partition.regular.length).toBe(1);
    expect(sumEffectiveEstMissing(partition.regular)).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// T4 — Unpaid Recovery: Josie + Syania absent from filteredRows AND from CSV.
// ---------------------------------------------------------------------------
describe('C2a T4 — Unpaid Recovery: terminated canaries absent from filteredRows and from buildUnpaidRecoveryCsv output', () => {
  const rawUnpaid = [makeUnpaidRow(JOSIE), makeUnpaidRow(SYANIA), makeUnpaidRow(LIVE)];

  it('filtered rows exclude Josie + Syania and CSV body does not mention their names', () => {
    const filtered = filterLatestBoTerminatedOwedRows(rawUnpaid, overlay, STATEMENT_MONTH_START_ISO);
    const partition = partitionUnpaidRowsByOverlay(filtered, EMPTY_CLEARING_OVERLAY_MAP);
    const survivingRows = partition.regular.map((it) => it.row);
    const universe = {
      rows: filtered,
      matched: filtered,
      boOnly: [],
      edeOnly: [],
    } as any;
    const adjustedByRow = new Map();
    for (const it of partition.regular) adjustedByRow.set(it.row, it);
    const csv = buildUnpaidRecoveryCsv(survivingRows, universe, () => null, adjustedByRow);
    expect(csv).not.toContain('Josie Martinez');
    expect(csv).not.toContain('u96466529');
    expect(csv).not.toContain('Syania');
    expect(csv).toContain('Live Member');
  });
});

// ---------------------------------------------------------------------------
// T5 — Raw-diagnostic guard (Dashboard): EDE debug / raw counts / paid buckets
// are computed from `expectedPaymentBreakdown` / `sourceCoverage` BEFORE the
// filter (Dashboard only filters the .unpaidRows seam fed into partition).
// ---------------------------------------------------------------------------
describe('C2a T5 — Dashboard raw-diagnostic guard: raw fields untouched by the filter', () => {
  const page = readFileSync(resolve(__dirname, '..', 'pages/DashboardPage.tsx'), 'utf8');

  it('filterLatestBoTerminatedOwedRows is only called against unpaid-row seams', () => {
    const matches = page.match(/filterLatestBoTerminatedOwedRows\([^)]*\)/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
    for (const m of matches) {
      // Only the two unpaid-row seams: expectedPaymentBreakdown.unpaidRows AND
      // sourceCoverage.expectedButUnpaid.rows. Never against universe / shouldPay /
      // expectedReceived / paid buckets / raw breakdown fields.
      expect(m).toMatch(/expectedPaymentBreakdown\.unpaidRows|sourceCoverage\.expectedButUnpaid\.rows/);
      expect(m).not.toMatch(/shouldPay|expectedReceived|paidRows|universe\b/);
    }
  });

  it('raw metrics fields (unpaid / estMissing / unpaidExpected / expectedPaymentBreakdown) still preserved alongside the adjusted/aligned variants', () => {
    expect(page).toMatch(/\bunpaid,\s/);
    expect(page).toMatch(/\bestMissing,\s/);
    expect(page).toMatch(/\bunpaidExpected,\s/);
    expect(page).toMatch(/\bexpectedPaymentBreakdown,\s/);
  });

  it('partition is fed the latestBo-aligned variant (dashUnpaidAligned / scUnpaidAligned), NOT the raw unpaidRows reference', () => {
    expect(page).toMatch(/partitionUnpaidRowsByOverlay\(\s*dashUnpaidAligned\s*,/);
    // The second partition call site uses the source-coverage aligned variable.
    expect(page).toMatch(/partitionUnpaidRowsByOverlay\(\s*sc[A-Za-z]*Aligned\s*,/);
  });
});

// ---------------------------------------------------------------------------
// T6 — Loading-state / caching guard. Hook-level caching is tested in
// c2a-use-latest-bo-overlay.test.tsx. Here we pin the page-side affordances:
//   - each page renders its loading testid while latestBoLoading
//   - Unpaid Recovery export button (ur-export-button) is disabled while loading
// ---------------------------------------------------------------------------
describe('C2a T6 — page-side loading / disabled-export affordances', () => {
  const dash = readFileSync(resolve(__dirname, '..', 'pages/DashboardPage.tsx'), 'utf8');
  const agent = readFileSync(resolve(__dirname, '..', 'pages/AgentSummaryPage.tsx'), 'utf8');
  const unpaid = readFileSync(resolve(__dirname, '..', 'pages/UnpaidRecoveryPage.tsx'), 'utf8');

  it('Dashboard renders the four latest-BO loading testids gated by latestBoLoading', () => {
    expect(dash).toMatch(/data-testid="dashboard-ebu-latest-bo-loading"/);
    expect(dash).toMatch(/data-testid="dashboard-ebu-est-missing-latest-bo-loading"/);
    expect(dash).toMatch(/data-testid="dashboard-ebu-drilldown-latest-bo-loading"/);
    expect(dash).toMatch(/data-testid="source-coverage-ebu-latest-bo-loading"/);
    expect(dash).toMatch(/latestBoLoading/);
  });

  it('Agent Summary uses useLatestBoOverlay and renders agent-summary-latest-bo-loading', () => {
    expect(agent).toMatch(/from '@\/hooks\/useLatestBoOverlay'/);
    expect(agent).toMatch(/useLatestBoOverlay\(/);
    expect(agent).toMatch(/data-testid="agent-summary-latest-bo-loading"/);
    // Export is disabled by passing undefined exportFileName while loading.
    expect(agent).toMatch(/exportFileName=\{\s*latestBoLoading\s*\?\s*undefined/);
  });

  it('Unpaid Recovery uses useLatestBoOverlay, renders unpaid-recovery-latest-bo-loading, and disables ur-export-button', () => {
    expect(unpaid).toMatch(/from '@\/hooks\/useLatestBoOverlay'/);
    expect(unpaid).toMatch(/useLatestBoOverlay\(/);
    expect(unpaid).toMatch(/data-testid="unpaid-recovery-latest-bo-loading"/);
    expect(unpaid).toMatch(/data-testid="ur-export-button"/);
    expect(unpaid).toMatch(/disabled=\{\s*latestBoLoading\s*\|\|/);
  });

  it('all three pages pre-filter the partition input through filterLatestBoTerminatedOwedRows', () => {
    for (const src of [dash, agent, unpaid]) {
      expect(src).toMatch(/filterLatestBoTerminatedOwedRows\(/);
      expect(src).toMatch(/latestBoLoading\s*\?\s*[\s\S]{0,200}filterLatestBoTerminatedOwedRows/);
    }
  });
});

// ---------------------------------------------------------------------------
// T7 — Reversal seed at page level: terminated row WITH commission_record_count>0
// (pure clawback) is NOT suppressed, so it remains visible on the owed surfaces
// after partition.
// ---------------------------------------------------------------------------
describe('C2a T7 — terminated-policy row with commission evidence (pure clawback) survives end-to-end', () => {
  it('row with commission_record_count>0 (in_commission=false) is preserved by filter AND partition.regular', () => {
    const row = makeUnpaidRow(TERMED_CLAWBACK, {
      in_commission: false,
      commission_record_count: 1,
      clawback_amount: -120,
      estimated_missing_commission: 75,
    });
    const filtered = filterLatestBoTerminatedOwedRows([row], overlay, STATEMENT_MONTH_START_ISO);
    expect(filtered).toEqual([row]);
    const partition = partitionUnpaidRowsByOverlay(filtered, EMPTY_CLEARING_OVERLAY_MAP);
    expect(partition.regular.length).toBe(1);
    expect((partition.regular[0].row as any).policy_number).toBe(TERMED_CLAWBACK.policy_number);
  });
});

// ---------------------------------------------------------------------------
// T8 — Dollars parity: partial-cleared NON-terminated row survives the filter
// and contributes its effectiveEstMissing remainder (post-clearing), NOT the
// raw estimated_missing_commission.
// ---------------------------------------------------------------------------
describe('C2a T8 — dollars parity: effectiveEstMissing remainder preserved for partial-cleared survivor', () => {
  it('non-terminated partial-cleared row remainder (effectiveEstMissing) is 30, NOT raw 100', () => {
    const row = makeUnpaidRow(LIVE_PARTIAL, { estimated_missing_commission: 100 });
    const filtered = filterLatestBoTerminatedOwedRows([row], overlay, STATEMENT_MONTH_START_ISO);
    expect(filtered.length).toBe(1);
    const clearing = buildClearingOverlayMap([
      pairOverlay(row, {
        clearing_state: 'partially_cleared',
        expected_amount: 100,
        actual_net_amount: 70,
        remainder_owed: 30,
      }),
    ]);
    const partition = partitionUnpaidRowsByOverlay(filtered, clearing);
    expect(partition.regular.length).toBe(1);
    expect(partition.regular[0].effectiveEstMissing).toBe(30);
    expect(partition.regular[0].effectiveEstMissing).not.toBe(100);
    expect(sumEffectiveEstMissing(partition.regular)).toBe(30);
  });
});
