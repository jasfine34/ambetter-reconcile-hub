# Bundle 13c Continuation Predraft Audit

Repo state audited: `main` at `c2ebeb6` (`Rolled back disclaimer & null fix`).

Purpose: read-only inventory for the continuation directive that wires the cross-batch clearing overlay into Dashboard, Missing Commission Export, Agent Summary, and completes Unpaid Recovery row-level rendering.

## 1. Current Repo State Confirmation

### 1.1 useCrossBatchOverlay import sites today

Found:

- `src/hooks/useCrossBatchOverlay.ts:35` exports `useCrossBatchOverlay`.
- `src/components/CrossBatchStaleSweepBanner.tsx:19` imports it, and `src/components/CrossBatchStaleSweepBanner.tsx:42` calls it.
- `src/pages/UnpaidRecoveryPage.tsx:50` imports it, and `src/pages/UnpaidRecoveryPage.tsx:402` calls it.

The foundation note that only the stale banner consumed the hook is now stale. A page file does import the hook: Unpaid Recovery has partial 13c wiring.

Consumable as-is: no. The continuation directive must treat UR as partial-shipped and avoid re-adding the hook.

Open question: none. This is direct repo evidence.

### 1.2 CrossBatchRolloutBanner mount sites today

Found:

- `src/components/CrossBatchRolloutBanner.tsx:12` exports `CrossBatchRolloutBanner`.
- `rg` found no imports or renders outside the component file.
- Component behavior: `src/components/CrossBatchRolloutBanner.tsx:10` uses localStorage key `cross_batch_clearings_rollout_seen`; `src/components/CrossBatchRolloutBanner.tsx:31` renders `data-testid="cross-batch-rollout-banner"`.

Consumable as-is: yes. The v3 idea that the component exists but is not mounted is still accurate.

Open question: where exactly to mount it relative to stale/rebuild banners. Dashboard banner anchors are in section 6.2.

### 1.3 EBU_BATCH_SCOPE_DISCLAIMER consumers today

Found:

- Constant value lives at `src/lib/constants.ts:125-126`:
  `"Unpaid counts are based on the selected batch's files only. Payments that appeared in later commission statements may not be cleared here."`
- Imports/renders:
  - `src/pages/DashboardPage.tsx:48`, rendered at `src/pages/DashboardPage.tsx:1415` and `src/pages/DashboardPage.tsx:1561`.
  - `src/pages/MissingCommissionExportPage.tsx:46`, rendered at `src/pages/MissingCommissionExportPage.tsx:893`.
  - `src/pages/AgentSummaryPage.tsx:7`, rendered at `src/pages/AgentSummaryPage.tsx:311`.
  - `src/pages/UnpaidRecoveryPage.tsx:49`, rendered at `src/pages/UnpaidRecoveryPage.tsx:477`.

Consumable as-is: no. The continuation directive must reword the centralized constant and update the static guard, not inline new copy per surface.

Open question: exact Bundle 13c post-overlay disclaimer copy.

### 1.4 dashboard-bundle1-clarity disclaimer guard

Found:

- `src/test/dashboard-bundle1-clarity.test.tsx:460-465` reads the constants file and the four surface files.
- `src/test/dashboard-bundle1-clarity.test.tsx:469-475` hard-codes the current disclaimer literal and asserts the constant file contains it exactly once.
- `src/test/dashboard-bundle1-clarity.test.tsx:478-509` asserts Dashboard, MCE, Agent Summary, and UR import/render `{EBU_BATCH_SCOPE_DISCLAIMER}`.

Exact assertion to update:

```ts
// src/test/dashboard-bundle1-clarity.test.tsx:469-475
const DISCLAIMER_TEXT =
  "Unpaid counts are based on the selected batch's files only. Payments that appeared in later commission statements may not be cleared here.";

it('constant is defined exactly once in src/lib/constants.ts', () => {
  expect(constantsSrc).toMatch(/export const EBU_BATCH_SCOPE_DISCLAIMER\s*=/);
  const occurrences = constantsSrc.split(DISCLAIMER_TEXT).length - 1;
  expect(occurrences).toBe(1);
});
```

Consumable as-is: no. The directive must update this guard in the same patch as the constant rewording.

Open question: whether to keep the exact-once text guard or relax it to assert import/render only.

### 1.5 Baseline test count snapshot

Found:

- `npm test` on current `main` passed: 67 files, 790 tests.

Consumable as-is: yes. Use 790 as the continuation baseline.

Open question: none.

### 1.6 ClearingStatusChip consumers today

Found:

- `src/components/ClearingStatusChip.tsx:29-37` exports `ClearingStatusChip`.
- `src/pages/UnpaidRecoveryPage.tsx:55` imports it.
- No JSX usage was found in `UnpaidRecoveryPage.tsx`; row rendering at `src/pages/UnpaidRecoveryPage.tsx:566-575` only calls `formatCell`.

