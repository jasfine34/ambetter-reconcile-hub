# Source-to-Screen Audit - Dashboard - 2026-05-17

## Snapshot
- Repo HEAD: `785016d46cb22ca6d47b9ad6b3cca49037ae76c7`
- Origin/main HEAD: `785016d46cb22ca6d47b9ad6b3cca49037ae76c7`
- Live DB snapshot timestamp: `2026-05-17T19:32:53.880Z`
- App URL: `https://ambetter-reconcile-hub.lovable.app/`
- Batches: January 2026 Ambetter `82d37413-231f-4ef2-a333-7d1f8e70221b`; March 2026 Ambetter `c275417a-7275-4b35-9027-d8d0049b89f4`
- Carrier: Ambetter
- Scopes audited: January Coverall, January Vix, March Coverall, January All
- Cross-batch clearing latest `evaluated_at`: `2026-05-17T14:11:35.132632+00:00`
- Active cross-batch clearing rows: `2241`
- Resolved identity rows read for helper replay: `5216`
- Mutation policy: READ ONLY

## Verdict
- Status: FINDINGS
- Highest severity: CRITICAL - wrong money
- Summary: Vix scope and raw commission dollars reconcile cleanly, but Coverall/All Dashboard expected-payment rollups do not reconcile to the current repo helper path plus live source rows. The largest visible money mismatch is Est. Missing Commission: `$7,389.44` visible for January Coverall/All vs `$7,361.03` from current HEAD helper replay, and `$8,202.69` visible for March Coverall vs `$8,176.52` from helper replay. Because this affects payable/missing-dollar reporting, pause follow-on source-to-screen phases until a targeted Dashboard cohort-delta diagnostic explains the row set difference.

## Helper Paths Audited
- Expected EDE source: `src/pages/DashboardPage.tsx:539`, `src/lib/expectedEde.ts:119`
- Expected payment universe and paid/unpaid split: `src/pages/DashboardPage.tsx:723`, `src/lib/canonical/metrics.ts:446`
- Net paid commission: `src/pages/DashboardPage.tsx:733`, `src/lib/canonical/metrics.ts:47`
- Source Coverage buckets: `src/pages/DashboardPage.tsx:757`, `src/lib/canonical/metrics.ts:581`
- Cross-batch overlay partition: `src/pages/DashboardPage.tsx:792`, `src/lib/canonical/crossBatchOverlay.ts:202`
- Adjusted EBU and Est. Missing values: `src/pages/DashboardPage.tsx:825`, `src/pages/DashboardPage.tsx:826`, `src/lib/canonical/crossBatchOverlay.ts:229`
- Dashboard tiles: `src/pages/DashboardPage.tsx:1430`, `src/pages/DashboardPage.tsx:1455`, `src/pages/DashboardPage.tsx:1612`, `src/pages/DashboardPage.tsx:1696`

## Aggregate Reconciliation

### January 2026 Ambetter Coverall

| Aggregate | UI Value | Helper / Source Query Value | Overlay Effect | Difference | Status |
|---|---:|---:|---|---:|---|
| Expected Enrollments | `1625` | `1623` | n/a | `+2` | FINDING |
| Should Be Paid | `1964` | `1962` | n/a | `+2` | FINDING |
| Expected Payments Received | `1304` | `1303` | n/a | `+1` | FINDING |
| Expected But Unpaid | `617` | `616` | raw `659`, removed `43`, review `43`, reversed `0` | `+1` | FINDING |
| Needs Review | `43` | `43` | review subset | `0` | CLEAN |
| Cleared then reversed | `0 / $0.00` | `0 / $0.00` | reversed partition | `0` | CLEAN |
| Net Paid Commission | `$38,242.00` | `$38,242.00` | n/a | `$0.00` | CLEAN |
| Gross Commission | `$38,654.00` | `$38,654.00` | n/a | `$0.00` | CLEAN |
| Clawbacks | `$-412.00` | `$-412.00` | n/a | `$0.00` | CLEAN |
| Est. Missing Commission | `$7,389.44` | `$7,361.03` | effective Est. Missing over regular partition | `+$28.41` | FINDING |
| Source Coverage EBU | `617` | `616` | raw `659`, removed `43`, review `43`, reversed `0` | `+1` | FINDING |

