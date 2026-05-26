# Data Dictionary and Field Semantics

Status: first authoritative cut.

This document defines what imported fields mean before the application uses them for matching, commission status, carrier inquiry exports, or audit screens. It is based on the current repo adapters, canonical rules, and Jason-confirmed corrections. It intentionally separates confirmed business meaning from current code behavior and open questions.

## Confidence Labels

- `LOCKED`: Jason-confirmed or already codified as a governing business rule.
- `CODED`: Current application behavior verified in source, but the business meaning may still need confirmation before new logic depends on it.
- `NEEDS_CONFIRMATION`: Do not use for new money/status logic without Jason confirmation.
- `KNOWN_CONTRADICTION`: Current code, docs, or prior verdicts conflict with confirmed meaning.

## Core Guardrails

- Never infer a field's meaning from its name alone.
- Every field belongs to an entity: member, policy, broker/AOR, commission, or upload/file metadata.
- A field can be valid for display or matching and still be unsafe as a money/status rule.
- `paid_through_date` in Back Office means member premium paid-through date. It is not commission paid-through.
- Any Red-lane directive that uses a `NEEDS_CONFIRMATION` field must stop and ask Jason.

## Source Authority

For raw field meaning: Jason-confirmed carrier semantics override repo code, repo code overrides working summaries, and working summaries override chat memory.

For current app behavior: source adapters and canonical helpers override page-level assumptions.

For certification: verdict files in `codex-comm/verdicts/` override draft directives and chat summaries, unless a later Jason-confirmed business correction supersedes the verdict.

## Ambetter Back Office

Source adapter: `src/lib/carriers/ambetter/backOffice.ts`.

| Raw field | Normalized field(s) | Entity | Meaning and allowed use | Confidence |
| --- | --- | --- | --- | --- |
| `Broker Name` | `agent_name` | Broker/AOR | Back Office broker name. Can support carrier-recognition only when paired with mapped broker NPN and an active service-month BO record. | CODED |
| `Broker NPN` | `agent_npn`, `aor_bucket` | Broker/AOR | Broker NPN used to map the BO row to official AOR scope. Must remain a string. It is not a commission pay entity by itself. | LOCKED |
| `Policy Number` | `policy_number`, `issuer_subscriber_id` | Policy / member identity | In Ambetter BO, this column carries the U-style subscriber/policy identifier. Current adapter stores a cleaned ID as `policy_number` and a subscriber-normalized value as `issuer_subscriber_id`. | CODED |
| `Plan Name` | raw JSON only | Policy | Plan label from BO. Currently not a typed normalized business-rule input. Display/research only unless promoted deliberately. | CODED |
| `Insured First Name` | `first_name` | Member identity | Member first name. Match/display support only; not a standalone money rule. | CODED |
| `Insured Last Name` | `last_name` | Member identity | Member last name. Match/display support only; not a standalone money rule. | CODED |
| `Broker Effective Date` | `broker_effective_date` | Broker/AOR | Date the broker is officially tied to the consumer and begins earning commission. BO broker support begins in the broker-effective service month, not earlier policy-effective months. Example: policy effective Jan 1 and broker effective May 1 means no BO broker support for March. | LOCKED |
| `Broker Term Date` | `broker_term_date` | Broker/AOR | Date the BO broker relationship ends. `12/31/9999` means no known broker term and is normalized to null. A broker term inside the service month is still active for that month; the following month is not active. | LOCKED |
| `Policy Effective Date` | `effective_date` | Policy | Policy coverage effective date. It is not always the same as broker attribution start. | CODED |
| `Policy Term Date` | `policy_term_date` | Policy | Policy termination date. A policy term inside the service month is still active for that month; the following month is not active. | LOCKED |
| `Paid Through Date` | `paid_through_date` | Member billing / premium | Member premium paid-through date. This means how far the member has paid premium to the carrier. It does not mean the agent has been paid commission through that date. Future paid-through is not a commission-paid exclusion. | LOCKED |
| `Member Responsibility` | `member_responsibility` | Member billing / premium | Member-paid premium responsibility. Can be used as BO fallback evidence for `+Net` / `0Net` when EDE is missing or unusable, after BO scope is otherwise confirmed. It may appear in audit/debug detail to explain the classification, but normal MT chips should stay as `+Net` / `0Net`. It is not a commission amount. | LOCKED |
| `Monthly Premium Amount` | `premium` | Policy premium | Gross monthly premium from BO. Not the same as net premium/member responsibility and not a direct commission-due amount. | CODED |
| `On/Off Exchange` | `on_off_exchange` | Policy/channel | Exchange channel indicator. Useful for research and segmentation. No current hard money rule without a directive. | CODED |
| `Exchange Subscriber ID` | `exchange_subscriber_id` | Member identity | Exchange subscriber identifier. Used as an identity key after subscriber normalization. | CODED |
| `Member Date Of Birth` | `dob` | Member identity | Member DOB for match/profile support. Not a standalone commission rule. | CODED |
| `Eligible for Commission` | `eligible_for_commission` | Commission eligibility | BO eligibility flag. `No` is a hard disqualifier under current canonical active-BO logic. Blank/unknown requires care and should not be over-interpreted. | LOCKED |
| `Policy Status` | raw JSON / optional normalized status | Policy status | BO policy status. Dates govern when BO dates and BO status disagree. Do not let BO status override active/inactive date windows without a separate Jason-approved rule. | LOCKED |