Consumable as-is: partial. The component exists and is imported, but row-level finalization still needs to consume it.

Open question: whether MCE preview should use the same chip in 13c or defer row adornment to UR only.

### 1.7 formatMoney consumers today

Found:

- `src/lib/utils.ts:15-22` exports `formatMoney`.
- `src/pages/UnpaidRecoveryPage.tsx:56` imports it.
- No call site was found in UR; existing table formatting uses local `formatCell` at `src/pages/UnpaidRecoveryPage.tsx:262-270`.

Consumable as-is: partial. The formatter is ready, but continuation should either use it or remove the dead import.

Open question: none.

## 2. DashboardPage.tsx Surface Inventory

### 2.1 getExpectedPaymentBreakdown call sites

Found:

- `src/pages/DashboardPage.tsx:628-633` calls:

```ts
const expectedPaymentBreakdown = getExpectedPaymentBreakdown(
  reconciled,
  scopeForCanonical,
  filteredEde,
  confirmedUpgradeMemberKeys,
);
```

- It is returned from the `metrics` memo at `src/pages/DashboardPage.tsx:697`.

Consumable as-is: yes, with adjustment. Recompute overlay-adjusted cohorts inside this same metrics memo, not in an unrelated downstream render path.

Open question: name of the adjusted metrics object. Avoid mutating `expectedPaymentBreakdown` in place unless tests explicitly require that shape.

### 2.2 metrics.unpaid and metrics.estMissing derivation

Found:

- `src/pages/DashboardPage.tsx:634-636`: `shouldPay`, `paidEligible`, and `unpaid` come from `expectedPaymentBreakdown.universe.total`, `.paidCount`, `.unpaidCount`.
- `src/pages/DashboardPage.tsx:650` computes `estMissing` through `getExpectedMissingCommissionSum(reconciled, scopeForCanonical, filteredEde, confirmedUpgradeMemberKeys)`.
- `src/lib/canonical/metrics.ts:495-512` shows `getExpectedMissingCommissionSum` recomputes `getExpectedPaymentBreakdown` and sums `estimated_missing_commission` over `breakdown.unpaidRows`.

Consumable as-is: no. If Dashboard gets overlay-aware counts but leaves `getExpectedMissingCommissionSum` untouched, counts and dollars can diverge.

Open question: whether continuation should introduce a new overlay-aware dollar helper, or compute via `partitionUnpaidRowsByOverlay` and `sumEffectiveEstMissing`.

### 2.3 EBU source-split chips

Found:

- The top Expected But Unpaid card renders at `src/pages/DashboardPage.tsx:1270-1286`.
- Its source chips consume `metrics.expectedPaymentBreakdown.unpaidSplit` at `src/pages/DashboardPage.tsx:1277-1281`.

Consumable as-is: no. 13c needs adjusted split counts from the regular unpaid partition, not the raw `unpaidSplit`.

Open question: should needs-review rows stay in regular split chips? Current helper semantics place `mark_needs_review` rows in regular and needsReview (`src/lib/canonical/crossBatchOverlay.ts:219-222`), so likely yes.

### 2.4 EBU premium-split chips

Found:

- Same card as above, `src/pages/DashboardPage.tsx:1270-1286`.
- Premium chips consume `metrics.expectedPaymentBreakdown.unpaidPremiumSplit` at `src/pages/DashboardPage.tsx:1282-1285`.

Consumable as-is: no. Recompute from overlay-regular unpaid rows.

Open question: for partially cleared rows, premium bucket still comes from row `net_premium`, not overlay amount. That matches current helper naming but should be explicit.

### 2.5 Source Coverage section

Found:

- `sourceCoverage` is computed at `src/pages/DashboardPage.tsx:662-669`; `unpaidExpected` is currently `sourceCoverage.expectedButUnpaid.count` at `src/pages/DashboardPage.tsx:675`.
- Drilldown for Source Coverage EBU uses `sc.expectedButUnpaid.rows` at `src/pages/DashboardPage.tsx:946`.
- Source Coverage Analysis renders at `src/pages/DashboardPage.tsx:1491-1563`.
- Its Expected But Unpaid tile value is `metrics.unpaidExpected` at `src/pages/DashboardPage.tsx:1500-1505`.
- Owner chips do not consume `sourceCoverage.expectedButUnpaid` directly; they consume `metrics.expectedPaymentBreakdown.unpaidOwnerSplit` at `src/pages/DashboardPage.tsx:1507-1515`.

Consumable as-is: no. 13c must adjust both the `sourceCoverage.expectedButUnpaid` row/count path and the owner chips, or the tile count and chips can disagree.

Open question: whether `sourceCoverage.expectedButUnpaid.rows` should be replaced with overlay-regular rows, or whether Source Coverage should receive an adjusted facade object.

### 2.6 Dashboard header area and rebuild button

Found:

- Header controls show scope selector and maintenance buttons at `src/pages/DashboardPage.tsx:970-1003`.
- Neighboring buttons:
  - Re-run Reconciliation: `src/pages/DashboardPage.tsx:980-983`.
  - Run Invariants: `src/pages/DashboardPage.tsx:984-995`.
  - Resolve Identities Across Batches: `src/pages/DashboardPage.tsx:996-999`.
  - RebuildBatchButton / RebuildAllBatchesButton / RebuildCrossBatchClearingsButton: `src/pages/DashboardPage.tsx:1000-1002`.
  - BatchSelector: `src/pages/DashboardPage.tsx:1003`.
- Last full rebuild timestamp renders below banners at `src/pages/DashboardPage.tsx:1077-1081`.

Consumable as-is: yes. Mount new cross-batch banners below the header and before the existing matching explanation, following the existing card banner pattern.

Open question: exact order: rollout banner, stale sweep banner, then existing stale rebuild/failsafe banners, or stale sweep after existing rebuild warnings.

### 2.7 Existing top-metric tile layout

Found:

- Top metric grid contains the initial tiles around `src/pages/DashboardPage.tsx:1129-1136` (Expected Enrollments), `src/pages/DashboardPage.tsx:1171-1190` (Not in Back Office), and then expected-payment cards around `src/pages/DashboardPage.tsx:1241-1286`.
- Expected But Unpaid is the natural anchor at `src/pages/DashboardPage.tsx:1270-1286`.
- Net Paid Commission begins immediately after at `src/pages/DashboardPage.tsx:1287-1290`.

Consumable as-is: yes. The new "Cleared then reversed" cohort-scoped tile should sit adjacent to Expected But Unpaid, likely after it and before Net Paid Commission, to keep recovery-state tiles together.

Open question: should the tile appear only when count > 0, or always with 0 for discoverability?

### 2.8 Dashboard disclaimer render sites

Found:

- Dashboard EBU card disclaimer: `src/pages/DashboardPage.tsx:1411-1416`, `data-testid="dashboard-ebu-disclaimer"`.
- Source Coverage EBU disclaimer: `src/pages/DashboardPage.tsx:1557-1562`, `data-testid="dashboard-source-coverage-ebu-disclaimer"`.
- Both render `{EBU_BATCH_SCOPE_DISCLAIMER}` imported at `src/pages/DashboardPage.tsx:48`.

Consumable as-is: yes if the constant is reworded centrally.

Open question: none.

## 3. MissingCommissionExportPage.tsx Surface Inventory

### 3.1 getExpectedPaymentBreakdown call site and missingMembers derivation

Found:

- `src/pages/MissingCommissionExportPage.tsx:608-614` computes scoped EDE rows.
- `src/pages/MissingCommissionExportPage.tsx:621-630` computes `confirmedUpgradeMemberKeys`.
- `src/pages/MissingCommissionExportPage.tsx:633-636` calls `getExpectedPaymentBreakdown(reconciledSnapshot, f.scope, ranFilteredEde, confirmedUpgradeMemberKeys)` and sets `missingMembers = breakdown.unpaidRows`.

Consumable as-is: no. 13c must partition `breakdown.unpaidRows` through the overlay before building export rows, or fully cleared/zero-expected rows still export.

Open question: whether MCE should include `manual_review_required` in export or exclude/flag. Current overlay helper semantics keep needs-review in regular (`src/lib/canonical/crossBatchOverlay.ts:219-222`).

### 3.2 _estimatedMissingCommission field

Found:

- `ExportRow` includes `_estimatedMissingCommission` at `src/pages/MissingCommissionExportPage.tsx:84`.
- It is included in `INTERNAL_COLUMNS` at `src/pages/MissingCommissionExportPage.tsx:118`.
- It is set from `m.estimated_missing_commission` or `DEFAULT_COMMISSION_ESTIMATE` at `src/pages/MissingCommissionExportPage.tsx:782-785`, then assigned at `src/pages/MissingCommissionExportPage.tsx:822`.
- It is rendered in the preview at `src/pages/MissingCommissionExportPage.tsx:1183-1186`.

Consumable as-is: partial. The field exists, so v3 does not need to invent it. But 13c should feed effective overlay dollars here for partial payments.

Open question: should MCE preview show both legacy estimate and effective remainder, or replace the internal estimate with adjusted value?

### 3.3 Messer CSV column generation

Found:

- Messer export columns are exactly `MESSER_COLUMNS` at `src/pages/MissingCommissionExportPage.tsx:93-106`: Carrier Name, NPN, Writing Agent Carrier ID, Writing Agent Name, Policy Effective Date, Policy #, Member First Name, Member Last Name, DOB, SSN, Member ID, Address.
- CSV generation loops only over `MESSER_COLUMNS` at `src/pages/MissingCommissionExportPage.tsx:425-440`.
- `INTERNAL_COLUMNS` are preview-only at `src/pages/MissingCommissionExportPage.tsx:108-120`.

