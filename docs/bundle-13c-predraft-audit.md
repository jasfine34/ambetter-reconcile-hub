# Bundle 13c Pre-Draft Repo Audit

Repo HEAD audited: `3772831592154d49e1f6e0fa00be7ca12ad1cb55`.

Scope: inventory only. No production files, tests, migrations, or generated types were modified.

## 1. Function Signatures, Columns, Constants, Patterns 13c Will Consume

### 1.1 getExpectedPaymentBreakdown

Found in `src/lib/canonical/metrics.ts`.

- Signature: `getExpectedPaymentBreakdown(reconciled: any[], scope: CanonicalScope, filteredEde: FilteredEdeResult, confirmedUpgradeMemberKeys: Set<string>): ExpectedPaymentBreakdown` (`src/lib/canonical/metrics.ts:446-451`).
- Return shape includes `universe`, `paidRows`, `unpaidRows`, `paidCount`, `unpaidCount`, `paidSplit`, `unpaidSplit`, `unpaidPremiumSplit`, and `unpaidOwnerSplit` (`src/lib/canonical/metrics.ts:390-417`).
- Unpaid rows are `unpaidRows`; unpaid count is `unpaidCount`; source splits are `unpaidSplit`; premium split is `unpaidPremiumSplit`; owner split is `unpaidOwnerSplit` (`src/lib/canonical/metrics.ts:394-417`).
- It is pure/no DB I/O. The function calls `getExpectedPaymentUniverse(...)`, loops in memory, and returns arrays/counts (`src/lib/canonical/metrics.ts:452-485`).
- Legacy unpaid dollar total currently comes from `getExpectedMissingCommissionSum(...)`, which sums `estimated_missing_commission` across `breakdown.unpaidRows` (`src/lib/canonical/metrics.ts:489-512`).
- Existing call sites:
  - Dashboard metrics builds `expectedPaymentBreakdown` and uses `unpaidCount` (`src/pages/DashboardPage.tsx:627-637`).
  - Dashboard EBU drilldown returns `epb.unpaidRows` with `_sourceType` (`src/pages/DashboardPage.tsx:930-935`).
  - Agent Summary builds `canonicalUnpaidRows` from `.unpaidRows` (`src/pages/AgentSummaryPage.tsx:148-155`).
  - Missing Commission Export runs `getExpectedPaymentBreakdown(...)` and assigns `missingMembers = breakdown.unpaidRows` (`src/pages/MissingCommissionExportPage.tsx:603-634`).
  - Unpaid Recovery derives `breakdown`, `unpaidRows`, and `universe` from the helper (`src/pages/UnpaidRecoveryPage.tsx:386-392`).

Readiness: ready to consume, but 13c should avoid changing this helper directly unless it is introducing a shared "clearing-adjusted EBU" wrapper. The current helper is the canonical batch-local source.

Open question: should 13c create a new helper that wraps this breakdown with clearing overlays, or patch each surface locally? Strong recommendation: new shared helper/hook to avoid matrix drift.

### 1.2 The Five EBU Surfaces

#### Dashboard EBU Tile

- Scope source: shared `usePayEntityScope()` returns `payEntityFilter` (`src/pages/DashboardPage.tsx:235`).
- Scope is applied upstream through `computeFilteredEde(normalizedRecords, reconciled, payEntityFilter, ...)` (`src/pages/DashboardPage.tsx:439-447`) and through canonical helpers using `scopeForCanonical` (`src/pages/DashboardPage.tsx:618-633`).
- The EBU count is `metrics.unpaid`, which is `expectedPaymentBreakdown.unpaidCount` (`src/pages/DashboardPage.tsx:634-637`), rendered as `MetricCard title="Expected But Unpaid" value={metrics.unpaid}` (`src/pages/DashboardPage.tsx:1270-1286`).
- The EBU tile has source and premium split chips via `unpaidSplit` and `unpaidPremiumSplit` (`src/pages/DashboardPage.tsx:1277-1285`).
- Dollar amount is not on the EBU tile. The current missing-dollar surface is a separate `Est. Missing Commission` card using `metrics.estMissing` (`src/pages/DashboardPage.tsx:650`, `src/pages/DashboardPage.tsx:1409`).
- Drilldown rows come from `epb.unpaidRows.map(...)` and carry `_sourceType` only (`src/pages/DashboardPage.tsx:916-920`, `src/pages/DashboardPage.tsx:935`).
- Drilldown columns do not include clearing status. `UNPAID_DETAILS_DRILLDOWN_COLUMNS` appends only `_sourceType` to coverage columns (`src/pages/DashboardPage.tsx:135-156`).

Readiness: can remove/reduce rows before `metrics.unpaid` and drilldown are rendered, but a shared adjusted-breakdown helper is safer than per-card edits.

Open question: for Dashboard top metrics, should 13c also adjust the separate `Est. Missing Commission` card in this slice, or only the EBU count/splits? Q27/Q24 imply dollar surfaces should shift, but the current count and dollar are separate UI elements.

#### Source Coverage EBU

