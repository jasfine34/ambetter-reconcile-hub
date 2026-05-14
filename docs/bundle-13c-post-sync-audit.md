# Bundle 13c Post-Sync Audit Packet

Prepared while Bundle 13c is building. This is a post-sync review script, not a production change request.

Baseline evidence was gathered from the current workspace before 13c lands. At this baseline, `git status --short --branch` is clean on `main...origin/main`.

## 0. Audit Goal

Bundle 13c should be a read-only surface-wiring slice over the 13b `cross_batch_clearings` sidecar. The audit should catch:

- wrong files touched,
- per-row or offset-style sidecar queries,
- sidecar lookups keyed by `reconciled_member_id`,
- direct `overlay.remainder_owed` usage that bypasses `deriveRemainder`,
- Dashboard count/dollar/split drift,
- `estimated_missing_commission` dependency creep before 13e,
- row/filter behavior mismatches for each `clearing_state`,
- accidental CSV/schema/type changes.

## 1. Pre-Sync Baseline Anchors

Capture the pre-sync hash before pulling Lovable's 13c build:

```powershell
$BASE = git rev-parse HEAD
git status --short --branch
```

Current code paths 13c will modify or depend on:

- Dashboard raw EBU breakdown is built from `getExpectedPaymentBreakdown(...)` at `src/pages/DashboardPage.tsx:627-636`.
- Dashboard legacy missing-dollar total uses `getExpectedMissingCommissionSum(...)` at `src/pages/DashboardPage.tsx:650`.
- Dashboard EBU source chips currently read raw `metrics.expectedPaymentBreakdown.unpaidSplit` at `src/pages/DashboardPage.tsx:1277-1280`.
- Dashboard EBU premium chips currently read raw `metrics.expectedPaymentBreakdown.unpaidPremiumSplit` at `src/pages/DashboardPage.tsx:1282-1284`.
- Source Coverage owner chips currently read raw `metrics.expectedPaymentBreakdown.unpaidOwnerSplit` at `src/pages/DashboardPage.tsx:1507-1514`.
- Missing Commission Export assigns `missingMembers = breakdown.unpaidRows` at `src/pages/MissingCommissionExportPage.tsx:633-636`.
- Missing Commission Export currently derives the preview missing amount from `m.estimated_missing_commission` or `DEFAULT_COMMISSION_ESTIMATE` at `src/pages/MissingCommissionExportPage.tsx:782-785`.
- Agent Summary derives `canonicalUnpaidRows` from `.unpaidRows` at `src/pages/AgentSummaryPage.tsx:152-155`.
- Agent Summary currently sums `estimated_missing_commission` at `src/pages/AgentSummaryPage.tsx:161-168` and `src/pages/AgentSummaryPage.tsx:242-244`.
- Unpaid Recovery maps display rows with `estimated_missing_commission: r.estimated_missing_commission ?? null` at `src/pages/UnpaidRecoveryPage.tsx:206-219`.
- Unpaid Recovery derives `breakdown.unpaidRows` at `src/pages/UnpaidRecoveryPage.tsx:386-392`.
- Existing rebuild button uses `AlertDialog`, `useBatch`, and `useToast` at `src/components/RebuildCrossBatchClearingsButton.tsx:1-15`; success path currently ends at the success toast at `src/components/RebuildCrossBatchClearingsButton.tsx:42-49`.
- Existing all-batches readiness pattern disables when `!total || running` at `src/components/RebuildAllBatchesButton.tsx:126-136`.
- Existing `Badge` variants are only `default`, `secondary`, `destructive`, and `outline` at `src/components/ui/badge.tsx:6-20`.
- Existing EBU disclaimer constant is at `src/lib/constants.ts:125-126`.
- Shared pay-entity scope hook is `usePayEntityScope()` at `src/hooks/usePayEntityScope.ts:16-59`.
- Canonical scope helpers are in `src/lib/canonical/scope.ts:27-123`.
- `src/lib/utils.ts` currently has only `cn(...)` at `src/lib/utils.ts:1-5`; 13c may add `formatMoney`.

