# Member Timeline Screen Contract — v1

## Purpose

This document locks the contract for what an operator sees on the Member Timeline page. For each visible surface — cell color, cell label, source chip, badge, filter button, summary number — the contract specifies:

- The exact visible form
- What it means in operator terms
- Which code produces it
- Which other surfaces it must remain consistent with
- Which tests currently pin it (state-behavior or visual-rendering, distinguished)
- Which tests are still required to detect drift

**v1 scope:** normal table display surfaces + critical tooltip evidence blocks (CR explanation, reversal evidence). Full tooltip line-by-line content is OUT of v1 scope and deferred to a future amendment.

If a code change makes the visible output disagree with this contract, either the code is wrong OR the contract needs an authorized amendment — never both silently.

## Three-layer architecture

Visible state flows through three layers, each with distinct responsibility:

1. **Assembly layer** (`src/lib/memberTimeline.ts`). Builds the base per-member timeline. Stamps `MonthCell` source flags (`in_ede`, `in_back_office`, `in_commission`), `carrier_recognition`, `carrier_recognition_premium`, row identity fields, and initial row totals. Uses canonical helpers including `isEDEQualified`, `isActiveBackOfficeRecord`, and `pickEdeForServiceMonth` to produce the source flags.
2. **Classifier layer** (`src/lib/classifier.ts`). Emits the 9 typed `ClassificationState` values via `classifyCell`, AND populates structured `reversal_evidence` for R-PAY-012 via Rule 1b / `hasReversalPairForMonth`. Provides parallel classification/trace helpers (`hasEdeForMonth`, `hasActiveBoForMonth`, `hasCommissionForMonth`, `paidForMonth`, etc.) used during classification and surfaced in `explainCell` trace output. These classifier helpers are NOT the canonical producers of the visible source chips — those come from the assembly layer's `MonthCell` stamping. The two run in parallel and should agree.
3. **Display layer** (`src/pages/MemberTimelinePage.tsx`). Merges classifier output (`state`, `state_reason`, `reversal_evidence`) into the displayed `MonthCell`, applies the no-source invariant override via `applyNoSourceInvariantToMonthCell`, then renders the table cells, filters, row indicators, and summary counts. The display layer is authoritative for what the operator sees.
4. **Audit/debug layer** (`src/components/CellLineagePanel.tsx`, `src/components/CellAttributionPopover.tsx`, `src/components/PaidDollarsAuditPanel.tsx`). Explains cells and totals but is NOT canonical for ordinary visible state.

Surfaces below tag their authoritative layer.

## Cell-level surfaces

### Cell states (9 typed `ClassificationState` values)

The 9 values: `paid`, `unpaid`, `reversed`, `not_expected_premium_unpaid`, `not_expected_pre_eligibility`, `not_expected_cancelled`, `not_expected_not_ours`, `pending`, `manual_review`. Plus a legacy "Present, not due" display fallback that is NOT a 10th state.

#### `paid`

- **Visible:** Green/success cell background and border. Inline label shows paid amount (e.g., `$24.00`). Source chips above if present.
- **Meaning:** Positive commission attributed to this service month. Payment wins over earlier eligibility predictions.
- **Trigger:** Classifier Rule 1 — `paid_amount > 0.0001` from `paidForMonth(records, month)`.
- **Authoritative layer:** Classifier emits state; display renders. Not subject to no-source override.
- **Couplings:** `row.total_paid`, `months_paid`, Due/Paid ratio, Fully paid filter count, Total paid summary, export status `PAID`.
- **State-behavior tests:** Named canary ledger slot 5 (Aaron Barrett); `member-timeline-export-rows.test.ts` (PAID export); stale-BO tests.
- **Visual-rendering tests:** MISSING.
- **Required new tests:** Visual rendering test for paid cell appearance.

#### `unpaid`