### Back Office Warnings

- Do not use `paid_through_date >= month_end` as proof that commission was already paid.
- Do not use a BO row as AOR support unless the BO broker is in scope and the service month is inside the broker/policy active window.
- Do not use `Member Responsibility` as a direct commission amount.

## EDE

Source adapter: `src/lib/normalize.ts`.

| Raw field | Normalized field(s) | Entity | Meaning and allowed use | Confidence |
| --- | --- | --- | --- | --- |
| `issuer` / `Issuer` | carrier detection | Upload/policy | Used to detect Ambetter EDE rows when issuer contains Ambetter. | CODED |
| `applicantName` | `applicant_name` | Member identity | Applicant/member name. Match/display support. | CODED |
| `applicantFirstName` | `first_name` | Member identity | Member first name. Match/display support. | CODED |
| `applicantLastName` | `last_name` | Member identity | Member last name. Match/display support. | CODED |
| `exchangeSubscriberId` | `exchange_subscriber_id` | Member identity | Exchange subscriber key after subscriber normalization. | CODED |
| `exchangePolicyId` | `exchange_policy_id` | Policy identity | Exchange policy key. Clean as ID, not as subscriber ID. | CODED |
| `issuerPolicyId` | `issuer_policy_id` | Policy identity | Issuer policy key. Clean as ID, not as subscriber ID. | CODED |
| `issuerSubscriberId` and variants | `issuer_subscriber_id` | Member identity | Issuer subscriber key, including U-style Ambetter subscriber IDs. Used for cross-source identity. | CODED |
| `agentName` | `agent_name` | Broker/AOR | EDE agent name. Current source only; must not be treated as historical service-month AOR without month-aware selection. | CODED |
| `agentNPN` | `agent_npn`, `aor_bucket` | Broker/AOR | Writing/current agent NPN from EDE. Important scope signal, but older EDE rows must not leak forward into later service months. | LOCKED |
| `policyStatus` | `status` | Policy status | Qualified statuses include `effectuated`, `pending effectuated`, and `pending termination`. Cancelled/terminated/expired rows should not support active chase state. | LOCKED |
| `effectiveDate` | `effective_date` | Policy | Coverage effective date from EDE. Pre-effective rows do not create service-month commission chase eligibility. | LOCKED |
| `premium` | `premium` | Premium | EDE premium amount. Gross/policy premium, not commission amount. | CODED |
| `netPremium` | `net_premium` | Member billing / premium | EDE net premium for the member/policy. Used for `+Net` vs `0Net` month classification when the EDE row is qualified for the service month. | LOCKED |
| `autoRenewal` | `auto_renewal` | Policy metadata | Renewal metadata. Current display/research support. | CODED |
| `policyOriginType` | `ede_policy_origin_type` | Policy metadata | EDE policy-origin metadata. Current display/research support. | CODED |
| `bucket` | `ede_bucket` | Upload/source metadata | EDE bucket/category metadata. Current display/research support. | CODED |
| `policyModifiedDate` | `policy_modified_date` | Policy metadata | EDE modification timestamp/date. Useful for row recency selection. | CODED |
| `currentPolicyAOR` | raw JSON / page-level use | Broker/AOR | Current policy AOR from EDE exports when present. It can resolve AOR for the row, but service-month use must be month-aware. | CODED |

### EDE Warnings

- Do not let a historical Coverall EDE row admit a later service month when a newer qualified row shows a different AOR for that month.
- Do not treat cancelled, terminated, or expired EDE rows as active premium/source support.
- Do not include pre-effective members in carrier inquiry exports for earlier service months.

## Commission Statements

Source adapter: `src/lib/normalize.ts`.

