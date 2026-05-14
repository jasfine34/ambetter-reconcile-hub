# Bundle 13b Post-Sync Audit

Use this immediately after Lovable syncs Bundle 13b. The goal is to catch scope drift, false green tests, unsafe sweep behavior, and anything that would make Bundle 13c harder.

## Baseline

- Pre-flight migration already exists:
  - `supabase/migrations/20260514160729_create_cross_batch_clearings.sql`
- Bundle 13b should not create a duplicate `cross_batch_clearings` migration.
- Expected new test delta from the v8 directive: `+82` to `+108`.
- Bundle 13b may add exactly one visible UI element:
  - `Rebuild Cross-Batch Clearings` maintenance button in the Dashboard header.
- Bundle 13b must not change EBU/counting/reporting behavior yet.

## Scope Check

Expected production files:

- `src/lib/canonical/policyIdentityKey.ts`
- `src/lib/canonical/serviceMonth.ts`
- `src/lib/canonical/crossBatchIdentityMatch.ts`
- `src/lib/canonical/crossBatchAmountClearing.ts`
- `src/lib/canonical/monthKey.ts`
- `src/lib/canonical/stateCode.ts`
- `src/lib/sweep/crossBatchClearingSweep.ts`
- `src/lib/sweep/resolverRecordAdapters.ts`
- `src/components/RebuildCrossBatchClearingsButton.tsx`
- `src/pages/DashboardPage.tsx`

Expected test files:

- `src/test/cross-batch-policy-identity-key.test.ts`
- `src/test/cross-batch-month-key.test.ts`
- `src/test/cross-batch-state-code.test.ts`
- `src/test/cross-batch-resolver-adapters.test.ts`
- `src/test/cross-batch-identity-match.test.tsx`
- `src/test/cross-batch-amount-clearing.test.tsx`
- `src/test/cross-batch-service-month.test.tsx`
- `src/test/cross-batch-clearing-sweep.test.tsx`
- `src/test/cross-batch-rebuild-button.test.tsx`
- `src/test/cross-batch-migration-static.test.ts`

Forbidden or high-risk edits:

- `src/contexts/BatchContext.tsx`
- `src/lib/canonical/metrics.ts`
- `src/lib/reconcile.ts`
- `src/lib/canonical/compGrid.ts`
- `src/lib/canonical/compGridLoader.ts`
- `src/integrations/supabase/types.ts`, unless Lovable regenerated types intentionally and consistently
- Any `src/pages/*` file other than `src/pages/DashboardPage.tsx`

## Migration Audit

Verify `supabase/migrations/20260514160729_create_cross_batch_clearings.sql` remains the canonical migration and Lovable did not add a duplicate.

Required table and constraint shape:

- Table: `public.cross_batch_clearings`
- Grain columns:
  - `policy_identity_key text NOT NULL`
  - `target_service_month text NOT NULL CHECK (target_service_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')`
- `reconciled_member_id uuid REFERENCES public.reconciled_members(id) ON DELETE SET NULL`
- `unpaid_batch_ids jsonb NOT NULL DEFAULT '[]'::jsonb`
- `payment_batch_ids jsonb NOT NULL DEFAULT '[]'::jsonb`
- `unpaid_statement_month` has the same strict month regex as `target_service_month`.
- `staging_status text NOT NULL DEFAULT 'active' CHECK (staging_status IN ('active', 'superseded'))`
- No `superseded_by` column.

Required indexes:

- Partial unique active grain:
  - `(policy_identity_key, target_service_month)`
  - `WHERE staging_status = 'active' AND superseded_at IS NULL`
- History:
  - `(policy_identity_key, target_service_month, evaluated_at)`
- Canonical lineage scalar:
  - `(unpaid_batch_id, clearing_state, staging_status)`
- GIN:
  - `unpaid_batch_ids`
  - `payment_batch_ids`
- Surface helpers:
  - `(carrier, target_service_month)`
  - `(run_id)`

Required RLS:

- `ALTER TABLE public.cross_batch_clearings ENABLE ROW LEVEL SECURITY`
- Policy uses:
  - `FOR ALL`
  - `USING (true)`
  - `WITH CHECK (true)`
- No `TO authenticated`.

Required RPC:

- Function: `public.replace_cross_batch_clearings_for_run(p_run_id uuid, p_rows jsonb, p_scope text DEFAULT 'global_full_rebuild')`
- Uses `pg_advisory_xact_lock(hashtext('cross_batch_clearings_global_full_rebuild'))`.
- Only supports `p_scope = 'global_full_rebuild'`.
- Supersedes all active rows globally:
  - `SET superseded_at = now(), staging_status = 'superseded'`
  - `WHERE staging_status = 'active' AND superseded_at IS NULL`
- Inserts from `jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb))`.

## Pure Helper Audit

Canonical helpers must be pure. They must not import Supabase or reach into persistence.

Files:

- `src/lib/canonical/policyIdentityKey.ts`
- `src/lib/canonical/serviceMonth.ts`
- `src/lib/canonical/crossBatchIdentityMatch.ts`
- `src/lib/canonical/crossBatchAmountClearing.ts`
- `src/lib/canonical/monthKey.ts`
- `src/lib/canonical/stateCode.ts`

Required behavior:

- `monthKey.ts`
  - Valid only: `^[0-9]{4}-(0[1-9]|1[0-2])$`
  - Rejects `2026-13`, `2026-00`, `2026-1`, whitespace-padded values, and date strings with day suffixes.
- `stateCode.ts`
  - Normalizes 50 states, DC, and territories.
  - Returns `null` for unknowns and blanks.
- `policyIdentityKey.ts`
  - Uses `cleanId` and `cleanSubscriberId`.
  - Cross-field alias where cleaned policy number equals cleaned issuer subscriber ID uses the unprefixed policy form.
- `serviceMonth.ts`
  - `paid_to_date` month is the last covered service month.
  - `months_paid` walks backward inclusively.
  - Missing or invalid fields return unresolvable, not defaults.
- `crossBatchIdentityMatch.ts`
  - Uses typed `issuer_subscriber_id` first.
  - Uses normalized policy/subscriber IDs.
  - Requires carrier match and service-month overlap.
- `crossBatchAmountClearing.ts`
  - Implements 70% threshold.
  - `0` or `null` commission amounts are ignored and recorded.
  - Reversal-only matched sets return `manual_review_required`.
  - Q22 terminal behavior: once `cleared_then_reversed` happens within a sweep, later positives do not revert state.

## Sweep Audit

File: `src/lib/sweep/crossBatchClearingSweep.ts`

Required architecture:

- Phase A: reference data + safety guards + pre-grain input errors.
- Phase B: bulk-load BO/EDE records with typed identifiers first.
- Phase C: bulk-load active commission rows once.
- Phase D: per-grain evaluation is memory-only.
- Phase E: one final RPC commit.

Safety guards:

- `upload_batches=[]` returns aborted `SweepResult`; no RPC call.
- `upload_batches` load error returns aborted `SweepResult`; no RPC call.
- Upload batches load but all `statement_month` values normalize invalid: aborted `SweepResult`; no RPC call.
- `shouldContinue()` false at start or before commit returns aborted `SweepResult`; no RPC call.
- RPC failure rejects/throws rather than returning a controlled abort.

SweepResult contract:

```ts
type AbortReason =
  | 'stale_generation'
  | 'no_upload_batches'
  | 'upload_batches_load_failed'
  | 'no_valid_batch_months';

type SweepResult = {
  run_id: string;
  clearingRowsWritten: number;
  inputErrors: InputError[];
  aborted: boolean;
  abortReason?: AbortReason;
  errorMessage?: string;
};
```

Pre-grain input errors produce no clearing row:

- `target_service_month_unresolved`
- `no_identity_keys`
- `no_carrier`
- `ambiguous_policy_identity_key_before_grain`
- `batch_statement_month_unresolved`