- **Visible:** Red/destructive cell background and border. Inline label `unpaid`.
- **Meaning:** Commission expected but not received; dispute candidate.
- **Trigger:** Classifier Rule 3 — fires after payment/reversal/not-ours/pre-eligibility/terminated/stale-source/pending gates clear.
- **Authoritative layer:** Classifier emits state, but SUBJECT to no-source override.
- **Couplings:** `Has unpaid`, `unpaid + Net`, `unpaid 0 Net`, `Partially paid` filters; `membersWithUnpaid`; `totalUnpaidMonths`; `months_unpaid`; export status `UNPAID`.
- **State-behavior tests:** `mt-stage2-net-premium-classifier.test.ts`; named canary ledger slot 6 (Adam Wicht); `member-timeline-no-source-invariant.test.ts`.
- **Visual-rendering tests:** MISSING.
- **Required new tests:** Visual rendering test.

#### `reversed` (R-PAY-012)

- **Visible:** Orange/amber cell background and border. Inline label `Reversed {monthLabel}` where `{monthLabel}` is `formatMonthLabel(negativeStatementMonth)` producing forms like `Apr 26` (short month + 2-digit year, NO apostrophe). When negative statement month is unknown, label is just `Reversed`.
- **Meaning:** Paid-then-reversed pattern detected.
- **Trigger:** Classifier Rule 1b — `hasReversalPairForMonth(records, month, batchMonthByBatchId)` returns matched.
- **Authoritative layer:** Classifier emits state. Display renders.
- **Couplings:** `MonthCell.reversal_evidence`, tooltip reversal block, lineage panel reversal evidence card, export status `REVERSED`. Reversed cells do NOT carry `netBucket`.
- **State-behavior tests:** `classifier-reversal-detection.test.ts`; `mt-reversed-cell-state.test.ts`; `explain-cell-trace.test.ts` (Dannielle Jan); named canary ledger slot 1.
- **Visual-rendering tests:** MISSING.
- **Required new tests:** Visual rendering test for reversed cell label/color.

#### `not_expected_premium_unpaid`

- **Visible:** Muted/dashed cell. Inline `n/a` only if any source chip exists, otherwise blank.
- **Meaning:** Commission not expected because the member's premium is unambiguously unpaid for that service month. Non-disputable.
- **Trigger:** Classifier Rule 4 — service-month net premium positive AND BO paid-through before the month start.
- **Authoritative layer:** Classifier emits state. Display renders.
- **Couplings:** Excluded from due-row filter counts.
- **State-behavior tests:** Named canary ledger slot 4 (Aaliayh Blakemore); `mt-stage2-net-premium-classifier.test.ts`.
- **Visual-rendering tests:** MISSING.
- **Required new tests:** Visual rendering test.

#### `not_expected_pre_eligibility`

- **Visible:** Muted/dashed cell. Inline `n/a` only if any source chip exists, otherwise blank.
- **Meaning:** Service month is before the member's first commission-eligible month.
- **Trigger:** Classifier pre-eligibility guard — `month < firstEligible` where `firstEligible` comes from `computeFirstEligibleMonth(records)`.
- **Authoritative layer:** Classifier emits state. Display renders.
- **Couplings:** Excluded from due-row counts.
- **State-behavior tests:** `classifier-first-eligible.test.ts`; named canary ledger slot 3 (Charles Allen).
- **Visual-rendering tests:** MISSING.
- **Required new tests:** Visual rendering test.

#### `not_expected_cancelled`

- **Visible:** Muted/dashed cell. Inline `n/a` if any source chip exists, otherwise blank.
- **Meaning:** Not expected — broker/policy support no longer current OR display-layer no-source invariant cleared a stale inferred state.
- **Trigger:** Two paths. (a) Classifier broker-terminated or stale-source guard. (b) Display-layer override via `applyNoSourceInvariantToMonthCell`.
- **Authoritative layer:** Display layer (post-override) is what the operator sees. The contract specifies the FINAL DISPLAYED state, not which layer produced it.
- **Couplings:** Affects Due/Paid counts, filter eligibility, export blanking when no source flags.
- **State-behavior tests:** `member-timeline-bo-active-range.test.ts`; `member-timeline-stale-bo.test.ts`; `member-timeline-no-source-invariant.test.ts`; named canary ledger slots 2 (Adam Shrum) + 12 (Aaron Higgins).
- **Visual-rendering tests:** MISSING.
- **Required new tests:** Visual rendering test.

