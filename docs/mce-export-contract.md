# Missing Commission Export (MCE) Contract — v1

## Purpose

This document locks the contract for the Missing Commission Export surface — the carrier inquiry/export workflow used to recover commissions Jason knows are owed but were not paid on the active batch.

MCE has TWO intentionally different output shapes:

1. **Vendor Messer CSV** — the downloaded, carrier-facing CSV (R-MCE-001). 12 locked columns (R-MCE-002, confirmed by Jason 2026-05-18, re-confirmed 05-22). This is what is emailed to the carrier.
2. **Internal preview** — the operator-facing table rendered in the page. Same 12 columns as the vendor CSV plus operator-only columns (member key, contact info, AOR, net premium bucket, missing reason, estimated missing commission dollar, source type, cross-batch clearing state).

If a code change makes the visible output disagree with this contract, either the code is wrong OR the contract needs an authorized amendment — never both silently.

## Two-schema separation

Current shipped schema: vendor CSV is exactly the 12 R-MCE-002 columns. Estimated missing commission and `_estMissingStatus` are preview/backing only and are not exported.

The single-month vendor Messer CSV (`buildMesserCsv`) remains exactly the 12 R-MCE-002 columns and is UNCHANGED by C3.

The C3 multi-month commission-submission CSV is a distinct carrier download, now authorized as 15 columns: the 12 base Messer columns + "Missing Month(s)" + "Operator Comment" + "Pay Entity". The Pay Entity column disambiguates dual-scope members emitted as two rows (same vendor fields, different pay entity).

The estimated missing commission dollar is computed and shown INTERNALLY in the preview only. It is NOT included in EITHER carrier CSV. The C3 vendor-schema unlock is limited to "Missing Month(s)" + "Operator Comment" + "Pay Entity"; it does not authorize exporting dollar/status/preview/internal fields in either CSV.

## Row-scope semantics

- **Official-AOR scope only.** MCE is a carrier inquiry surface. Even when Phase B item 4 rewires MCE to MT-approved rows, the export remains scoped to the official Jason/Coverall/Vix book. MT's all-AOR audit mode does not propagate to this export.
- **Pre-effective members excluded** (R-MCE-007).
- **Reversed cells excluded** from the MCE chase; they route to Phase C operator review (R-PAY-010 / R-PAY-012).
- MT-approved inclusion source. Post-Phase-B-4a/4b, MCE row inclusion is produced from MT-approved unpaid member-months via the selector/cache path, then cross-batch overlay/enrichment/dollar logic is applied.
- manual_review cells excluded from auto-chase. Classifier manual_review cells are not part of the MT-approved unpaid selector. Cross-batch overlay rows with manual-review clearing states remain review evidence and should not be treated as ordinary chase rows.
- **Cross-batch profile enrichment** (R-MCE-003) — best-known descriptive/contact fields are walked across all uploaded batches.

## Vendor Messer CSV — 12 locked columns (R-MCE-002)

Header order is fixed. `buildMesserCsv` MUST emit exactly these labels, in this order, with no additional columns.