- Produced by `getSourceCoverageBuckets(...)`, whose interface includes `expectedButUnpaid: { rows; count }` (`src/lib/canonical/metrics.ts:532-538`).
- The helper builds `expectedButUnpaidRows = universe.rows.filter((r) => !r.in_commission)` (`src/lib/canonical/metrics.ts:645-650`).
- Dashboard stores `sourceCoverage` and uses `sourceCoverage.expectedButUnpaid.count` as `metrics.unpaidExpected` (`src/pages/DashboardPage.tsx:658-675`).
- Rendered as Source Coverage `MetricCard title="Expected But Unpaid" value={metrics.unpaidExpected}` with owner split chips from `expectedPaymentBreakdown.unpaidOwnerSplit` (`src/pages/DashboardPage.tsx:1490-1516`).
- Source Coverage EBU drilldown returns `sc.expectedButUnpaid.rows` (`src/pages/DashboardPage.tsx:945-947`) and renders with `COVERAGE_DRILLDOWN_COLUMNS`, which has no clearing-status column (`src/pages/DashboardPage.tsx:135-146`, `src/pages/DashboardPage.tsx:1487`).
- Disclaimer appears below Source Coverage at `data-testid="dashboard-source-coverage-ebu-disclaimer"` (`src/pages/DashboardPage.tsx:1557-1562`).

Readiness: count/remove decisions need to happen before `metrics.unpaidExpected` and `sc.expectedButUnpaid.rows` reach the card/drilldown.

Open question: if `manual_review_required` is "count separately", does Source Coverage gain a new tile/chip, or does the existing EBU tile render a split chip? Current MetricCard supports split chips but no badge/status prop (`src/components/MetricCard.tsx:19-26`, `src/components/MetricCard.tsx:85-111`).

#### Missing Commission Export

- Uses local `scope` state, not the shared `usePayEntityScope` hook (`src/pages/MissingCommissionExportPage.tsx:469-470`).
- The report is lazy. Filter changes reset to idle (`src/pages/MissingCommissionExportPage.tsx:509-522`); `runReport()` snapshots filters and selected batch (`src/pages/MissingCommissionExportPage.tsx:551-576`).
- Computes selected-batch `filteredEde`, weak-match upgrades, then `breakdown = getExpectedPaymentBreakdown(...)` and `missingMembers = breakdown.unpaidRows` (`src/pages/MissingCommissionExportPage.tsx:603-634`).
- Result rows are `ExportRow[]`; internal preview columns include `_missingReason`, `_estimatedMissingCommission`, and `_sourceType` (`src/pages/MissingCommissionExportPage.tsx:61-90`).
- Messer CSV columns do not include clearing status (`src/pages/MissingCommissionExportPage.tsx:92-105`).
- Internal preview columns include "Est. missing commission" and "Source Type", but no clearing status (`src/pages/MissingCommissionExportPage.tsx:107-119`).
- Existing dollar field is derived as `m.estimated_missing_commission` or `DEFAULT_COMMISSION_ESTIMATE` (`src/pages/MissingCommissionExportPage.tsx:772-777`) and displayed with `$${v.toFixed(2)}` (`src/pages/MissingCommissionExportPage.tsx:1167-1170`).
- Existing Badge use is provenance-only (`src/pages/MissingCommissionExportPage.tsx:1142-1145`).
- Existing status patterns are state-machine screens: source error/loading/report error/idle/empty/results (`src/pages/MissingCommissionExportPage.tsx:1000-1074`).

Readiness: MCE can filter out fully cleared/not owed before building `allBeforeBucket`, but any clearing status shown to operators requires adding preview-only internal columns or badges.

Open question: should the downloaded Messer CSV exclude fully cleared rows only, or also include a clearing-status column? Current CSV column order is "locked" in comments (`src/pages/MissingCommissionExportPage.tsx:1-17`), so 13c should not add a Messer column unless explicitly directed.

#### Agent Summary Unpaid Section

- Scope source: shared `usePayEntityScope()` (`src/pages/AgentSummaryPage.tsx:66-70`).
- Commission dollars are filtered by `filterCommissionRowsByScope(normalizedRecords, scope)` (`src/pages/AgentSummaryPage.tsx:103-117`).
- EBU row source is `canonicalUnpaidRows = getExpectedPaymentBreakdown(...).unpaidRows` (`src/pages/AgentSummaryPage.tsx:148-155`).
- Per-owner unpaid count and est-missing dollars are grouped in `unpaidByOwnerBucket`; `entry.estMissing += Number(r.estimated_missing_commission) || 0` (`src/pages/AgentSummaryPage.tsx:161-171`).
- Agent row fields include `unpaid_count` and `estimated_missing_commission` (`src/pages/AgentSummaryPage.tsx:202-213`).
- Table columns include `Unpaid` and `Est. Missing`; no clearing-status column (`src/pages/AgentSummaryPage.tsx:217-228`).
- Attribution note and EBU disclaimer render above the table (`src/pages/AgentSummaryPage.tsx:290-312`).

Readiness: counts and dollars are centralized enough to adjust in `canonicalUnpaidRows` or `unpaidByOwnerBucket`.

Open question: if manual-review rows count separately, does Agent Summary need a new "Needs Review" column per agent, or a table-level note/chip? Current columns have no category/status field.

#### Unpaid Recovery

