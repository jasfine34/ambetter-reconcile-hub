# Named Canary Ledger

**Version:** v1
**Last updated:** 2026-05-28

## Purpose

Durable list of real Ambetter members with expected MT outcomes per cell. Drives MT certification and regression detection. Every code change re-runs the parser test; any canary state flip surfaces immediately.

## Permitted cell state values

Test parser MUST accept only these literal `ClassificationState` enum values from `src/lib/classifier.ts`:

- `paid`
- `unpaid`
- `reversed`
- `not_expected_premium_unpaid`
- `not_expected_pre_eligibility`
- `not_expected_cancelled`
- `not_expected_not_ours`
- `pending`
- `manual_review`

Any other value in the table is a parse error.

## Pattern slots and assertion rows

15 pattern slots. 19 assertion rows (3 canaries have multiple rows for scope-disambiguation: Latronda, Thomas Mitchell, Albert Holder). Slots 2 and 15 are explicit TBD placeholders for v1 — parser skips rows with `TBD` in any cell.

| # | Canary | Pattern | Member | Policy | Scope | Jan 2026 | Feb 2026 | Mar 2026 | Apr 2026 | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Dannielle Coe | `reversed` (R-PAY-012) | DANNIELLE COE | u96332808 | All | reversed | unpaid | unpaid | unpaid | Cell-level equal-and-opposite commission pair for `paid_to_date = 2026-01-31`; positive TXN `8245546` and negative TXN `8705401`. |
| 2 | Adam Shrum | `not_expected_cancelled` (R-INELIG-001) — terminated policy | Adam Shrum | u98019911 | All | not_expected_cancelled | not_expected_cancelled | not_expected_cancelled | not_expected_cancelled | Policy term date `2025-12-31`; no newer active BO row covering 2026. |
| 3 | Charles Allen | `not_expected_pre_eligibility` (effective date after service month) | Charles Allen | u96954671 | All | not_expected_pre_eligibility | not_expected_premium_unpaid | not_expected_premium_unpaid | not_expected_premium_unpaid | Broker not commission-eligible until 2026-02-01. Jan is the key assertion month. |
| 4 | Aaliayh Blakemore | `not_expected_premium_unpaid` (positive premium + BO paid_through before service month) | Aaliayh Blakemore | u72991776 | All | not_expected_premium_unpaid | not_expected_premium_unpaid | not_expected_premium_unpaid | not_expected_premium_unpaid | Jan premium $97.12; paid_through_date pre-Jan. Proves the corrected `not_expected_premium_unpaid` definition (positive premium + member-didn't-pay, NOT zero premium). |
| 5 | Aaron Barrett | clean `paid` (happy path) | Aaron Barrett | u96603414 | All | paid | not_expected_premium_unpaid | not_expected_premium_unpaid | not_expected_premium_unpaid | Jan paid_amount 24, EDE + active BO + matched commission. Textbook commission-paid scenario. |
| 6 | Adam Wicht | clean `unpaid` (chase path) | Adam Wicht | u97896137 | All | unpaid | not_expected_premium_unpaid | not_expected_premium_unpaid | not_expected_premium_unpaid | Jan has EDE + active BO + `netBucket = +Net`, no commission. Textbook chase scenario. |
| 7a | Latronda Davis (All scope) | Coverall_or_Vix cross-pay-entity satisfaction | LATRONDA DAVIS | u97385094 | All | paid | not_expected_cancelled | not_expected_cancelled | not_expected_cancelled | Jan paid in Vix ($4.50); cell shows as paid in All-scope. Phase C operator workflow target. |
| 7b | Latronda Davis (Vix scope) | Coverall_or_Vix cross-pay-entity satisfaction | LATRONDA DAVIS | u97385094 | Vix | paid | not_expected_cancelled | not_expected_cancelled | not_expected_cancelled | Same Jan payment surfaces under Vix scope as paid. |
| 7c | Latronda Davis (Coverall scope) | Coverall_or_Vix cross-pay-entity satisfaction | LATRONDA DAVIS | u97385094 | Coverall | unpaid | not_expected_cancelled | not_expected_cancelled | not_expected_cancelled | Coverall scope correctly does NOT auto-classify Vix payment as Coverall-paid. |
| 8 | Deborah Livingston | multi-FFM / cross-pay-entity | Deborah Livingston | u70050073 | All | not_expected_premium_unpaid | not_expected_premium_unpaid | paid | not_expected_premium_unpaid | Identity resolver merges multiple FFM IDs. Mar paid_amount 68. |
| 9a | Thomas Mitchell (All-AOR scope) | wrong-AOR scope leakage negative control | Thomas Mitchell | u96757202 | All | not_expected_cancelled | unpaid | unpaid | unpaid | Current policy AOR: Filipe Iannarelli (21401083). All-AOR sees Feb-Apr as due/unpaid through EDE. |
| 9b | Thomas Mitchell (Coverall scope) | wrong-AOR scope leakage negative control | Thomas Mitchell | u96757202 | Coverall | not_expected_cancelled | not_expected_cancelled | not_expected_cancelled | not_expected_cancelled | Coverall-scope correctly excludes (no due/source flags). Proves AOR scope filter holds. |
| 10 | Lannette Moore | Georgia SBE direct-write / BO-only | Lannette Moore | u71478796 | All | paid | unpaid | unpaid | unpaid | BO-only, no EDE row. Jan paid; Feb-Apr unpaid (chase). BO-only is correct for SBE. |
| 11 | Chasity Harris | `paid_through_date >= statementMonthEnd` correctly chased (R-INELIG-002 sentinel) | Chasity Harris | u70396792 | All | unpaid | unpaid | unpaid | unpaid | Jan BO has paid_through_date 2026-01-31, no commission. Classifier correctly emits `unpaid` (not suppressed). Proves the R-INELIG-002 correction held. |
| 12 | Aaron Higgins | stale-BO contamination excluded by no-source guard | Aaron Higgins | u96806211 | All | not_expected_cancelled | not_expected_premium_unpaid | not_expected_premium_unpaid | not_expected_premium_unpaid | Historical BO rows exist but Jan has no current EDE/active-BO/commission. R-SRC-002 active-BO predicate excludes. |
| 13 | Anthony Lembrick | carrier-recognition badge fires (R-AUDIT-010 Layer 1) | ANTHONY LEMBRICK | u97638656 | All | reversed | unpaid | not_expected_premium_unpaid | not_expected_premium_unpaid | v1 temporary canary; v2 should split into a CR-only canary. Jan cell has `carrier_recognition=true`; test assertion narrowed to "CR badge fires on Jan", not the `reversed` state coverage. |
| 14a | Albert Holder (Vix scope) | Vix vs Coverall scope disambiguation | Albert Holder | u98544697 | Vix | paid | unpaid | not_expected_cancelled | not_expected_cancelled | Jan paid under Vix ($4.50). |
| 14b | Albert Holder (Coverall scope) | Vix vs Coverall scope disambiguation | Albert Holder | u98544697 | Coverall | not_expected_pre_eligibility | not_expected_pre_eligibility | paid | paid | Jan-Feb Coverall scope is not_expected_pre_eligibility (broker not Coverall-eligible until Mar 2026). Mar-Apr Vix payment does NOT count as Coverall-paid; Mar-Apr are Coverall `paid` per the broker's Mar-onward Coverall eligibility. Disambiguation: same member shows `paid` in Vix Jan but not Coverall Jan. |
| 15 | TBD (placeholder) | cross-batch `cleared_then_reversed` (R-PAY-010) | TBD | TBD | All | TBD | TBD | TBD | TBD | No active `cleared_then_reversed` rows in current Jan-Apr Ambetter sidecar. Fills when a real cross-batch case appears (later month or R-PAY-010 logic change). |
