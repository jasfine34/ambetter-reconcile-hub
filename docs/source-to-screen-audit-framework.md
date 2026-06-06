# Source-to-Screen Traceability Audit Framework

Created: 2026-05-17

Purpose: define a read-only audit that proves the app's visible numbers, row cells, badges, and exports are explainable from raw source files through `normalized_records`, `reconciled_members`, active `cross_batch_clearings`, and page/export logic. This framework is for audit design only; Phase 2 performs view-by-view traces.

## 0. Audit Standard - 100% Source Traceability

Our audit standard is **100% source traceability**.

For current, future, and prior audits, a CLEAN verdict means more than UI-helper parity. It means every material count, dollar, row, badge, status, and export value can be traced back to raw source data and justified through each transformation layer.

Future audits must validate:

```text
raw file row -> normalized_records -> reconciled_members / cross_batch_clearings when applicable -> helper/classifier decision -> UI/export
```

They must also validate **exclusions**: rows that should not count, such as stale BO, ineligible BO, wrong AOR, off-scope pay entity, no current source, or invalid FFM fallback, must be proven absent from the relevant outputs.

If an audit only proves helper-to-screen agreement, label it `HELPER_PARITY_ONLY`, not CLEAN.

For prior audits already marked CLEAN, review whether they included raw-source truth and negative-control coverage. If not, classify them as needing amendment or targeted re-run.

The existing Production-Loader Parity Contract remains required. Production-loader parity proves the audit is using the same app data path as the UI; source traceability proves that path is correct against raw evidence. Both are required for a CLEAN verdict.

## 0A. Audit Reclassification Labels

Use these labels when reviewing prior or partial audits against the 100% source traceability standard:

| Label | Definition | Action |
|---|---|---|
| `RAW_SOURCE_CLEAN` | Audit meets the new standard: raw-source truth was validated through every relevant transformation layer, and applicable negative-control strata were covered. | Leave CLEAN status intact; cite the evidence rows/trace artifacts. |
| `HELPER_PARITY_ONLY` | Audit was valid for helper-to-UI/export parity but did not prove raw-source truth or exclusions. | Preserve as useful evidence, but do not treat as final source-to-screen proof. Add targeted raw-source checks before relying on it for business closure. |
| `NEEDS_TARGETED_RERUN` | Specific negative-control strata or raw-source traces are missing. | Rerun only the missing strata or canaries; do not redo the whole audit unless the targeted rerun finds a broader defect. |
| `NEEDS_FULL_RERUN` | Audit is fundamentally inadequate against the new standard, or its loader/path diverged from production. | Redo the audit from the production-loader and raw-source layers. |

## 0B. Required Negative-Control Strata

For any audit of expected/unpaid/due/missing-commission surfaces, include these negative-control strata. A CLEAN verdict must prove that these rows are absent from outputs where they should not count.

1. **Stale/historical Back Office rows**
   - BO rows whose active-support dates (`policy_term_date`, `broker_term_date`, or future `broker_effective_date`) make them inactive for the selected month/range. Do not use `paid_through_date` as an active-BO disqualifier; it is a member-premium-payment signal.
   - Expected: do not create current-month due, unpaid, pending, MCE, EBU, or missing-commission rows unless another current source supports the month.

2. **BO ineligible rows**
   - `eligible_for_commission = No` / false.
   - Expected: do not enter expected-payment/due/unpaid cohorts as active commission-eligible BO evidence.

3. **No-current-source rows**
   - No current EDE, no canonically-active BO for the month, and no commission source for the month.
   - Expected: cannot render/export as `UNPAID` or `PENDING`; cannot contribute to `months_due` or equivalent counts.

4. **Wrong-AOR / transferred-AOR rows**
   - Raw source row exists, but current AOR is not one of the selected/official AORs for the scope.
   - Expected: excluded from due/unpaid/missing surfaces unless a pay-entity or override rule explicitly says otherwise.

5. **Coverall/Vix scope leakage rows**
   - Commission or enrollment evidence belongs to one pay entity but the user is viewing another.
   - Expected: no off-scope commission dollars or paid statuses leak into the selected scope.

6. **Blank FFM expected-vs-bug rows**
   - Expected blank: true BO-only / SBE / direct-write member with no EDE/SBE FFM source available.
   - Bug blank: EDE/SBE source has an FFM/application ID but the app failed to link or fall back to it.
   - Expected: audit must distinguish these two; a blank FFM is not automatically a bug, and a populated FFM is not enough to prove the row belongs in the current unpaid universe.

## 0C. Required Record-Level Trace Shape

