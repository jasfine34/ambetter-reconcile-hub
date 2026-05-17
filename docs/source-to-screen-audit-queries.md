# Source-to-Screen Audit Queries

Created: 2026-05-17

Use these snippets as Phase 2 read-only starting points. They are not a replacement for the app helpers. The SQL-ish queries locate source rows and count cohorts; the TypeScript/Supabase shapes show how to reproduce the app's canonical transformations.

Mutation policy: READ ONLY ONLY. Do not click Rebuild, Upload, Save, Submit, Delete, or any action that changes live data.

## Parameters

Set these before each audit run:

```text
:batch_ids       -- one or more upload_batches.id values
:batch_id        -- selected upload_batches.id
:statement_month -- YYYY-MM, for example 2026-01
:carrier         -- Ambetter for Phase 2.1
:scope           -- Coverall | Vix | All
:source_type     -- EDE | BACK_OFFICE | COMMISSION | null
:premium_bucket  -- all | zeroNetPremium | hasPremium
```

Phase 2.1 Dashboard filter matrix:

1. January 2026 Ambetter Coverall
2. January 2026 Ambetter Vix
3. March 2026 Ambetter Coverall
4. January 2026 Ambetter All

April 2026 is intentionally excluded from Phase 2.1 because no commission statements have arrived for that month yet.

## Scope Predicate Notes

The TypeScript helpers are authoritative. SQL below uses diagnostic approximations.

App scope semantics live in `src/lib/canonical/scope.ts`.

```text
Coverall:
  current_policy_aor belongs to Jason Fine, Erica Fine, or Becky Shuta.

Vix:
  current_policy_aor belongs to Erica Fine AND actual_pay_entity = 'Vix'.

All:
  Coverall scope OR actual_pay_entity = 'Vix'.
```

SQL-ish scope approximation for `reconciled_members`:

```sql
-- Replace :scope before use.
and (
  :scope = 'All'
  or (
    :scope = 'Coverall'
    and (
      current_policy_aor ilike '%Jason Fine%'
      or current_policy_aor ilike '%21055210%'
      or current_policy_aor ilike '%Erica Fine%'
      or current_policy_aor ilike '%21277051%'
      or current_policy_aor ilike '%Becky Shuta%'
      or current_policy_aor ilike '%16531877%'
    )
  )
  or (
    :scope = 'Vix'
    and (current_policy_aor ilike '%Erica Fine%' or current_policy_aor ilike '%21277051%')
    and actual_pay_entity = 'Vix'
  )
)
```

For `normalized_records` commission dollars, use `filterCommissionRowsByScope` in app-helper checks. SQL can approximate commission scope by `pay_entity`, but that is not equivalent for every enrollment-style metric.

## Active Normalized Records

### SQL-ish

```sql
select
  id,
  batch_id,
  source_type,
  source_file_label,
  carrier,
  member_key,
  applicant_name,
  policy_number,
  exchange_subscriber_id,
  issuer_subscriber_id,
  agent_name,
  agent_npn,
  pay_entity,
  current_policy_aor,
  effective_date,
  policy_term_date,
  status,
  premium,
  net_premium,
  commission_amount,
  raw_json,
  staging_status,
  superseded_at,
  created_at
from normalized_records
where staging_status = 'active'
  and superseded_at is null
  and batch_id in (:batch_ids)
  and (:source_type is null or source_type = :source_type)
order by batch_id, source_type, member_key, id;
```

### Supabase / JS shape

```ts
const { data, error } = await supabase
  .from('normalized_records')
  .select([
    'id', 'batch_id', 'source_type', 'source_file_label', 'carrier',
    'member_key', 'applicant_name', 'policy_number', 'exchange_subscriber_id',
    'issuer_subscriber_id', 'agent_name', 'agent_npn', 'pay_entity',
    'current_policy_aor', 'effective_date', 'policy_term_date', 'status',
    'premium', 'net_premium', 'commission_amount', 'raw_json',
    'staging_status', 'superseded_at', 'created_at',
  ].join(','))
  .eq('staging_status', 'active')
  .is('superseded_at', null)
  .in('batch_id', batchIds)
  .order('id', { ascending: true });
if (error) throw error;
const rows = data ?? [];
```

Transformations to document:

- Active predicate: `staging_status = 'active' and superseded_at is null`.
- Batch filter: use selected batch for Dashboard; use all active batches only when a surface explicitly does.
- Source-type filter: `EDE`, `BACK_OFFICE`, `COMMISSION`.
- Premium bucket is not applied to raw records directly. The canonical unpaid premium bucket uses reconciled row `net_premium` via `isZeroNetPremium`.

## Reconciled Members

### SQL-ish