- Scope source: shared `usePayEntityScope()` with URL sync (`src/pages/UnpaidRecoveryPage.tsx:272-309`).
- Computes `filteredEde`, confirmed weak-match upgrades, `breakdown = getExpectedPaymentBreakdown(...)`, `unpaidRows = breakdown.unpaidRows`, and `universe = breakdown.universe` (`src/pages/UnpaidRecoveryPage.tsx:359-392`).
- Visible table and CSV both use `filteredRows`, derived by `filterUnpaidRecoveryRows(unpaidRows, universe, filters, getFfmId)` (`src/pages/UnpaidRecoveryPage.tsx:397-400`).
- Current filters: owner, source type, premium bucket, search (`src/pages/UnpaidRecoveryPage.tsx:55-71`, `src/pages/UnpaidRecoveryPage.tsx:115-150`, `src/pages/UnpaidRecoveryPage.tsx:455-492`).
- Current columns include `Source Type`, `Premium Bucket`, `Net Premium`, `Est. Missing Commission`, `Policy Status`, and `Issue / Missing Reason`; no clearing-status column/tab (`src/pages/UnpaidRecoveryPage.tsx:184-197`).
- Display row derives `estimated_missing_commission: r.estimated_missing_commission ?? null` (`src/pages/UnpaidRecoveryPage.tsx:201-219`).
- Currency display is local: `net_premium` and `estimated_missing_commission` are formatted as dollars with two decimals (`src/pages/UnpaidRecoveryPage.tsx:255-263`).
- Page size is 50; pagination is client-side over `filteredRows` (`src/pages/UnpaidRecoveryPage.tsx:266`, `src/pages/UnpaidRecoveryPage.tsx:403-404`, `src/pages/UnpaidRecoveryPage.tsx:535-543`).
- Empty state is a table row: "No unpaid policies match the current filters." (`src/pages/UnpaidRecoveryPage.tsx:512-516`).

Readiness: best target for the richest 13c overlay because it already has a row derivation function and exports it for tests.

Open question: Q27 mentions "Recovered tab"; current page has no tab component, only filters. 13c either adds a status filter/tab or defers richer tab UX to 13d.

### 1.3 Badge / Pill / Status Components

- Reusable `Badge` lives at `src/components/ui/badge.tsx`; variants are `default`, `secondary`, `destructive`, and `outline` (`src/components/ui/badge.tsx:6-20`). It accepts `children` and `className`, so icons can be passed as children but there is no explicit icon prop (`src/components/ui/badge.tsx:23-27`).
- `MetricCard` has `variant?: 'default' | 'success' | 'warning' | 'destructive' | 'info'` and split-chip props (`src/components/MetricCard.tsx:5-27`). It renders compact split pills with hard-coded muted styling (`src/components/MetricCard.tsx:85-111`).
- `DataTable` has `filterChips` rendered as rounded buttons and a `renderCell` escape hatch for adornments (`src/components/DataTable.tsx:13-19`, `src/components/DataTable.tsx:64-72`, `src/components/DataTable.tsx:96-111`).
- `ResolvedBadge` is an icon-only tooltip, not a status pill (`src/components/ResolvedBadge.tsx:22-43`).
- Existing custom pill examples include Manual Match signal badges with success/destructive class overrides (`src/pages/ManualMatchPage.tsx:217-233`) and SourceFunnel `GapBadge` (`src/components/SourceFunnelCard.tsx:219-230`).

Readiness: existing `Badge` is enough for 13c/13d status labels, but 13d should likely add a dedicated `ClearingStatusBadge` helper so five surfaces do not hand-roll colors/text.

Open question: 13c may defer badge polish to 13d, but Q25/Q27 require at least some visible context for `cleared_then_reversed` and `manual_review_required`. Minimal labels can use `Badge` now.

### 1.4 Currency Formatter

- No canonical `formatCurrency` helper exists. `rg` found inline `toLocaleString`/`toFixed` formatting across pages/components.
- `DataTable` defaults dollar formatting when column key includes `commission` or `premium`, with two minimum fraction digits (`src/components/DataTable.tsx:103-106`).
- Unpaid Recovery has a local `formatCell` for `net_premium` and `estimated_missing_commission` (`src/pages/UnpaidRecoveryPage.tsx:255-263`).
- Missing Commission Export uses `toFixed(2)` for `_estimatedMissingCommission` (`src/pages/MissingCommissionExportPage.tsx:1167-1170`).
- Dashboard uses inline dollar formatting for net paid, clawbacks, and est missing (`src/pages/DashboardPage.tsx:1317-1333`, `src/pages/DashboardPage.tsx:1408-1409`).
- Negative handling exists by convention in Dashboard clawbacks: it displays `Math.abs(metrics.totalClawbacks)` with a minus glyph in the surrounding string (`src/pages/DashboardPage.tsx:1332`, `src/pages/DashboardPage.tsx:1761`, `src/pages/DashboardPage.tsx:1896`), while `DataTable` would display negative numbers as `$-10.00`.

Readiness: needs a precursor helper or careful local consistency. 13c will display `actual_net_amount`, `remainder_owed`, and possibly `actual_reversal_amount`; a shared `formatMoney(amount, { signed?: boolean })` would reduce drift.

Open question: should 13c create a small formatter in `src/lib/utils.ts` or keep inline formatting to avoid widening scope?

### 1.5 Toast / Banner Patterns

- Primary toast API is shadcn-style `useToast`/`toast` from `src/hooks/use-toast.ts`; it supports `title`, `description`, and `variant`, with one toast at a time (`src/hooks/use-toast.ts:5-13`, `src/hooks/use-toast.ts:137-184`).
- Sonner exists and exports `toast`, but current Bundle 13b rebuild button uses `useToast`, not Sonner (`src/components/ui/sonner.tsx:1-27`, `src/components/RebuildCrossBatchClearingsButton.tsx:8-10`, `src/components/RebuildCrossBatchClearingsButton.tsx:36-55`).
- Dashboard has existing card-style stale/rebuild banners:
  - Cross-batch stale logic banner for old rebuild logic across batches (`src/pages/DashboardPage.tsx:1007-1025`).
  - Zero reconciled members fail-safe banner (`src/pages/DashboardPage.tsx:1027-1053`).
  - Per-batch rebuild status warning for never rebuilt or stale logic (`src/pages/DashboardPage.tsx:1055-1081`).
