/**
 * Phase 2 follow-up — Leonard Jackson April 2026 Ambetter Coverall opt-in
 * smoke control.
 *
 * Background (per codex-comm/verdicts/phase-2-dashboard-slice-postsync_DONE.md
 * Inspection 12):
 *   - April 2026 Ambetter Coverall has 1 EE member `Leonard Jackson`
 *     (member_key=sub:3437828).
 *   - Raw EDE: current_policy_aor='Jason Fine (21055210)',
 *     policy_number='214039840', issuer_subscriber_id='U96069319',
 *     exchange_subscriber_id='0002964539'.
 *   - Reconciled: current_policy_aor='Bahroz Hussain (21408130)',
 *     exchange_subscriber_id='3437828'.
 *   - Current live tile counts: foundInBO=131, notInBO=42, expectedEnrollments=174.
 *   - abs((131 + 42) - 174) === 1.
 *   - NOT a Phase 2 regression. Pre-existing scope debt in the EDE→reconciled
 *     enrichment.
 *
 * This smoke control DOCUMENTS the warning via the directive-standard
 * `smokeIt` gating pattern. Default `npm test` skips it. Run with
 * `RUN_SMOKE_CONTROLS=1 npm test` to invoke against live data.
 *
 * Legacy-raw comparison (NOT enforced as a test): Codex's Phase 2 post-sync audit
 * harness observed legacyFoundInBO + legacyNotInBO = 1660 vs legacyExpectedEnrollments
 * = 1659 (same deviation magnitude). See codex-comm/verdicts/phase-2-dashboard-slice-
 * postsync_DONE.md Inspection 12. No in-app helper exposes the legacy count today;
 * if one is added later, this smoke control can be extended to assert the legacy
 * magnitude too.
 */
import { describe, it, expect } from 'vitest';
import { getBatches, getNormalizedRecords, getReconciledMembers } from '@/lib/persistence';
import { computeFilteredEde } from '@/lib/expectedEde';
import { loadResolverIndex } from '@/lib/resolvedIdentities';
import {
  loadWeakMatchOverrides,
  findWeakMatches,
  applyOverrides,
  pickStableKey,
} from '@/lib/weakMatch';
import { getCoveredMonths } from '@/lib/dateRange';
import { getStatementMonthBounds } from '@/lib/canonical/statementMonthBounds';
import { applyRuntimeBOActive } from '@/lib/canonical/applyRuntimeBOActive';
import {
  getFoundInBackOffice,
  getNotInBackOfficeRows,
} from '@/lib/canonical/metrics';

// Directive-standard smoke gating pattern. Default `npm test` skips this
// test entirely via the it.skip fallback when RUN_SMOKE_CONTROLS is not '1'.
const smokeIt = process.env.RUN_SMOKE_CONTROLS === '1' ? it : it.skip;