| # | Column | Meaning | Computation / source (current file:line) |
|---|---|---|---|
| 1 | Carrier Name | Carrier literal | `'Ambetter'` (MissingCommissionExportPage.tsx:1151) |
| 2 | NPN | Writing-agent NPN | Member/AOR resolution; NPN extracted from `current_policy_aor` via `extractNpnFromAorString` with fallback to `m.agent_npn` |
| 3 | Writing Agent Carrier ID | Carrier-specific agent ID | Derived from observed COMMISSION rows per `(carrier, pay_entity, agent_npn)` via `buildWritingAgentCarrierIdLookup` (#109 derived lookup, ~:245-307); `resolveWritingAgentCarrierId` Tier-1 direct → Tier-2 historical → blank |
| 4 | Writing Agent Name | Agent name | `resolveWritingAgentName` — `current_policy_aor` (display name) → BO Broker Name → Commission Writing Agent Name → blank |
| 5 | Policy Effective Date | Policy effective date | `resolvePolicyEffectiveDate` (~:217-251). MCE contract **AC-3** — see precedence below; never the broker effective date ahead of an actual policy effective date |
| 6 | Policy # | Policy number | `m.policy_number` (:1159) |
| 7 | Member First Name | First name | `profile.applicant_name` split, BO-first walk |
| 8 | Member Last Name | Last name | Same |
| 9 | DOB | Date of birth | `profile.dob` ?? `m.dob` |
| 10 | SSN | SSN | Intentionally blank in v1 (`ssn: ''`, :1163) |
| 11 | Member ID | Member / subscriber ID | `resolveMemberId` — `issuer_subscriber_id` → `policy_number` → `exchange_subscriber_id` → blank |
| 12 | Address (Street, City, State, Zip) | Address | `assembleAddressLine(profile.address1, city, state, zip)` |

### Policy Effective Date precedence (AC-3)

First non-blank wins:

1. EDE typed `effective_date` (authoritative filed date)
2. EDE `raw_json.effectiveDate`
3. BO typed `effective_date` (ISO-normalized Policy Effective Date — preferred over raw and over broker)
4. BO `raw_json['Policy Effective Date']` (raw carrier-formatted fallback)
5. reconciled `effective_date`
6. BO `broker_effective_date` — last-ditch ONLY, never ahead of any actual policy effective date

Ambetter BO normalization maps raw `Policy Effective Date` → typed `effective_date` via `normalizeDate` (`src/lib/carriers/ambetter/backOffice.ts:94`).

## Internal preview — additional operator columns

These appear in the rendered table but are NOT written to the vendor CSV.

| Internal column | Backing field | Purpose |
|---|---|---|
| member_key | `_memberKey` | Operator-side join key |
| Phone | `_phone` | Profile-walked phone |
| Email | `_email` | Profile-walked email |
| exchange_subscriber_id | `_exchangeSubscriberId` | Audit |
| issuer_subscriber_id | `_issuerSubscriberId` | Audit |
| AOR | `_aor` | Display |
| Net premium bucket | `_netPremiumBucket` | Filter binding |
| Missing reason | `_missingReason` | `m.issue_type \|\| 'Missing from Commission'` (:1176) |
| Est. missing commission | `_estimatedMissingCommission` | Bundle 13e resolver amount. Cell display also reads the backing `_estMissingStatus` to render `Needs review` (UNSUPPORTED), `TBD` (TBD_AMBIGUOUS_PAYEE), or `$X.XX` (resolved) — MissingCommissionExportPage.tsx:1557-1567 |
| Source Type | `_sourceType` | Post-4a value carried from MT selector as `_mtSourceType` (Matched / BO Only / EDE Only), with defensive fallback to Matched in the page. The old `classifySourceTypeForRow` page-local contract is historical for MCE. |
| Clearing | `_clearingStatus` | Bundle 13c cross-batch clearing state chip |

`_estMissingStatus` is intentionally NOT a standalone preview column — it is a backing field that drives the dollar cell text.

## Acceptance criteria

The contract is satisfied only when all of these pass.

### AC-1 - Current vendor Messer CSV emits the 12 shipped columns

`MESSER_COLUMNS` contains exactly the 12 labels listed above, in order. `buildMesserCsv` emits exactly those 12 columns; `Estimated Missing Commission` and `Est_Missing_Status` are NOT present in the vendor CSV. The dollar remains as the preview-only `Est. missing commission`; the status remains a backing field on `ExportRow` (`_estMissingStatus`) and is NOT re-added as a standalone preview column. The separate C3 multi-month commission-submission CSV is 15 columns (12 base + Missing Month(s) + Operator Comment + Pay Entity); the single-month vendor Messer CSV's 12-column lock is unaffected by that.

### AC-2 — Blank-dollar resolution in the preview

The preview dollar must stop returning `UNSUPPORTED` / `MISSING_STATE` / `MISSING_MEMBER_COUNT` for rows where normalized BO/EDE evidence proves those inputs. The evidence map MUST be built from normalized BO/EDE records via the canonical resolver-record adapters (`buildPolicyStateRecords`, `buildPolicyMemberCountRecords`) plus the canonical state/member-count resolvers — not from reconciled-row fields, which lack state and member_count.

State + member-count are necessary but not sufficient. The following remain legitimate non-blank-failure outcomes and MUST NOT be forced to `RESOLVED`:

- `RESOLVED_WITH_OVERRIDE`
- `PARTIAL_CLEARED_REMAINDER`
- `TBD_AMBIGUOUS_PAYEE` (Erica/EF-owner rows with no matched payee)
- `UNSUPPORTED` / `NO_RATE_ROW` when the comp grid has no matching rate

### AC-3 — Policy Effective Date uses the policy date, not the broker date

`resolvePolicyEffectiveDate` MUST never return `broker_effective_date` ahead of an actual policy effective date. See the precedence above. A BO-only row with typed `effective_date = '2026-01-01'`, `broker_effective_date = '2026-02-15'`, and raw `Policy Effective Date` present MUST export `2026-01-01`.

## Required tests

1. **Vendor CSV column lock** — `buildMesserCsv` header === the 12 R-MCE-002 labels, in order; no `Estimated Missing Commission` / `Est_Missing_Status`.
2. **Preview retains dollar** — `INTERNAL_COLUMNS` includes `{ key: '_estimatedMissingCommission', label: 'Est. missing commission' }`; status is a backing field (not asserted as a separate column).
3. **Dollar resolves (full evidence)** — missing member row + complete BO/EDE state+count+months+policy_year+rate evidence → preview dollar non-null, status `RESOLVED`.
4. **Dollar stays unsupported when evidence absent** — row with no state/count evidence → `UNSUPPORTED`, blank dollar. Legitimate `TBD_AMBIGUOUS_PAYEE` / `NO_RATE_ROW` outcomes are not failures.
5. **PED not BED** — BO-only row with typed `effective_date` ≠ `broker_effective_date` exports the typed `effective_date`.

## Out of scope / future

- Old standalone MCE inclusion builder behavior (retired in Phase B item 4b)
- All-AOR audit export variant
- Reversed-recovery export
- Adding estimated missing commission or status fields to the vendor CSV
- Further additions to the C3 15-column multi-month submission export beyond Missing Month(s) / Operator Comment / Pay Entity