#### `not_expected_not_ours`

- **Visible:** Muted/dashed cell. Inline `n/a` only if any source chip exists, otherwise blank.
- **Meaning:** Member never tied to an in-scope NPN, or first eligibility could not be established.
- **Trigger:** Classifier `memberBelongsToUs` guard or firstEligible-null guard.
- **Authoritative layer:** Classifier emits state. Display renders.
- **Couplings:** Strongly affected by scope/pay-entity filters.
- **State-behavior tests:** Named canary ledger slot 9 (Thomas Mitchell).
- **Visual-rendering tests:** MISSING.
- **Required new tests:** Visual rendering test.

#### `pending`

- **Visible:** Amber cell background and border. Inline label `pending`. Legend label `Pending (not ripe)`.
- **Meaning:** Commission expectation exists, but the statement or BO snapshot evidence needed to call the month final isn't yet available.
- **Trigger:** Classifier Rule 2 — `isMonthRipe(month, context)` returns false.
- **Authoritative layer:** Classifier emits state. Display renders.
- **Couplings:** `Has pending` filter; internal `RollupStatus.has_pending`; excluded from Fully paid filter.
- **State-behavior tests:** `member-timeline-no-source-invariant.test.ts`.
- **Visual-rendering tests:** MISSING.
- **Required new tests:** Visual rendering test.

#### `manual_review`

- **Visible:** Purple cell background and border. Inline label `review`. Legend label `Needs review`.
- **Meaning:** No commission received and remaining signals insufficient or conflicting; human review required.
- **Trigger:** Classifier Rule 5 — fallback after net premium and paid-through checks fail to resolve to unpaid or premium-unpaid.
- **Authoritative layer:** Classifier emits state. Display renders.
- **Couplings:** `needs_manual_review`; `Needs review` filter; export status `REVIEW`; tooltip state/reason.
- **State-behavior tests:** `mt-stage2-net-premium-classifier.test.ts`.
- **Visual-rendering tests:** MISSING.
- **Required new tests:** Visual rendering test.

#### Legacy "Present, not due" display fallback (NOT a 10th state)

- **Visible:** When `c.state` is missing, falls back to green paid / red unpaid / muted present-not-due. Legend includes `Present, not due`.
- **Meaning:** Display compatibility path for older callers or cells without classifier state.
- **Trigger:** Default branch in `MemberTimelinePage.tsx` cell render plus `exportStatusForMonthCell`.
- **Authoritative layer:** Display.
- **Contract note:** NOT a formal classifier state. Future cleanup may remove the legacy branch if all callers stamp `state`.

### Source chips (E, B, C)

Three small badges rendered above each cell when the corresponding source supports the service month.

#### EDE chip (`E`)

- **Visible:** Small secondary badge `E`.
- **Meaning:** A qualified EDE row is active and selected for the service month under the current scope/picker rules.
- **Trigger (authoritative):** `MonthCell.in_ede` stamped by `buildMemberTimeline` using its own EDE qualification, range, and picker-gate logic.
- **Authoritative layer:** Assembly. Display reads `MonthCell.in_ede`.
- **Parallel internal helper:** Classifier has its own `hasEdeForMonth` used during classification and surfaced in `explainCell` trace. The chip on screen comes from `MonthCell.in_ede`, NOT directly from `hasEdeForMonth`.
- **Couplings:** Tooltip EDE yes/no; source export `EDE`; no-source invariant input; lineage panel chip display.
- **State-behavior tests:** `member-timeline-bo-active-range.test.ts`; `member-timeline-stale-bo.test.ts`; loader-shape tests; canary ledger.
- **Visual-rendering tests:** MISSING.
- **Required new tests:** Visual rendering test for `E` chip presence/absence.