| Raw field | Normalized field(s) | Entity | Meaning and allowed use | Confidence |
| --- | --- | --- | --- | --- |
| `Database` / `companyId` | carrier detection | Upload metadata | Used to detect Ambetter commission rows when source metadata contains Ambetter. | CODED |
| `Policy Number` | `policy_number`, `issuer_subscriber_id` | Member/policy identity | Ambetter commission policy number currently behaves as U-style subscriber identifier. Stored as both cleaned policy ID and subscriber-normalized ID. | CODED |
| `Policyholder Name` | `applicant_name` | Member identity | Member name on commission statement. Match/display support. | CODED |
| `Agent Name` | `agent_name` | Commission / broker | Agent name on commission row. Useful for audit; not by itself proof of current AOR scope. | CODED |
| `Writing Agent ID` | `agent_npn` | Commission / broker | Writing agent identifier. Used for matching/audit. Not equivalent to official AOR by itself. | CODED |
| `eACID` / `Agent ID` | `writing_agent_carrier_id` | Commission / broker | Carrier-side writing agent ID. `eACID` is preferred when present, then `Agent ID`. | CODED |
| upload pay entity slot | `pay_entity` | Commission payment entity | Which entity received the commission file/payment, e.g. Coverall or Vix. Required for service-month payment detection. | LOCKED |
| `Policy Status` | `status` | Policy status | Status text on commission statement. Audit context; not a standalone active-policy truth. | CODED |
| `Issue Date` | `effective_date` | Policy | Issue/effective date carried by commission statement. Context for payment record. | CODED |
| `Commissionable` | `premium` | Commission basis | Premium/commissionable basis on the commission statement. Not the commission paid amount. | CODED |
| `Gross Commission` | `commission_amount` | Commission payment | Dollar commission paid on the statement row. Service-month and pay-entity scope still matter. | LOCKED |
| `Paid-To Date` | `paid_to_date` | Commission payment period | Commission paid-through/service-period endpoint. This is the commission-side paid-to field, unlike BO `Paid Through Date`. | LOCKED |
| `Months Paid` | `months_paid` | Commission payment period | Number of months covered by the commission row. Used with paid-to date to infer service months paid. | LOCKED |

### Commission Statement Warnings

- BO `Paid Through Date` and commission `Paid-To Date` are different fields on different entities.
- A commission row only satisfies a service month when payment period, identity, and allowed pay entity all match the question being asked.
- Erica Fine has a Coverall-or-Vix pay entity rule in current business logic; directives touching pay entity satisfaction must explicitly account for it.

## Identity and Normalization Rules

| Concept | Rule | Confidence |
| --- | --- | --- |
| Subscriber IDs | Use subscriber normalization only for subscriber-id fields. Purely numeric subscriber IDs lose leading zeros. | CODED |
| Policy IDs | Use ID cleaning, not subscriber normalization, for policy-number-as-policy-number, exchange policy ID, issuer policy ID, agent NPN, and carrier agent IDs. | CODED |
| Ambetter U identifiers | BO `Policy Number`, EDE issuer subscriber ID, and commission `Policy Number` often align as U-style subscriber identifiers, but each normalized field's role still matters. | CODED |
| Names | Names are match/display support, not primary source-of-truth when stronger IDs exist. | LOCKED |
| DOB | DOB can support identity resolution but is not currently a money/status rule. | CODED |

## Current Known Contradictions

| Topic | Contradiction | Required action |
| --- | --- | --- |
| BO paid-through | Confirmed meaning says member premium paid-through. Existing canonical helper and some rules previously treated it as commission-paid exclusion. | Remove hard exclusion from canonical active-BO logic and update stale rule text. |
| Broker effective date | BO adapter stores `broker_effective_date`, and Jason confirmed it is the broker commission-support start date. Current active-BO logic may not consistently enforce it. | Enforce broker-effective service-month start before MT certification. |
| BO member responsibility | Field is approved as BO fallback for zero-vs-positive premium classification when EDE is missing or unusable. | Audit/debug detail may show the value; normal MT chips should not. Ensure directives do not treat the value as commission dollars. |
| Carrier-recognition | BO broker can keep a cell in scope when EDE shows another AOR, but only if the BO record is active and mapped to a Coverall official AOR. | Enforce NPN-map gate and active-month gate in MT work. |
| MCE / MT source of truth | MT is intended to become audit source of truth, but MCE is not yet rewired to MT-approved rows. | Certify MT source-to-screen, add audit decisions, then rewire MCE. |

## Directive Rules

- Any directive using a data field must cite this dictionary or explain why the field is outside it.
- Any directive changing money/status logic is Red lane unless it is strictly UI-only.
- Any directive changing labels, chips, badges, or export columns is at least Yellow lane.
- Schema changes stop the workflow and require Jason confirmation.
- If a field meaning is `NEEDS_CONFIRMATION`, the directive must ask Jason before implementation.
- If code behavior conflicts with a `LOCKED` meaning, the code is wrong unless Jason explicitly changes the business rule.

## Open Questions

No open field-semantics questions as of 2026-05-26. New money/status use of fields not listed here still requires review before implementation.