Consumable as-is: yes. Directive should explicitly forbid adding clearing columns to the Messer CSV; preview-only badges/fields are safer.

Open question: none.

### 3.4 12.7 non-fatal commission fallback path

Found:

- Cross-batch enrichment begins at `src/pages/MissingCommissionExportPage.tsx:647`.
- `getNormalizedRecordsByMemberKeys` loads profile records at `src/pages/MissingCommissionExportPage.tsx:675`.
- `getCommissionRecordsByTriples` is attempted at `src/pages/MissingCommissionExportPage.tsx:677-678`.
- If the triple lookup fails, it sets `commissionTripleFallbackFailed = true`, clears fallback rows, and logs a warning at `src/pages/MissingCommissionExportPage.tsx:679-683`.
- The report still completes with a warning toast at `src/pages/MissingCommissionExportPage.tsx:842-847`.

Consumable as-is: yes, but 13c must not turn overlay load failures into full report failure unless explicitly intended.

Open question: should overlay load failure follow this non-fatal warning model, or fail closed to legacy selected-batch behavior?

### 3.5 MCE disclaimer render site

Found:

- `src/pages/MissingCommissionExportPage.tsx:889-894`, `data-testid="mce-ebu-disclaimer"`, renders `{EBU_BATCH_SCOPE_DISCLAIMER}` imported at `src/pages/MissingCommissionExportPage.tsx:46`.

Consumable as-is: yes if the constant is updated centrally.

Open question: none.

### 3.6 Existing row preview UI

Found:

- Header renders MESSER and internal columns at `src/pages/MissingCommissionExportPage.tsx:1108-1116`.
- Preview row cells render MESSER fields at `src/pages/MissingCommissionExportPage.tsx:1142-1176`.
- Existing badge pattern: source badge inside field cells at `src/pages/MissingCommissionExportPage.tsx:1157-1162`.
- Existing conflict icon pattern: `AlertTriangle` tooltip at `src/pages/MissingCommissionExportPage.tsx:1163-1171`.
- Internal fields render at `src/pages/MissingCommissionExportPage.tsx:1177-1195`, with `_estimatedMissingCommission` special-cased at `src/pages/MissingCommissionExportPage.tsx:1183-1186`.

Consumable as-is: yes. New clearing status should use `ClearingStatusChip` as a preview adornment, not alter Messer CSV columns.

Open question: exact cell home for clearing chip: source type internal column, missing reason, or a new preview-only internal column.

## 4. AgentSummaryPage.tsx Surface Inventory

### 4.1 canonicalUnpaidRows derivation

Found:

- Scope comes from `usePayEntityScope` at `src/pages/AgentSummaryPage.tsx:70`.
- Filtered EDE is computed at `src/pages/AgentSummaryPage.tsx:119-122`.
- `canonicalUnpaidRows` is derived at `src/pages/AgentSummaryPage.tsx:152-155` as:
  `getExpectedPaymentBreakdown(reconciled, scope, filteredEde, confirmedUpgradeMemberKeys).unpaidRows`.

Consumable as-is: no. 13c must partition this row set before owner aggregation.

Open question: should Agent Summary show a separate "needs review" chip/field per agent, or only adjust counts/dollars silently plus a note?

### 4.2 Per-agent entry construction

Found:

- `unpaidByOwnerBucket` groups `canonicalUnpaidRows` at `src/pages/AgentSummaryPage.tsx:161-171`.
- Entry shape in the map is `{ count: number; estMissing: number }` at `src/pages/AgentSummaryPage.tsx:162`.
- Count increments at `src/pages/AgentSummaryPage.tsx:166`; dollars add `estimated_missing_commission` at `src/pages/AgentSummaryPage.tsx:167`.
- `agentData` rows are built at `src/pages/AgentSummaryPage.tsx:180-215`, with `unpaid_count` at `src/pages/AgentSummaryPage.tsx:210` and `estimated_missing_commission` at `src/pages/AgentSummaryPage.tsx:212`.
- The "Other AORs" aggregate repeats the legacy dollar sum at `src/pages/AgentSummaryPage.tsx:235-260`.

Consumable as-is: no. Add overlay partition per owner bucket so removed rows drop out, partial rows use effective remainder, reversed rows move to a separate subset, and needs-review counts can be exposed.

Open question: whether `written_by_count` for the Other AOR aggregate should remain `otherUnpaidCount` at `src/pages/AgentSummaryPage.tsx:254`; it is currently a disclosure row, not literal writing-agent data.

### 4.3 Per-agent chip render

Found:

- No per-agent chips currently render.
- `agentData` is rendered as three `MetricCard`s at `src/pages/AgentSummaryPage.tsx:314-322`; subtitle includes paid count and commission dollars at `src/pages/AgentSummaryPage.tsx:320`.
- Table data is rendered via generic `DataTable` at `src/pages/AgentSummaryPage.tsx:324`.
- `DataTable` supports `filterChips` at `src/components/DataTable.tsx:13` and renders them at `src/components/DataTable.tsx:64-73`; it also supports `renderCell` at `src/components/DataTable.tsx:15-19` and uses it at `src/components/DataTable.tsx:97-110`.