#### Back Office chip (`B`)

- **Visible:** Small secondary badge `B`.
- **Meaning:** A canonically active, in-scope BO row supports the service month.
- **Trigger (authoritative):** `MonthCell.in_back_office` stamped by `buildMemberTimeline` using `backOfficeActiveRange` + `isActiveBackOfficeRecord` + due-scope predicate.
- **Authoritative layer:** Assembly. Display reads `MonthCell.in_back_office`.
- **Parallel internal helper:** Classifier `hasActiveBoForMonth`.
- **Couplings:** Tooltip Back Office active/no; source export `BO`; no-source invariant input; CR detection input.
- **State-behavior tests:** `member-timeline-bo-active-range.test.ts`; `member-timeline-stale-bo.test.ts`; `member-timeline-no-source-invariant.test.ts`; canary ledger.
- **Visual-rendering tests:** MISSING.
- **Required new tests:** Visual rendering test.

#### Commission chip (`C`)

- **Visible:** Small secondary badge `C`.
- **Meaning:** One or more in-scope commission rows are attributed to the service month.
- **Trigger (authoritative):** `MonthCell.in_commission`, `paid_amount`, `payment_count` stamped by `buildMemberTimeline` from `commissionServiceMonths`.
- **Authoritative layer:** Assembly. Display reads from `MonthCell`.
- **Parallel internal helper:** Classifier `hasCommissionForMonth`, `paidForMonth`.
- **Couplings:** Tooltip payment count; paid label; total paid; reversal state/evidence input; paid-dollars audit.
- **State-behavior tests:** Export tests; stale-BO paid path; classifier reversal tests; canary ledger.
- **Visual-rendering tests:** MISSING.
- **Required new tests:** Visual rendering test.

#### No-source dash (`—`)

- **Visible:** When no E/B/C source flags are true, the cell source-chip row shows a muted dash.
- **Meaning:** No displayed current source supports that month.
- **Trigger:** `hasAny = c.in_ede || c.in_back_office || c.in_commission` evaluates false. Also triggers `applyNoSourceInvariantToMonthCell` override.
- **Authoritative layer:** Display.
- **Couplings:** Suppresses `n/a` inline label for not_expected states; export status can be blank.
- **State-behavior tests:** `member-timeline-no-source-invariant.test.ts`.
- **Visual-rendering tests:** MISSING.
- **Required new tests:** Visual rendering test for dash appearance.

### Carrier-recognition (CR) cell badge

- **Visible:** Amber outline `CR` badge alongside E/B/C chips. Tooltip explains the recognition condition.
- **Meaning:** Carrier recognized the member through in-scope BO evidence even though the picked EDE row shows a non-scope AOR.
- **Trigger (authoritative):** `MonthCell.carrier_recognition` stamped by `detectCarrierRecognition` inside `buildMemberTimeline`. Only runs when `selectedAorScope === 'official'` AND `rawRecordsByMemberKey` is supplied.
- **Authoritative layer:** Assembly. CR is INDEPENDENT of the cell's `ClassificationState`.
- **Couplings:** Row-level `CR×{N}` badge; tooltip CR explanatory text; `carrier_recognition_premium`; `+Net` override for unpaid cells; lineage panel displayed-state badges.
- **State-behavior tests:** Named canary ledger slot 13 (Darrell Crutcher).
- **Visual-rendering tests:** MISSING. No direct isolated unit test for `detectCarrierRecognition`.
- **Required new tests:** Isolated unit test for `detectCarrierRecognition`; visual rendering test for the `CR` badge.
- **Important:** Not emitted under `All AOR` scope. Do NOT model CR as a classifier state.

### Reversal evidence card (in tooltip + lineage panel)