### January 2026 Ambetter Vix

| Aggregate | UI Value | Helper / Source Query Value | Overlay Effect | Difference | Status |
|---|---:|---:|---|---:|---|
| Expected Enrollments | `215` | `215` | n/a | `0` | CLEAN |
| Should Be Paid | `102` | `102` | n/a | `0` | CLEAN |
| Expected Payments Received | `101` | `101` | n/a | `0` | CLEAN |
| Expected But Unpaid | `1` | `1` | raw `1`, removed `0`, review `0`, reversed `0` | `0` | CLEAN |
| Needs Review | `0` | `0` | review subset | `0` | CLEAN |
| Cleared then reversed | `0 / $0.00` | `0 / $0.00` | reversed partition | `0` | CLEAN |
| Net Paid Commission | `$481.50` | `$481.50` | n/a | `$0.00` | CLEAN |
| Gross Commission | `$490.50` | `$490.50` | n/a | `$0.00` | CLEAN |
| Clawbacks | `$-9.00` | `$-9.00` | n/a | `$0.00` | CLEAN |
| Est. Missing Commission | `$3.20` | `$3.20` | effective Est. Missing over regular partition | `$0.00` | CLEAN |
| Source Coverage EBU | `1` | `1` | raw `1`, removed `0`, review `0`, reversed `0` | `0` | CLEAN |

### March 2026 Ambetter Coverall

| Aggregate | UI Value | Helper / Source Query Value | Overlay Effect | Difference | Status |
|---|---:|---:|---|---:|---|
| Expected Enrollments | `1723` | `1724` | n/a | `-1` | FINDING |
| Should Be Paid | `1892` | `1891` | n/a | `+1` | FINDING |
| Expected Payments Received | `1364` | `1361` | n/a | `+3` | FINDING |
| Expected But Unpaid | `527` | `529` | raw `530`, removed `1`, review `19`, reversed `0` | `-2` | FINDING |
| Needs Review | `19` | `19` | review subset | `0` | CLEAN |
| Cleared then reversed | `0 / $0.00` | `0 / $0.00` | reversed partition | `0` | CLEAN |
| Net Paid Commission | `$36,640.50` | `$36,640.50` | n/a | `$0.00` | CLEAN |
| Gross Commission | `$38,992.00` | `$38,992.00` | n/a | `$0.00` | CLEAN |
| Clawbacks | `$-2,351.50` | `$-2,351.50` | n/a | `$0.00` | CLEAN |
| Est. Missing Commission | `$8,202.69` | `$8,176.52` | effective Est. Missing over regular partition | `+$26.17` | FINDING |
| Source Coverage EBU | `527` | `529` | raw `530`, removed `1`, review `19`, reversed `0` | `-2` | FINDING |

### January 2026 Ambetter All

| Aggregate | UI Value | Helper / Source Query Value | Overlay Effect | Difference | Status |
|---|---:|---:|---|---:|---|
| Expected Enrollments | `1625` | `1623` | n/a | `+2` | FINDING |
| Should Be Paid | `1965` | `1963` | n/a | `+2` | FINDING |
| Expected Payments Received | `1304` | `1303` | n/a | `+1` | FINDING |
| Expected But Unpaid | `618` | `617` | raw `660`, removed `43`, review `43`, reversed `0` | `+1` | FINDING |
| Needs Review | `43` | `43` | review subset | `0` | CLEAN |
| Cleared then reversed | `0 / $0.00` | `0 / $0.00` | reversed partition | `0` | CLEAN |
| Net Paid Commission | `$38,723.50` | `$38,723.50` | n/a | `$0.00` | CLEAN |
| Gross Commission | `$39,144.50` | `$39,144.50` | n/a | `$0.00` | CLEAN |
| Clawbacks | `$-421.00` | `$-421.00` | n/a | `$0.00` | CLEAN |
| Est. Missing Commission | `$7,389.44` | `$7,361.03` | effective Est. Missing over regular partition | `+$28.41` | FINDING |
| Source Coverage EBU | `618` | `617` | raw `660`, removed `43`, review `43`, reversed `0` | `+1` | FINDING |