For each named canary and each sampled aggregate row, include this trace. Do not issue a CLEAN verdict without enough evidence to explain the row from raw source to UI/export.

```text
Raw row evidence:
- source file name
- source type: EDE / BACK_OFFICE / COMMISSION / SBE if applicable
- statement/upload month
- source row number if available
- applicant/member name
- policy/subscriber/exchange/FFM ids
- AOR / broker / NPN / pay entity
- effective date, term date, paid-through date, eligible flag, status
- commission amount and paid-to/service month fields where relevant

normalized_records evidence:
- id, batch_id, source_type, staging_status, superseded_at
- member_key and all relevant IDs
- carrier, AOR, agent_npn, pay_entity
- effective/term/paid-through/eligible typed fields
- raw_json fields used by the helper

reconciled_members evidence, if used by the surface:
- reconciled_member_id, batch_id, member_key
- in_ede, in_back_office, in_commission
- eligible_for_commission
- is_in_expected_ede_universe / current_policy_aor
- estimated_missing_commission and issue fields

cross_batch_clearings evidence, if relevant:
- clearing row id, clearing_state
- threshold_amount, actual_net_amount, remainder_owed
- payment_batch_ids, clearing_statement_months

helper/classifier evidence:
- exact helper/classifier function used
- input row ids/member keys
- intermediate cohort decision: included/excluded and why
- active BO predicate result for the month
- scope/pay-entity predicate result
- cross-batch clearing overlay result if applicable

UI/export evidence:
- visible card/cell/table value
- row count or dollar value
- badges/source flags
- CSV/export columns and values
```

## 0D. Inaugural Failure Example - Member Timeline Stale BO

The 2026-05-18 Member Timeline stale-BO finding is the first canonical example of why this standard exists.

Phase 2.3 closed CLEAN on helper-to-UI parity, but the Member Timeline export later showed 525 of Becky Shuta's 550 rows with blank source columns paired with UNPAID/PENDING statuses. Named canaries included Aaron Stanley, Alexis Gibson, and Amanda Price. These were historical members present in the current 2026 Ambetter BO upload, but their `paid_through_date` or `policy_term_date` predates 2026 and no current EDE/commission source supported Jan-May 2026 due months.

Root cause: the Member Timeline classifier's per-cell BO-active check was looser than the canonical `isActiveBackOfficeRecord` predicate, and the classifier lacked a no-current-source guard. The UI/export accurately reflected helper output; the helper output admitted the wrong source universe.

Lesson: helper-to-UI parity is necessary but not sufficient. Audits must prove both inclusions and exclusions against raw-source truth.

## 0E. Retroactive Review Process

For each prior CLEAN verdict, including Phase 2.1 Dashboard, Phase 2.2 MCE, Phase 2.2 extension, Phase 2.3 Member Timeline, and Phase 2.4 cross-batch reconciliation:

1. Review whether the audit included raw-source truth validation.
2. Review whether the audit covered all negative-control strata applicable to that surface.
3. Apply one label: `RAW_SOURCE_CLEAN`, `HELPER_PARITY_ONLY`, `NEEDS_TARGETED_RERUN`, or `NEEDS_FULL_RERUN`.
4. Annotate the verdict file with the reclassification and reasoning.
5. Queue any `NEEDS_TARGETED_RERUN` or `NEEDS_FULL_RERUN` audits for execution.

Retroactive reclassification depends on the targeted stale-BO contamination check against each affected surface's actual row source. Do not reopen full audits automatically when a targeted stratum can answer the risk.

## 1. Scope - Views in Audit

Audit highest-stakes views first. A surface is high-stakes when its output is used as an operational truth, feeds a carrier/Messer follow-up, or rolls up many hidden transformations.

