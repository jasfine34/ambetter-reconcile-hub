# Lovable Platform-Fit And Complexity Audit

Date: 2026-05-16  
Repo HEAD: `ba1b1809e6beebb8d561d7c8983eda2e49e24ce5` (`ba1b180 Chunked sweep RPC deployed`)

## Short Verdict

**Verdict: Yellow.**

The app is not simply "too big for Lovable." The file count is manageable, the test suite is strong, and ordinary UI/reporting slices are still a reasonable Lovable fit. The risk is that the app has become **architecture-sensitive and data-logic heavy**: small generated changes can alter money/counting semantics, timeout behavior, or cross-surface consistency.

Lovable can keep participating, but not as a broad autonomous implementer for core data logic. The operating model should become: **Codex/Claude specify and audit contracts first; Lovable implements narrow, bounded slices; Codex verifies post-sync.**

## Evidence Snapshot

- Repo inventory from `rg --files`: 283 files total, 211 under `src`, 29 migrations, 13 docs, 29 files under `src/lib/canonical`, 12 page files.
- Largest files by line count:
  - `src/pages/DashboardPage.tsx`: 2,292 lines.
  - `src/pages/MissingCommissionExportPage.tsx`: 1,279 lines.
  - `src/integrations/supabase/types.ts`: 1,142 lines.
  - `src/lib/persistence.ts`: 1,053 lines.
  - `src/pages/MemberTimelinePage.tsx`: 1,033 lines.
  - `src/lib/reconcile.ts`: 953 lines.
  - `src/lib/canonical/metrics.ts`: 794 lines.
  - `src/lib/sweep/crossBatchClearingSweep.ts`: 529 lines.
- `npm test` passed: 69 test files, 860 tests.
- `npm run build` passed. Warnings remain: 997.40 kB minified JS chunk, CSS `@import` ordering warning, browserslist data stale, and `resolvedIdentities.ts` dynamic import cannot split because the module is also statically imported.

## 1. Is The App Too Big For Lovable?

**No, not by size alone. Yes, if Lovable is asked to make broad changes across data logic, SQL/RPC, and multiple surfaces in one directive.**

The main issue is not total files. The issue is that core behavior now depends on a chain of contracts:

- Expected Payment Universe comes from `getExpectedPaymentBreakdown(...)`, with paid/unpaid and premium splits derived in one helper at `src/lib/canonical/metrics.ts:446-486`.
- Scope semantics are centralized in `src/lib/canonical/scope.ts:1-15`, with `getMembersInScope` using current AOR and Vix commission evidence at `src/lib/canonical/scope.ts:67-90`.
- Cross-batch clearings are a sidecar overlay keyed by policy identity and target service month at `src/lib/canonical/crossBatchOverlay.ts:6-10`.
- Overlay states have surface instructions such as remove, reduce dollars, move to reversed bucket, or mark needs review at `src/lib/canonical/crossBatchOverlay.ts:142-162`.
- Surfaces consume the overlay by partitioning unpaid rows at `src/lib/canonical/crossBatchOverlay.ts:202-227`.

This is a contract-heavy architecture. Lovable can work inside it, but broad prompts create a high chance of accidental reimplementation or stale assumptions.

## 2. Safe Lovable Zones

Lovable is still a good fit for:

- Single-surface UI work that consumes existing helper outputs without redefining business rules.
- Copy, banners, badges, chips, table columns, filters, and export presentation, when source data is already defined.
- Tests that pin existing behavior after Codex/Claude define the test matrix.
- Small pure helper additions with explicit signatures and examples.
- Post-sync patches that touch one file or one tightly bounded concern.

Examples of relatively safe patterns already present:

- Dashboard mounts the cross-batch rebuild button and last-updated timestamp in one header cluster at `src/pages/DashboardPage.tsx:1140-1151`.
- MCE waits for overlay state and falls back with a warning rather than silently using stale overlay data at `src/pages/MissingCommissionExportPage.tsx:720-737`.
- Unpaid Recovery applies the overlay partition before downstream filters at `src/pages/UnpaidRecoveryPage.tsx:411-445`.

## 3. High-Risk Zones That Need Engineer-Authored Specs

Lovable should not freely design these areas:

1. **SQL/RPC and long-running rebuilds.**  
   `replace_cross_batch_clearings_for_run` now uses an advisory lock, 300 second statement timeout, chunked supersede, and chunked insert at `supabase/migrations/20260516134343_1308f943-0f77-4904-a148-91c5ebb9cfa7.sql:1-102`. This is infrastructure-sensitive. Any future RPC change needs a SQL-first spec, static tests, live deployment check, and smoke test.

2. **Cross-batch sweep orchestration.**  
   `runCrossBatchClearingSweep` handles abort reasons, bulk loads, grain grouping, comp-grid resolution, identity matching, amount clearing, and RPC commit in one 529-line file. The critical phases span `src/lib/sweep/crossBatchClearingSweep.ts:113-544`.

3. **Payment/commission math.**  
   `evaluateCrossBatchAmountClearing` classifies clawbacks/reversals and computes actual positive, reversal, net, remainder, terminal reversed state, and manual-review state at `src/lib/canonical/crossBatchAmountClearing.ts:36-193`. This logic should be changed only with explicit truth tables.

4. **Scope/AOR/pay-entity rules.**  
   Scope membership is intentionally current-AOR based, not writing-agent based, at `src/lib/canonical/scope.ts:55-65`. Commission row scope is separately pay-entity based at `src/lib/canonical/scope.ts:107-123`. Mixing these concepts is one of the easiest ways to create plausible but wrong results.

5. **Comp-grid expected commission.**  
   `getExpectedCommission` validates required inputs, maps policy year to grid year, filters rates by carrier/state/variant, and returns multiple support statuses at `src/lib/canonical/compGrid.ts:372-444`. The v1 sweep still loads comp rates with `effectiveYear: 2026` at `src/lib/sweep/crossBatchClearingSweep.ts:347-353`, which is fine for current data but a known future-year trap.

6. **Large data loaders.**  
   The repo already documents that offset pagination with `select('*')` caused `statement_timeout` on large normalized-record reads at `src/lib/persistence.ts:421-451`. Any new broad read must use projection plus keyset pagination unless proven small.

## 4. Data-Volume And Timeout Risks

The app is now data-volume sensitive. The biggest concern is not React rendering; it is read/write shape against Supabase.

### Known Good Pattern

`getNormalizedRecords` uses keyset pagination by `id` with page size 500, active predicate, and no offset range at `src/lib/persistence.ts:453-473`. The comment explains the exact timeout class: `select('*')` over Feb-sized data timed out with offset pagination at `src/lib/persistence.ts:436-443`.

`useCrossBatchOverlay` also uses keyset pagination and a projection against active `cross_batch_clearings` at `src/hooks/useCrossBatchOverlay.ts:17-25` and `src/hooks/useCrossBatchOverlay.ts:54-72`.

### Risky Or Aging Pattern

`getReconciledMembers` still uses `select('*')` plus `.range(from, from + pageSize - 1)` at `src/lib/persistence.ts:908-924`. The 13b sweep reimplements a similar per-batch `reconciled_members` read with `select('*')` plus `.range(...)` at `src/lib/sweep/crossBatchClearingSweep.ts:143-160`.

This may be acceptable today if `reconciled_members` stays modest per batch, but it is the same pagination family that previously caused normalized-record timeouts. It should be treated as a near-term hardening target.

### Cross-Batch Sweep Shape

The sweep now narrows commission loading to identifiers from unpaid grains, rather than scanning all commission rows:

- BO/EDE rows are loaded by typed `policy_number` and `issuer_subscriber_id` chunks at `src/lib/sweep/crossBatchClearingSweep.ts:300-314`.
- Commission rows are loaded by the same identifier sets at `src/lib/sweep/crossBatchClearingSweep.ts:316-345`.
- Per-grain evaluation is memory-only at `src/lib/sweep/crossBatchClearingSweep.ts:355-533`.

That is the right direction. The remaining risk is that the client still assembles a full `p_rows` JSON payload and pushes it through one RPC call at `src/lib/sweep/crossBatchClearingSweep.ts:536-544`. If row volume grows, this belongs in a server-side job/RPC that does more work inside Postgres or a backend worker.

## 5. Domain Complexity

The domain is now high-complexity because rules interact across dimensions:

- Batch month vs target service month.
- EDE vs Back Office vs Commission records.
- Current AOR vs writing-agent NPN vs pay entity.
- Coverall vs Vix vs All scope.
- Zero net premium vs has premium.
- Matched, BO-only, EDE-only universe buckets.
- Cross-batch states: `fully_cleared`, `partially_cleared`, `not_cleared`, `cleared_then_reversed`, `zero_expected_no_payment_required`, `manual_review_required`.
- Dollar semantics: estimated missing commission vs expected amount vs remainder owed vs actual net vs reversals.

