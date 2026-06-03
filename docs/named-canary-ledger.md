# Named Canary Ledger

**Version:** v1
**Last updated:** 2026-06-03

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
| 4 | Aaliayh Blakemore | re-ledgered under alias-aware BO supersession | Aaliayh Blakemore | u72991776 | All | not_expected_cancelled | not_expected_cancelled | not_expected_cancelled | not_expected_cancelled | Latest authoritative BO `policy_term_date = 2025-12-31`. Pre alias-fix: baseline `not_expected_premium_unpaid` held all four months; post-fix: alias-aware supersession (`cc|sub:u72991776` bridge for EDE rows with blank `policy_number`) flips all four months to `not_expected_cancelled`. |
| 5 | Aaron Barrett | clean `paid` (happy path) | Aaron Barrett | u96603414 | All | paid | not_expected_premium_unpaid | not_expected_premium_unpaid | not_expected_premium_unpaid | Jan paid_amount 24, EDE + active BO + matched commission. Textbook commission-paid scenario. |
| 6 | Adam Wicht | clean `unpaid` (chase path) | Adam Wicht | u97896137 | All | unpaid | not_expected_premium_unpaid | not_expected_premium_unpaid | not_expected_premium_unpaid | Jan has EDE + active BO + `netBucket = +Net`, no commission. Textbook chase scenario. |
| 7a | Latronda Davis (All scope) | Coverall_or_Vix cross-pay-entity satisfaction | LATRONDA DAVIS | u97385094 | All | paid | not_expected_cancelled | not_expected_cancelled | not_expected_cancelled | Jan paid in Vix ($4.50); cell shows as paid in All-scope. Phase C operator workflow target. |
| 7b | Latronda Davis (Vix scope) | Coverall_or_Vix cross-pay-entity satisfaction | LATRONDA DAVIS | u97385094 | Vix | paid | not_expected_cancelled | not_expected_cancelled | not_expected_cancelled | Same Jan payment surfaces under Vix scope as paid. |
| 7c | Latronda Davis (Coverall scope) | Coverall_or_Vix cross-pay-entity satisfaction | LATRONDA DAVIS | u97385094 | Coverall | unpaid | not_expected_cancelled | not_expected_cancelled | not_expected_cancelled | Coverall scope correctly does NOT auto-classify Vix payment as Coverall-paid. |
| 8 | Deborah Livingston | multi-FFM / cross-pay-entity | Deborah Livingston | u70050073 | All | not_expected_premium_unpaid | not_expected_premium_unpaid | paid | not_expected_premium_unpaid | Identity resolver merges multiple FFM IDs. Mar paid_amount 68. |
| 9a | Thomas Mitchell (All-AOR scope) | wrong-AOR scope leakage negative control | Thomas Mitchell | u96757202 | All | not_expected_cancelled | unpaid | unpaid | unpaid | Current policy AOR: Filipe Iannarelli (21401083). All-AOR sees Feb-Apr as due/unpaid through EDE. |
| 9b | Thomas Mitchell (Coverall scope) | wrong-AOR scope leakage negative control | Thomas Mitchell | u96757202 | Coverall | not_expected_cancelled | not_expected_cancelled | not_expected_cancelled | not_expected_cancelled | Coverall-scope correctly excludes (no due/source flags). Proves AOR scope filter holds. |
| 10 | Lannette Moore | re-ledgered under alias-aware BO supersession | Lannette Moore | u71478796 | All | paid | not_expected_cancelled | not_expected_cancelled | not_expected_cancelled | Latest authoritative BO `policy_term_date = 2026-01-27`. Jan still paid (commission landed). Feb–Apr: pre alias-fix baseline `unpaid`; post-fix supersession flips to `not_expected_cancelled`. |
| 11 | Chasity Harris | `paid_through_date >= statementMonthEnd` correctly chased (R-INELIG-002 sentinel) | Chasity Harris | u70396792 | All | unpaid | unpaid | unpaid | unpaid | Jan BO has paid_through_date 2026-01-31, no commission. Classifier correctly emits `unpaid` (not suppressed). Proves the R-INELIG-002 correction held. |
| 12 | Aaron Higgins | re-ledgered under alias-aware BO supersession | Aaron Higgins | u96806211 | All | not_expected_cancelled | not_expected_cancelled | not_expected_cancelled | not_expected_cancelled | Latest authoritative BO `policy_term_date = 2026-01-15`. Jan already `not_expected_cancelled` via stale-source guard; Feb–Apr were baseline `not_expected_premium_unpaid` and post alias-fix flip to `not_expected_cancelled`. |
| 13 | Darrell Crutcher | carrier-recognition badge fires (R-AUDIT-010 Layer 1), CR-only | DARRELL CRUTCHER | u73043122 | Coverall | paid | unpaid | unpaid | unpaid | Jan cell has `carrier_recognition=true` and classifier state `paid` (not `reversed`). CR fires because active in-scope Jason BO supports the cell while the picked EDE row shows out-of-scope current AOR `Michael Farago (20629024)`; Jan Coverall commission pays `$24.00`. Replaces Anthony Lembrick (v1 two-for-one; reversed-state coverage retained by slot 1 Dannielle). |
| 14a | Albert Holder (Vix scope) | Vix vs Coverall scope disambiguation | Albert Holder | u98544697 | Vix | paid | unpaid | not_expected_cancelled | not_expected_cancelled | Jan paid under Vix ($4.50). |
| 14b | Albert Holder (Coverall scope) | Vix vs Coverall scope disambiguation | Albert Holder | u98544697 | Coverall | unpaid | unpaid | paid | paid | Jan-Feb: Coverall scope IS eligible (Erica NPN Coverall_or_Vix brings Jan BO into Coverall scope; first-eligible = Jan 2026 per `computeFirstEligibleMonth` earliest-across-all semantic), but Coverall has no Jan-Feb commission rows so cells emit unpaid. Mar-Apr: Coverall commissions land starting Mar. Disambiguation: same member shows `paid` in Vix Jan but `unpaid` in Coverall Jan. |
| 15 | TBD (placeholder) | cross-batch `cleared_then_reversed` (R-PAY-010) | TBD | TBD | All | TBD | TBD | TBD | TBD | No active `cleared_then_reversed` rows in current Jan-Apr Ambetter sidecar. Fills when a real cross-batch case appears (later month or R-PAY-010 logic change). |
| 16a | Josie Martinez (All scope) | cross-batch BO term-date supersession (Phase B fix) | JOSIE MARTINEZ | u96466529 | All | paid | reversed | not_expected_cancelled | not_expected_cancelled | April BO file (`policies_20260413104442.csv`) corrects `policy_term_date` to `2026-01-31`; earlier Jan/Feb BO rows had a later term. With the supersession overlay, Mar/Apr fall to `not_expected_cancelled` via the stale-source guard (reason carries `Superseded by later BO termination` marker). Pre-fix: Mar/Apr were `unpaid`. |
| 16b | Josie Martinez (Coverall scope) | cross-batch BO term-date supersession (Phase B fix) | JOSIE MARTINEZ | u96466529 | Coverall | paid | reversed | not_expected_cancelled | not_expected_cancelled | Same supersession under Coverall scope. |