| Rank | View / Surface | Primary Data Sources | Key Visible Numbers | Key Visible Columns / Cells | Export Outputs | Code Evidence |
|---:|---|---|---|---|---|---|
| 1 | Dashboard | `normalizedRecords`, `reconciled`, `filteredEde`, weak-match overrides, active `cross_batch_clearings` overlay | Expected Enrollments, Should Be Paid, Expected Payments Received, Expected But Unpaid, Needs Review, Cleared then reversed, Net Paid Commission, Clawbacks, Est. Missing Commission, Source Coverage tiles | Source Funnel boxes, metric-card split chips, EBU needs-review chip, reversed tile, Reconciliation Validation, drilldowns | Drilldown `DataTable` exports; unpaid validation sample; clawback CSV; EDE raw/debug exports | `src/pages/DashboardPage.tsx:698-838`, `src/pages/DashboardPage.tsx:1400-1476`, `src/pages/DashboardPage.tsx:1518-1620`, `src/pages/DashboardPage.tsx:1696-1757`, `src/components/DataTable.tsx:22-82` |
| 2 | Missing Commission Export (MCE) | All-batch MT projection/cache, MT-approved MCE selector, selected-batch records for enrichment/fallbacks, cross-batch overlay, commission triple fallback, profile/dollar resolver evidence. | Report row count, source-load status, premium bucket count, clearing preview state, needs-review badge | FFM ID first visible column, Messer columns, internal columns, clearing chip, phone/email/profile provenance badges | Messer CSV with locked `MESSER_COLUMNS`; preview-only internal columns not exported | `src/pages/MissingCommissionExportPage.tsx:111-138`, `src/pages/MissingCommissionExportPage.tsx:687-972`, `src/pages/MissingCommissionExportPage.tsx:1240-1338`, `src/pages/MissingCommissionExportPage.tsx:442-456` |
| 3 | Member Timeline | All active normalized records across batches, pay-entity scope, due-eligibility classifier, Class-A FFM fallback index | Total members in filtered rows, months due/paid/unpaid, total paid, timeline cell status | Member, policy/subscriber ID display, current AOR, multi-FFM badge/tooltip, month cells with E/B/C presence, paid amount | Timeline CSV via `buildMemberTimelineExportRows` and `exportToCSV` | `src/pages/MemberTimelinePage.tsx:313-417`, `src/pages/MemberTimelinePage.tsx:506-508`, `src/pages/MemberTimelinePage.tsx:840-886`, `src/lib/memberTimeline.ts:182-316`, `src/lib/memberTimeline.ts:324-347` |
| 4 | Agent Summary | `reconciled`, `normalizedRecords`, `filteredEde`, active clearing overlay, pay-entity scope | Per-agent Expected (AOR), Written by, BO, Eligible, Paid, Unpaid, Needs Review, Total Commission, Est. Missing; Other AOR aggregate | Agent row values and attribution notes | `agent_summary.csv` through `DataTable` filtered export | `src/pages/AgentSummaryPage.tsx:113-245`, `src/pages/AgentSummaryPage.tsx:304-364` |
| 5 | Unpaid Recovery | `getExpectedPaymentBreakdown(...).unpaidRows`, `normalizedRecords`, active clearing overlay, URL filters | Row count after overlay/filter, reversed filter, per-row estimated missing commission | FFM ID, member, policy, source type, premium bucket, clearing chip, needs-review marker | Unpaid Recovery CSV excluding UI-only Clearing column | `src/pages/UnpaidRecoveryPage.tsx:87-155`, `src/pages/UnpaidRecoveryPage.tsx:191-253`, `src/pages/UnpaidRecoveryPage.tsx:412-474`, `src/pages/UnpaidRecoveryPage.tsx:561-619` |
| 6 | Exception Queue / Drilldowns | `reconciled`, `issue_type`, `issue_notes`, Dashboard drilldown row sets | Exception counts by issue type; drilldown row counts | Issue Type, Notes, Dashboard drilldown columns | `exception_queue.csv`; Dashboard `DataTable` drilldown exports | `src/pages/ExceptionsPage.tsx:25-60`, `src/pages/DashboardPage.tsx:1054-1097`, `src/pages/DashboardPage.tsx:1680-1690` |
| 7 | All Records | Server-paginated `reconciled_members`; resolved identity badges | Total records, filtered total, page count | Reconciled member columns, resolved badge, clickable row to Member Timeline | `all_reconciled_records.csv` from full filtered server-side export | `src/pages/AllRecordsPage.tsx:209-232`, `src/pages/AllRecordsPage.tsx:262-345`, `src/lib/persistence.ts:938-968` |
| 8 | Upload/Rebuild Status Surfaces | `upload_batches`, `uploaded_files`, `normalized_records`, `reconciled_members`, rebuild stamps | Stale-logic warnings, partial-rebuild warnings, counts | Status messages and rebuild buttons | None | `src/pages/DashboardPage.tsx:1140-1237`, `src/contexts/BatchContext.tsx:43-49`, `src/contexts/BatchContext.tsx:161-186` |

Shared computation anchors:

- Expected-payment universe and paid/unpaid split: `src/lib/canonical/metrics.ts:330-386` and `src/lib/canonical/metrics.ts:446-486`.
- Premium bucket rule: `src/lib/canonical/metrics.ts:428-438`.
- Source Coverage buckets: `src/lib/canonical/metrics.ts:581-751`.
- Net paid commission: `src/lib/canonical/metrics.ts:47-63`.
- Reconciled member construction: `src/lib/reconcile.ts:839-996`.
- Cross-batch overlay mapping and partitioning: `src/lib/canonical/crossBatchOverlay.ts:80-107`, `src/lib/canonical/crossBatchOverlay.ts:142-162`, `src/lib/canonical/crossBatchOverlay.ts:202-233`.
- Active overlay load: `src/hooks/useCrossBatchOverlay.ts:17-23`, `src/hooks/useCrossBatchOverlay.ts:48-81`.

Mutation policy for all phases: this audit is read-only. Do not click Rebuild, Upload, Save, Submit, Delete, or any live action that changes data unless Jason explicitly approves that action in the request file. Audit queries may read live data and local raw files. Lovable must not change source code during framework design; corrective patches require a separate Jason-approved directive.

## 1A. Production-Loader Parity Contract

Replay and collector scripts are not allowed to become a second implementation of a page's data layer. Every source-to-screen collector MUST load runtime data through the same production helpers or hooks used by the surface under audit before calling canonical helper logic. For Dashboard, that means using `getBatches`, `getNormalizedRecords`, `getReconciledMembers`, `loadResolverIndex`, and `loadWeakMatchOverrides` for the same inputs Dashboard uses. For another page, the collector must name that page's production loaders before it computes counts, row keys, or dollars.

Manual REST queries, hand-rolled keyset loops, direct `supabase.from(...)` calls, and parallel pagination paths are PROHIBITED inside replay collectors unless all of the following are true:

- No production loader exists for that exact runtime input, such as a React hook that cannot be called from a Node collector.
- The collector documents an inline `AUDIT_DIRECT_DB_PARITY_EXCEPTION` comment naming the production file and lines it mirrors.
- The direct query uses the same projection, predicates, ordering, paging semantics, and fallback behavior as the production path.
- The verdict reports a parity check against a current-source UI capture or a replay using production loaders.

Each collector that computes helper outputs must include an `AUDIT_LOADER_CONTRACT` header naming the production loaders it uses. If a collector cannot include that header, it is not eligible to certify source-to-screen values.

Why this is a hard rule: Phase 2.1 initially reported false Dashboard Est. Missing deltas for January and March 2026 Coverall (`+$28.41` and `+$26.17`). The Dashboard was correct. The standalone collector had manually loaded `reconciled_members` with a different ordering than the UI loader, then fed those rows into `computeFilteredEde`. That helper has first-wins candidate registration for BO lookup, so a small ordering difference changed the derived row sets and created a false money finding. Audit code must therefore reuse the page's data loaders; matching the pure helper calls alone is not enough.

## 2. Canaries - Named Members and Edge Cases

Phase 2 should maintain a canary registry with these columns: canary id, person/policy label, month/batch, scope, expected edge case, raw-file locator, normalized ids, reconciled member id, clearing grain key, views to inspect, status.

Initial canary set:

| Canary | Why It Matters | Required Trace Coverage |
|---|---|---|
| Diedric Mccullough | Class-A FFM fallback example where BO `issub:*` and EDE `sub:*` split historically hid `ffmAppId`; current tests cover this pattern. | MCE visible FFM, MCE export, Member Timeline tooltip/export, normalized EDE fallback source, absence/presence in current scope. |
| Lisa Taylor | Georgia SBE valid application id `9690062026`; proves 10-digit app ids need not start with `7`. | Raw/normalized SBE evidence, MCE FFM display, export, classification as expected not OTHER. |
| Frederick Williams | Georgia SBE valid application id `2457662026`; same leading-digit rule correction. | Same as Lisa. |
| Patty Lott | Bundle 13d override-rate smoke canary. Significance must be re-established from live rows before Phase 2 assertion. | Expected commission override, clearing state, MCE/UR/Agent Summary effect. |
| Alicia Diaby | Bundle 13d override-rate smoke canary. Significance must be re-established from live rows before Phase 2 assertion. | Same as Patty. |
| Alicia Lopez | Bundle 13d override-rate smoke canary. Significance must be re-established from live rows before Phase 2 assertion. | Same as Patty. |
| Erica-owned Coverall row | Erica AOR paid by Coverall can be expected overage/override behavior, not a Messer master-table miss. | `current_policy_aor`, expected pay entity, override amount, MCE inclusion/exclusion by scope, Agent Summary EF bucket. |
| Erica/Vix row | Vix is pay entity; ownership remains AOR. Vix row must not leak into Coverall money unless scope semantics say so. | Dashboard Vix scope, Agent Summary Total Commission, Member Timeline paid amount, MCE Writing Agent Carrier ID. |
| Cleared-then-reversed row | Cross-batch terminal state must not be treated as fully cleared or normal unpaid. | Dashboard reversed tile, MCE exclusion from missingMembers, UR reversed filter, Agent Summary exclusion, clearing row evidence. |
| Manual-review clearing row | Row remains unresolved but must be visibly flagged. | Dashboard needs-review chip, MCE needs-review badge, UR needs-review marker, Agent Summary needs-review column. |
| Partial-cleared row | Remaining dollars should display as the remainder, not original estimate. | Dashboard Est. Missing, UR row dollars/export, Agent Summary est missing, clearing `remainder_owed`. |
| Zero-expected row | No payment required; should be removed from unpaid counts and exports. | Dashboard EBU, Source Coverage EBU, MCE, UR, clearing expected amount = 0. |
| True BO-only member | Expected blank FFM is correct when no EDE row exists. | MCE blank FFM, UR blank FFM, raw BO row, no EDE normalized row. |
| Multi-FFM member | Validates #76 picker order and joined export behavior. | Member Timeline multi-FFM badge/tooltip, export `ffm_app_id` join, MCE single profile pick if applicable. |
| State-normalization canary (Erica Flowers pattern) | Prior state mismatch caused manual-review clearing inflation. | Raw EDE state fields, normalized `client_state_full`, clearing state, comp-grid state resolution. |
| SBA direct-write Georgia member | Georgia rows may have valid SBE app IDs or no EDE row; both can be expected depending on write path. | Raw BO/SBE evidence, EDE availability, FFM display/export classification. |

Canary removal rule: do not remove a canary because the bug is fixed. Reclassify it as EXPECTED or REGRESSION-GUARD unless the underlying feature no longer exists.

For each canary, Phase 2 must produce a full trace:

- Raw EDE / BO / commission row(s): source filename, source row number if available, source type, statement month, key fields, and raw ID fields.
- `normalized_records`: id, batch_id, source_type, source_file_label, staging_status, superseded_at, member_key, IDs, AOR, state, premium, `raw_json.ffmAppId`, commission amount/pay entity.
- `reconciled_members`: id, member_key, expected/paid/unpaid booleans, policy IDs, AOR, premium bucket inputs, estimated missing commission, issue type, expected pay entity.
- `cross_batch_clearings`: grain key, clearing state, expected amount, actual positive/reversal/net amounts, remainder, matched paid record ids, payment batch ids, evaluated_at.
- UI outputs: every relevant displayed cell on Dashboard/MCE/Member Timeline/Agent Summary/UR.
- Export outputs: every exported column on the row.

## 3. Evidence Table Template

Use one evidence workbook/document per view audit and one matrix per canary. A per-canary matrix is better than one giant per-view table because it keeps identity, money, and UI disagreements visible in one place.

Required columns:

| Column | Meaning |
|---|---|
| Audit ID | Stable id such as `dashboard-dollars-jan-coverall-001`. |
| View | Dashboard, MCE, Member Timeline, Agent Summary, UR, Exceptions, All Records. |
| Canary / Aggregate | Named canary or aggregate cohort. |
| Scope / Filters | Batch, carrier, pay entity scope, premium bucket, date range, URL params. |
| Layer | Raw file, `normalized_records`, `reconciled_members`, `cross_batch_clearings`, helper output, UI, export. |
| Source | Specific file, table, helper, component, DOM selector, or CSV. |
| Field | Column/cell/metric being traced. |
| Value | Actual observed value. |
| Transform Applied | e.g. scope filter, weak-match upgrade, Class-A FFM fallback, clearing overlay partition, premium bucket, dedupe. |
| Expected Value | The value downstream should show after transform. |
| Path | File:line, DB table:column, raw file row, UI selector, or CSV header. |
| Discrepancy | Blank if aligned; otherwise concise mismatch. |
| Classification | CRITICAL/HIGH/MEDIUM/LOW/EXPECTED. |
| Follow-up | Test, doc, patch, monitor, or none. |

Aggregate evidence tables should use the same columns but replace canary fields with cohort identifiers. Example: `Dashboard EBU Jan 2026 Ambetter Coverall Zero Net Premium`.

Rules:

- Every displayed count must have a cohort query and row-id list.
- Every displayed dollar total must have a cent-level source sum and transformation ledger.
- Every export must be compared to the same row set as the visible table unless the page intentionally has a locked external schema.
- MCE has two schemas by design: visible preview includes FFM/internal/clearing columns, but downloaded Messer CSV only includes `MESSER_COLUMNS` at `src/pages/MissingCommissionExportPage.tsx:111-124` and `src/pages/MissingCommissionExportPage.tsx:442-456`.
- `DataTable` exports filtered client rows at `src/components/DataTable.tsx:29-47` and `src/components/DataTable.tsx:74-77`; audit must account for active search/chip/sort state before comparing exported row counts.

## 4. Dollar-Reconciliation Contract Per View

All dollar audits reconcile to the cent. Each chain must name every transform that changes membership or dollars.

### Dashboard

Canonical count chain:

```
raw normalized records for selected batch/scope
  -> computeFilteredEde(...)
  -> getExpectedPaymentBreakdown(reconciled, scope, filteredEde, confirmedUpgradeMemberKeys)
  -> partitionUnpaidRowsByOverlay(...)
  -> Dashboard metric fields
  -> Dashboard drilldown DataTable export
```

Evidence:

- Dashboard computes expected payment breakdown at `src/pages/DashboardPage.tsx:722-731`.
- It computes net paid and missing dollars at `src/pages/DashboardPage.tsx:733-746`.
- It applies clearing overlay partition at `src/pages/DashboardPage.tsx:792-836`.
- EBU and Est. Missing visible values are `metrics.adjustedUnpaid` and `metrics.adjustedEstMissing` at `src/pages/DashboardPage.tsx:1428-1452` and `src/pages/DashboardPage.tsx:1611-1612`.

Dollar identities:

- Net Paid Commission = sum of in-scope commission `commission_amount`, split into gross positive and negative clawbacks by `getNetPaidCommission` (`src/lib/canonical/metrics.ts:47-63`).
- Est. Missing Commission = sum of `effectiveEstMissing` after overlay (`src/lib/canonical/crossBatchOverlay.ts:202-233`), not the legacy raw `getExpectedMissingCommissionSum` when overlay is available.
- Cleared-then-reversed amount = sum of effective dollars in reversed partition, surfaced in Dashboard tile (`src/pages/DashboardPage.tsx:1455-1476`).

### MCE

Canonical row chain:

```
reconciled_members snapshot
  -> computeFilteredEde + weak-match upgrades
  -> getExpectedPaymentBreakdown(...).unpaidRows
  -> partitionUnpaidRowsByOverlay
  -> missingMembers = partition.regular
  -> profile enrichment + FFM fallback + writing-agent-id fallback
  -> premium bucket filter
  -> visible preview rows
  -> Messer CSV columns only
```

Evidence:

- MCE uses `getExpectedPaymentBreakdown` at `src/pages/MissingCommissionExportPage.tsx:716-718`.
- It awaits/uses overlay and sets `missingMembers = partition.regular` at `src/pages/MissingCommissionExportPage.tsx:720-751`.
- It loads cross-batch source records at `src/pages/MissingCommissionExportPage.tsx:762-807`.
- It builds Class-A FFM fallback and member profile at `src/pages/MissingCommissionExportPage.tsx:841-862`.
- It computes row dollars and clearing metadata at `src/pages/MissingCommissionExportPage.tsx:910-970`.

Dollar identity:

- Visible internal estimated missing commission = row legacy/default estimate, except `partially_cleared` uses `effectiveEstMissing`.
- Downloaded Messer CSV has no clearing or internal dollar columns unless Jason explicitly changes the external contract.

### Member Timeline

Canonical chain:

```
all active normalized_records across selected months/scope
  -> member_key grouping
  -> due eligibility predicate
  -> month cell E/B/C presence and commission allocation
  -> row totals/month counts
  -> visible table
  -> buildMemberTimelineExportRows CSV
```

Evidence:

- Grouping and Class-A fallback index live at `src/lib/memberTimeline.ts:182-229`.
- EDE/BO/commission month-cell logic lives at `src/lib/memberTimeline.ts:237-295`.
- Totals live at `src/lib/memberTimeline.ts:297-316`.
- Export rows put `ffm_app_id` first at `src/lib/memberTimeline.ts:324-347`.
- Page exports those rows at `src/pages/MemberTimelinePage.tsx:506-508`.

Dollar identity:

- `total_paid` = sum of month-cell `paid_amount` across selected months for the row.
- Scope predicate must be the same one used for due rows and commission rows; commission rows outside scope must not inflate `total_paid`.

### Agent Summary

Canonical chain:

```
normalized commission rows
  -> filterCommissionRowsByScope(scope)
  -> per-agent commission totals

reconciled_members + filteredEde
  -> getExpectedPaymentBreakdown(...).unpaidRows
  -> partitionUnpaidRowsByOverlay
  -> group regular adjusted rows by current_policy_aor owner bucket
  -> per-agent table + Other AOR aggregate
  -> DataTable export
```

Evidence:

- Commission totals use `filterCommissionRowsByScope` at `src/pages/AgentSummaryPage.tsx:113-126`.
- Canonical unpaid rows use `getExpectedPaymentBreakdown(...).unpaidRows` at `src/pages/AgentSummaryPage.tsx:156-164`.
- Overlay-adjusted owner grouping is at `src/pages/AgentSummaryPage.tsx:175-197`.
- Per-agent values are built at `src/pages/AgentSummaryPage.tsx:206-245`.
- DataTable export is at `src/pages/AgentSummaryPage.tsx:363`.

Dollar identity:

- `total_paid_commission` per agent = sum of scoped normalized commission rows by writing-agent NPN.
- `estimated_missing_commission` per owner bucket = sum of overlay-adjusted `effectiveEstMissing` for canonical unpaid rows grouped by current AOR ownership, not writing-agent NPN.

### Unpaid Recovery

Canonical chain:

```
canonical unpaid rows
  -> partitionUnpaidRowsByOverlay
  -> regular rows by default (+ reversed only with URL filter)
  -> page filters: owner/source/premium/search
  -> visible table
  -> buildUnpaidRecoveryCsv(filteredRows)
```

Evidence:

- Overlay partition and reversed toggle live at `src/pages/UnpaidRecoveryPage.tsx:412-445`.
- Visible/export row set is `filteredRows` at `src/pages/UnpaidRecoveryPage.tsx:450-453`.
- CSV uses the same `filteredRows` at `src/pages/UnpaidRecoveryPage.tsx:466-474`.
- CSV excludes UI-only Clearing at `src/pages/UnpaidRecoveryPage.tsx:233-253`.

Dollar identity:

- Row Est. Missing = `r.estimated_missing_commission` unless overlay is `reduce_dollars`, then use `effectiveEstMissing`.
- Default row set excludes fully cleared, zero expected, and cleared-then-reversed; reversed rows appear only when the reversed filter is active.

### Exceptions and All Records

Exceptions:

- `exceptions = reconciled.filter(r => r.issue_type !== 'Fully Matched')` at `src/pages/ExceptionsPage.tsx:25-30`.
- Export is `exception_queue.csv` through `DataTable` at `src/pages/ExceptionsPage.tsx:54-60`.

All Records:

- Server-side rows are paged by `getReconciledMembersPage`; export loops through every filtered server page at `src/pages/AllRecordsPage.tsx:209-232`.
- Audit should compare visible first page, total count, search/sort, and full export count to the same server-side query.

## 5. Audit Findings Classification

| Classification | Definition | Action |
|---|---|---|
| CRITICAL - wrong money | Displayed or exported dollar figure cannot reconcile to raw/normalized/reconciled/clearing source within one cent, or a payment is counted under the wrong pay entity. | Stop bundle work. Fix before continuing audit. Add regression test. |
| HIGH - wrong count or category | Member appears in wrong payable/unpaid/source/premium/clearing bucket, or a row is missing from a required operational view/export. | Fix before next feature bundle. Add regression test. |
| MEDIUM - labeling / display drift | Data layer is correct but UI/export labels or cells mislead operators, such as FFM/member-id confusion. | Patch opportunistically unless it affects current workflow. Add UI/export test if user-facing. |
| LOW - documentation gap | Behavior is correct but not codified in docs, tests, or comments. | Document and consider test if likely to regress. |
| EXPECTED | Apparent discrepancy is by design, such as Georgia SBE direct-write rows with valid non-`7` application ids or true BO-only blank FFM. | Codify as expected case in audit notes and, when stable, fixture/comment. |

Escalation rule: if a finding affects money and category, classify by money. If it affects export and UI, classify by the stricter consumer. If the source file itself is ambiguous, classify as Data gap until proven.

## 6. Per-View Audit Phase Sequencing

Recommended Phase 2 order:

| Order | View | Why Now | Estimated Audit Time | Canaries / Aggregates | Dollar Queries Needed |
|---:|---|---|---:|---:|---|
| 1 | Dashboard | Highest rollup stakes; catches wrong global numbers before auditing row-level details. | 4-6 hours | 8-12 aggregate cohorts + 6 canaries | Net paid, clawbacks, EBU, Est. Missing, Source Coverage EBU, reversed amount |
| 2 | MCE | External carrier/Messer workflow; recent FFM and timeout fixes make it high-risk/high-value. | 4-6 hours | 15-25 rows including all FFM canaries | MissingMembers after overlay, premium bucket counts, effective row dollars |
| 3 | Member Timeline | Cross-batch visual truth for operators; validates FFM fallback and month-cell logic. | 4-5 hours | 10-15 members across months | Total paid by month cells vs normalized commission rows |
| 4 | Unpaid Recovery | Row-level recovery workbench; shares MCE/Agent Summary row semantics but has its own filters/export. | 3-5 hours | 10-15 unpaid/reversed/partial rows | Effective Est. Missing export sums |
| 5 | Agent Summary | Important but smaller table; depends on same canonical EBU/overlay chain already tested. | 2-4 hours | 3 agents + Other aggregate + Erica/Vix canaries | Per-agent commission and est missing |
| 6 | Exception Queue / Dashboard drilldowns | Lower direct money risk but catches categorization drift. | 2-3 hours | Issue-type samples | Usually no dollar chains except drilldown totals |
| 7 | All Records | Read-through view; verify it does not lie under search/sort/export. | 1-2 hours | 3-5 search/sort cases | None unless spot-checking fields |

Do not audit all views in one pass. Each view gets its own result file and a Jason/Claude/Codex review loop.

## 7. Pause / Resume Rules During Audit

Pause while Phase 2 is active:

- Bundle 13e estimated-missing replacement.
- Bundle 14 manual override.
- Multi-carrier expansion.
- Identity-resolution Red item / member-key merge Option 1.
- Non-urgent UI polish, broad refactors, and new report features.

Allowed during audit:

- Tiny test-only patches that do not change runtime behavior, such as CRLF/static-test fixes.
- Read-only live diagnostics.
- Audit-driven corrective patches approved by Jason.
- Emergency fixes for broken operator workflow.

Pause/resume workflow:

1. Start a view audit from a clean synced repo and current live DB snapshot.
2. If CRITICAL/HIGH is found, freeze the current audit evidence and write a concise fix directive.
3. Ship and post-sync the fix.
4. Re-run only the impacted evidence rows plus the upstream aggregate for that view.
5. Resume from the next unfinished evidence table.
6. Do not advance queued bundles until all CRITICAL/HIGH findings in the current view are resolved or explicitly deferred by Jason.

## 8. Codify Findings as Test Fixtures

Test naming convention:

`src/test/audit-<view>-<canary-or-aspect>.test.ts` or `.test.tsx` when rendering React is required.

What becomes a test:

- Every CRITICAL finding.
- Every HIGH finding.
- Every MEDIUM finding that is user-visible, export-visible, or likely to regress.
- Every EXPECTED case that has already caused confusion or could be "fixed" incorrectly later.
- Any cross-surface invariant used in the evidence table, such as MCE row count matching UR filtered count under identical filters.

What can remain documentation-only:

- Data anomalies unique to a raw file that the app correctly displays.
- One-off live DB snapshot notes that cannot be represented without brittle real data.
- Open business decisions not yet resolved by Jason.

Fixture rules:

- Prefer pure helper tests for money/category predicates (`metrics`, `crossBatchOverlay`, `memberTimeline`, `aorPicker`, MCE row builders).
- Use page tests only when the bug is DOM/export behavior.
- Include source-to-screen language in test names, e.g. `audit-mce-diedric-class-a-ffm-fallback.test.tsx`.
- Avoid live DB dependencies in committed tests. Convert live evidence to minimal fixtures.
- Include at least one negative assertion per former bug, e.g. FFM display must not equal `issuer_subscriber_id` when a real `ffmAppId` exists.

## 9. Phase 3 Deliverable Spec

Phase 3 is complete when:

- Every CRITICAL/HIGH finding has a regression test committed or a Jason-approved deferral with written risk.
- Every MEDIUM finding has either a test or a documented justification.
- Every EXPECTED case has an audit note and, if it is a known confusion point, a comment-anchored documentation reference.
- Every new fixture identifies the original audit id and canary/aspect.
- The test suite passes.
- The corresponding post-sync audit confirms no unrelated production files changed.

Phase 3 outputs:

- `docs/source-to-screen-audit-findings-<view>.md` for each audited view.
- Test files named by the convention above.
- A summary table of fixed, deferred, expected, and documentation-only findings.
- A short prompt for Claude/Lovable if code changes are needed.

Phase 3 should not expand business rules. If an audit exposes a missing product decision, stop and ask Jason before converting it into code.
