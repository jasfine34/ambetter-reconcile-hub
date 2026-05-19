# Bundle 13e — Plan

## Scope acknowledgment

This is ~10 files, including 2,387-line DashboardPage and 1,377-line MissingCommissionExportPage, plus a new resolver, 3 adapters, an invariant update, and ≥20 tests across 14 categories. Atomicity rule: single ship. I will batch reads heavily and keep consumer edits minimal/surgical.

## One contract correction to confirm before coding

The directive's resolver code samples reference `result.amount` and `result.rateRecordId` on the helper return. The actual `ExpectedCommissionResult` (src/lib/canonical/compGrid.ts:90) uses `expectedAmount` (not `amount`). I will:
- Internally read `result.expectedAmount` from the helper.
- Externally expose `EstMissingResolution.amount` (per directive's public API).
- RESOLVED_WITH_OVERRIDE detection will match the directive's intent: `owner==='EF' && matched_payee∈{Coverall,Vix} && supportStatus==='supported' && evidence.computation.startsWith('agency_tier_override(')`. (The directive's "rateRecordId===null" in the Final Summary is consistent with the override branch in expectedCommissionForClearing.ts:91 setting `rateRecordId: null`; I'll use the `computation` prefix as the canonical signal per the resolver-logic section.)

## Deliverables (single ship)

### New files
1. `src/lib/canonical/estMissingResolver.ts` — pure factory per API contract. Priority: PARTIAL_CLEARED_REMAINDER → required-input UNSUPPORTED → TBD_AMBIGUOUS_PAYEE → rate-chart RESOLVED/RESOLVED_WITH_OVERRIDE → NO_RATE_ROW. LRU memo cache (1000 entries) keyed per directive. No Supabase/loader imports.
2. `src/lib/canonical/estMissingEvidenceAdapter.ts` — shared surface adapter (Dashboard / Agent Summary / Unpaid Recovery / Exceptions). Returns `Map<member_key, EstMissingInputEvidence>`. policy_year derivation: target_service_month → expected_ede_effective_month → effective_date year. Returns null evidence fields when unprovable (never fakes from legacy column).
3. MCE adapter: inlined inside `MissingCommissionExportPage.tsx` (extraction criterion ≥30 shared lines not met based on MCE's enrichment shape; will reassess after writing both — if shared, extract to `estMissingEvidenceShared.ts`).

### Resolver factory wiring (consumers)
- React consumers wrap factory in `useMemo([batchId, scope, ratesVersion, overlayVersion, evidenceVersion])`. ratesVersion = hash of rateRows length+max id; overlayVersion = overlayMap size + identity; evidenceVersion = evidence Map size + identity. Documented inline.
- `loadCarrierCompRates({ effectiveYear: 2026 })` called once per page in a `useEffect`+state (or report runner for MCE).

### Consumer edits (8)
| # | File | Edit |
|---|---|---|
| 1 | `src/lib/canonical/crossBatchOverlay.ts:192-200` (`legacyEstMissing`) | Replace body with resolver-driven helper; OR mark as single-delegate deprecation shim that just throws-on-call. Aggregator paths shift to resolver. |
| 2 | `src/pages/DashboardPage.tsx:826` (`sumEffectiveEstMissing`) | Sum amounts where status ∈ resolved-set; pass TBD/UNSUPPORTED counts into tile metadata + add "{N} TBD · {M} Needs Review" badge (hidden when both 0). |
| 3 | `src/pages/MissingCommissionExportPage.tsx:912-916` | Amount column numeric-or-blank; insert new `Est_Missing_Status` column to the right. Remove $18 fallback. |
| 4 | `src/pages/AgentSummaryPage.tsx` | Per-agent total uses resolver; add same badge. |
| 5 | `src/pages/UnpaidRecoveryPage.tsx` | Per-row: amount when resolved, "TBD" or "Needs Review (<reason>)"; CSV mirrors. Same tile badge. |
| 6 | `src/lib/canonical/metrics.ts` (`getExpectedMissingCommissionSum`) | Aggregate only resolved amounts. Accept resolver as injected dep (keeps it pure-ish; tests stub it). |
| 7 | `src/pages/ExceptionsPage.tsx:20` | Adapter injects `resolved_est_missing_amount` + `resolved_est_missing_status` upstream of DataTable columns. Replace `estimated_missing_commission` column with these two. No new tile/badge. |
| 8 | Static wiring tests | Update assertions for new statuses. |

### Invariant update
- `src/lib/canonical/invariants.ts:269-279` — replace `estimated_missing_commission > 0` proxy. Use canonical paid/unpaid predicate: a row is "unpaid" if it is in EE-universe, eligible, has matched BO, AND `in_commission === false`. "Paid" is the same predicate with `in_commission === true`. Disjoint by construction; violator = row flagged in_commission=true while also appearing in unpaid set (shouldn't be possible — that's exactly the check).

### Removals
- All `?? 0` and `|| 0` reads of `estimated_missing_commission` across the 8 consumer files.
- `DEFAULT_COMMISSION_ESTIMATE` references in active code (constants.ts may keep the export only if tests reference it; otherwise delete).
- Direct `legacyEstMissing` callers outside the deprecated shim.

### Tests (≥20 across 14 categories, all passing, none skipped)
New files:
- `src/test/canonical/estMissingResolver.test.ts` — categories 1-6, 8, 13, 14, 15 (factory, priority, each UnsupportedReason, plan_variant null, owner classifier, override detection, memoization, regression partial/override paths, positive-removal grep + runtime per consumer).
- `src/test/canonical/estMissingEvidenceAdapter.test.ts` — category 7 (adapter per surface).
- `src/test/est-missing-consumer-wiring.test.tsx` — categories 9, 10, 11 (consumer integration, badge rendering per consumer, MCE CSV columns).
- Update `src/test/dashboard-invariants-feedback.test.tsx` (or sibling) — category 12 (spy on canonical paid/unpaid predicate; assert it drove disjoint result).

Grep test enforces: no `estimated_missing_commission\s*[?][?]\s*0` or `\|\|\s*0` near consumer reads; no `DEFAULT_COMMISSION_ESTIMATE` in src/pages/** or src/lib/canonical/{metrics,crossBatchOverlay}.ts active paths.

## Execution order

1. Read: compGrid result shape, crossBatchOverlay (overlayMap shape, legacyEstMissing, RowAdjustment), metrics.getExpectedMissingCommissionSum, ExceptionsPage, AgentSummaryPage, UnpaidRecoveryPage, DashboardPage:780-880, MCE:880-960, invariants:240-290, constants.DEFAULT_COMMISSION_ESTIMATE, reconcile read sites — **all parallel**.
2. Write resolver + shared adapter.
3. Write resolver tests (categories 1-6, 8, 13, 14).
4. Wire each consumer + adjust its tests.
5. Update invariant + its test.
6. Run full vitest; iterate until green; verify no skipped tests; run consumer grep test.
7. Final report with file list and category-coverage matrix.

## Open question (one)

`getExpectedMissingCommissionSum` in `src/lib/canonical/metrics.ts` is currently a pure helper consumed by both pages and invariants. The cleanest pure-resolver wiring is to **change its signature** to accept a pre-built resolver (or its `resolve` function) as a parameter, with all callers building the resolver at the page/report boundary. Confirming this is acceptable — the alternative (resolver loading rates internally) violates the "resolver stays pure, no compGridLoader imports" rule. **I will proceed with the signature change** unless you object.

## Risk callouts

- DashboardPage is 2,387 lines. I will keep edits localized to the EBU tile + Source Coverage bucket aggregation sites and add the badge near the existing tile JSX. No structural refactor.
- MCE CSV column insertion shifts column order downstream of the amount column. I'll insert `Est_Missing_Status` immediately after the existing amount column to minimize column-order churn in any downstream consumers.
- "≥20 tests, 14 categories, zero skipped" is the hard gate. I will not ship until vitest reports all passing with zero `.skip`.