Consumable as-is: partial. There is no current chip home in Agent Summary. Use `DataTable.renderCell` or `filterChips` deliberately if adding "Needs review"; do not assume an existing chip pattern on this page.

Open question: should the new needs-review subset be in the cards, the table, or both?

### 4.4 Agent Summary disclaimer render site

Found:

- `src/pages/AgentSummaryPage.tsx:307-312`, `data-testid="agent-summary-ebu-disclaimer"`, renders `{EBU_BATCH_SCOPE_DISCLAIMER}` imported at `src/pages/AgentSummaryPage.tsx:7`.

Consumable as-is: yes if constant is updated centrally.

Open question: none.

## 5. UnpaidRecoveryPage.tsx Finalization Inventory

### 5.1 adjustedByRow current state

Found:

- UR computes `breakdown` at `src/pages/UnpaidRecoveryPage.tsx:393-396`, then assigns `rawUnpaidRows` and `universe` at `src/pages/UnpaidRecoveryPage.tsx:398-399`.
- `useCrossBatchOverlay` is called at `src/pages/UnpaidRecoveryPage.tsx:402`.
- `partitionUnpaidRowsByOverlay(rawUnpaidRows, clearingOverlay)` runs at `src/pages/UnpaidRecoveryPage.tsx:403-406`.
- `adjustedByRow` is a `Map<any, AdjustedRow>` keyed by the original row object at `src/pages/UnpaidRecoveryPage.tsx:408-412`.

Consumable as-is: partial. Object-keyed lookup is safe only while rendering original row objects. It will fail if rendering uses derived rows. Current `pagedRows` are original row objects, so row-level finalization can use `adjustedByRow.get(r)`.

Open question: whether to switch to grain-key lookup to make CSV/export and display more resilient.

### 5.2 filteredRows and filter chips

Found:

- `showReversed` is controlled by URL query param `filter=clearedThenReversed` at `src/pages/UnpaidRecoveryPage.tsx:414-423`.
- `overlayedUnpaidRows` uses regular rows by default, and includes reversed rows only when `showReversed` is true at `src/pages/UnpaidRecoveryPage.tsx:425-430`.
- `filteredRows` comes from `filterUnpaidRecoveryRows(overlayedUnpaidRows, universe, filters, getFfmId)` at `src/pages/UnpaidRecoveryPage.tsx:436-438`.
- Existing filters render at `src/pages/UnpaidRecoveryPage.tsx:493-533`.
- The "Cleared then reversed" chip already renders at `src/pages/UnpaidRecoveryPage.tsx:536-544`.

Consumable as-is: yes for reversed partition behavior. Continuation should finish status/dollar rendering rather than reimplement the filter.

Open question: whether a second chip for "Needs review" belongs beside the existing reversed chip.

### 5.3 Row component shape

Found:

- Columns are defined at `src/pages/UnpaidRecoveryPage.tsx:191-204`; `estimated_missing_commission` is column key at `src/pages/UnpaidRecoveryPage.tsx:200`.
- `deriveDisplayRow` maps `estimated_missing_commission: r.estimated_missing_commission ?? null` at `src/pages/UnpaidRecoveryPage.tsx:208-226`.
- `formatCell` formats `net_premium` and `estimated_missing_commission` as dollars at `src/pages/UnpaidRecoveryPage.tsx:262-267`.
- Row rendering uses `deriveDisplayRow(r, universe, getFfmId)` and `formatCell(c.key, (d as any)[c.key])` at `src/pages/UnpaidRecoveryPage.tsx:566-575`.

Consumable as-is: partial. Row-level badge and adjusted dollar rendering should hook into this `pagedRows.map` block. For partial rows, replace the displayed `estimated_missing_commission` value with `adjustedByRow.get(r)?.effectiveEstMissing`.

Open question: whether CSV export should also use adjusted dollars. The current CSV path uses `buildUnpaidRecoveryCsv(filteredRows, universe, getFfmId)` at `src/pages/UnpaidRecoveryPage.tsx:453`, and `buildUnpaidRecoveryCsv` derives legacy display rows at `src/pages/UnpaidRecoveryPage.tsx:229-244`.

### 5.4 Unused partial-ship imports/locals

Found:

- `ClearingStatusChip` imported at `src/pages/UnpaidRecoveryPage.tsx:55`, currently unused.
- `formatMoney` imported at `src/pages/UnpaidRecoveryPage.tsx:56`, currently unused.
- `adjustedByRow` is built at `src/pages/UnpaidRecoveryPage.tsx:408-412`, currently unused by the render loop at `src/pages/UnpaidRecoveryPage.tsx:566-575`.

Consumable as-is: no. Continuation should consume these exactly once, not add a parallel helper path.