- **Visible:** Tooltip "Reversal" block with amount, positive TXN, negative TXN, paid-to-date, statement months. Lineage panel "Reversal evidence" card with same fields.
- **Meaning:** Structured evidence backing the `reversed` cell state.
- **Trigger:** `MonthCell.reversal_evidence` populated by classifier Rule 1b's `hasReversalPairForMonth` output; merged into displayed `MonthCell` by `MemberTimelinePage.tsx`.
- **Authoritative layer:** Classifier (data); display (merge + presentation).
- **Couplings:** Coupled with `reversed` state; if state is `reversed`, evidence MUST be populated.
- **State-behavior tests:** `explain-cell-trace.test.ts`; `classifier-reversal-detection.test.ts`; `mt-reversed-cell-state.test.ts`.
- **Visual-rendering tests:** MISSING.
- **Required new tests:** Visual rendering test for tooltip Reversal block.

## Row-level surfaces

### Member identity row

- **Member name + Policy/Subscriber ID:** Member name displayed; below it Policy Number or Subscriber ID (whichever is canonical). Source: assembly.
- **`ResolvedBadge`:** Small badge appears when displayed value is `issuer_subscriber_id` AND resolver confirms. Trigger: `lookupResolved` + `ResolvedBadge`. Visual rendering test MISSING — required new test.
- **`N× FFM`:** Tag like `2× FFM` when `row.ffm_app_ids.length > 1`. Tooltip lists FFM application IDs. Trigger: `collectFfmAppIds` + Class-A fallback index. State-behavior test: `member-timeline-ffm-visible-ui.test.ts`.
- **Member AOR text:** Displays `current_policy_aor || aor_bucket || '—'` (U+2014 EM DASH). Visual rendering test for fallback order MISSING.

### Row stat columns

#### Due/Paid ratio

- **Visible:** Table column `Due/Paid` showing `months_paid/months_due` (e.g., `3/4`).
- **Meaning:** Due service months paid versus total due service months in the selected range.
- **Trigger:** Row fields from `buildMemberTimeline`, overwritten after classifier/display stamping.
- **Authoritative layer:** Assembly + display.
- **Couplings:** Fully paid, Partially paid, Has unpaid filters; summary counts.
- **State-behavior tests:** Export rows include `months_due`, `months_paid`, `months_unpaid`.
- **Visual-rendering tests:** MISSING.
- **Required new tests:** Visual rendering test for ratio column.
- **NOT derived from `RollupStatus`.**

#### Total paid (`$` column)

- **Visible:** `Total $` table column per row plus top summary `Total paid`.
- **Meaning:** Sum of commission dollars attributed to due months for the visible timeline cohort. NOT identical to canonical dashboard net paid.
- **Trigger:** `row.total_paid` from month cells. Debug audit cross-checks via `buildPaidDollarsAudit`.
- **Authoritative layer:** Assembly + display.
- **State-behavior tests:** Export row tests.
- **Visual-rendering tests:** MISSING.
- **Required new tests:** Visual rendering test.

### Row CR count badge (`CR×{N}`)

- **Visible:** Tiny amber outline text next to member name, format `CR×{N}` using the multiplication sign `×` (U+00D7), e.g., `CR×3`.
- **Meaning:** Count of cells in the row with `carrier_recognition === true`.
- **Trigger:** Display layer counts `Object.values(row.cells).filter(c => c.carrier_recognition).length`.
- **Authoritative layer:** Display.
- **Visual-rendering tests:** MISSING.
- **Required new tests:** Visual rendering test asserting the `CR×{N}` text format AND count correctness.

## Current-batch range warning banner

### Trigger predicate

The banner renders when **all** of the following are true:
- `batchScope === 'current'` (the batch scope filter is set to "Current batch").
- `monthsOutsideSelectedStatement(monthList, currentBatch?.statement_month)` returns a non-empty array.

The canonical helper `monthsOutsideSelectedStatement` lives in `src/lib/memberTimeline.ts` and is imported into `MemberTimelinePage.tsx`. It compares the user-selected month range against the current batch's statement month and returns the months that fall outside it.

### Suppress conditions

The banner is **absent** when any of the following hold:
- `batchScope === 'all'` ("All batches" scope).
- No `currentBatch` is available.
- `currentBatch.statement_month` is `null` or unparseable.
- `monthList` is empty (no month range selected).