## Dashboard Phase 2.1 Cross-Surface Invariants

| Invariant | Expected | Observed | Status | Evidence |
|---|---|---|---|---|
| EBU count equals `partitionUnpaidRowsByOverlay(getExpectedPaymentBreakdown(...).unpaidRows).regular.length` | Helper regular partition | Vix matches; Coverall/All differs by 1-2 rows | FINDING | `dashboard-helper-results.json`; UI excerpts under each filter |
| Est. Missing equals `sumEffectiveEstMissing(dashboard regular partition)` | Helper effective sum | Vix matches; Coverall/All differs by `$26.17` to `$28.41` | FINDING | `query-*-aggregates.json`; UI excerpts |
| Needs Review chip equals regular rows with `manual_review_required` or `partial_amount_unavailable` adjustment | Helper review subset | Matches all filters | CLEAN | `needs_review` in helper JSON and UI text |
| Cleared then reversed tile equals reversed partition count and effective amount | Helper reversed partition | Matches all filters; there are no active `cleared_then_reversed` rows in live data | CLEAN / DATA GAP | `clearingStates.cleared_then_reversed` empty |
| Source Coverage EBU count equals overlay-adjusted Source Coverage expected-but-unpaid regular rows | Helper Source Coverage regular partition | Vix matches; Coverall/All differs by 1-2 rows | FINDING | Source Coverage UI excerpts and helper JSON |
| Net Paid Commission equals scoped raw commission net, with gross/clawback split | Helper `getNetPaidCommission` | Matches all filters exactly | CLEAN | UI excerpts and helper JSON |

## Canary Traces

| Canary | Status | Layer | Field | Value | Expected | Path | Discrepancy | Classification |
|---|---|---|---|---|---|---|---|---|
| Erica-owned Coverall row | FOUND_IN_SCOPE | normalized/commission sample | pay entity | Coverall commission rows with Erica NPN exist in January | Coverall scope includes Coverall-paid Erica writing evidence | `dashboard-helper-results.json` `canaries.ericaCommissionRows` | none at aggregate level | EXPECTED |
| Erica/Vix row | FOUND_IN_SCOPE | reconciled_members | `Anthony Ceasar`, `issub:u73040140`, `actual_pay_entity='Vix'` | Present in January Vix; Vix net/paid/unpaid metrics reconcile | Vix money stays in Vix scope; All includes it | `dashboard-helper-results.json` `canaries.Erica[2]` | none | EXPECTED |
| Manual-review clearing row | FOUND_IN_SCOPE | overlay partition | `Toronto Smith`, `issub:u72731324`, `manual_review_required` | Counted in regular EBU and Needs Review | Manual review remains unresolved but flagged | `query-jan-2026-ambetter-coverall-aggregates.json` | none | CLEAN |
| Fully cleared removed row | FOUND_IN_SCOPE | overlay partition | `Kevin Chestnut`, `issub:u96123350`, `fully_cleared` | Removed from regular EBU | Fully cleared rows should not inflate EBU | `query-mar-2026-ambetter-coverall-aggregates.json` | none | CLEAN |
| Cleared-then-reversed row | NOT_FOUND | cross_batch_clearings | active rows | `0` | Need a live row to trace tile positive case | `dashboard-helper-results.json` `canaries.clearingStates` | no live canary available | DATA GAP |
| Partial-cleared row | NOT_FOUND | cross_batch_clearings | active rows | `0` | Need a live row to prove remainder-dollar display | `dashboard-helper-results.json` `canaries.clearingStates` | no live canary available | DATA GAP |
| Zero-expected row | NOT_FOUND | cross_batch_clearings | active rows | `0` | Need a live row to prove removal from EBU/Source Coverage | `dashboard-helper-results.json` `canaries.clearingStates` | no live canary available | DATA GAP |