- Missing Commission Export uses state-machine banners/screens for source load failed, report failed, idle, empty, loading (`src/pages/MissingCommissionExportPage.tsx:1000-1074`).

Readiness: 13c can reuse Dashboard `Card` banner style for Q31 stale-sweep prompt and Q33 one-time rollout banner.

Open question: no one-time dismissible banner primitive exists. If Q33 ships in 13c, decide whether dismissal is localStorage-backed or session-only.

### 1.6 Scope Filter Consumer Pattern

- Shared hook is `usePayEntityScope(): [PayEntityScope, setScope]`, persisted to `localStorage` key `dashboard_pay_entity_filter` and synced by custom/window storage events (`src/hooks/usePayEntityScope.ts:16-59`).
- Dashboard uses the hook at `payEntityFilter` and renders the dropdown in the header (`src/pages/DashboardPage.tsx:235`, `src/pages/DashboardPage.tsx:969-979`).
- Agent Summary uses the hook and dropdown (`src/pages/AgentSummaryPage.tsx:66-70`, `src/pages/AgentSummaryPage.tsx:270-279`).
- Unpaid Recovery uses the hook plus URL sync (`src/pages/UnpaidRecoveryPage.tsx:272-309`, `src/pages/UnpaidRecoveryPage.tsx:442-451`).
- Missing Commission Export is different: it owns local `scope` state (`src/pages/MissingCommissionExportPage.tsx:469-470`) and renders a local scope select (`src/pages/MissingCommissionExportPage.tsx:906-915`).
- Canonical scope helpers define semantics. `filterReconciledByScope` returns all rows for `All`, otherwise filters via `getMembersInScope` (`src/lib/canonical/scope.ts:67-105`). `filterCommissionRowsByScope` filters commission rows by `pay_entity` (`src/lib/canonical/scope.ts:107-123`).

Readiness: 13c should follow each surface's current scope owner. Do not force MCE into the shared hook unless that is in scope.

Open question: Q29 says scope filtering at surface level. Current 13b clearing rows store `pay_entity` from the unpaid grain (`src/lib/sweep/crossBatchClearingSweep.ts:220`, `src/lib/sweep/crossBatchClearingSweep.ts:546-563`), while the matched commission row pay entity is not copied into the clearing row. To validate "matched commission pay_entity is also consistent" exactly, 13c must bulk-fetch `matched_paid_record_ids` from `normalized_records` or accept `cross_batch_clearings.pay_entity` as a proxy.

### 1.7 estimated_missing_commission Consumers

Production consumers/producers:

- Schema/original column: `estimated_missing_commission NUMERIC(12,2)` in `20260415003124...` (`supabase/migrations/20260415003124_0d4c9ffc-7276-4a76-bde5-321ed4fd411f.sql:82`).
- Types expose it on `reconciled_members` Row/Insert/Update (`src/integrations/supabase/types.ts:529`, `src/integrations/supabase/types.ts:563`, `src/integrations/supabase/types.ts:597`).
- Producer: `reconcile.ts` type includes it and final member output assigns `estMissing` (`src/lib/reconcile.ts:126`, `src/lib/reconcile.ts:980`).
- Producer/persistence: `saveReconciledMembers` writes it and builds `commission_estimates` rows from non-null values (`src/lib/persistence.ts:765-803`).
- Consumer: `getExpectedMissingCommissionSum` sums it across canonical unpaid rows (`src/lib/canonical/metrics.ts:489-512`).
- Consumer: Dashboard `metrics.estMissing` uses `getExpectedMissingCommissionSum` and renders `Est. Missing Commission` (`src/pages/DashboardPage.tsx:650`, `src/pages/DashboardPage.tsx:1409`).
- Consumer: Agent Summary sums per owner bucket and exposes table column (`src/pages/AgentSummaryPage.tsx:161-167`, `src/pages/AgentSummaryPage.tsx:217-228`, `src/pages/AgentSummaryPage.tsx:243-260`).
- Consumer: Missing Commission Export uses row value if positive, otherwise `DEFAULT_COMMISSION_ESTIMATE` (`src/pages/MissingCommissionExportPage.tsx:774-777`).
- Consumer: Unpaid Recovery display/export derives and formats it (`src/pages/UnpaidRecoveryPage.tsx:184-197`, `src/pages/UnpaidRecoveryPage.tsx:201-219`, `src/pages/UnpaidRecoveryPage.tsx:255-263`).
- Consumer: Exceptions page column includes "Est. Missing $" (`src/pages/ExceptionsPage.tsx:20`).
- Diagnostic/guard: invariants check in-commission rows with positive estimated missing (`src/lib/canonical/invariants.ts:269-279`).

Readiness: 13c should not add new legacy `estimated_missing_commission` dependencies. For partial-cleared rows, prefer `cross_batch_clearings.remainder_owed`/`expected_amount` from the sidecar; 13e can later replace the remaining legacy consumers.

Open question: MCE's `DEFAULT_COMMISSION_ESTIMATE` fallback (`src/pages/MissingCommissionExportPage.tsx:45`, `src/pages/MissingCommissionExportPage.tsx:774-777`) may conflict with 13c partial-dollar math if an overlay has `expected_amount` null.

### 1.8 Existing Rebuild-State-Stale Warning Pattern