The code has moved many rules to canonical helpers, which is good. But the UI pages still contain a lot of orchestration and recomputation:

- Dashboard computes canonical expected payments at `src/pages/DashboardPage.tsx:722-731`, then applies overlay partitions and adjusted splits at `src/pages/DashboardPage.tsx:792-830`.
- MCE computes weak-match upgrades, expected payment breakdown, overlay partition, and adjusted row metadata in one run flow at `src/pages/MissingCommissionExportPage.tsx:690-751`.
- Agent Summary currently consumes raw canonical unpaid rows directly at `src/pages/AgentSummaryPage.tsx:152-171`; this is a signal that multi-surface 13c rollout is still architecture-sensitive and should continue surface-by-surface.
- Unpaid Recovery consumes overlay partition and adjusted row mapping at `src/pages/UnpaidRecoveryPage.tsx:403-427`.

The risk is not that any one helper is impossible to maintain. The risk is that a generated patch can update one surface and miss the others.

## 6. Generated-Code Risk

The repo shows signs of a generated iterative process that is mostly controlled, but expensive:

- There are many static and grep-based tests that pin wiring contracts, which is useful but also indicates the system is brittle around accidental drift.
- The test suite is large and green, but the command takes about 101 seconds. That is enough that partial or skipped verification becomes tempting during fast patch cycles.
- The largest UI files combine data loading, canonical computations, diagnostics, toasts, banners, and presentation. `DashboardPage.tsx` at 2,292 lines is the clearest example.
- `src/integrations/supabase/types.ts` now includes `cross_batch_clearings` at `src/integrations/supabase/types.ts:246-265` and the RPC at `src/integrations/supabase/types.ts:985-987`, but the cross-batch hook/sweep still cast through `(supabase as any)` at `src/hooks/useCrossBatchOverlay.ts:58-64` and `src/lib/sweep/crossBatchClearingSweep.ts:126-127`. That was sensible when types were missing, but now it should be retired gradually to recover type safety.

This is not a reason to stop using Lovable. It is a reason to stop giving Lovable "all affected surfaces plus helper plus tests plus migration" in one directive.

## 7. Recommended Operating Model

Use a three-lane model:

### Green Lane: Lovable-Preferred

- UI-only changes.
- One surface at a time.
- Copy, banners, chips, layout, columns.
- Tests that assert visible behavior.
- No SQL, no new data loading, no new business rule.

### Yellow Lane: Lovable With Pre-Specified Contract

- Wiring one existing canonical helper into one surface.
- Adding an export column based on an already-defined field.
- Adding a pure helper with a fixed signature, truth table, and tests.
- Adding a data-loader projection if Codex/Claude provides exact query shape.

Requirements: exact files in scope, files out of scope, source-of-truth helper, test matrix, and grep guards against local reimplementation.

### Red Lane: Engineer-Authored Or SQL-First

- Migrations and RPCs.
- Rebuild/sweep jobs.
- Cross-batch clearing semantics.
- AOR/pay-entity override math.
- Comp-grid expected commission logic.
- Pagination strategy for large tables.
- Changes touching more than one major surface plus a helper.

Requirements: Codex/Claude audit first, implementation spec second, Lovable only after the contract is stable.

## 8. Architecture Changes To Reduce Future Bug Rate

1. **Move global sweeps out of the browser path.**  
   The browser button should enqueue or start a server-side job and poll a `sweep_runs` table. Avoid client-side assembly of thousands of rows and one giant RPC payload.

2. **Create a canonical "unpaid overlay view model" helper.**  
   Instead of each surface doing its own `getExpectedPaymentBreakdown` plus `partitionUnpaidRowsByOverlay` plus dollar recompute, expose one helper that returns adjusted rows, removed rows, reversed rows, review rows, counts, and dollar totals. Pages should consume that output only.

3. **Keyset-project `reconciled_members` loaders.**  
   Replace broad `.select('*').range(...)` readers in high-volume paths with projected keyset readers. The exact anti-pattern is visible at `src/lib/persistence.ts:908-924` and `src/lib/sweep/crossBatchClearingSweep.ts:143-160`.

4. **Promote generated Supabase types back into new data paths.**  
   Since `types.ts` now includes `cross_batch_clearings` and the RPC, phase out `(supabase as any)` in cross-batch consumers where practical.

