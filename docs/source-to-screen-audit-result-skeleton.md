# Source-to-Screen Audit Result Skeleton

Copy this template into each Phase 2 result file. Replace placeholders before publishing the result.

Mutation policy: READ ONLY ONLY. Do not click Rebuild, Upload, Save, Submit, Delete, or any action that changes live data.

## Dashboard Phase 2.1 Filter Matrix

Use this locked matrix unless Jason changes it:

1. January 2026 Ambetter Coverall
2. January 2026 Ambetter Vix
3. March 2026 Ambetter Coverall
4. January 2026 Ambetter All

April 2026 is excluded from Phase 2.1 because no commission statements have arrived for that month yet. Auditing April would have little payment data to reconcile against.

## Result Template

```markdown
# Source-to-Screen Audit - <View> - <Date>

## Snapshot
- Repo HEAD:
- Origin/main HEAD:
- Live DB snapshot timestamp:
- App URL:
- Batch/month:
- Carrier:
- Scope:
- Premium bucket:
- Cross-batch clearing latest evaluated_at:
- Mutation policy: READ ONLY

## Verdict
- Status: CLEAN / FINDINGS / BLOCKED
- Highest severity:
- Summary:

## Aggregate Reconciliation
| Aggregate | UI Value | Helper Value | Source Query Value | Overlay Effect | Difference | Status |
|---|---:|---:|---:|---:|---:|---|
| Expected Enrollments |  |  |  | n/a |  |  |
| Should Be Paid |  |  |  | n/a |  |  |
| Expected Payments Received |  |  |  | n/a |  |  |
| Expected But Unpaid |  |  |  | regular/removed/reversed/review |  |  |
| Needs Review |  |  |  | review subset |  |  |
| Cleared then reversed |  |  |  | reversed partition |  |  |
| Net Paid Commission |  |  |  | n/a |  |  |
| Gross Commission |  |  |  | n/a |  |  |
| Clawbacks |  |  |  | n/a |  |  |
| Est. Missing Commission |  |  |  | effectiveEstMissing |  |  |
| Source Coverage EBU |  |  |  | regular/removed/reversed/review |  |  |

## Dashboard Phase 2.1 Cross-Surface Invariants
| Invariant | Expected | Observed | Status | Evidence |
|---|---|---|---|---|
| EBU count equals `partitionUnpaidRowsByOverlay(getExpectedPaymentBreakdown(...).unpaidRows).regular.length` |  |  |  |  |
| Est. Missing equals `sumEffectiveEstMissing(dashboard regular partition)` |  |  |  |  |
| Needs Review chip equals regular rows with `manual_review_required` or `partial_amount_unavailable` adjustment |  |  |  |  |
| Cleared then reversed tile equals reversed partition count and effective amount |  |  |  |  |
| Source Coverage EBU count equals overlay-adjusted Source Coverage expected-but-unpaid regular rows |  |  |  |  |
| Net Paid Commission equals scoped raw commission net, with gross/clawback split |  |  |  |  |

## Canary Traces
| Canary | Status | Layer | Field | Value | Expected | Path | Discrepancy | Classification |
|---|---|---|---|---|---|---|---|---|
|  | FOUND_IN_SCOPE / FOUND_OUT_OF_SCOPE / NOT_FOUND / EDGE_SHIFTED / NEW_EDGE_FOUND | raw file |  |  |  |  |  |  |
|  |  | normalized_records |  |  |  |  |  |  |
|  |  | reconciled_members |  |  |  |  |  |  |
|  |  | cross_batch_clearings |  |  |  |  |  |  |
|  |  | helper output |  |  |  |  |  |  |
|  |  | UI |  |  |  |  |  |  |
|  |  | export CSV |  |  |  |  |  |  |

## Findings
| ID | Severity | View | Field | Evidence | Recommendation | Owner |
|---|---|---|---|---|---|---|

## Artifacts
- Screenshots:
- CSV exports:
- Query output files:

## Follow-Ups
- Fix now:
- Defer:
- Expected/documented:
```

## Canary Status Codes

| Status | Meaning | Contingency Action |
|---|---|---|
| FOUND_IN_SCOPE | Canary exists under the active audit filters. | Trace normally. |
| FOUND_OUT_OF_SCOPE | Canary exists, but not under the current filter. | Trace separately, and pick an in-scope replacement if the aggregate needs one. |
| NOT_FOUND | No live row is found by name or known ID. | Ask Jason or replace with the same edge class. |
| EDGE_SHIFTED | Canary exists but no longer represents the original edge case. | Document as EXPECTED/resolved, then pick a replacement for the edge class if needed. |
| NEW_EDGE_FOUND | A new suspicious row appears during audit. | Add to the canary locator and audit now only if it affects the current aggregate or is CRITICAL/HIGH. |
| PENDING_LOOKUP | Starter status before live row lookup. | Locate or replace before relying on the canary in a result. |

## Evidence Cutoff Rules

### Aggregate minimum sufficient evidence

For each Dashboard aggregate, collect:

- UI value from screenshot, DOM text, or visible app evidence.
- Helper path, for example `getExpectedPaymentBreakdown`, `partitionUnpaidRowsByOverlay`, or `getNetPaidCommission`.
- Source query value and row count.
- Row-id list or deterministic cohort query.
- Cent-level reconciliation for dollar values.
- Overlay partition counts where relevant: `regular`, `removed`, `needsReview`, `reversed`.

### Canary minimum sufficient evidence

For each canary, collect:

- Raw/source-file evidence when available.
- Active `normalized_records` rows.
- `reconciled_members` row.
- Active `cross_batch_clearings` row when applicable.
- Helper output that explains the UI value.
- Relevant UI cells.
- Export row when the surface has an export.
- A blank `Discrepancy` when aligned, or a concise mismatch.

### Stop rule

Once the matrix is fully populated and no discrepancy remains, move to the next canary. Do not chase extra history unless it explains a discrepancy.

### Deeper-dive trigger

Any CRITICAL or HIGH finding stops normal rotation and triggers focused investigation until the likely failing layer is identified.

## Dashboard Phase 2.1 Artifact Folder

Use:

```text
codex-comm/artifacts/source-to-screen/phase-2-1-dashboard/
```

Suggested files:

```text
snapshot.json
dashboard-<filter>-screenshot.png
dashboard-<filter>-drilldown-<name>.csv
query-<filter>-aggregates.json
query-<filter>-canaries.json
```