## Findings

| ID | Severity | View | Field | Evidence | Recommendation | Owner |
|---|---|---|---|---|---|---|
| DASH-P2.1-001 | CRITICAL - wrong money | Dashboard | Expected-payment rollups and Est. Missing | Coverall/All UI values do not reconcile to current HEAD helper replay over live rows. Jan Coverall Est. Missing UI `$7,389.44` vs helper `$7,361.03`; Mar Coverall UI `$8,202.69` vs helper `$8,176.52`. Vix and raw commission dollars match, narrowing the issue to EDE/payment-universe row membership rather than source loading or commission summing. | Pause Phase 2.2. Run a targeted Dashboard cohort-delta diagnostic that exports member-key lists from the live UI/helper path for `filteredEde.uniqueMembers`, `expectedPaymentBreakdown.universe`, `paidRows`, `unpaidRows`, and overlay partitions, then compare to current HEAD helper replay. Also verify the deployed Lovable build is using the same commit as origin/main. | Claude/Lovable, with Codex post-sync |
| DASH-P2.1-002 | MEDIUM - labeling / display drift | Dashboard | Reconciliation Validation block | Validation shows raw EBU (`660` Jan Coverall, `661` Jan All, `528` Mar Coverall) while the visible EBU card shows overlay-adjusted EBU (`617`, `618`, `527`). Variance is internally zero because the validation block is raw should-paid minus paid, but it sits next to adjusted Dashboard tiles. | If raw validation is intentional, relabel it as "Raw Expected But Unpaid (before clearings)" or add an adjusted EBU validation line. Do not silently mix raw and adjusted labels. | Claude/Lovable |
| DASH-P2.1-003 | LOW - data gap | Dashboard | Reversed/partial/zero expected canaries | Live active `cross_batch_clearings` currently has manual-review and fully-cleared examples, but no active `cleared_then_reversed`, `partially_cleared`, or `zero_expected_no_payment_required` examples for a positive canary trace. | Add fixture-backed tests or seed/live-locator canaries later; current Dashboard tile zero-state is clean but positive-state source-to-screen remains unproven by live data. | Codex/Claude |

## Artifacts
- Helper/source snapshot: `codex-comm/artifacts/source-to-screen/phase-2-1-dashboard/snapshot.json`
- Helper/source full results: `codex-comm/artifacts/source-to-screen/phase-2-1-dashboard/dashboard-helper-results.json`
- UI console/network errors: `codex-comm/artifacts/source-to-screen/phase-2-1-dashboard/ui-console-errors.json` (`0` captured app errors)
- Per-filter query outputs:
  - `codex-comm/artifacts/source-to-screen/phase-2-1-dashboard/jan-2026-ambetter-coverall/query-jan-2026-ambetter-coverall-aggregates.json`
  - `codex-comm/artifacts/source-to-screen/phase-2-1-dashboard/jan-2026-ambetter-vix/query-jan-2026-ambetter-vix-aggregates.json`
  - `codex-comm/artifacts/source-to-screen/phase-2-1-dashboard/mar-2026-ambetter-coverall/query-mar-2026-ambetter-coverall-aggregates.json`
  - `codex-comm/artifacts/source-to-screen/phase-2-1-dashboard/jan-2026-ambetter-all/query-jan-2026-ambetter-all-aggregates.json`
- Per-filter UI screenshots/text/html/excerpts saved in the matching filter folders.

## Follow-Ups
- Fix now: investigate DASH-P2.1-001 before advancing to Phase 2.2. The next diagnostic should produce row-key deltas, not just aggregate numbers.
- Defer: live positive canaries for cleared-then-reversed, partial-cleared, and zero-expected until such rows exist or fixture tests are created.
- Expected/documented: Vix Dashboard source-to-screen is clean in this phase. Raw net/gross/clawback commission math is clean across all four filters.
