# Source-to-Screen Hardening Plan

Status: historical guardrail plan. MT certification and the MCE rewire have since shipped for the Ambetter Phase A/B scope. Keep this document for field-semantics lessons, but do not use its pre-certification status statements as current implementation truth; cite ROADMAP.md and final verdicts instead.

This is not a standalone Lovable build directive. It is a guardrail plan for preventing more field-semantics mistakes before Member Timeline is certified and before MCE is rewired to consume MT-approved rows.

Use this together with:

- `docs/data-dictionary.md`
- `BUSINESS_RULES.md`
- the active MT Stage 2.1 prerequisite directive
- the future MT source-to-screen certification directive

## Practical Sequencing

Do not stop the current prerequisite work to complete every item in this document.

For the current prerequisite directive, include only the items that directly reduce risk in the touched code:

- required reading of `docs/data-dictionary.md`
- field contradiction grep for touched fields
- targeted canaries for the fields/rules changed
- source-to-screen trace for changed MT outputs
- explicit Red-lane handling for money/status logic

The broader documentation and certification items should become follow-up tasks before MT receives a final "trusted source of truth" certification.

## 1. Source-to-Screen Lineage

Goal: document how raw source fields become screen/export outputs.

For each major money/status screen, trace:

`raw field -> normalized field -> helper/classifier -> screen chip/export value`

Minimum screens:

- Member Timeline
- Missing Commission Export
- Dashboard
- Manual Match
- Unpaid Recovery
- Agent Summary

Starter lineage rows:

| Screen | Raw field | Normalized field | Logic layer | Output | Risk caught |
| --- | --- | --- | --- | --- | --- |
| MT | BO `Member Responsibility` | `member_responsibility` | MT net premium classifier fallback | `unpaid - +Net` or `unpaid - 0Net` chip | Prevents using net premium as commission amount. |
| MT | BO `Broker Effective Date` | `broker_effective_date` | active BO/source support logic | BO source support / in-scope cell | Prevents BO support before broker earns commission. |
| MT | BO `Paid Through Date` | `paid_through_date` | premium-paid / lapse signal only | premium-paid context, not commission-paid exclusion | Prevents suppressing valid chase rows. |
| MT | Commission `Paid-To Date` + `Months Paid` | `paid_to_date`, `months_paid` | service-month payment detection | paid vs unpaid month cell | Prevents paying the wrong service month. |
| MCE | MT-approved future state | audit decision row | MCE export builder | Messer carrier inquiry CSV | Prevents MCE and MT from being separate truth engines. |

Directive use: any directive changing a row in this lineage must update or confirm the lineage.

## 2. Screen Contracts

Goal: define what each screen answers so the app does not have competing truth engines.

Proposed contracts:

| Screen | Contract |
| --- | --- |
| Member Timeline | Shows, by member and service month, whether raw BO/EDE/commission evidence makes the month chase-worthy, review-worthy, paid, or not expected. MT is the intended audit workbench. |
| Missing Commission Export | Until rewired, exports a carrier inquiry list from its own inclusion logic. After MT certification and audit actions, exports MT-approved chase rows only. |
| Dashboard | Summarizes operational health and counts; it should not silently create a different definition of who is owed. |
| Manual Match | Helps resolve identity/source joins; it should not override certified money/status logic without an explicit audit decision. |
| Unpaid Recovery | Recovery workflow surface; should consume certified unpaid/audit state rather than inventing independent eligibility rules. |
| Agent Summary | Agent-level rollup; should summarize certified status and payment evidence, not define member-level chase eligibility. |

Directive use: before changing a screen, state which contract the change supports. If a directive makes MCE and MT answer the same question differently, it must stop or explicitly mark that divergence as temporary.

## 3. Named Canary Ledger

Goal: preserve real-world examples as permanent regression checks.

Each canary should include:

- member name / identifier
- service month
- screen/scope
- raw facts
- expected outcome
- why the outcome is correct
- which rule it protects
- verification status

Canary statuses:

- `CANDIDATE`: identified but not fully source-traced.
- `LOCKED`: source-traced and Jason-confirmed.
- `RETIRED`: no longer applicable after data/schema changes.

Starter canaries to formalize:

| Canary | Service month | Expected protection | Status |
| --- | --- | --- | --- |
| Latronda Davis | Jan 2026 | Erica Coverall-or-Vix payment satisfaction and paid-through semantic do not create false unpaid logic. Exact final expected state must be source-traced under current rules. | CANDIDATE |
| Lannette Moore | Feb/Mar 2026 | Broker term before service-month start means no BO broker support for those months. | CANDIDATE |
| Anna pattern | Feb+ 2026 | Older Coverall EDE AOR must not leak into later months after a newer qualified EDE row shows another AOR. | CANDIDATE |
| Broker-effective-later-than-policy-effective | Example: PED Jan, BED May | BO broker support starts in May, not Jan/Feb/Mar/Apr. | LOCKED SEMANTIC, needs concrete row |
| BO member responsibility fallback | SBE/stale-EDE shape | When no qualified/current EDE exists, BO member responsibility can classify `+Net` vs `0Net`. | LOCKED SEMANTIC, needs concrete row |
| Commission service-month payment | Paid-To Date + Months Paid example | A payment row only clears the service months it actually covers. | NEEDS concrete row |