describe('Leonard Jackson April 2026 Ambetter Coverall — opt-in smoke control', () => {
  smokeIt('sub:3437828 — known EDE→reconciled AOR scope mismatch (deviation magnitude = 1)', async () => {
    // 1. Locate April 2026 Ambetter through the same month-map shape as the live-grid probe.
    //    NOTE: getBatches() orders by created_at DESC. Using .find(...) would return the
    //    NEWEST matching batch, but the live-grid probe resolves to the OLDEST via
    //    map-overwrite-on-iterate. Use the same shape here.
    const batches = await getBatches();
    const batchByMonth = new Map<string, any>();
    for (const b of batches) {
      const month = String(b.statement_month ?? '').substring(0, 7);
      if (month === '2026-04' && String(b.carrier ?? 'Ambetter') === 'Ambetter') {
        batchByMonth.set(month, b);
      }
    }
    const aprilAmbetterBatch = batchByMonth.get('2026-04');
    expect(aprilAmbetterBatch).toBeTruthy();

    // 2. Load resolver + weak-match overrides (mirroring live-grid probe).
    const resolverIndex = await loadResolverIndex(true);
    const weakOverrides = await loadWeakMatchOverrides().catch(
      () => new Map<string, any>(),
    );

    // 3. Load batch-scoped normalized + reconciled records.
    const normalizedRecords = await getNormalizedRecords(aprilAmbetterBatch!.id);
    const reconciled = await getReconciledMembers(aprilAmbetterBatch!.id);

    // 4. Compute covered months + service-month bounds for runtime overlay.
    const coveredMonths = getCoveredMonths(aprilAmbetterBatch!.statement_month);
    const viewedServiceMonth = String(aprilAmbetterBatch!.statement_month).substring(0, 7);
    const monthBounds = getStatementMonthBounds(viewedServiceMonth);
    const boNormalized = (normalizedRecords ?? []).filter(
      (r: any) => r.source_type === 'BACK_OFFICE',
    );

    // 5. Apply runtime BO-active overlay + build exclusion-filtered reconciled.
    const overlay = applyRuntimeBOActive(reconciled ?? [], boNormalized, monthBounds);
    const boAdjustedReconciled = overlay.adjustedReconciled.filter(
      (r: any) => !overlay.mceExclusionMemberKeys.has(r.member_key),
    );

    // 6. Compute resolver-backed filtered EDE universe (the critical resolver call).
    const boAdjustedRaw = computeFilteredEde(
      normalizedRecords ?? [],
      overlay.adjustedReconciled,
      'Coverall',
      coveredMonths,
      resolverIndex,
    );

    // 7. Rebuild the BO-adjusted, exclusion-filtered EDE result (the critical adjusted-vs-raw fix).
    const adjUnique = boAdjustedRaw.uniqueMembers.filter(
      (m: any) => !overlay.mceExclusionMemberKeys.has(m.member_key),
    );
    const adjMissing = boAdjustedRaw.missingFromBO.filter(
      (m: any) => !overlay.mceExclusionMemberKeys.has(m.member_key),
    );
    const adjByMonth: Record<string, number> = {};
    for (const m of adjUnique) {
      const month = (m as any).effective_month;
      if (month) adjByMonth[month] = (adjByMonth[month] ?? 0) + 1;
    }
    const boAdjustedFilteredEde = {
      ...boAdjustedRaw,
      uniqueMembers: adjUnique,
      missingFromBO: adjMissing,
      uniqueKeys: adjUnique.length,
      inBOCount: adjUnique.filter((m: any) => m.in_back_office).length,
      notInBOCount: adjMissing.length,
      byMonth: adjByMonth,
    };

    // 8. Raw Leonard five-field tuple identity assertion (preserved from v3).
    const rawLeonard = boAdjustedFilteredEde.uniqueMembers.find(
      (m: any) =>
        m.applicant_name === 'Leonard Jackson' &&
        m.current_policy_aor === 'Jason Fine (21055210)' &&
        m.policy_number === '214039840' &&
        m.issuer_subscriber_id === 'U96069319' &&
        m.exchange_subscriber_id === '0002964539',
    );
    expect(rawLeonard).toBeTruthy();
    expect(rawLeonard?.current_policy_aor).toContain('Jason Fine');

    // 9. Reconciled-side assertion (preserved from v3).
    const reconciledLeonard = (reconciled ?? []).find(
      (r: any) => r.member_key === 'sub:3437828',
    );
    expect(reconciledLeonard).toBeTruthy();
    expect(String(reconciledLeonard?.current_policy_aor ?? '')).not.toMatch(
      /Jason Fine/i,
    );

    // 10. Weak-match candidate scan (mirroring probe).
    const candidates = findWeakMatches(
      boAdjustedFilteredEde.uniqueMembers,
      normalizedRecords ?? [],
      { periodStart: aprilAmbetterBatch!.statement_month },
    );
    const { confirmedKeys } = applyOverrides(candidates, weakOverrides);

    // 11. Confirmed-upgrade derivation — Finding A scoped version (NOT loose loop over
    //     boAdjustedReconciled). Start from Coverall-scoped reconciled rows, map to
    //     overlay.adjustedReconciled by member_key, filter out overlay.mceExclusionMemberKeys,
    //     then convert confirmed stable keys to member keys. April Coverall currently has zero
    //     confirmed weak-match upgrades, so confirmedUpgradeMemberKeys stays empty, but the
    //     scoped derivation is preserved so the smoke mirrors probe shape under all conditions.
    const confirmedUpgradeMemberKeys = new Set<string>();
    if (confirmedKeys.size && boAdjustedReconciled.length) {
      const inScope = (reconciled ?? [])
        .filter(
          (r: any) =>
            r.expected_pay_entity === 'Coverall' ||
            r.expected_pay_entity === 'Coverall_or_Vix' ||
            r.actual_pay_entity === 'Coverall',
        )
        .map(
          (r: any) =>
            overlay.adjustedReconciled.find((a: any) => a.member_key === r.member_key) ?? r,
        )
        .filter((r: any) => !overlay.mceExclusionMemberKeys.has(r.member_key));

      for (const r of inScope) {
        if (r.in_back_office) continue;
        const key = pickStableKey({
          issuer_subscriber_id: r.issuer_subscriber_id,
          exchange_subscriber_id: r.exchange_subscriber_id,
          policy_number: r.policy_number,
        });
        if (key && confirmedKeys.has(key)) confirmedUpgradeMemberKeys.add(r.member_key);
      }
    }

    // 12. Canonical helpers (the live-grid probe's final variable sources).
    const foundInBO = getFoundInBackOffice(
      boAdjustedReconciled,
      'Coverall',
      boAdjustedFilteredEde,
      confirmedUpgradeMemberKeys,
    );
    const notInBO = getNotInBackOfficeRows(
      boAdjustedFilteredEde,
      confirmedKeys,
      pickStableKey,
    ).length;
    const expectedEnrollments = boAdjustedFilteredEde.uniqueKeys;

    // 13. Positive diagnostic assertions (complement the deviation check).
    expect(foundInBO).toBe(131);
    expect(notInBO).toBe(42);
    expect(expectedEnrollments).toBe(174);

    // 14. Deviation assertion (preserved shape from v3, now passing).
    expect(Math.abs((foundInBO + notInBO) - expectedEnrollments)).toBe(1);
  }, 30000);

});