Post-grain failures write a clearing row with `clearing_state='manual_review_required'`:

- State resolver manual review or unresolved.
- Member-count resolver manual review or unresolved.
- Expected commission unsupported, not found, or unresolvable.
- Identity predicate manual review.
- Amount predicate manual review.

Bulk-load requirements:

- Use Supabase query builder calls:
  - `.in()`
  - `.eq()`
  - `.is()`
  - `.order()`
  - `.limit()`
  - `.gt()`
- Do not use raw SQL `ANY()` text in TypeScript.
- No per-grain commission queries.
- Keyset pagination by `id` with page size `500`.
- BO/EDE source types are `BACK_OFFICE` and `EDE`.
- Resolver adapter maps:
  - `BACK_OFFICE -> bo`
  - `EDE -> ede`
- Commission projection includes typed `issuer_subscriber_id`.
- `statement_month` for commission candidates comes from `upload_batches`, not `normalized_records`.

Ambetter alias-aware resolver indexing:

- `buildResolverRecordIndex` must index Ambetter BO/EDE records under both relevant forms when typed values exist:
  - `ambetter|<cleaned-policy>`
  - `ambetter|sub:<cleaned-subscriber>`
  - `ambetter|<cleaned-subscriber>`
- Non-Ambetter records use only the primary derived key.
- De-dupe records by `id` within each bucket before resolver adapters receive them.

Canonical batch tie-break:

- earliest normalized `statement_month`
- then earliest `upload_batches.created_at`
- then lexicographically smallest `batch_id`

## Button Audit

File: `src/components/RebuildCrossBatchClearingsButton.tsx`

Required behavior:

- Uses existing AlertDialog confirmation pattern.
- Disabled when no batches are loaded.
- Disabled while running.
- First click opens dialog; it does not start the sweep.
- Confirm starts the sweep.
- Cancel does not start the sweep.
- Uses local state; no `BatchContext.tsx` modification required.
- Owns `generationRef`.
- Passes `shouldContinue: () => generationRef.current === generationId`.
- Handles three sweep outcomes:
  - resolved `aborted=false`: success toast and last-run state update.
  - resolved `aborted=true`: error toast, no last-run/count update.
  - rejected: error toast, no last-run/count update.
- Success toast includes clearing row count and input error count when nonzero.
- Logs `inputErrors` to console for debugging.

Dashboard placement:

- New button appears in `src/pages/DashboardPage.tsx` header beside:
  - Rebuild Entire Batch
  - Rebuild All Batches
- No other Dashboard behavior changes.

## Command Checklist

Run after Lovable syncs.

```powershell
git status --short
git diff --name-only HEAD
```

Check for duplicate migration:

```powershell
rg -n "CREATE TABLE public\.cross_batch_clearings|replace_cross_batch_clearings_for_run" supabase/migrations
```

Check forbidden file drift:

```powershell
git diff --name-only HEAD | Where-Object {
  $_ -match '^src/contexts/BatchContext\.tsx$' -or
  $_ -match '^src/lib/canonical/metrics\.ts$' -or
  $_ -match '^src/lib/reconcile\.ts$' -or
  $_ -match '^src/lib/canonical/compGrid\.ts$' -or
  $_ -match '^src/lib/canonical/compGridLoader\.ts$' -or
  ($_ -like 'src/pages/*' -and $_ -ne 'src/pages/DashboardPage.tsx')
}
```

Check canonical helper purity:

```powershell
rg -n "supabase|from\(|rpc\(|createClient|integrations/supabase" src/lib/canonical/policyIdentityKey.ts src/lib/canonical/serviceMonth.ts src/lib/canonical/crossBatchIdentityMatch.ts src/lib/canonical/crossBatchAmountClearing.ts src/lib/canonical/monthKey.ts src/lib/canonical/stateCode.ts
```

Check source-type query literals:

```powershell
rg -n "'BO'|\"BO\"|source_type.*BO|BACK_OFFICE|EDE" src/lib/sweep/crossBatchClearingSweep.ts src/lib/sweep/resolverRecordAdapters.ts
```

Check bad statement-month source:

```powershell
rg -n "statement_month" src/lib/sweep src/lib/canonical
```

Expected:

- `statement_month` loads from `upload_batches`.
- No code assumes `normalized_records.statement_month`.

Check no per-grain commission query smell:

```powershell
rg -n "source_type.*COMMISSION|eq\('source_type', 'COMMISSION'\)|from\('normalized_records'\)" src/lib/sweep/crossBatchClearingSweep.ts
```

Expected:

- One bulk commission loader.
- Per-grain Phase D should use in-memory maps only.

Check full-rebuild RPC usage:

```powershell
rg -n "replace_cross_batch_clearings_for_run|global_full_rebuild|p_rows|p_run_id" src/lib/sweep src/components
```

Run tests and build:

```powershell
npm test
npm run build
```

Count tests if needed:

```powershell
rg -n "\bit\(|\btest\(" src/test/cross-batch-*.test.ts src/test/cross-batch-*.test.tsx
```

## Test Quality Traps

Flag tests that:

- Assert only that mocks were called without checking row contents.
- Use comment-only or empty test bodies.
- Recreate the implementation logic inside the assertion.
- Do not test negative paths.
- Do not test both controlled abort and unexpected rejection.
- Do not verify `p_rows` content for sweep rows.
- Do not verify the absence of a row for pre-grain `inputErrors`.
- Do not test Q22 terminal behavior after a later positive payment.

High-value row assertions:

- `policy_identity_key`
- `target_service_month`
- `unpaid_batch_ids`
- `payment_batch_ids`
- `clearing_state`
- `manual_review_reason`
- `reason`
- `matched_paid_record_ids`
- `reversal_record_ids`
- `ignored_record_ids`
- `first_full_clear_statement_month`
- `reversed_at_statement_month`
- `run_id`
- `logic_version`

## 13c Prep Notes

Bundle 13c should consume `cross_batch_clearings` as a read-only overlay.

Required active predicate:

```sql
staging_status = 'active'
AND superseded_at IS NULL
```

Primary read grain:

- `policy_identity_key`
- `target_service_month`

Batch overlay reads:

- Use `unpaid_batch_ids` to attach clearings to unpaid surfacing batches.
- Use `payment_batch_ids` to identify later batches that supplied payments or reversals.

13c should not:

- Re-run the sweep automatically.
- Mutate `cross_batch_clearings`.
- Change Bundle 13a comp-grid helpers.
- Change `reconcile.ts`.
- Replace legacy estimated missing commission app-wide.

Candidate 13c helper:

```ts
type CrossBatchClearingOverlay = {
  policy_identity_key: string;
  target_service_month: string;
  clearing_state:
    | 'fully_cleared'
    | 'partially_cleared'
    | 'not_cleared'
    | 'cleared_then_reversed'
    | 'zero_expected_no_payment_required'
    | 'manual_review_required';
  expected_amount: number | null;
  actual_positive_amount: number | null;
  actual_reversal_amount: number | null;
  actual_net_amount: number | null;
  remainder_owed: number | null;
  unpaid_batch_ids: string[];
  payment_batch_ids: string[];
};
```

Potential 13c surface rules to decide before implementation:

- `fully_cleared`: remove from unpaid count or show as cleared overlay.
- `zero_expected_no_payment_required`: remove from expected recovery.
- `partially_cleared`: keep in unpaid/recovery but reduce dollar amount by `actual_net_amount`.
- `cleared_then_reversed`: treat as not currently cleared, with a reversal badge later in 13d.
- `manual_review_required`: keep unresolved, optionally count separately.
- `not_cleared`: no overlay effect.

Open 13c wording decision:

- Whether to call the operator-facing category "Recovered", "Cleared later", or "Cross-batch cleared".
- Keep 13b terminology stable in data; UI wording can be friendlier in 13c.