5. **Split page orchestration from page rendering.**  
   Move Dashboard/MCE derived-data logic into hooks or pure view-model modules. The target is not "small files for aesthetics"; the target is to let Lovable edit presentation without entering money logic.

6. **Create real-data smoke audits for hot paths.**  
   Keep unit tests, but add small scripted audits that query live Supabase counts for "active sidecar freshness", "January zero-premium remaining rows", "cross-batch overlay count by state", and "RPC latest evaluated_at advanced".

7. **Make future-year rate handling explicit before 2027 data.**  
   `mapPolicyYearTo2026Grid` intentionally maps 2025 and 2026 to 2026 at `src/lib/canonical/compGrid.ts:108-113`, while the sweep loads only 2026 rates at `src/lib/sweep/crossBatchClearingSweep.ts:347-353`. Before 2027 work, this needs a rate-year policy.

## 9. Build-Process Changes To Reduce Iteration Loops

1. **One directive = one surface or one backend/data concern.**  
   Do not mix Dashboard + MCE + Agent Summary + Unpaid Recovery + helpers in one Lovable pass.

2. **Every directive starts with an evidence block.**  
   Include current file line references, function signatures, source constants, known query patterns, and "do not touch" files.

3. **Every money/counting change includes a truth table.**  
   Include at least: input row state, clearing state, surface visibility, count effect, dollar effect, export effect, and review/banner effect.

4. **Use "implementation packets" for Red Lane work.**  
   For SQL/RPC/sweep changes, Codex should produce exact SQL/query-shape/test-shape first. Lovable should not infer the architecture.

5. **Post-sync audit remains mandatory.**  
   Keep the current Codex/Claude post-sync pattern, but aim to reduce it to verification rather than discovery.

6. **Require "no local reimplementation" grep checks.**  
   Any surface prompt should say which helper must be consumed and include static tests against inline duplicate predicates.

7. **Keep live deployment checks separate from repo checks.**  
   The repo can pass tests/build while live Supabase still has stale active clearings. Current live checks already showed this class of gap during the 13b timeout work. Treat "code merged" and "database behavior live" as two different gates.

## 10. Before Bundle 13d / 13e / 14

Before 13d badge polish:

- Finish the current sweep hotfix and confirm active `cross_batch_clearings.evaluated_at` advances after a successful rebuild.
- Freeze the overlay state-to-badge matrix in one doc or test fixture.
- Keep 13d UI-only unless a missing overlay field is discovered.

Before 13e estimated-missing replacement:

- Build a single adjusted-unpaid view-model helper first.
- Do not let each surface replace `estimated_missing_commission` independently.
- Include compatibility for `reconciled_member_id` being null after rebuild, since overlay matching is grain-based.

Before Bundle 14 manual override:

- Define the precedence stack before implementation: manual override vs comp grid vs cross-batch clearing vs source evidence.
- Decide whether overrides are row-scoped, grain-scoped, policy-month-scoped, or AOR/pay-entity scoped.
- Add an audit trail table before UI work.

## 11. Concrete Guardrails For Future Lovable Prompts

Use this checklist in future prompts:

- State the lane: Green, Yellow, or Red.
- List exact files in scope and exact files forbidden.
- Name the canonical source-of-truth helpers and forbid page-local reimplementation.
- Include exact query requirements: projected columns, active predicates, keyset pagination, no `select('*')` on large paths, no `.range(...)` for growing cross-batch readers.
- Include a truth table for every money/counting rule.
- Include one surface only unless Codex explicitly approves multi-surface scope.
- Require `npm test` and `npm run build`.
- Require a post-sync report with changed files, test count, build result, and known warnings.
- For migrations/RPCs, require static SQL tests plus a live smoke check after deployment.
- For cross-batch work, require active sidecar freshness check: latest active `evaluated_at`, active row count, and latest `run_id`.
- For generated Supabase types, say whether `(supabase as any)` is allowed or forbidden.

## Bottom Line

This project is still workable with Lovable, but the app has crossed into a **Yellow platform-fit** state. Lovable should be used like a fast implementation assistant inside tight boundaries, not like the owner of architecture-sensitive reconciliation logic. The safest near-term move is not to abandon Lovable; it is to narrow Lovable's role and make Codex/Claude own the contracts for SQL, sweep architecture, scope/AOR semantics, and money-counting rules.
