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
import {
  applyRuntimeBOActive,
  getFoundInBackOffice,
  getNotInBackOffice,
  getStatementMonthBounds,
} from '@/lib/canonical';
import { pickStableKey } from '@/lib/weakMatch';

// Directive-standard smoke gating pattern. Default `npm test` skips this
// test entirely via the it.skip fallback when RUN_SMOKE_CONTROLS is not '1'.
const smokeIt = process.env.RUN_SMOKE_CONTROLS === '1' ? it : it.skip;

describe('Leonard Jackson April 2026 Ambetter Coverall — opt-in smoke control', () => {
  smokeIt('sub:3437828 — known EDE→reconciled AOR scope mismatch (deviation magnitude = 1)', async () => {
    // Locate the April 2026 Ambetter batch via production loaders.
    // NOTE: getBatches() orders by created_at DESC. Using .find(...) would
    // return the NEWEST matching batch, but the live-grid probe resolves to
    // the OLDEST via map-overwrite-on-iterate. Use the same shape here.
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


    const reconciled = await getReconciledMembers(aprilAmbetterBatch!.id);
    const normalizedRecords = await getNormalizedRecords(aprilAmbetterBatch!.id);


    const monthBounds = getStatementMonthBounds('2026-04');
    const boNormalized = (normalizedRecords ?? []).filter(
      (r: any) => r.source_type === 'BACK_OFFICE',
    );
    const overlay = applyRuntimeBOActive(reconciled ?? [], boNormalized, monthBounds);
    const boAdjustedReconciled = overlay.adjustedReconciled.filter(
      (r: any) => !overlay.mceExclusionMemberKeys.has(r.member_key),
    );
    const rawFilteredEde = computeFilteredEde(
      normalizedRecords ?? [],
      reconciled ?? [],
      'Coverall',
      ['2026-04'],
      null as any,
    );
    const adjFilteredEdeRaw = computeFilteredEde(
      normalizedRecords ?? [],
      overlay.adjustedReconciled,
      'Coverall',
      ['2026-04'],
      null as any,
    );
    const adjUnique = adjFilteredEdeRaw.uniqueMembers.filter(
      (m: any) => !overlay.mceExclusionMemberKeys.has(m.member_key),
    );
    const adjMissing = adjFilteredEdeRaw.missingFromBO.filter(
      (m: any) => !overlay.mceExclusionMemberKeys.has(m.member_key),
    );
    const boAdjustedFilteredEde = {
      ...adjFilteredEdeRaw,
      uniqueMembers: adjUnique,
      missingFromBO: adjMissing,
      uniqueKeys: adjUnique.length,
    };

    // Identity assertion: Leonard present in raw EDE under Jason Fine (matched
    // by the production identity tuple, NOT by the reconciled-side normalized
    // member_key); in reconciled under non-Coverall AOR.
    const rawLeonard = rawFilteredEde.uniqueMembers.find(
      (m) =>
        m.applicant_name === 'Leonard Jackson' &&
        m.current_policy_aor === 'Jason Fine (21055210)' &&
        m.policy_number === '214039840' &&
        m.issuer_subscriber_id === 'U96069319' &&
        m.exchange_subscriber_id === '0002964539',
    );
    expect(rawLeonard).toBeTruthy();
    expect(rawLeonard?.current_policy_aor).toContain('Jason Fine');
    const reconciledLeonard = (reconciled ?? []).find(
      (r: any) => r.member_key === 'sub:3437828',
    );
    expect(reconciledLeonard).toBeTruthy();
    expect(String(reconciledLeonard?.current_policy_aor ?? '')).not.toMatch(
      /Jason Fine/i,
    );


    // Dashboard deviation assertion (enforced).
    const foundInBO = getFoundInBackOffice(
      boAdjustedReconciled,
      'Coverall',
      boAdjustedFilteredEde,
      new Set(),
    );
    const notInBO = getNotInBackOffice(
      boAdjustedFilteredEde,
      new Set(),
      pickStableKey,
    );
    const expectedEnrollments = rawFilteredEde.uniqueKeys;
    expect(Math.abs((foundInBO + notInBO) - expectedEnrollments)).toBe(1);
  });
});