- Existing stale patterns are Dashboard-only:
  - All-batch logic staleness count from `batches[].last_rebuild_logic_version` (`src/pages/DashboardPage.tsx:220-229`) and banner (`src/pages/DashboardPage.tsx:1007-1025`).
  - Current-batch rebuild warning uses `last_full_rebuild_at`/`last_rebuild_logic_version` (`src/pages/DashboardPage.tsx:216-219`, `src/pages/DashboardPage.tsx:1055-1081`).
  - BatchContext polls rebuild version and refreshes state on changes (`src/hooks/useBatchDataVersion.ts:5-24`, `src/hooks/useBatchDataVersion.ts:41-71`, `src/contexts/BatchContext.tsx:229-232`).
- There is no existing "cross-batch clearing sweep is stale" warning.
- The 13b button stores last-run state internally but does not render it (`src/components/RebuildCrossBatchClearingsButton.tsx:17-22`, `src/components/RebuildCrossBatchClearingsButton.tsx:42-49`).

Readiness: 13c needs a new stale-sweep read pattern if Q31 is included.

Open question: Q31 compares latest clearing `evaluated_at` to latest batch rebuild. `cross_batch_clearings` has `evaluated_at` and `run_id` (`supabase/migrations/20260514160729_create_cross_batch_clearings.sql:46-49`), and `upload_batches` has `last_full_rebuild_at` (`src/integrations/supabase/types.ts:690-701`), but no helper exists.

### 1.9 Supabase Typed vs Untyped Status

- `src/integrations/supabase/types.ts` includes `normalized_records`, `reconciled_members`, `upload_batches`, etc. (`src/integrations/supabase/types.ts:320-374`, `src/integrations/supabase/types.ts:514-548`, `src/integrations/supabase/types.ts:690-725`).
- `rg cross_batch_clearings src/integrations/supabase/types.ts` returns no match. The table and RPC are not in generated types at this HEAD.
- The 13b sweep uses `(supabase as any)` for the RPC (`src/lib/sweep/crossBatchClearingSweep.ts:537-540`).

Readiness: 13c must either regenerate `types.ts` and include it in scope, or explicitly use `(supabase as any)` for `cross_batch_clearings` reads.

Open question: if Lovable's environment auto-regenerated types during v11, re-check before drafting 13c. At this audited HEAD, types are not regenerated.

## 2. Bug-Class Memory Checklist for 13c

### 2.1 offset_pagination_timeout_class

13c does implicate this class. Unpaid Recovery paginates client-side over `filteredRows` with page size 50 (`src/pages/UnpaidRecoveryPage.tsx:397-404`, `src/pages/UnpaidRecoveryPage.tsx:266`). Dashboard/MCE/Agent Summary also compute full unpaid cohorts in memory.

Guard:

- Do not fetch clearings per row.
- Bulk-load active clearings once per surface run/render, ideally by current batch using `unpaid_batch_ids` GIN (`supabase/migrations/20260514160729_create_cross_batch_clearings.sql:7`, `supabase/migrations/20260514160729_create_cross_batch_clearings.sql:63-67`) plus `staging_status='active'`/`superseded_at IS NULL` (`supabase/migrations/20260514160729_create_cross_batch_clearings.sql:53-55`).
- Build a `Map<policy_identity_key|target_service_month, overlay>` and attach in memory, mirroring 13b Phase D's memory-only per-grain loop (`src/lib/sweep/crossBatchClearingSweep.ts:353-356`).

Readiness: needs new read helper/hook; no existing helper.

### 2.2 Source-Field Inventory

Cross-batch fields needed by 13c exist in the migration:

- Grain and lookup: `policy_identity_key`, `target_service_month`, `reconciled_member_id`, `unpaid_batch_id`, `unpaid_batch_ids`, `payment_batch_ids` (`supabase/migrations/20260514160729_create_cross_batch_clearings.sql:3-8`).
- Scope-ish/evidence fields: `policy_number`, `issuer_subscriber_id`, `carrier`, `pay_entity`, `agent_npn` (`supabase/migrations/20260514160729_create_cross_batch_clearings.sql:10-14`).
- State fields: six-state `clearing_state` check (`supabase/migrations/20260514160729_create_cross_batch_clearings.sql:15-22`).
- Dollar fields: `expected_amount`, `threshold_amount`, `actual_positive_amount`, `actual_reversal_amount`, `actual_net_amount`, `remainder_owed` (`supabase/migrations/20260514160729_create_cross_batch_clearings.sql:23-28`).
- Evidence fields: comp/state/member/evidence IDs and months (`supabase/migrations/20260514160729_create_cross_batch_clearings.sql:29-45`).
- History fields: `run_id`, `logic_version`, `evaluated_at`, `staging_status`, `superseded_at` (`supabase/migrations/20260514160729_create_cross_batch_clearings.sql:46-50`).

Readiness: no schema field is missing for basic 13c display. Scope correctness is the only caveat: matched commission pay entity is not stored directly; see 1.6.

### 2.3 Rule-Interaction Walk

Business defaults from `bundle_13c_business_questions.md`:

- Partial-cleared reduces dollars by actual net, keeps count (`../bundle_13c_business_questions.md:9-17`).
- Cleared then reversed stays unpaid with badge/context (`../bundle_13c_business_questions.md:21-29`).
- Q27 surface matrix (`../bundle_13c_business_questions.md:46-59`).
- Labels: Recovered, Partially recovered, Recovered then reversed, Not owed, Needs review (`../bundle_13c_business_questions.md:63-80`).
- Scope filter at surface level (`../bundle_13c_business_questions.md:84-92`).