```sql
select
  id,
  batch_id,
  member_key,
  carrier,
  applicant_name,
  policy_number,
  exchange_subscriber_id,
  issuer_subscriber_id,
  agent_name,
  agent_npn,
  current_policy_aor,
  expected_pay_entity,
  actual_pay_entity,
  in_ede,
  in_back_office,
  in_commission,
  eligible_for_commission,
  premium,
  net_premium,
  actual_commission,
  positive_commission,
  clawback_amount,
  estimated_missing_commission,
  issue_type,
  issue_notes,
  expected_ede_effective_month,
  ffm_app_ids,
  created_at
from reconciled_members
where batch_id = :batch_id
  -- apply scope predicate from the Scope Predicate Notes section
order by member_key;
```

### Supabase / JS shape

```ts
const { data, error } = await supabase
  .from('reconciled_members')
  .select('*')
  .eq('batch_id', batchId)
  .order('member_key', { ascending: true });
if (error) throw error;
const reconciled = data ?? [];

const inScope = filterReconciledByScope(reconciled, scope);
```

Transformations to document:

- `filterReconciledByScope` is authoritative for Dashboard/Agent Summary/Unpaid Recovery scope.
- Weak-match upgrades are represented by `confirmedUpgradeMemberKeys` and can move rows into effective BO-active status in app helpers.

## Active Cross-Batch Clearings

### SQL-ish

```sql
select
  id,
  policy_identity_key,
  target_service_month,
  clearing_state,
  expected_amount,
  threshold_amount,
  actual_positive_amount,
  actual_reversal_amount,
  actual_net_amount,
  remainder_owed,
  unpaid_batch_id,
  unpaid_batch_ids,
  payment_batch_ids,
  matched_paid_record_ids,
  clearing_statement_months,
  first_full_clear_statement_month,
  reversed_at_statement_month,
  manual_review_reason,
  evaluated_at,
  run_id,
  logic_version
from cross_batch_clearings
where staging_status = 'active'
  and superseded_at is null
order by policy_identity_key, target_service_month;
```

### Latest Evaluated At

```sql
select max(evaluated_at) as latest_evaluated_at
from cross_batch_clearings
where staging_status = 'active'
  and superseded_at is null;
```

### By Grain

```sql
select *
from cross_batch_clearings
where staging_status = 'active'
  and superseded_at is null
  and policy_identity_key = :policy_identity_key
  and target_service_month = :target_service_month;
```

### Supabase / JS shape

```ts
const { data, error } = await (supabase as any)
  .from('cross_batch_clearings')
  .select([
    'id', 'policy_identity_key', 'target_service_month', 'clearing_state',
    'expected_amount', 'actual_positive_amount', 'actual_reversal_amount',
    'actual_net_amount', 'remainder_owed', 'unpaid_batch_ids', 'payment_batch_ids',
    'reversed_at_statement_month', 'first_full_clear_statement_month',
    'evaluated_at', 'run_id', 'manual_review_reason',
  ].join(','))
  .eq('staging_status', 'active')
  .is('superseded_at', null)
  .order('id', { ascending: true });
if (error) throw error;
const overlay = buildClearingOverlayMap(data ?? []);
```

Transformations to document:

- Grain is `(policy_identity_key, target_service_month)`.
- Active overlay rows only.
- `evaluated_at` should be fresh relative to the last successful Rebuild Cross-Batch Clearings run.

## Dashboard Expected-Payment Cohorts

Use app helpers for the authoritative cohort math.

### Supabase / JS shape

```ts
const normalizedRecords = await getNormalizedRecords(batchId);
const reconciled = await getReconciledMembers(batchId);
const overlayRows = await loadActiveCrossBatchClearings();
const overlay = buildClearingOverlayMap(overlayRows);

const filteredEde = computeFilteredEde(
  normalizedRecords,
  reconciled,
  scope,
  coveredMonths,
  resolverIndex,
);

const confirmedUpgradeMemberKeys = deriveConfirmedUpgradeMemberKeys({
  filteredEde,
  normalizedRecords,
  weakOverrides,
  reconciled,
  statementMonth,
});

const breakdown = getExpectedPaymentBreakdown(
  reconciled,
  scope,
  filteredEde,
  confirmedUpgradeMemberKeys,
);

const dashboardPartition = partitionUnpaidRowsByOverlay(
  breakdown.unpaidRows,
  overlay,
);
```

### Expected Enrollments

```ts
const expectedEnrollments = filteredEde.uniqueKeys;
const expectedEnrollmentMemberKeys = new Set(
  filteredEde.uniqueMembers.map((m) => m.member_key),
);
```

Transformations:

- Uses `computeFilteredEde`.
- Scope and covered-month rules are EDE/enrollment rules, not plain row counts.

### Should Be Paid

```ts
const shouldBePaidRows = breakdown.universe.rows;
const shouldBePaidCount = breakdown.universe.total;
const shouldBePaidSplit = {
  matched: breakdown.universe.matchedCount,
  boOnly: breakdown.universe.boOnlyCount,
  edeOnly: breakdown.universe.edeOnlyCount,
};
```

Transformations:

- Broader expected-payment universe: Matched + BO Only + EDE Only.
- Effective BO-active can include confirmed weak-match upgrades.

### Expected Payments Received

```ts
const paidRows = breakdown.paidRows;
const paidCount = breakdown.paidCount;
const paidSplit = breakdown.paidSplit;
```