Open question: none.

### 5.5 UR disclaimer render site

Found:

- `src/pages/UnpaidRecoveryPage.tsx:473-478`, `data-testid="ur-ebu-disclaimer"`, renders `{EBU_BATCH_SCOPE_DISCLAIMER}` imported at `src/pages/UnpaidRecoveryPage.tsx:49`.

Consumable as-is: yes if constant is updated centrally.

Open question: none.

## 6. Cross-Cutting

### 6.1 Scope filter consumer pattern

Dashboard:

- Scope value is shared hook state: `src/pages/DashboardPage.tsx:235` calls `usePayEntityScope`.
- Scope is passed to `getExpectedPaymentBreakdown` as `scopeForCanonical` at `src/pages/DashboardPage.tsx:628-633`.
- Scope also feeds `getExpectedMissingCommissionSum` at `src/pages/DashboardPage.tsx:650` and Source Coverage at `src/pages/DashboardPage.tsx:662-669`.

MCE:

- Local scope state starts as Coverall at `src/pages/MissingCommissionExportPage.tsx:471`.
- Scope is part of `filters` at `src/pages/MissingCommissionExportPage.tsx:497-498`.
- It passes through `computeFilteredEde` at `src/pages/MissingCommissionExportPage.tsx:608-614`, `filterReconciledByScope` at `src/pages/MissingCommissionExportPage.tsx:621`, and `getExpectedPaymentBreakdown` at `src/pages/MissingCommissionExportPage.tsx:633-635`.
- It also drives target pay entity in the commission-triple fallback at `src/pages/MissingCommissionExportPage.tsx:661-666`.

Agent Summary:

- Scope value is shared hook state at `src/pages/AgentSummaryPage.tsx:70`.
- It scopes commission dollars through `filterCommissionRowsByScope` at `src/pages/AgentSummaryPage.tsx:107-117`.
- It scopes EDE via `computeFilteredEde` at `src/pages/AgentSummaryPage.tsx:119-122`.
- It scopes unpaid via `getExpectedPaymentBreakdown(...).unpaidRows` at `src/pages/AgentSummaryPage.tsx:152-155`.

Unpaid Recovery:

- Scope value is shared hook state at `src/pages/UnpaidRecoveryPage.tsx:281`.
- URL sync is managed at `src/pages/UnpaidRecoveryPage.tsx:293-316`.
- Scope feeds `computeFilteredEde` at `src/pages/UnpaidRecoveryPage.tsx:366-369`, `filterReconciledByScope` at `src/pages/UnpaidRecoveryPage.tsx:380`, and `getExpectedPaymentBreakdown` at `src/pages/UnpaidRecoveryPage.tsx:393-395`.

Consumable as-is: yes. Each surface already pushes scope through `getExpectedPaymentBreakdown`; overlay adjustments should happen after that raw unpaid universe is created, not by changing scope filters.

Open question: whether MCE should adopt `usePayEntityScope` like Dashboard/Agent/UR, or intentionally remain local report filters.

### 6.2 Toast/banner mount points

Found:

- Dashboard header ends at `src/pages/DashboardPage.tsx:1005`.
- Existing stale-batch banner uses `Card` + `CardContent` at `src/pages/DashboardPage.tsx:1007-1025`.
- Existing zero-reconciled failsafe banner uses the same card pattern at `src/pages/DashboardPage.tsx:1027-1053`.
- Existing stale-logic warning uses the same card pattern at `src/pages/DashboardPage.tsx:1055-1075`.
- Last full rebuild timestamp renders at `src/pages/DashboardPage.tsx:1077-1081`.
- `CrossBatchStaleSweepBanner` is self-contained and currently unmounted; its component renders `data-testid="cross-batch-stale-banner"` at `src/components/CrossBatchStaleSweepBanner.tsx:98-121`.
- `CrossBatchRolloutBanner` is self-contained and currently unmounted; its component renders `data-testid="cross-batch-rollout-banner"` at `src/components/CrossBatchRolloutBanner.tsx:30-47`.

Consumable as-is: yes. Mount both banners below the header controls and before the matching explanation. Reuse the card banner pattern.

Open question: should rollout banner be gated on overlay load success/non-empty, or just appear once after code deploy.

### 6.3 Centralized-constant guard

Found:

- Same as section 1.4. The exact-once constant assertion is at `src/test/dashboard-bundle1-clarity.test.tsx:472-475`.
- Cross-surface render assertions are at `src/test/dashboard-bundle1-clarity.test.tsx:478-509`.

Consumable as-is: no. Update this test with the new copy and keep the single-constant discipline.

Open question: none.

### 6.4 estimated_missing_commission legacy consumer inventory

Production references found:

- `src/pages/AgentSummaryPage.tsx:167` sums legacy estimate per owner bucket.
- `src/pages/AgentSummaryPage.tsx:212` writes it into per-agent rows.
- `src/pages/AgentSummaryPage.tsx:227` includes table column.
- `src/pages/AgentSummaryPage.tsx:243` sums Other AORs legacy estimate.
- `src/pages/AgentSummaryPage.tsx:260` writes Other AORs estimate.
- `src/pages/ExceptionsPage.tsx:20` table column.
- `src/integrations/supabase/types.ts:529`, `src/integrations/supabase/types.ts:563`, `src/integrations/supabase/types.ts:597` generated type rows/inserts/updates.
- `src/pages/MissingCommissionExportPage.tsx:783-784` fallback source for `_estimatedMissingCommission`.
- `src/pages/UnpaidRecoveryPage.tsx:200` column definition.
- `src/pages/UnpaidRecoveryPage.tsx:222` display row field.
- `src/pages/UnpaidRecoveryPage.tsx:265` dollar formatting branch.
- `src/lib/canonical/crossBatchOverlay.ts:198` legacy estimate fallback inside overlay partition helper.
- `src/lib/canonical/invariants.ts:269` and `src/lib/canonical/invariants.ts:279` invariant guard/copy.
- `src/lib/reconcile.ts:126` type field.
- `src/lib/reconcile.ts:815` commission-less batch suppression comment.
- `src/lib/reconcile.ts:980` reconciled member output assignment.
- `src/lib/persistence.ts:791`, `src/lib/persistence.ts:799`, `src/lib/persistence.ts:803` estimate persistence rows.
- `src/lib/canonical/metrics.ts:489` docs and `src/lib/canonical/metrics.ts:509` legacy sum.

Consumable as-is: yes as a static-guard allowlist. 13c should add only overlay-aware consumers, not rewrite every legacy consumer.

Open question: whether Bundle 13e will replace all page-level consumers or leave persistence/reconcile/types as historical fields.

### 6.5 Q19/Q22/Q25 row-classification fanout

Synthetic overlay: one raw EBU row has a matching `cross_batch_clearings` active row with `clearing_state='cleared_then_reversed'`.

Dashboard current behavior:

- Dashboard does not import `useCrossBatchOverlay` today. It uses raw `expectedPaymentBreakdown.unpaidCount` at `src/pages/DashboardPage.tsx:636`, raw split fields at `src/pages/DashboardPage.tsx:1277-1285`, and raw Source Coverage EBU rows at `src/pages/DashboardPage.tsx:946`.
- Current result: row remains in EBU counts/drilldown and no reversed cohort tile exists. This is not double-counting yet because the reversed cohort is absent, but 13c must avoid keeping it in regular EBU and also adding a reversed tile.

MCE current behavior:

- MCE sets `missingMembers = breakdown.unpaidRows` at `src/pages/MissingCommissionExportPage.tsx:636`.
- Current result: row exports as missing commission. Continuation must exclude `cleared_then_reversed` by default or flag it outside the Messer CSV path, depending on the Q27 matrix.

Agent Summary current behavior:

- Agent Summary uses raw `canonicalUnpaidRows` at `src/pages/AgentSummaryPage.tsx:152-155`.
- It then counts/sums by owner at `src/pages/AgentSummaryPage.tsx:161-171`.
- Current result: row remains in owner unpaid count and missing dollar sum. Continuation must partition it out of regular unpaid and expose reversed subset if required.

Unpaid Recovery current behavior:

- UR already partitions rows with `partitionUnpaidRowsByOverlay` at `src/pages/UnpaidRecoveryPage.tsx:403-406`.
- `cleared_then_reversed` maps to `move_to_reversed_bucket` at `src/lib/canonical/crossBatchOverlay.ts:149-150`.
- The reversed row is hidden by default and shown only when `showReversed` is true at `src/pages/UnpaidRecoveryPage.tsx:425-430`.
- Current result: partitioning is plausibly correct, but row-level status/dollars are not displayed because `adjustedByRow`, `ClearingStatusChip`, and `formatMoney` are unused.

Consumable as-is: partial. UR behavior can be finalized. The other three surfaces need fresh overlay plumbing.

Open question: the Q27 matrix should be explicit for `manual_review_required`: current helper keeps it in regular and needsReview (`src/lib/canonical/crossBatchOverlay.ts:219-222`).

## 7. Inversion Pass at Audit Time

### 7.1 metrics.unpaid and metrics.estMissing computation location

Found:

- Dashboard computes both inside the page metrics memo, not in an external hook: `src/pages/DashboardPage.tsx:628-650`.
- However `estMissing` calls a helper that recomputes the raw breakdown (`src/lib/canonical/metrics.ts:501-509`), rather than consuming the `expectedPaymentBreakdown` already bound in Dashboard.

Spec adjustment:

- Recompute overlay-adjusted count and dollar values inside Dashboard's metrics memo. Do not only patch render lines.
- Avoid calling raw `getExpectedMissingCommissionSum` for the adjusted EBU dollar tile after 13c wiring.