Recommended 13c matrix after existing surface scope is applied:

| clearing_state | All scope | Coverall scope | Vix scope | Dashboard EBU | Source Coverage EBU | MCE | Agent Summary | Unpaid Recovery |
|---|---|---|---|---|---|---|---|---|
| fully_cleared | Apply if row grain matches and scope allows overlay | Same | Same | Remove from count and est-missing dollars | Remove | Remove from report/export | Remove from unpaid count/dollars | Remove or put behind Recovered filter/tab |
| partially_cleared | Apply if row grain matches and scope allows overlay | Same | Same | Keep count, reduce dollars by `actual_net_amount`/use `remainder_owed` | Same | Keep row, reduced actionable dollar | Keep count, reduced dollars | Keep row, show reduced owed |
| not_cleared | No adjustment | Same | Same | No change | No change | No change | No change | No change |
| cleared_then_reversed | Apply if row grain matches and scope allows overlay | Same | Same | Keep unpaid, badge/context | Same | Keep row, badge/context | Keep count/dollars, badge/context if added | Keep row, badge/context |
| zero_expected_no_payment_required | Apply if row grain matches and scope allows overlay | Same | Same | Remove from unpaid and expected/owed dollars | Remove | Remove | Remove | Remove |
| manual_review_required | Apply if row grain matches and scope allows overlay | Same | Same | Count separately as Needs review | Count separately | Count separately or retain with Needs review | Count separately | Separate filter/tab or status |

High-risk cells to test:

- `fully_cleared` removed from both Dashboard EBU count (`src/pages/DashboardPage.tsx:1270-1286`) and Source Coverage EBU (`src/pages/DashboardPage.tsx:1500-1516`).
- `partially_cleared` keeps rows in MCE/UR but changes dollar fields (`src/pages/MissingCommissionExportPage.tsx:774-777`, `src/pages/UnpaidRecoveryPage.tsx:214-215`).
- `zero_expected_no_payment_required` removes from expected/unpaid, not just unpaid dollars (`../bundle_13c_business_questions.md:56`).
- `manual_review_required` cannot be silently counted as normal unpaid without a separate indication.

Readiness: current surfaces cannot all render the full matrix without at least status badges/chips or extra columns.

### 2.4 Pre-Flight Artifact Check

13c has no new migration or seed. Existing migration is `supabase/migrations/20260514160729_create_cross_batch_clearings.sql`.

If 13c regenerates Supabase types, `src/integrations/supabase/types.ts` must be in scope. At this HEAD it lacks `cross_batch_clearings` and `replace_cross_batch_clearings_for_run`.

Readiness: choose typed-vs-untyped before drafting.

### 2.5 Post-Sync Verification High-Risk Paths

Post-sync should verify implementation, not only tests:

- File scope: only the five surfaces plus shared overlay/helper/test files, unless types are intentionally regenerated.
- No per-row `cross_batch_clearings` fetches in row render paths.
- Q27 state x surface matrix, especially `zero_expected_no_payment_required`, `manual_review_required`, and `cleared_then_reversed`.
- Partial-cleared dollar math should use sidecar `remainder_owed` or `expected_amount - actual_net_amount`, with null guards.
- Scope interaction: no Coverall/Vix cross-leakage. Current `cross_batch_clearings.pay_entity` may be unpaid-side entity only (`src/lib/sweep/crossBatchClearingSweep.ts:220`, `src/lib/sweep/crossBatchClearingSweep.ts:552-563`), so tests should include matched payment in the other pay entity if Q29 is strict.

## 3. Forward-Looking Consumer Trace

### 3.1 13d Badge Polish Hooks

Current row surfaces do not have a shared clearing overlay shape. `DataTable` can render custom cell content with `renderCell` (`src/components/DataTable.tsx:15-19`, `src/components/DataTable.tsx:96-111`), MCE and UR render table cells manually (`src/pages/MissingCommissionExportPage.tsx:1113-1182`, `src/pages/UnpaidRecoveryPage.tsx:518-527`).

Recommendation: 13c should attach a typed overlay object to unpaid rows before rendering:

```ts
type CrossBatchClearingOverlay = {
  clearing_state: 'fully_cleared' | 'partially_cleared' | 'not_cleared' | 'cleared_then_reversed' | 'zero_expected_no_payment_required' | 'manual_review_required';
  expected_amount: number | null;
  actual_net_amount: number | null;
  remainder_owed: number | null;
  reversed_at_statement_month?: string | null;
  first_full_clear_statement_month?: string | null;
  evaluated_at: string;
};
```

Readiness: this lets 13d add `ClearingStatusBadge` without reworking the 13c data path.

### 3.2 13e estimated_missing_commission Replacement Compatibility

13b sweep already computes expected amounts using Bundle 13a `getExpectedCommission` (`src/lib/sweep/crossBatchClearingSweep.ts:391-400`) and writes `expected_amount`, `actual_net_amount`, and `remainder_owed` to the clearing row (`src/lib/sweep/crossBatchClearingSweep.ts:507-517`).

Recommendation:

- 13c overlay helper should consume the sidecar's `expected_amount`/`remainder_owed` for rows with overlays.
- It should not introduce new direct `estimated_missing_commission` consumers.
- For rows with no overlay, keep current legacy behavior until 13e replaces the remaining consumers listed in 1.7.

Readiness: compatible if the helper is shared and has null guards.

### 3.3 Bundle 14 Manual Override Accommodation

