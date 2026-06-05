/**
 * Phase B Item 4a — Wiring Slice v2 (D3 + D4 + Tests).
 *
 * Locks the MCE production-inclusion swap onto the MT-approved selector +
 * all-batch projection cache, the BO-only overlay-month fallback (§4.1), the
 * demotion of the whole old inclusion stack from the production path (D4),
 * and that the locked Messer 12-column export contract is preserved.
 *
 * Pure source-grep + behavioral guards. No render coverage — page-render
 * regressions are covered by `missing-commission-export-page.test.tsx`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  getMtAllBatchProjection,
  invalidateMtAllBatchProjectionCache,
  makeMtAllBatchCacheKey,
} from '@/lib/canonical/mtApprovedMceCache';
import {
  partitionUnpaidRowsByOverlay,
  buildClearingOverlayMap,
  deriveGrainKeyForReconciledRow,
} from '@/lib/canonical/crossBatchOverlay';
import { derivePolicyIdentityKey } from '@/lib/canonical/policyIdentityKey';
import { buildMesserCsv } from '@/pages/MissingCommissionExportPage';
import Papa from 'papaparse';

const pageSource = readFileSync(
  resolve(__dirname, '..', 'pages/MissingCommissionExportPage.tsx'),
  'utf8',
);

// ---------------------------------------------------------------------------
// D3 — Production wiring (source-grep guards).
// ---------------------------------------------------------------------------
describe('Item 4a D3 — MCE production inclusion sources from MT-approved selector + cache', () => {
  it('page imports buildMtApprovedMceCandidates from the canonical selector module', () => {
    expect(pageSource).toMatch(
      /from\s+['"]@\/lib\/canonical\/mtApprovedMceSelector['"]/,
    );
    expect(pageSource).toMatch(/buildMtApprovedMceCandidates/);
  });

  it('page imports getMtAllBatchProjection from the cache module', () => {
    expect(pageSource).toMatch(
      /from\s+['"]@\/lib\/canonical\/mtApprovedMceCache['"]/,
    );
    expect(pageSource).toMatch(/getMtAllBatchProjection/);
  });

  it('page uses useAllBatchesDataVersion as the cache-key data-version source', () => {
    expect(pageSource).toMatch(
      /from\s+['"]@\/hooks\/useBatchDataVersion['"]/,
    );
    expect(pageSource).toMatch(/useAllBatchesDataVersion\(/);
  });

  it('page passes the resolverIndex object (not just the fingerprint) to the cache', () => {
    expect(pageSource).toMatch(
      /getMtAllBatchProjection\(\s*\{[\s\S]*?resolverIndex:\s*resolverIndexSnapshot/,
    );
    expect(pageSource).toMatch(
      /loader:\s*(?:\(\)\s*=>\s*)?getAllNormalizedRecordsForMemberTimeline/,
    );
  });

  it('page builds candidates via buildMtApprovedMceCandidates with official-AOR scope from filters', () => {
    expect(pageSource).toMatch(
      /buildMtApprovedMceCandidates\(\s*\{[\s\S]*?allBatchRecords:[\s\S]*?monthList:[\s\S]*?serviceMonth:[\s\S]*?scope:\s*f\.scope[\s\S]*?batchMonthByBatchId:/,
    );
  });

  it('display reads come from MT-cell fields, not breakdown.universe / classifyNetPremium', () => {
    // _sourceType reads m._mtSourceType directly.
    expect(pageSource).toMatch(/_sourceType:\s*\(m as any\)\._mtSourceType/);
    // Net-premium bucket derived from m._mtNetBucket, not the legacy helper.
    expect(pageSource).toMatch(/_mtNetBucket/);
    expect(pageSource).not.toMatch(/const bucket = classifyNetPremium\(m\)/);
    // breakdown.universe must NOT be required to render production rows.
    expect(pageSource).not.toMatch(/_sourceType:\s*classifySourceTypeForRow\(/);
  });
});

// ---------------------------------------------------------------------------
// D4 — Demote the whole old inclusion stack from the production path.
// ---------------------------------------------------------------------------
describe('Item 4a D4 — old inclusion stack demoted off the production path', () => {
  it('runReport block (~production click path) does NOT call the old inclusion stack', () => {
    // Isolate the runReport function body for the grep.
    const startIdx = pageSource.indexOf('async function runReport');
    expect(startIdx).toBeGreaterThan(0);
    // Crude end-cap: the next top-level `function handleDownload` declaration.
    const endIdx = pageSource.indexOf('function handleDownload', startIdx);
    expect(endIdx).toBeGreaterThan(startIdx);
    const runBody = pageSource.slice(startIdx, endIdx);

    expect(runBody).not.toMatch(/applyRuntimeBOActive\s*\(/);
    expect(runBody).not.toMatch(/computeFilteredEde\s*\(/);
    expect(runBody).not.toMatch(/findWeakMatches\s*\(/);
    expect(runBody).not.toMatch(/applyOverrides\s*\(/);
    expect(runBody).not.toMatch(/getExpectedPaymentBreakdown\s*\(/);
    expect(runBody).not.toMatch(/buildMceCandidateSetForServiceMonth\s*\(/);
    expect(runBody).not.toMatch(/loadWeakMatchOverrides\s*\(/);
  });

  it('Phase B Item 4b — buildMceCandidateSetForServiceMonth and the demoted-stack docstring are deleted', () => {
    expect(pageSource).not.toMatch(/export function buildMceCandidateSetForServiceMonth/);
    expect(pageSource).not.toMatch(/export interface McePaymentBreakdownLike/);
    expect(pageSource).not.toMatch(/DEMOTED \(Phase B Item 4a wiring slice v2\)/);
  });

  it('Phase B Item 4b — the page does not import the deleted MCE-only stack symbols', () => {
    expect(pageSource).not.toMatch(/from\s+['"]@\/lib\/expectedEde['"]/);
    expect(pageSource).not.toMatch(/from\s+['"]@\/lib\/canonical\/applyRuntimeBOActive['"]/);
    expect(pageSource).not.toMatch(/from\s+['"]@\/lib\/weakMatch['"]/);
    // No executable import or call to getExpectedPaymentBreakdown.
    expect(pageSource).not.toMatch(/import\s+\{[^}]*getExpectedPaymentBreakdown[^}]*\}\s+from/);
    expect(pageSource).not.toMatch(/getExpectedPaymentBreakdown\s*\(/);
  });
});

// ---------------------------------------------------------------------------
// §4.1 — Overlay month fallback for BO-only MT candidates.
// ---------------------------------------------------------------------------
describe('Item 4a §4.1 — BO-only overlay-month fallback (regression for the P1 bug)', () => {
  function makeBoOnlyRow(serviceMonth: string): any {
    return {
      member_key: 'bo-only-1',
      carrier: 'Ambetter',
      policy_number: 'POL-BO-1',
      issuer_subscriber_id: 'IS-BO-1',
      // Selector emits null here for BO-only — exactly what we're testing.
      expected_ede_effective_month: null,
      service_month: serviceMonth,
      estimated_missing_commission: 100,
    };
  }

  it('deriveGrainKeyForReconciledRow returns null when expected_ede_effective_month is null', () => {
    const row = makeBoOnlyRow('2026-01');
    expect(deriveGrainKeyForReconciledRow(row)).toBeNull();
  });

  it('the wiring-layer proxy with `expected_ede_effective_month ?? service_month` resolves the grain', () => {
    const row = makeBoOnlyRow('2026-01');
    const proxy = {
      ...row,
      expected_ede_effective_month: row.expected_ede_effective_month ?? row.service_month,
    };
    expect(deriveGrainKeyForReconciledRow(proxy)).not.toBeNull();
  });

  it('a fully_cleared overlay applies to the BO-only proxy row via the service-month fallback', () => {
    const row = makeBoOnlyRow('2026-01');
    const proxy = {
      ...row,
      expected_ede_effective_month: row.expected_ede_effective_month ?? row.service_month,
    };
    const identity = derivePolicyIdentityKey({
      carrier: row.carrier,
      policy_number: row.policy_number,
      issuer_subscriber_id: row.issuer_subscriber_id,
    });
    if (identity.status !== 'resolved') throw new Error('fixture');
    const overlay = buildClearingOverlayMap([
      {
        id: 'c1',
        policy_identity_key: identity.key,
        target_service_month: '2026-01',
        clearing_state: 'fully_cleared',
        expected_amount: 100,
        actual_positive_amount: 100,
        actual_reversal_amount: null,
        actual_net_amount: 100,
        remainder_owed: 0,
        unpaid_batch_ids: [],
        payment_batch_ids: [],
        reversed_at_statement_month: null,
        first_full_clear_statement_month: '2026-01',
        evaluated_at: '2026-05-01T00:00:00Z',
        run_id: 'r',
        manual_review_reason: null,
      },
    ]);
    const partition = partitionUnpaidRowsByOverlay([proxy], overlay);
    expect(partition.regular.length).toBe(0);
    expect(partition.removed.length).toBe(1);
  });

  it('the page constructs overlay-input proxies with expected_ede_effective_month ?? service_month', () => {
    expect(pageSource).toMatch(
      /expected_ede_effective_month:\s*[\s\S]{0,80}\?\?[\s\S]{0,80}service_month/,
    );
    expect(pageSource).toMatch(/overlayInputCandidates/);
    expect(pageSource).toMatch(
      /partitionUnpaidRowsByOverlay\(\s*overlayInputCandidates/,
    );
  });
});

// ---------------------------------------------------------------------------
// Cache invalidation — keyed by useAllBatchesDataVersion() + resolverIndex
// fingerprint. Unchanged → reuse; changed → recompute.
// ---------------------------------------------------------------------------
describe('Item 4a cache — invalidation on data-version OR resolver-fingerprint change', () => {
  beforeEach(() => invalidateMtAllBatchProjectionCache());

  const idxA = {
    byFfmApp: new Map(),
    byExchangeSub: new Map(),
    totalRows: 0,
    fingerprint: 'fp-A',
  } as any;
  const idxB = {
    byFfmApp: new Map(),
    byExchangeSub: new Map(),
    totalRows: 0,
    fingerprint: 'fp-B',
  } as any;

  it('cache key is stable when both inputs are unchanged', () => {
    const k1 = makeMtAllBatchCacheKey('dv-1', idxA);
    const k2 = makeMtAllBatchCacheKey('dv-1', idxA);
    expect(k1).toBe(k2);
  });

  it('cache key changes when the data-version changes', () => {
    const k1 = makeMtAllBatchCacheKey('dv-1', idxA);
    const k2 = makeMtAllBatchCacheKey('dv-2', idxA);
    expect(k1).not.toBe(k2);
  });

  it('cache key changes when the resolver fingerprint changes (even with the same data-version)', () => {
    const k1 = makeMtAllBatchCacheKey('dv-1', idxA);
    const k2 = makeMtAllBatchCacheKey('dv-1', idxB);
    expect(k1).not.toBe(k2);
  });

  it('getMtAllBatchProjection re-runs the loader when the cache key changes', async () => {
    let calls = 0;
    const loader = async () => {
      calls += 1;
      return [];
    };
    await getMtAllBatchProjection({ allBatchesDataVersion: 'dv-1', resolverIndex: idxA, loader });
    await getMtAllBatchProjection({ allBatchesDataVersion: 'dv-1', resolverIndex: idxA, loader });
    expect(calls).toBe(1); // reuse
    await getMtAllBatchProjection({ allBatchesDataVersion: 'dv-2', resolverIndex: idxA, loader });
    expect(calls).toBe(2); // dv changed
    await getMtAllBatchProjection({ allBatchesDataVersion: 'dv-2', resolverIndex: idxB, loader });
    expect(calls).toBe(3); // fingerprint changed
  });
});

// ---------------------------------------------------------------------------
// Item-1 preserved — Messer CSV stays 12 locked columns.
// ---------------------------------------------------------------------------
describe('Item 4a — item-1 contract preserved (Messer CSV = 12 locked columns)', () => {
  it('buildMesserCsv emits exactly the 12-column Messer header', () => {
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
});