Sidecar/schema anchors:

- Canonical 13b migration is `supabase/migrations/20260514160729_create_cross_batch_clearings.sql`.
- `cross_batch_clearings` active grain is `(policy_identity_key, target_service_month)` with active predicate at `supabase/migrations/20260514160729_create_cross_batch_clearings.sql:53-55`.
- JSONB arrays/indexes exist for `unpaid_batch_ids` and `payment_batch_ids` at `supabase/migrations/20260514160729_create_cross_batch_clearings.sql:63-67`.
- Dollar fields including `remainder_owed` are nullable at `supabase/migrations/20260514160729_create_cross_batch_clearings.sql:23-28`.
- `matched_paid_record_ids` exists at `supabase/migrations/20260514160729_create_cross_batch_clearings.sql:37`.
- RLS policy is open-app style at `supabase/migrations/20260514160729_create_cross_batch_clearings.sql:75-80`.
- `src/integrations/supabase/types.ts` does not currently include `cross_batch_clearings`; new reads should use `(supabase as any)` unless 13c explicitly regenerates types.

## 2. Expected File Scope

After syncing Lovable's 13c build, run:

```powershell
git diff --name-only $BASE..HEAD
```

Expected production files:

- `src/lib/canonical/crossBatchOverlay.ts`
- `src/hooks/useCrossBatchOverlay.ts`
- `src/components/ClearingStatusChip.tsx`
- `src/components/CrossBatchRolloutBanner.tsx`
- `src/components/CrossBatchStaleSweepBanner.tsx`
- `src/pages/DashboardPage.tsx`
- `src/pages/AgentSummaryPage.tsx`
- `src/pages/MissingCommissionExportPage.tsx`
- `src/pages/UnpaidRecoveryPage.tsx`
- `src/components/RebuildCrossBatchClearingsButton.tsx`
- `src/lib/constants.ts`
- `src/lib/utils.ts`

Expected test files may vary, but should cover overlay helper, hook, chip, banners, formatMoney, rebuild event dispatch, and all five surfaces.

Forbidden or suspicious files for 13c:

- `src/contexts/BatchContext.tsx`
- `src/lib/canonical/metrics.ts`
- `src/lib/canonical/compGrid.ts`
- `src/lib/canonical/compGridLoader.ts`
- `src/lib/canonical/crossBatchAmountClearing.ts`
- `src/lib/canonical/crossBatchIdentityMatch.ts`
- `src/lib/canonical/policyIdentityKey.ts`
- `src/lib/canonical/serviceMonth.ts`
- `src/lib/canonical/monthKey.ts`
- `src/lib/canonical/stateCode.ts`
- `src/lib/sweep/crossBatchClearingSweep.ts`
- `src/lib/reconcile.ts`
- `src/integrations/supabase/types.ts` unless the final 13c directive explicitly chose type regeneration.
- Any `supabase/migrations/*` file.

Fast scope check:

```powershell
git diff --name-only $BASE..HEAD | Select-String -Pattern "src/contexts/BatchContext.tsx|src/lib/canonical/metrics.ts|src/lib/canonical/compGrid|src/lib/canonical/crossBatchAmountClearing.ts|src/lib/canonical/crossBatchIdentityMatch.ts|src/lib/canonical/policyIdentityKey.ts|src/lib/canonical/serviceMonth.ts|src/lib/canonical/monthKey.ts|src/lib/canonical/stateCode.ts|src/lib/sweep/crossBatchClearingSweep.ts|src/lib/reconcile.ts|src/integrations/supabase/types.ts|supabase/migrations"
```

Expected: no output unless there is an explicit, reviewed reason.

## 3. Static Bug Traps

Run these immediately after sync.

### 3.1 Sidecar Query Shape

```powershell
rg -n "from\(['\"]cross_batch_clearings['\"]\)" src
```

Expected:

- Allowed in `src/hooks/useCrossBatchOverlay.ts`.
- Allowed in `src/components/CrossBatchStaleSweepBanner.tsx` only if the banner is self-contained.
- Not allowed in row renderers, loops, or the four page files except via the hook.

Then verify active predicate and keyset pagination:

```powershell
rg -n "staging_status|superseded_at|order\(['\"]id['\"]|limit\(500\)|gt\(['\"]id['\"]|CLEARING_SELECT|select\(" src/hooks/useCrossBatchOverlay.ts src/components/CrossBatchStaleSweepBanner.tsx
```

Expected:

- `id` included in the select list.
- `.eq('staging_status', 'active')`.
- `.is('superseded_at', null)`.
- `.order('id', { ascending: true })`.
- `.limit(500)`.
- `.gt('id', lastId)` on later pages.

### 3.2 No Per-Row DB Calls

```powershell
rg -n "map\(.*from\(|forEach\(.*from\(|for .*from\(|from\(['\"]cross_batch_clearings['\"]\)" src/pages src/components src/hooks src/lib
```

Review any match. The only acceptable sidecar fetch pattern is bulk load, build a `Map`, then memory-only per-row classification.

### 3.3 Overlay Key Must Be Grain, Not `reconciled_member_id`

```powershell
rg -n "reconciled_member_id" src/lib/canonical/crossBatchOverlay.ts src/hooks/useCrossBatchOverlay.ts src/pages src/components
```

Expected:

- No use in overlay lookup logic.
- If present as display/evidence only, manually verify it is not part of the `Map` key.

Correct lookup key is:

- `derivePolicyIdentityKey({ carrier, policy_number, issuer_subscriber_id })`
- plus `expected_ede_effective_month`
- never `reconciled_member_id`.

### 3.4 Do Not Bypass `deriveRemainder`

This catches the v3 review finding.

```powershell
rg -n "overlay\.remainder_owed|\.remainder_owed" src/pages src/components src/lib/canonical/crossBatchOverlay.ts
```

Expected:

- `remainder_owed` may appear in `crossBatchOverlay.ts` to build the overlay and in tests.
- Surface code should not use `overlay.remainder_owed` directly for `reduce_dollars`.
- Surface code should use `adjustment.remainder` from `classifyOverlay()`.

Manual test to require: `partially_cleared` overlay with `remainder_owed: null`, `expected_amount: 100`, `actual_net_amount: 40` should classify as `reduce_dollars` with `remainder: 60`, and all dollar surfaces should use 60.

### 3.5 Dashboard Raw Split Drift

```powershell
rg -n "expectedPaymentBreakdown\.unpaidSplit|expectedPaymentBreakdown\.unpaidPremiumSplit|expectedPaymentBreakdown\.unpaidOwnerSplit" src/pages/DashboardPage.tsx
```

Expected after 13c:

- No raw reads in rendered Dashboard EBU chips or Source Coverage owner chips.
- If raw reads remain for diagnostics, they must not drive the visible adjusted tiles.

Manual read:

- `metrics.unpaid` from adjusted regular unpaid rows.
- `metrics.estMissing` from adjusted rows.
- Dashboard EBU source chips from adjusted rows.
- Dashboard EBU premium chips from adjusted rows.
- Source Coverage owner chips from adjusted rows.

### 3.6 `estimated_missing_commission` Creep

```powershell
rg -n "estimated_missing_commission" src/lib/canonical/crossBatchOverlay.ts src/hooks src/components/ClearingStatusChip.tsx src/components/CrossBatchRolloutBanner.tsx src/components/CrossBatchStaleSweepBanner.tsx
```

Expected: no output.

Then inspect new diff lines in page files:

```powershell
git diff -U0 $BASE..HEAD -- src/pages/DashboardPage.tsx src/pages/AgentSummaryPage.tsx src/pages/MissingCommissionExportPage.tsx src/pages/UnpaidRecoveryPage.tsx | Select-String -Pattern "estimated_missing_commission|DEFAULT_COMMISSION_ESTIMATE"
```

Allowed only in legacy fallback branches:

- `no_overlay`
- `no_adjustment`
- `mark_needs_review`
- `partial_amount_unavailable`

Not allowed for `reduce_dollars`; those rows must use `adjustment.remainder`.

### 3.7 Hook Import Allowlist

```powershell
rg -n "useCrossBatchOverlay" src
```

Allowed import locations:

- `src/pages/DashboardPage.tsx`
- `src/pages/AgentSummaryPage.tsx`
- `src/pages/MissingCommissionExportPage.tsx`
- `src/pages/UnpaidRecoveryPage.tsx`
- `src/components/CrossBatchStaleSweepBanner.tsx` if self-contained
- the hook file itself

### 3.8 Rebuild Event Dispatch

```powershell
rg -n "crossBatchClearings:rebuilt|dispatchEvent" src/components/RebuildCrossBatchClearingsButton.tsx src/hooks/useCrossBatchOverlay.ts
```

Expected:

- Button dispatches `crossBatchClearings:rebuilt` only after successful, non-aborted sweep.
- Not dispatched in aborted result branch.
- Not dispatched in catch/reject branch.
- Hook listens and cleans up listener.

### 3.9 CSV Contract

```powershell
git diff $BASE..HEAD -- src/pages/MissingCommissionExportPage.tsx | Select-String -Pattern "MESSER|CSV|columns|clearing|Clearing|download|_clearing"
```

Expected:

- Messer CSV column order unchanged.
- Clearing status may be preview-only/internal, but not a downloaded Messer column unless explicitly directed.

### 3.10 Types and Migration Guard

```powershell
git diff --name-only $BASE..HEAD -- supabase src/integrations/supabase/types.ts
rg -n "cross_batch_clearings|replace_cross_batch_clearings_for_run" src/integrations/supabase/types.ts
```

Expected:

- No migration changes.
- No duplicate `cross_batch_clearings` migration.
- If `types.ts` remains unchanged, all sidecar reads use `(supabase as any)`.
- If `types.ts` changed, verify it is complete and intentional.

## 4. Clearing State x Surface Matrix

Use this as the manual read and test oracle.

| State / condition | Dashboard EBU | Source Coverage EBU | MCE | Agent Summary | Unpaid Recovery |
| --- | --- | --- | --- | --- | --- |
| `fully_cleared` | Exclude from main count, est missing, source/premium chips, drilldown | Exclude from count, owner chips, drilldown | Exclude from preview and CSV | Exclude from per-agent unpaid count/dollars | Exclude from default row set |
| `zero_expected_no_payment_required` | Same as fully cleared | Same | Exclude | Exclude | Exclude |
| `partially_cleared` with finite remainder | Keep in count; est missing contributes `adjustment.remainder`; badge/context if row shown | Keep in count/chips; badge/context if row shown | Keep row; preview `_estimatedMissingCommission = adjustment.remainder`; preview badge | Keep in count; per-agent dollars use `adjustment.remainder`; needs no separate review count | Keep row; display adjusted dollar = `adjustment.remainder`; row badge |
| `partially_cleared` with null/unusable amount | Keep in count; preserve legacy dollar; badge/context | Keep in count/chips | Keep row; preserve legacy/default dollar; preview badge | Keep count; preserve legacy dollar | Keep row; preserve legacy dollar; row badge |
| `cleared_then_reversed` | Exclude from main EBU; count in cohort-scoped reversed tile | Exclude from main EBU; include reversed context if added | Exclude from missing export | Exclude from normal unpaid, or separate reversed indicator if implemented | Exclude by default; visible only when "Cleared then reversed" filter is active |
| `manual_review_required` | Keep in main unpaid; count in "Needs review" subset chip | Keep in main; count in subset chip | Keep row; preview badge "Needs review" | Keep count/dollars; per-agent "Needs review" subset | Keep row; row badge |
| `not_cleared` | No adjustment | No adjustment | No adjustment | No adjustment | No adjustment |
| no overlay / no grain | No adjustment | No adjustment | No adjustment | No adjustment | No adjustment |