### Verbatim banner copy

The rendered text is byte-equal to the following (interpolations noted):

> Current batch view: payment evidence comes from the {statementMonthLabel} statement only. {n} of the selected months fall outside it and may show "unpaid" even if paid in another statement. Switch to "All batches" for cross-statement payment truth.

Where:
- `{statementMonthLabel}` = `formatMonthLabel(statementMonthKey(currentBatch.statement_month))`
- `{n}` = `outsideMonths.length`

### Semantic note (locked)

> Current-batch mode is a selected-statement inspection view; All-batches mode is the certified cross-statement payment view.

### Rendering details

- The banner element carries `data-testid="mt-range-warning"`.
- The banner is **non-dismissible**.
- Because the default current-batch range is year-to-date, the banner **will show by default** in current-batch mode when the selected range spans months outside the current statement.


## Summary / filter surfaces

**Contract policy on filter chip and summary counts:**

> Filter chip and summary counts are CONTRACTUAL surfaces. The lineage panel's per-cell `netBucket` outline badge is an audit surface, not a contract surface. If a filter count drifts from its defined derivation, that is a contract violation requiring fix or explicit spec amendment.

### Status filter chips

- `All` — rows with at least one due month.
- `Has unpaid` — rows with `months_unpaid > 0`.
- `unpaid - + Net` — rows with at least one unpaid cell where service-month net premium evidence is positive (or CR-forced positive).
- `unpaid - 0 Net` — rows with at least one unpaid cell where net premium is zero/null/no service-month EDE.
- `Partially paid` — rows where `months_paid > 0 && months_unpaid > 0`.
- `Fully paid` — rows where `months_paid === months_due && months_due > 0`.
- `Has pending` — rows with any cell in `pending` state.
- `Needs review` — rows with any cell in `manual_review` state.

- **Trigger:** `MemberTimelinePage.tsx` filter/count logic.
- **Authoritative layer:** Display.
- **State-behavior tests:** `mt-stage2-net-premium-classifier.test.ts` covers `+Net`/`0Net` row derivation.
- **Visual-rendering tests:** MISSING.
- **Required new tests:** Per-chip count assertion tests using synthetic row sets with known expected counts.

### Summary totals (top of page)

- `Total paid` — sum of `total_paid` across visible rows.
- `Members w/ gaps:` — count of rows with `months_unpaid > 0`.
- `Unpaid month-events:` — sum of `months_unpaid` across visible rows.

Same contract policy: counts are contractual.

- **Required new tests:** Summary total assertion tests.

## Display override mechanic

### `applyNoSourceInvariantToMonthCell`

- **Trigger:** Fires after classification when classifier emitted a state implying current expectation but NONE of `in_ede`, `in_back_office`, `in_commission` are true for the cell.
- **Effect:** Overrides the cell's `state` to `not_expected_cancelled`. Updates `state_reason` accordingly.
- **Why:** Without this guard, stale historical evidence could leave a cell rendering as expected/unpaid even when no current source backs it.
- **Visible to operator:** The cell shows `not_expected_cancelled` (the override). The classifier's original output is NOT visible in the table.
- **Lineage panel handling:** Renders displayed state at the top (post-override) AND surfaces a "Display override" note if `MonthCell.state !== trace.final.state`.
- **State-behavior tests:** `member-timeline-no-source-invariant.test.ts`.

**Contract rule:** The displayed `MonthCell.state` is the source of truth for what the operator sees.

## Debug and audit surfaces

### Debug toggle + CellAttributionPopover + PaidDollarsAuditPanel

- **Visible:** Debug button at top of page. When toggled on, cells get wrapped in `CellAttributionPopover` and `PaidDollarsAuditPanel` appears below the table.
- **Trigger:** `debugOpen` state in `MemberTimelinePage.tsx`.
- **Authoritative layer:** Audit/debug.
- **Couplings:** Does NOT change classifier state. Lineage panel is INDEPENDENT of `debugOpen`.
- **Visual-rendering tests:** MISSING.
- **Required new tests:** Visual rendering test asserting toggle on shows popover wrap + panel.