Transformations:

- Paid means expected-payment universe row with `in_commission = true`.

### Expected But Unpaid

```ts
const rawUnpaidRows = breakdown.unpaidRows;
const rawUnpaidCount = breakdown.unpaidCount;
const regular = dashboardPartition.regular;
const removed = dashboardPartition.removed;
const needsReview = dashboardPartition.needsReview;
const reversed = dashboardPartition.reversed;

const adjustedUnpaidCount = regular.length;
const adjustedUnpaidRows = regular.map((it) => it.row);
```

Transformations:

- `fully_cleared` and `zero_expected_no_payment_required` move to `removed`.
- `cleared_then_reversed` moves to `reversed`.
- `manual_review_required` stays in `regular` and also appears in `needsReview`.
- `partially_cleared` stays in `regular`, with effective dollars reduced to `remainder_owed` when available.

### Needs Review

```ts
const needsReviewRows = regular.filter(isReviewWorthyAdjustment);
const needsReviewCount = needsReviewRows.length;
```

Transformations:

- Needs Review means `manual_review_required` or `partial_amount_unavailable`.

### Cleared Then Reversed

```ts
const reversedRows = dashboardPartition.reversed;
const reversedCount = reversedRows.length;
const reversedAmount = sumEffectiveEstMissing(reversedRows);
```

Transformations:

- Reversed rows are excluded from default EBU and surfaced in the Dashboard reversed tile.

## Net Paid / Gross / Clawback Sums

### App-helper shape

```ts
const netPaid = getNetPaidCommission(normalizedRecords, scope);

const netPaidTotal = netPaid.net;
const gross = netPaid.gross;
const clawbacks = netPaid.clawbacks; // negative number
const nonZeroCommissionRowCount = netPaid.rowCount;
```

### SQL-ish diagnostic approximation

```sql
select
  sum(case when commission_amount > 0 then commission_amount else 0 end) as gross,
  sum(case when commission_amount < 0 then commission_amount else 0 end) as clawbacks,
  sum(coalesce(commission_amount, 0)) as net,
  count(*) filter (where coalesce(commission_amount, 0) <> 0) as non_zero_rows
from normalized_records
where staging_status = 'active'
  and superseded_at is null
  and batch_id = :batch_id
  and source_type = 'COMMISSION'
  -- For Vix, diagnostic filter can use pay_entity = 'Vix'.
  -- For Coverall/All, prefer app helper filterCommissionRowsByScope.
;
```

Transformations:

- App helper `filterCommissionRowsByScope` is authoritative.
- Gross includes positive commission rows only.
- Clawbacks are negative commission rows and remain negative internally; UI may render absolute value for display.

## Clearing Overlay Partitions

### App-helper shape

```ts
const partition = partitionUnpaidRowsByOverlay(unpaidRows, overlay);

const counts = {
  regular: partition.regular.length,
  removed: partition.removed.length,
  needsReview: partition.needsReview.length,
  reversed: partition.reversed.length,
};

const dollars = {
  regularEffectiveMissing: sumEffectiveEstMissing(partition.regular),
  reversedEffectiveMissing: sumEffectiveEstMissing(partition.reversed),
};
```

### Per-row audit shape

```ts
const perRow = unpaidRows.map((row) => {
  const grainKey = deriveGrainKeyForReconciledRow(row);
  const overlayRow = grainKey ? overlay.byGrain.get(grainKey) : undefined;
  const adjustment = classifyOverlay(overlayRow);
  return {
    member_key: row.member_key,
    policy_number: row.policy_number,
    issuer_subscriber_id: row.issuer_subscriber_id,
    expected_ede_effective_month: row.expected_ede_effective_month,
    grainKey,
    clearing_state: overlayRow?.clearing_state ?? null,
    adjustment_kind: adjustment.kind,
    legacy_est_missing: Number(row.estimated_missing_commission ?? 0),
    effective_est_missing:
      adjustment.kind === 'reduce_dollars'
        ? adjustment.remainder
        : Number(row.estimated_missing_commission ?? 0),
  };
});
```

Transformations:

- Grain derivation uses policy identity plus `expected_ede_effective_month`.
- Surfaces should consume `effectiveEstMissing`, not read `overlay.remainder_owed` directly.

## Premium Bucket Filter

Use app helper `isZeroNetPremium(row)` or `classifyUnpaidPremium(row)`.

Diagnostic equivalent:

```text
zeroNetPremium:
  row.net_premium is null, blank, non-numeric, zero, or negative

hasPremium:
  numeric row.net_premium > 0
```

## Dashboard Phase 2.1 Output Checklist

For each filter in the Phase 2.1 matrix, capture:

```text
normalized_records active count by source_type
reconciled_members count
active cross_batch_clearings latest evaluated_at
Expected Enrollments
Should Be Paid
Expected Payments Received
Expected But Unpaid raw and adjusted
Needs Review
Cleared then reversed
Net Paid Commission gross/clawbacks/net
Est. Missing Commission
Source Coverage EBU raw and adjusted
```