Schema has no `surface_ignore` column (`supabase/migrations/20260514160729_create_cross_batch_clearings.sql:1-50`). Q30 recommends no override in 13c (`../bundle_13c_business_questions.md:96-104`).

Recommendation: the 13c read model can include `surface_ignore?: boolean` defaulting to false, without reading a DB column yet. Bundle 14 can add the column or override table later without changing every surface.

Readiness: no DB support yet; type/hook accommodation is enough.

## 4. Schema-vs-Behavior Consistency Sweep

### 4.1 Can Each Surface Render Every clearing_state?

Dashboard EBU:

- Count card exists, split chips exist, no status badge/column (`src/pages/DashboardPage.tsx:1270-1286`).
- Drilldown uses `UNPAID_DETAILS_DRILLDOWN_COLUMNS`, no clearing status (`src/pages/DashboardPage.tsx:153-156`).
- Can remove rows/counts; cannot show per-row clearing badge without adding drilldown column or renderCell.

Source Coverage EBU:

- Count card exists with owner split chips, no clearing badge/column (`src/pages/DashboardPage.tsx:1500-1516`).
- Drilldown uses coverage columns with no status (`src/pages/DashboardPage.tsx:135-146`, `src/pages/DashboardPage.tsx:1487`).
- Can remove rows/counts; manual-review separate count needs new chip/card/column.

MCE:

- Table has internal columns and existing Badge import/use (`src/pages/MissingCommissionExportPage.tsx:23`, `src/pages/MissingCommissionExportPage.tsx:107-119`, `src/pages/MissingCommissionExportPage.tsx:1142-1145`).
- No clearing-state column today. Adding an internal preview-only column is feasible. Messer CSV columns are separate and locked (`src/pages/MissingCommissionExportPage.tsx:92-105`).
- Can keep/remove rows before `allBeforeBucket` (`src/pages/MissingCommissionExportPage.tsx:718-826`).

Agent Summary:

- Data is aggregated by owner bucket; no per-row table for unpaid rows (`src/pages/AgentSummaryPage.tsx:161-213`).
- Columns have `Unpaid` and `Est. Missing`, no status/review columns (`src/pages/AgentSummaryPage.tsx:217-228`).
- Manual-review "count separately" requires new aggregate column or note.

Unpaid Recovery:

- Best suited for full display. It already has filters, a row derivation function, columns, pagination, CSV, and empty state (`src/pages/UnpaidRecoveryPage.tsx:55-71`, `src/pages/UnpaidRecoveryPage.tsx:184-219`, `src/pages/UnpaidRecoveryPage.tsx:397-416`, `src/pages/UnpaidRecoveryPage.tsx:512-516`).
- No Recovered tab/filter today. 13c must add a status filter/tab or defer the tab wording to 13d.

Readiness: every surface can be adjusted for remove/keep math, but not every surface can visibly distinguish all states without UI additions.

### 4.2 Bundle 12 Disclaimer Wording

Central constant:

- `EBU_BATCH_SCOPE_DISCLAIMER = "Unpaid counts are based on the selected batch's files only. Payments that appeared in later commission statements may not be cleared here."` (`src/lib/constants.ts:113-126`).

Rendered in:

- Dashboard Source Coverage disclaimer (`src/pages/DashboardPage.tsx:1557-1562`).
- Agent Summary disclaimer (`src/pages/AgentSummaryPage.tsx:307-312`).
- Missing Commission Export disclaimer (`src/pages/MissingCommissionExportPage.tsx:873-878`).
- Unpaid Recovery disclaimer (`src/pages/UnpaidRecoveryPage.tsx:435-440`).

Recommendation: 13c should reword the central constant only, not inline strings. Suggested new copy:

> Cross-batch payment clearings are reflected where available. Last sweep: [timestamp]. Re-run cross-batch clearings after rebuilding batches.

Readiness: constant is centralized.

## 5. Empty/Null Robustness for 13c

### 5.1 cross_batch_clearings Empty

No current read helper exists, so 13c should define the fallback explicitly: if no active clearing row exists for a grain, return `overlay=null` and render today's batch-local behavior.

Current surfaces already render from `getExpectedPaymentBreakdown(...).unpaidRows` (`src/pages/DashboardPage.tsx:628-637`, `src/pages/AgentSummaryPage.tsx:152-155`, `src/pages/MissingCommissionExportPage.tsx:631-634`, `src/pages/UnpaidRecoveryPage.tsx:386-392`).

Readiness: safe if overlay helper is null-object/fallback by default.

### 5.2 Clearing Row Has NULL expected_amount or actual_net_amount

Schema allows `expected_amount`, `actual_net_amount`, and `remainder_owed` to be null (`supabase/migrations/20260514160729_create_cross_batch_clearings.sql:23-28`).

Manual-review rows can be written before expected amount exists: resolver failure rows only set `clearing_state`, `manual_review_reason`, and `state_resolution_evidence` (`src/lib/sweep/crossBatchClearingSweep.ts:382-388`).

Recommendation:

- Do not reduce dollars unless `expected_amount`, `actual_net_amount`, and/or `remainder_owed` are finite numbers.
- For null math, keep legacy dollars and show "Needs review".

Readiness: needs explicit tests.

### 5.3 NULL reconciled_member_id After Batch Rebuild

Schema allows nullable FK with `ON DELETE SET NULL` (`supabase/migrations/20260514160729_create_cross_batch_clearings.sql:5`).

The stable lookup should be grain-based: `policy_identity_key + target_service_month`, enforced by unique active index (`supabase/migrations/20260514160729_create_cross_batch_clearings.sql:53-55`).