### Source-to-screen lineage panel (`CellLineagePanel`)

- **Visible:** Right-side sheet opened by clicking any MT cell.
- **Authoritative layer:** Audit/debug. Independent of `debugOpen`.
- **Couplings:** Renders displayed state from `MonthCell` (not `trace.final`); surfaces classifier pre-display output separately; shows display override note when they differ. Raw evidence limited to projected `raw_json` subset.
- **State-behavior tests:** `explain-cell-panel.test.tsx` covers all nine required behaviors.
- **Required new tests:** None.

## Raw evidence availability

The MT all-batch loader (`getAllNormalizedRecordsForMemberTimeline`) deliberately avoids `select('*')` and full `raw_json`. It projects typed columns plus these 9 raw_json subkeys via stable aliases: `ffmAppId`, `currentPolicyAOR`, `policyStatus`, `issuer`, `lastEDESync`, `Months Paid`, `Broker Name`, `broker_name`, `Transaction ID`.

Enforced by `member-timeline-all-batch-loader-shape.test.ts`.

**Contract statement:** MT source-to-screen evidence is limited to typed columns + the projected `raw_json` subset above. The lineage panel's "raw evidence" second-expand surfaces these subkeys, NOT the full source CSV row. Any future surface requiring full `raw_json` requires a separate row-level fetch design + directive.

## Non-rendered internal fields (NOT screen contract surfaces)

### `RollupStatus` enum

- **Code location:** `computeRollup` in `src/lib/classifier.ts`.
- **Visible:** NOT displayed.
- **Contract note:** Do NOT include `RollupStatus` in the visible screen contract.

### `netBucket` per-cell field

- **Code location:** Page-level net bucket assignment in `MemberTimelinePage.tsx`.
- **Visible:** NOT displayed inside normal table cells. Appears only via filter chip counts (contractual), lineage panel badge (NOT contractual per-cell), CR tooltip.

## Spec versioning and drift detection

### Versioning rules

- This document is v1.
- Adding a new surface: spec amendment required before code ships the surface.
- Removing a surface: spec amendment required to mark surface deprecated; code change ships after spec amendment lands.
- Changing semantic meaning of an existing surface: spec amendment required.

### Drift detection — required new tests summary

State-behavior tests assert classifier/helper/export output. Visual-rendering tests assert rendered UI matches expectations. MOST SURFACES LACK VISUAL-RENDERING TESTS.

Required NEW tests (to ship via follow-up directive):

1. Visual rendering tests for each cell state.
2. Isolated unit test for `detectCarrierRecognition`.
3. Visual rendering test for `E`, `B`, `C` chips and no-source dash.
4. Visual rendering test for the `CR` cell badge and `CR×{N}` row badge.
5. Visual rendering test for tooltip Reversal evidence block.
6. Visual rendering test for `ResolvedBadge`.
7. Visual rendering test for Member AOR text fallback order.
8. Visual rendering test for Due/Paid ratio column.
9. Visual rendering test for Total paid column.
10. Per-filter-chip count assertion tests for all 8 chips.
11. Summary total assertion tests.
12. Visual rendering test for Debug toggle.
13. Visual rendering test for `reversed` cell label including `formatMonthLabel` output.

## Open items deferred from v1

- Full `raw_json` availability: requires row-level on-demand fetch directive.
- Tooltip exhaustive contract: v1 covers critical evidence blocks only.
- Mobile/responsive contract: v1 assumes desktop viewport.

## Cross-references

- `BUSINESS_RULES.md` — R-PAY-010 / R-PAY-012 distinction; R-INELIG-001 / R-INELIG-002 / R-INELIG-004; R-AUDIT-010 CR rule.
- `docs/named-canary-ledger.md` — surfaces locked here must agree with the live MT classifier output for all canaries in the ledger.