Current directive minimum: add or preserve targeted tests for any canary class directly touched by the prerequisite directive. Do not block the prerequisite directive on building the full ledger.

## 4. Paid Canary Ledger

This is a subset of the named canary ledger focused on "paid" and "not paid" semantics.

It should protect these distinctions:

| Paid concept | Correct meaning | Bad interpretation to prevent |
| --- | --- | --- |
| BO `Paid Through Date` | Member premium paid-through date. | Agent commission already paid through that date. |
| Commission `Paid-To Date` | End of commission service period paid by a commission row. | Same thing as BO paid-through. |
| `Months Paid` | Number of service months covered by the commission row. | Ignore it and treat paid-to month only as paid. |
| BO `Member Responsibility` | Net premium / member premium responsibility signal. | Commission amount or Messer payout basis. |
| Premium unpaid | Carrier may withhold commission if member premium is not paid. | Treat every positive net premium as automatically commission-due regardless of payment status. |
| Erica Coverall-or-Vix | Either allowed pay entity can satisfy the obligation when the rule applies. | Treat Vix payment as missing in Coverall scope when Erica rule permits it. |

Current directive minimum: if the directive changes any paid/not-paid classifier path, it must include at least one positive and one negative canary for the changed path.

## 5. Field Contradiction Audit

Goal: find stale assumptions after `docs/data-dictionary.md` is updated.

For each directive touching money/status logic, grep at least:

- `paid_through_date`
- `broker_effective_date`
- `broker_term_date`
- `policy_term_date`
- `member_responsibility`
- `eligible_for_commission`
- `paid_to_date`
- `months_paid`

Classify each relevant usage:

- `aligned`
- `intentionally changed by this directive`
- `out of scope but flagged`

Known areas already flagged:

- canonical active-BO helper still has stale paid-through semantics.
- MT active range logic has used `paid_through_date` as an active-range end.
- weak match comments/logic reference paid-through-covered as ineligible.
- reconcile/debug paths may use `paid_through_date` as term-like fallback.

Directive use: a Red-lane directive should not proceed if a stale usage is inside its touched path and not addressed or explicitly carved out.

## 6. Upload Schema/Header Validation

Goal: prevent silent source drift when a carrier export changes.

For each source type, define required headers, optional headers, and meaning-critical headers.

Minimum Ambetter checks:

| Source | Required meaning-critical headers |
| --- | --- |
| BO | `Broker Name`, `Broker NPN`, `Policy Number`, `Broker Effective Date`, `Broker Term Date`, `Policy Effective Date`, `Policy Term Date`, `Paid Through Date`, `Member Responsibility`, `Monthly Premium Amount`, `Exchange Subscriber ID`, `Eligible for Commission` |
| EDE | `issuer`, `exchangeSubscriberId`, `exchangePolicyId`, `issuerPolicyId`, `issuerSubscriberId`, `agentName`, `agentNPN`, `policyStatus`, `effectiveDate`, `premium`, `netPremium`, `currentPolicyAOR` when present |
| Commission | `Policy Number`, `Policyholder Name`, `Writing Agent ID`, `eACID` or `Agent ID`, `Commissionable`, `Gross Commission`, `Paid-To Date`, `Months Paid`, upload pay entity |

Future task: add upload-time validation that warns or fails when meaning-critical headers are missing or renamed.

## 7. Business-Rule Examples

Goal: make rules hard to misread.

For each high-impact rule in `BUSINESS_RULES.md`, add:

- one plain-English example
- one counterexample

Priority examples:

- BO paid-through is premium paid-through, not commission paid-through.
- broker effective date starts commission support.
- broker/policy term inside the month supports that month but not the next.
- BO member responsibility is net premium evidence, not commission payout.
- MCE will eventually export MT-approved rows, not independently define truth.

Directive use: if a directive changes a business rule, include the example/counterexample in the same update or explain why it is deferred.

## 8. Certification Checklist Before MT Is Trusted

Before MT is certified as source-to-screen accurate, require:

- raw file trace for sampled/certified rows
- normalized record trace
- classifier/helper trace
- UI cell/chip trace
- export trace if the row can feed an export
- named canary pass
- paid canary pass
- no unresolved field-semantics questions in `docs/data-dictionary.md`
- contradiction grep clean for touched fields
- explicit list of any remaining out-of-scope risks

Certification statement should say exactly what is certified:

- raw-to-normalized mapping
- normalized-to-classifier logic
- classifier-to-screen rendering
- screen-to-export behavior, if applicable

It should not claim MT is "100% accurate" for workflows that still require human audit decisions unless those decisions are included in the certified path.

## Recommended Task Split

Immediate, inside the active prerequisite directive:

- field-semantics authority
- stale paid-through cleanup
- BED-aware BO support
- member responsibility fallback semantics
- targeted canaries for changed logic
- field contradiction grep for touched paths

Near-term, before MT source-to-screen certification:

- formal named canary ledger file
- source-to-screen lineage for MT
- MT screen contract
- full field contradiction audit for MT paths
- certification checklist execution

Later, before MCE rewire:

- MCE screen contract update
- MCE export lineage
- MCE consumes MT-approved rows
- MCE/MT agreement invariant based on shared audit decisions