Critical interaction checks:

- Dashboard reversed tile must be cohort-scoped, not a global count of every sidecar row.
- Manual-review rows are a subset of unpaid, not a replacement for unpaid.
- `cleared_then_reversed` is not "fully cleared"; it is removed from default unpaid only because 13c gives it a separate recovery/reversed path.
- Scope is loose per Q29: surface cohort scope decides which rows are considered; sidecar matched-payment `pay_entity` should not block overlay use in 13c.

## 5. Per-Surface Manual Read Checklist

### Dashboard

Read `src/pages/DashboardPage.tsx`.

- `useCrossBatchOverlay()` is called once at page level, not inside render loops.
- A shared adjusted-row model exists before metrics/rendering.
- `metrics.unpaid`, `metrics.estMissing`, EBU source chips, EBU premium chips, and Source Coverage owner chips all derive from adjusted rows.
- `cleared_then_reversed` tile exists, is cohort-scoped, and links to Unpaid Recovery with the correct filter.
- Needs-review chip is a subset chip, not a main-count replacement.
- Banners do not block primary metrics when sidecar is empty.
- Disclaimers are reworded from "later payments may not be cleared here" to cross-batch-aware copy.

### Missing Commission Export

Read `src/pages/MissingCommissionExportPage.tsx`.

- Overlay is applied after `breakdown.unpaidRows` and before export row creation.
- Removed/reversed rows do not enter the Messer CSV.
- `reduce_dollars` rows use `adjustment.remainder`.
- `partial_amount_unavailable` rows preserve legacy/default estimate.
- Internal preview can show clearing badges, but downloaded CSV columns remain locked.
- 12.7's non-fatal commission fallback remains intact.

### Agent Summary

Read `src/pages/AgentSummaryPage.tsx`.

- Per-agent unpaid count excludes fully cleared, zero expected, and reversed rows.
- Per-agent estimated missing uses `adjustment.remainder` for partials.
- "Other AORs" aggregate follows the same adjusted logic as named agents.
- Needs-review is visible as a subset count/chip/column.
- Scope hook remains `usePayEntityScope()`.

### Unpaid Recovery

Read `src/pages/UnpaidRecoveryPage.tsx`.

- Display row derivation carries clearing status/adjustment.
- Fully cleared and zero expected rows are excluded.
- `cleared_then_reversed` rows are excluded by default and included only when the new filter is active.
- New filter state is URL-safe if existing filter URL sync is touched.
- Row-level badges exist for partial, needs review, and reversed.
- Export uses adjusted rows/dollars consistently with the table.

### Banners and Button

Read:

- `src/components/CrossBatchRolloutBanner.tsx`
- `src/components/CrossBatchStaleSweepBanner.tsx`
- `src/components/RebuildCrossBatchClearingsButton.tsx`

Check:

- Rollout dismissal is stable and does not hide error/stale banners.
- Stale banner handles: both null, never-run, stale, fresh, and dismiss.
- Stale banner query does not make row-level sidecar fetches.
- Rebuild button dispatches `crossBatchClearings:rebuilt` only on success.

## 6. Test Quality Checklist

Run:

```powershell
npm test
npm run build
```

If test count jumps unexpectedly, inspect distribution:

```powershell
rg -n "it\(|it\.each\(" src/test src/lib src/pages src/components
```

Spot-check for vacuous tests:

```powershell
rg -n "expect\(true\)|toBeTruthy\(\)|toBeDefined\(\)|expect\.anything\(\)|mock\.calls\.length" src/test src/lib src/pages src/components
```

Required high-signal tests:

- `crossBatchOverlay`: `finiteNumber(null)`, `finiteNumber('')`, `deriveRemainder` fallback, `partial_amount_unavailable`, subscriber-id fallback grain key.
- Hook: select includes `id`, 500-row page uses `.gt('id', lastId)`, reload event, cleanup, `enabled=false` no fetch.
- Dashboard: full recomputation of count, missing dollars, source split, premium split, owner split from adjusted rows.
- Dashboard: unrelated reversed overlay outside cohort does not increment reversed tile.
- MCE: downloaded CSV columns unchanged while preview rows adjust/filter.
- Agent Summary: named agents and Other AORs both use adjusted count/dollars.
- Unpaid Recovery: reversed filter default off and URL/filter behavior preserved.
- Static guards: hook import allowlist, no new sidecar mutation, no new `estimated_missing_commission` in overlay files.

## 7. Forward Compatibility Checks

### Bundle 13d Badge Polish

- `ClearingStatusChip` should centralize labels/colors.
- Surfaces should not duplicate long label/color mappings.
- Existing Badge variants are limited, so className overrides are acceptable for 13c but should be centralized.

### Bundle 13e `estimated_missing_commission` Replacement

- Legacy fallback should be isolated to adjustment branches.
- New overlay helper/files should not import or reference `estimated_missing_commission`.
- Do not add new helpers that make `estimated_missing_commission` look like the future canonical value.

### Bundle 14 Manual Override

- Overlay row data should pass through enough evidence (`overlay`, `manual_review_reason`, months, row ids) for future manual override surfaces.
- Do not collapse manual-review rows into plain unpaid with no status.
- Do not remove sidecar `manual_review_required` rows from row-capable surfaces.

## 8. Empty / Null Robustness

Explicitly verify:

- Empty `cross_batch_clearings` table returns an empty overlay map and all five surfaces behave exactly like pre-13c.
- Failed sidecar read should not crash all pages; show a recoverable banner/toast/error state or preserve legacy values.
- Nullable `expected_amount`, `actual_net_amount`, and `remainder_owed` never display as `$0` unless the finite value is actually zero.
- `reconciled_member_id` may be null after batch rebuild; grain lookup still works.
- JSONB arrays may arrive as arrays or stringified arrays; `coerceStringArray` handles both.
- Supabase numeric strings are normalized before arithmetic.

## 9. Worst Reasonable Misinterpretations To Catch

- Lovable uses `reconciled_member_id` as the overlay key. Catch with `reconciled_member_id` grep and row after rebuild/null-FK test.
- Lovable filters sidecar rows by only `unpaid_batch_id` and misses multi-batch `unpaid_batch_ids`. Catch with a row where current batch is in `unpaid_batch_ids` but not the scalar canonical `unpaid_batch_id`.
- Lovable reads `overlay.remainder_owed` directly and loses the `expected - actualNet` fallback. Catch with the null-remainder/fallback test.
- Lovable removes `manual_review_required` from unpaid instead of keeping it with a subset chip. Catch with Q27 tests.
- Lovable treats `cleared_then_reversed` as fully cleared. Catch with Unpaid Recovery reversed filter and Dashboard reversed tile tests.
- Lovable changes the Messer CSV column contract. Catch with CSV header snapshot.
- Lovable fetches `cross_batch_clearings` inside each row/page loop. Catch with query grep and mock call-count tests.
- Lovable updates only Dashboard EBU count but leaves chips/dollars raw. Catch with dashboard recomputation tests.
- Lovable regens types partially or adds a duplicate migration. Catch with scope and migration/type guard.

## 10. Post-Sync Report Template

Use this format after running the audit:

```md
# Bundle 13c Post-Sync Audit Result

HEAD: <hash>
Base: <hash>

## Result
Clean / Needs patch

## Scope
- Expected files:
- Unexpected files:
- Forbidden files touched:

## Static Checks
- Sidecar query shape:
- Keyset pagination:
- Hook import allowlist:
- Grain lookup:
- `adjustment.remainder`:
- `estimated_missing_commission`:
- Dashboard raw split drift:
- CSV contract:
- Types/migrations:

## Tests
- npm test:
- npm run build:
- Test quality notes:

## Manual Reads
- Dashboard:
- MCE:
- Agent Summary:
- Unpaid Recovery:
- Banners/button:

## Findings
P1/P2/P3 with file:line and suggested patch.
```