Recommendation: 13c surfaces must not join overlays by `reconciled_member_id`. Use `derivePolicyIdentityKey` (`src/lib/canonical/policyIdentityKey.ts:20-53`) and `expected_ede_effective_month` from unpaid rows (`src/integrations/supabase/types.ts:532`) to compute the grain.

Readiness: existing `reconciled_members` rows include the source columns needed for grain, but 13c must use the same cleaner as 13b.

### 5.4 Empty Scope Filter

Existing empty state patterns:

- Unpaid Recovery displays "No unpaid policies match the current filters." (`src/pages/UnpaidRecoveryPage.tsx:512-516`).
- MCE displays an empty state when reportStatus is `empty` (`src/pages/MissingCommissionExportPage.tsx:1062-1071`).
- DataTable displays "No records found" for empty paged results (`src/components/DataTable.tsx:91-94`).

Recommendation: if a scope has no rows or no clearings, do not special-case; allow existing empty states and zero cards.

Readiness: ready.

## 6. Inversion Pass at Draft Time

### 6.1 Could Lovable Re-Fetch cross_batch_clearings on Every Render?

Yes. The danger is highest in Unpaid Recovery's row render loop (`src/pages/UnpaidRecoveryPage.tsx:518-527`) and MCE's preview table (`src/pages/MissingCommissionExportPage.tsx:1113-1182`).

Guard: 13c overlay loader must run once per surface data cycle, return a Map, and be memoized/cached by `currentBatchId`, scope, and unpaid grain keys. No row component should call Supabase.

### 6.2 Could Lovable Apply Scope Filter After the Fetch Instead of in the Query?

Yes, but the correct query-side predicate is not trivial. `cross_batch_clearings.pay_entity` is written from unpaid expected/actual entity (`src/lib/sweep/crossBatchClearingSweep.ts:220`), not directly from matched payment rows. The matched payment records are available as IDs (`supabase/migrations/20260514160729_create_cross_batch_clearings.sql:37`, `src/lib/sweep/crossBatchClearingSweep.ts:523-530`).

Guard:

- Existing unpaidRows scope must remain the first filter.
- Fetch clearings only for current batch via `unpaid_batch_ids` and active predicate.
- For Coverall/Vix strictness, either:
  - require `clearing.pay_entity` to be compatible with scope, understanding it is unpaid-side entity; or
  - bulk-fetch matched normalized records by `matched_paid_record_ids` and validate payment `pay_entity` with `filterCommissionRowsByScope` semantics (`src/lib/canonical/scope.ts:107-123`).

Open question for Claude/Jason: is unpaid-side `pay_entity` sufficient for Q29, or must 13c verify matched payment entity?

### 6.3 Could Lovable Miss cleared_then_reversed Badge Logic?

Yes. `cleared_then_reversed` is one of the six DB states (`supabase/migrations/20260514160729_create_cross_batch_clearings.sql:15-22`) and is terminal in the amount predicate output shape (`src/lib/canonical/crossBatchAmountClearing.ts:13-34`).

Guard: tests must assert `cleared_then_reversed` remains in unpaid rows and surfaces "Recovered then reversed" or equivalent on every row-capable surface. Dashboard/Source Coverage aggregate surfaces need at least a split/count or drilldown status.

### 6.4 Could Lovable Use Legacy estimated_missing_commission Instead of Bundle 13a getExpectedCommission?

Yes. The path of least resistance is current legacy dollar fields:

- Dashboard est missing (`src/pages/DashboardPage.tsx:650`, `src/pages/DashboardPage.tsx:1409`).
- Agent Summary est missing (`src/pages/AgentSummaryPage.tsx:161-167`, `src/pages/AgentSummaryPage.tsx:217-228`).
- MCE fallback/default (`src/pages/MissingCommissionExportPage.tsx:774-777`).
- Unpaid Recovery column (`src/pages/UnpaidRecoveryPage.tsx:214-215`).

Guard: 13c should consume cross_batch_clearings amounts for overlay rows. Those amounts come from 13b's `getExpectedCommission` sweep path (`src/lib/sweep/crossBatchClearingSweep.ts:391-400`, `src/lib/sweep/crossBatchClearingSweep.ts:507-517`). Add a static test that 13c does not introduce new `estimated_missing_commission` reductions for overlay math.

### 6.5 Could Lovable Forget the Stale-Sweep Notice?

Yes. Existing stale banners are rebuild-logic-only, not clearing-sweep-aware (`src/pages/DashboardPage.tsx:1007-1081`).

Guard: acceptance criteria should require a passive stale-sweep notice comparing latest active clearing `evaluated_at` with max `upload_batches.last_full_rebuild_at`, per Q31 (`../bundle_13c_business_questions.md:108-116`). If no active clearings exist, wording should be "Cross-batch clearings have not been run yet" rather than "stale".

### 6.6 Could Lovable Apply the Clearing Overlay Outside the Five EBU Surfaces?

Yes, especially if it patches `getExpectedPaymentBreakdown` globally. That helper feeds tests and other helper consumers (`src/lib/canonical/metrics.ts:441-486`).

Guard:

- Prefer a new `getClearingAdjustedExpectedPaymentBreakdown` or `useCrossBatchClearingOverlays` used only by Dashboard, Source Coverage, MCE, Agent Summary, and Unpaid Recovery.
- Static test should assert the new overlay helper is imported only in the five EBU surface files and/or a shared 13c helper.
- Do not alter Entity Summary, Member Timeline, Exceptions, All Records, or base reconcile outputs.