Open question: whether to keep raw `estMissing` in metrics for 13e parity tests and add `adjustedEstMissing`, or replace `estMissing`.

### 7.2 Split chips may need deeper rewrite

Found:

- Top EBU source chips consume `metrics.expectedPaymentBreakdown.unpaidSplit` at `src/pages/DashboardPage.tsx:1277-1281`.
- Premium chips consume `metrics.expectedPaymentBreakdown.unpaidPremiumSplit` at `src/pages/DashboardPage.tsx:1282-1285`.
- Source Coverage owner chips consume `metrics.expectedPaymentBreakdown.unpaidOwnerSplit` at `src/pages/DashboardPage.tsx:1507-1515`.

Spec adjustment:

- The continuation cannot simply swap `metrics.unpaid`. It needs an adjusted split object for source, premium, and owner chips.

Open question: should `expectedPaymentBreakdown` get wrapped in an adjusted facade, or should adjusted split fields live as separate `metrics.adjustedUnpaidSplit`, `metrics.adjustedUnpaidPremiumSplit`, `metrics.adjustedUnpaidOwnerSplit`.

### 7.3 Partial UR imports/signatures

Found:

- `ClearingStatusChip` signature is `({ state }: { state: ClearingState })` at `src/components/ClearingStatusChip.tsx:29`.
- `formatMoney` signature is `(amount: number | null | undefined, opts?: { signed?: boolean })` at `src/lib/utils.ts:15`.
- UR imports both at `src/pages/UnpaidRecoveryPage.tsx:55-56`, but does not use them.

Spec adjustment:

- Reuse these exact imports/signatures. Do not add duplicate chip/formatter helpers.

Open question: whether the table should show a chip beside `estimated_missing_commission`, `source_type`, or `issue_type`.

### 7.4 Other plausible-but-wrong readings

1. Wrong: "No page imports `useCrossBatchOverlay`, so all four surfaces start blank."
   - Current reality: UR imports/calls it at `src/pages/UnpaidRecoveryPage.tsx:50` and `src/pages/UnpaidRecoveryPage.tsx:402`.
   - Adjustment: make UR a finalization task only.

2. Wrong: "CrossBatchRolloutBanner is already mounted because the component exists."
   - Current reality: `rg` finds only `src/components/CrossBatchRolloutBanner.tsx:12`.
   - Adjustment: continuation must add the Dashboard mount and tests.

3. Wrong: "Updating Dashboard `metrics.unpaid` is enough."
   - Current reality: drilldowns and Source Coverage still use raw rows at `src/pages/DashboardPage.tsx:935-946`, and chips use raw split fields at `src/pages/DashboardPage.tsx:1277-1285` and `src/pages/DashboardPage.tsx:1507-1515`.
   - Adjustment: update counts, dollars, splits, and row arrays together.

4. Wrong: "MCE can add clearing columns to the Messer CSV."
   - Current reality: CSV uses only `MESSER_COLUMNS` at `src/pages/MissingCommissionExportPage.tsx:425-440`, while internal fields are preview-only at `src/pages/MissingCommissionExportPage.tsx:108-120`.
   - Adjustment: keep clearing indicators out of CSV columns unless Jason explicitly changes the Messer form contract.

5. Wrong: "Agent Summary already has chip UI."
   - Current reality: Agent cards are simple `MetricCard`s at `src/pages/AgentSummaryPage.tsx:314-322`, and table rendering is generic DataTable at `src/pages/AgentSummaryPage.tsx:324`.
   - Adjustment: specify a concrete rendering home for needs-review/reversed subsets.

6. Wrong: "The generated Supabase types include cross_batch_clearings."
   - Current reality: `rg` found no `cross_batch_clearings` or RPC entries in `src/integrations/supabase/types.ts`; new reads use `(supabase as any)` in `src/hooks/useCrossBatchOverlay.ts:58-60` and the sweep RPC uses `(supabase as any)` at `src/lib/sweep/crossBatchClearingSweep.ts:539-541`.
   - Adjustment: continue Option B untyped access unless 13c explicitly regenerates types.

7. Wrong: "Partial row adjustment can read `overlay.remainder_owed` directly everywhere."
   - Current reality: helper docs say surfaces consume `effectiveEstMissing`, not `overlay.remainder_owed` directly at `src/lib/canonical/crossBatchOverlay.ts:177-180`; remainder fallback logic lives at `src/lib/canonical/crossBatchOverlay.ts:71-77`.
   - Adjustment: use `AdjustedRow.effectiveEstMissing` and `sumEffectiveEstMissing`.

8. Wrong: "The comp-grid effective year issue is part of continuation."
   - Current reality: sweep still loads comp rates with `effectiveYear: 2026` at `src/lib/sweep/crossBatchClearingSweep.ts:350`.
   - Adjustment: note as deferred unless continuation touches sweep logic.

Jason, tell Claude to read docs/bundle-13c-continuation-predraft-audit.md
