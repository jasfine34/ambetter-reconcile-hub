# Jason Decision Summary - Card Document Definitions

Status: interpretation draft for Jason confirmation  
Source reviewed: `card-document-definitions-jason-review-v1.docx`  
Purpose: summarize Jason's first-pass answers into confirmed decisions, open questions, and next implementation work.

This document is not yet the final business contract. It is Codex's interpretation of Jason's tracked edits. Jason should confirm or correct these interpretations before they are folded into the main Card Document Definitions.

## Confirmed Decisions

### 1. Source Funnel should be scoped

Decision: Source Funnel should change when the user switches Coverall / Vix / All.

Reasoning from Jason: the main Dashboard should identify what is expected from the FFM EDE platform and track breakage from EDE to Back Office to carrier payment. Downline, legacy AOR, and state-based exchange payments should still be visible, but they should be separated so they do not confuse the core EDE reconciliation flow.

Implementation implication:

- Do not leave Source Funnel as an unlabeled whole-batch card under the scope dropdown.
- Either wire scope into the funnel or redesign it into clearly separated scoped sections.

### 2. Vix enrollment members being inside Coverall is correct

Decision: It is correct that Vix enrollment members are treated as a subset of Coverall enrollment members under the enrollment/AOR view.

Implementation implication:

- Do not force Coverall + Vix = All for enrollment-style cards.
- UI may still need to explain this overlap in plainer terms.

### 3. Not in Back Office split is operationally useful

Decision: The current split into disputable / waiting / weak match makes sense.

New question from Jason: do we need a "submitted to carrier for reconciliation" holding status, where records can later resolve through a file upload or be removed if the carrier denies?

Drilldown/export decision: the **Not in Back Office** drilldown should support tabs or equivalent filters for **All**, **Has Issuer ID**, and **Missing Issuer ID**.

General export rule: any drilldown/export screen that offers tabs should allow both **Export Current Tab** and **Export All**. Not in Back Office is the first confirmed use case, but the export behavior should be consistent wherever tabbed drilldowns exist.

Implementation implication:

- Keep the current split.
- Consider a future workflow/status for carrier-submitted reconciliation items.

### 4. Weak Match workflow is good, with upload-based auto-clear

Decision: Current weak match workflow works well for Ambetter after the latest fixes.

Jason's condition: if "auto-resolve later" means a future upload supplies missing data and cures the weak match, then yes. Otherwise, do not auto-resolve purely by confidence.

Implementation implication:

- Future uploads should naturally clear weak matches if new data creates a strict match.
- Do not add speculative auto-confirm behavior yet.
- Other carriers remain TBD.

### 5. Total Covered Lives wording is clear enough

Decision: current wording makes clear enough that Vix means Erica AOR for Total Covered Lives.

Implementation implication:

- No immediate wording change required for TCL.

### 6. Should Be Paid should reflect what is due by scope

Decision: For Coverall scope, Should Be Paid should reflect what is due Coverall. For Vix scope, it should reflect what is due Vix.

Additional intent: if a member was Vix but the AOR changes to Jason later, the member should move accordingly.

Flexibility: if implementing this precisely becomes too complex, using the same Vix definition as Expected Enrollments may be acceptable.

Important expansion: Jason wants EDE-eligible members missing from Back Office included or represented until the gap is resolved.

Implementation implication:

- Current "Should Be Paid" may be too narrow if it excludes EDE-eligible but missing-from-BO members from the operational expected-payment picture.
- Before building, Jason needs to choose the display shape:
  - expand the existing card so it includes both BO-confirmed expected payments and EDE-only missing-from-BO items
  - keep one main card but show an internal split, for example "confirmed expected payments" plus "pending BO resolution"
  - create two related cards, one for confirmed expected payments and one for EDE-only pending items
- Do not assume the answer is "two cards." Jason's edits sound closer to expanding the existing operational recovery view, but the exact layout needs confirmation.

### 7. Paid Commission Records should be based on where money paid

Decision: Paid Commission Records should count based on where payment occurred, not the broad Dashboard mixed filter.

Implementation implication:

- This card should likely move from the loose Dashboard filter to a payment/pay-entity based count.
- This is a good candidate for a focused Lovable ticket after document decisions are confirmed.

### 8. Paid Within Eligible Cohort should be renamed

Decision: the concept is useful, but the label is not plain enough.

Preferred plain-English label from Jason: **Expected Payments Received**.

Implementation implication:

- Rename card/labels/tooltips from "Paid Within Eligible Cohort" toward "Expected Payments Received," if the underlying definition remains members expected to be paid who did receive commission.

### 9. Unpaid Policies is the main recovery target

Decision: yes, Unpaid Policies should be the main recovery target.

Additional desired breakdown: Jason wants to see how many unpaid/missing records are tied to zero-net-premium plans versus plans with net premium due.

Reason: this helps distinguish likely unpaid-premium issues from missing commission that remains unexplained.

Implementation implication:

- Add a future breakdown/split for zero-net-premium versus premium-due on unpaid/missing recovery cards or drilldowns.
- Jason specifically suggested a split-number display on the card, similar to the Expected Enrollments month breakdown style. The design should not bury this only inside an export.

### 10. Net Paid should remain money-flow based

Decision: Net Paid should continue to be based on actual money flow, even if AOR is blank, downline, former, or otherwise not a current active Coverall AOR.

Implementation implication:

- Do not force Net Paid into EDE/AOR scope.
- Keep downline/former/legacy money visible in money-flow views.

### 11. Allen / Hantz / Scott should remain Downline/Override for now

Decision: Allen Ford, Hantz Pierre, and Scott O'Toole should stay in Downline/Override; no separate bucket is needed right now.

Jason's note: the current Net Paid breakout is fine.

Implementation implication:

- Do not use `COVERALL_OWNED_WRITING_NPNS` to move these into direct Coverall.
- The map can still help classify/label/audit Coverall-owned writing-agent cases.

### 12. Clawback popup/export is useful, but should consolidate rows

Decision: the clawback detail popup and export are useful.

Desired improvement:

- Consolidate multi-row chargebacks by member.
- Example: if one person is charged back for 3 months, show one member-level row with total charged back, timeframe, and number of months.
- Add bottom totals: number of members, number of months, total amount, and earliest-to-latest date span.

Implementation implication:

- Future Lovable ticket: improve clawback detail modal/export grouping.

### 13. Est. Missing Commission should align with the unpaid/export calculation

Decision: Est. Missing Commission should use the same dollar calculation as the Missing Commission Export, assuming "official unpaid recovery list" means Unpaid Policies / export rows.

Jason caveat: needs better understanding of how downline payment could be considered missing if the member is not in our EDE or Back Office.

Implementation implication:

- Move toward aligning Est. Missing Commission with the Missing Commission Export.
- Do not silently hide the 5 junk/downline AOR missing-dollar rows until the business meaning is discussed.
- This is not a safe immediate build ticket yet. It needs a short data-flow audit first: where did the `estimated_missing_commission` dollars on those 5 rows come from, and why were they identified as missing?

### 14. Source Coverage should separate core Coverall/Vix from downline/legacy/SBE cases

Decision direction: Source Coverage should distinguish core Coverall/Vix expected business from downline/legacy AOR and state-based exchange cases.

Jason's examples:

- Paid but missing from EDE may be tied to SBE enrollments.
- A Coverall AOR might auto-renew but not be rewritten in EDE, for example Becky Shuta.
- This could appear in Back Office but not EDE and should be visible without confusing the main EDE-based reconciliation.

Implementation implication:

- Source Coverage likely needs clearer naming and/or sub-buckets.
- Do not collapse all non-EDE paid rows into one ambiguous label.

### 15. Exception Summary should be scoped to Dashboard dropdown

Decision: Dashboard Exception Summary should follow the Dashboard scope dropdown.

Additional observed issue: in Feb 2026, "Paid but Missing from EDE" showed 128 in Exception Summary but 56 in Source Coverage. Jason suspects this may be a labeling/definition issue.

Implementation implication:

- Scope Exception Summary to the Dashboard dropdown.
- Audit similarly named issue/category labels to distinguish:
  - exists in Ambetter/Back Office but missing from EDE
  - paid on commission statement but missing from EDE

### 16. Missing Commission Export parity is the test for item 13

Decision: yes, Est. Missing Commission should use the same dollar calculation as the export, subject to the caveat above about understanding downline/junk-AOR missing dollars.

Implementation implication:

- Future contract should define one official missing-commission dollar calculation.
- Treat this as the parity test for item 13, not as a separate build decision. After the definition is settled, the Dashboard card and Missing Commission Export should match for the same batch and scope.

## New Business Concepts Jason Introduced

## New Source Coverage / Exception Summary Decisions

These decisions came from Jason's card-by-card review after the 128 vs 56 audit and the "uz..." commission-only audit. They should be treated as the current working direction for the Source Coverage and Exception Summary redesign.

### Source Coverage labels and card meanings

Split label decision: use compact card labels **EF** and **DL** to preserve spacing. Define them in tooltip/help text as **EF = Erica Fine** and **DL = Downline / legacy / owned-writing rows**.

Split priority decision: when one row could fit more than one bottom-split bucket, classify it in this order: **SBE first, then DL, then EF, then Core**. This keeps the split rows from being double-counted and makes the bucket totals add back to the card total.

Label style decision: use colon-style labels for state/source cards, for example **Paid: Back Office Only**, **Paid: Commission Statement Only**, and **Unpaid: Back Office Only**. This is more compact and easier to read than hyphen-separated labels.

#### Fully Matched & Paid

Decision: keep label as **Fully Matched & Paid**.

Plain meaning:

- EDE has it.
- Back Office has it.
- Commission was paid.

#### Paid: Back Office Only

Decision: rename **Paid but Missing from EDE** to **Paid: Back Office Only**.

Plain meaning:

- Commission was paid.
- Back Office has the policy.
- EDE does not have the policy.

Jason's rationale: this cleanly describes the data state without guessing the cause. Some rows may later resolve through SBE uploads, auto-renewal evidence, or other carrier/back-office timing issues.

Display: one number only. No EF/DL split needed on this card.

#### Paid: Commission Statement Only

Decision: rename **Commission Statement Only** to **Paid: Commission Statement Only**.

Plain meaning:

- Commission was paid.
- The row appears only on the commission statement.
- It is not in EDE and not in Back Office.

Display: add a bottom split:

- **EF** = Erica Fine rows.
- **DL** = all other downline / legacy / owned-writing rows.

Rule: **EF + DL must equal the card total.**

#### Unpaid: Back Office Only

Decision: rename **Back Office Only (Not Paid)** to **Unpaid: Back Office Only**.

Plain meaning:

- Back Office has the policy.
- No commission was paid.
- EDE does not have the policy.

Jason's rationale: these are a subset of missing commissions to chase. The useful split is where to look next.

Display: add a bottom state/channel split:

- **FFM** count.
- Individual SBE state counts where present, for example **GA**, **IL**, etc.

Rule: **FFM + each SBE state count must equal the card total.**

#### Expected But Unpaid

Decision: rename **Unpaid Expected Policies** to **Expected But Unpaid**.

Definition consistency decision: **Expected But Unpaid must use the same logic everywhere it appears.** Do not create two different cards or panels with the same label but different rules.

Plain meaning:

- We expected payment.
- Payment was not received.

Expanded definition direction: this should be part of the broader expected-payment universe, not only the current narrow EDE + BO + eligible predicate.

Display: one card with bottom split:

- **Confirmed** = EDE + Back Office confirms the policy.
- **BO Only** = Back Office shows the policy, EDE does not.
- **EDE Only** = EDE shows the policy, Back Office does not yet confirm it.

Rule: **Confirmed + BO Only + EDE Only must equal the card total.**

Premium split, if feasible:

- **$0 Prem** = EDE `netPremium` is zero.
- **Prem Due** = EDE `netPremium` is greater than zero.
- **No EDE/SBE** = rows where premium cannot be reliably determined from EDE, including SBE or Back-Office-only rows without EDE premium data.

Jason note: premium status should come from EDE `netPremium`; rows without reliable EDE premium data should fall into No EDE/SBE rather than forcing a false zero/premium classification.

#### Total Policies Paid

Decision: rename **Total Paid (All Sources)** to **Total Policies Paid**.

Plain meaning:

- Counts paid policy/member records, not covered lives.
- A policy with two covered people still counts as one policy/member record.

Display: add bottom split:

- **Core**
- **EF**
- **DL**
- **SBE**

Rule: **Core + EF + DL + SBE must equal Total Policies Paid.**

SBE should stay separate from Core because the app already treats GA/IL/NJ/PA state-based exchange rows as intentional non-FFM cases.

#### Paid Outside Current EDE

Decision: rename **Paid Outside Expected Universe** to **Paid Outside Current EDE**.

Plain meaning:

- Commission was paid.
- The policy is outside the current EDE expected-enrollment universe.

Display: add bottom split:

- **Core**
- **EF**
- **DL**
- **SBE**

Rule: **Core + EF + DL + SBE must equal the card total.**

Jason chose **Core** as the label for regular Coverall / non-Erica / non-downline paid rows. EF means Erica Fine. DL means downline / legacy / owned-writing rows. SBE means state-based / non-FFM rows.

### Top expected-payment cards

#### Should Be Paid

Decision: broaden **Should Be Paid** into the full expected-payment universe.

Plain meaning:

- Policies we believe should generate payment.

Display: one card with bottom split:

- **Confirmed** = EDE + Back Office.
- **BO Only** = Back Office only.
- **EDE Only** = EDE only / needs Back Office resolution.

Rule: **Confirmed + BO Only + EDE Only must equal Should Be Paid.**

Jason confirmed EDE Only should be included in Should Be Paid, but shown explicitly in the bottom split. If carrier review later denies the item, it should be manually removed/closed from this expected-payment universe.

Jason also confirmed **BO Only** should be included in Should Be Paid. If Back Office shows an active/eligible policy, the app should treat it as expected to pay even when the policy is missing from EDE. The bottom split must show those rows as **BO Only** so the larger total is explainable.

#### Expected Payments Received

Decision: rename **Paid Within Eligible Cohort** to **Expected Payments Received** and broaden it to match the expected-payment universe.

Plain meaning:

- Policies we expected payment on, and payment was received.

Display: one card with bottom split:

- **Confirmed**
- **BO Only**
- **EDE Only**

Rule: **Confirmed + BO Only + EDE Only must equal Expected Payments Received.**

Jason confirmed BO-only paid rows should be included because if the policy is in Back Office, we expected payment even if it is missing from EDE.

#### Expected But Unpaid

Decision: top-level **Unpaid Policies** should align with **Expected But Unpaid**.

Plain meaning:

- Policies we expected payment on, but payment was not received or still needs resolution.

Display: same bottom split:

- **Confirmed**
- **BO Only**
- **EDE Only**

Rule: **Confirmed + BO Only + EDE Only must equal Expected But Unpaid.**

### Cards that stay EDE-only

These cards should remain tied strictly to the current EDE expected-enrollment universe:

- **Expected Enrollments**
- **Not in Back Office**
- **Total Covered Lives**

Do not expand these with BO-only, commission-only, SBE-only, or downline/legacy rows unless those rows are actually in the EDE file.

### Net Paid and money-flow cards

#### Net Paid Commission

Decision: keep **Net Paid Commission** money-flow based.

Plain meaning:

- Actual commission dollars paid, minus clawbacks/adjustments.
- Not limited to EDE.
- Includes valid Coverall, Vix, downline, legacy, override, and other owned commission money.

#### Net Paid split

Decision: use:

- **Core / Direct**
- **EF**
- **DL / Override**

Erica should be visible separately, not hidden inside generic downline. Allen, Hantz, Scott, and similar owned-writing rows stay in DL / Override.

#### Clawbacks / Adjustments

Decision: keep one total on the card. No bottom split needed.

Future detail/export should consolidate by member and show:

- total clawback amount
- number of months
- date range/timeframe
- bottom totals for member count, month count, total amount, and earliest-to-latest date span

### Exception Summary decisions

#### Prior EDE Consumers Not in Back Office

Decision: rename **Has EDE Row But Not in Back Office** to **Prior EDE Consumers Not in Back Office**.

Purpose:

- historical / retarget / data-mining list
- not the current Not in Back Office work queue
- not a missing commission card

Definition direction:

- consumers who had an EDE row under one of our AORs with the same status gate as eligible: effectuated, pending effectuation, or pending termination
- but never made it into Back Office

Guardrails:

- must have been effectuated, pending effectuation, or pending termination under our AOR
- should exclude junk/non-qualified EDE rows
- should not be confused with current **Not in Back Office**
- should be checked for duplicate/alternate BO matches before treating as a true retarget list

#### Eligible & In BO But No Commission Row

Decision: remove from Exception Summary once **Expected But Unpaid** is clearly defined and visible.

Reason: it duplicates the main recovery card.

#### Paid to Wrong Entity

Decision: rename **Wrong Pay Entity** to **Paid to Wrong Entity**.

Current rule:

- flags Jason or Becky policies paid under Vix instead of Coverall.

Tooltip direction:

- "Currently flags Jason or Becky policies paid under Vix instead of Coverall. In future multi-entity use, this card should represent any policy paid to the wrong entity."

#### Paid but Missing from EDE

Decision: remove from Exception Summary once Source Coverage is redesigned.

Reason: it duplicates and muddies Source Coverage. The information should be represented through:

- Paid: Back Office Only
- Paid: Commission Statement Only
- Paid Outside Current EDE
- Core / EF / DL / SBE splits

#### Not Eligible for Commission

Decision: keep in Exception Summary when count is greater than zero.

Plain meaning:

- policy exists
- carrier/Back Office says it is not eligible for commission
- distinct from missing payment

#### Submitted to Carrier

Decision: add future workflow/status **Submitted to Carrier**.

Plain meaning:

- operator sent item to carrier for review/reconciliation
- awaiting response or future file resolution
- if future upload confirms it, it can resolve
- if carrier denies it, operator manually removes/closes it

This is a future workflow feature, not necessarily part of the immediate label cleanup.

### Writing-agent master spreadsheet as ownership authority

Jason suggested using the spreadsheet that contains writing IDs, NPNs, agents, and carriers.

Proposed business rule:

If an agent/NPN appears in that spreadsheet, and appears on a commission statement, and is not a current Coverall AOR, treat it similarly to Allen Ford or Scott O'Toole: Coverall-owned writing-agent business rather than outside leakage.

Needs follow-up:

- Identify the spreadsheet.
- Confirm fields and carrier coverage.
- For now, keep it as an audit/reference file only. Do not make it automatic app logic yet.
- Keep `COVERALL_OWNED_WRITING_NPNS` as the explicit app map for known owned-writing NPNs until the spreadsheet's coverage is verified enough to trust.

### Carrier-submitted reconciliation holding status

Jason confirmed the app needs a broader reconciliation tracking workflow for both commission reconciliation issues and Back Office reconciliation issues.

Plain meaning:

- The app should track what has been submitted for review.
- It should show what is still in progress.
- It should show how each item resolves.

Potential workflow:

1. Record is missing, disputable, or needs carrier / Back Office follow-up.
2. Operator submits it for review or marks it as being worked.
3. App marks it as submitted / in progress / holding.
4. Later file upload may resolve it automatically.
5. If the carrier denies it, the operator manually closes/removes or changes the status. The app should not automatically delete denied items without operator action.

Needs follow-up:

- Design this as a broader exception/reconciliation workflow, not just a Not in Back Office feature.
- Decide the exact statuses and where the workflow appears in the UI.

### Premium due versus zero-net-premium split

Jason wants missing/unpaid views to distinguish:

- zero-net-premium plans
- plans with net premium due
- rows without reliable EDE premium data

Reason:

- Some missing commissions may be explainable by unpaid premiums.
- Others remain unexplained and should be prioritized differently.

Needs follow-up:

- Identify where premium due / net premium fields live.
- Decide which cards/drilldowns should show the split.

## Questions Still Open or Needing Discussion

1. How should the broader expected-payment universe be implemented safely?
   - Jason chose one card with bottom breakout, not separate cards.
   - Should Be Paid, Expected Payments Received, and Expected But Unpaid should share the same Confirmed / BO Only / EDE Only universe.
   - This now needs a code scoping pass because the current implementation is narrower than the chosen contract.

2. Should the UI explain Vix/Coverall overlap directly?
   - Jason confirmed the overlap is correct but asked what this question means.
   - Proposed translation: add a tooltip note saying Vix is included inside Coverall for enrollment-style cards because Erica is a Coverall_or_Vix AOR.

3. How should the 5 junk/downline AOR missing-dollar rows be treated?
   - Jason wants to understand how downline missing payment can be known if not in EDE/Back Office.
   - Requires a short data-flow audit before deciding exception behavior.
   - Specific question: where does `estimated_missing_commission` come from for these 5 rows?

4. What exactly are the whole-batch/persistent diagnostics for?
   - Jason wants discussion before deciding labels.
   - Need to explain why raw records/persistent flags can differ from current scoped card logic.

5. Should Source Coverage be redesigned or just renamed?
   - Jason wants separation among core EDE expected business, SBE payments, downline/legacy AOR business, and auto-renewal not-in-EDE cases.

6. Does the 128 vs 56 Paid but Missing from EDE discrepancy represent two useful definitions?
   - Likely yes, but needs a read-only audit to prove what each number includes.

7. Are there real Becky Shuta-style auto-renewal cases today?
   - Jason gave this as an example of a Coverall AOR member who could appear in Back Office but not in EDE.
   - Audit whether this pattern exists in current data before designing Source Coverage categories around it.

8. Is the writing-agent spreadsheet available now?
   - If yes, inspect its structure and decide whether it can become the ownership reference for former/downline/SBE writing agents.
   - If no, keep `COVERALL_OWNED_WRITING_NPNS` as the temporary explicit map.

## Suggested Next Lovable / Codex Work

Do not jump straight into broad Dashboard refactor. The next useful steps are targeted and decision-driven.

### Recommended read-only audits first

1. **Paid but Missing from EDE 128 vs 56 audit**
   - Compare Exception Summary "Paid but Missing from EDE" rows against Source Coverage "Paid but Missing from EDE" rows for Feb 2026.
   - Explain the difference in plain English.
   - Recommend clearer labels.

2. **Expected-payment universe scoping**
   - Compare current Should Be Paid / Expected Payments Received / Unpaid logic against the new Confirmed / BO Only / EDE Only contract.
   - Identify exact predicates and row counts for each split before implementation.

3. **Premium due / zero-net-premium field audit**
   - Identify where premium due data exists.
   - Determine whether unpaid/missing cards can show zero-net-premium vs premium-due split.

4. **Writing-agent spreadsheet feasibility check**
   - Locate and inspect the spreadsheet of writing IDs/NPNs/agents/carriers.
   - Determine whether it can power the Coverall-owned writing-agent map.

### Truly safe build tickets now

1. Pure label-only rename can be avoided for now because Expected Payments Received now requires a broader definition and bottom split, not just text.
2. Improve Clawback detail popup/export with member-level consolidation.

### Build tickets that still need audit or Jason confirmation

1. Source Funnel scoping/redesign.
   - Jason's request is more than "apply the dropdown." It needs a small scoping pass because the funnel should preserve the core EDE breakage story while separately showing downline, legacy, and SBE payments.
2. Scope Exception Summary to the Dashboard dropdown after the 128 vs 56 label audit.
3. Align Est. Missing Commission with Missing Commission Export after the 5-row missing-dollar data-flow audit.
4. Add the Unpaid Policies zero-net-premium / premium-due split after field availability is confirmed.

### Phasing decision

Do not ship the Source Coverage / expected-payment redesign as one large ticket. Use a phased workflow:

1. Read-only preflight first: map current logic, counts, and proposed splits.
2. Phase 1: pure renames and low-risk label cleanup.
3. Phase 2: expected-payment universe changes.
4. Phase 3: bottom split additions and Source Coverage redesign.
5. Phase 4: broader submitted / in-progress / resolved workflow.

Jason will use Claude as a checkpoint before each phase becomes a Lovable build directive.

## Interpretation Caveats

These are Codex's interpretations of Jason's first-pass Word edits. Before implementation, Jason should confirm:

- Whether the expected-payment universe implementation matches the new Confirmed / BO Only / EDE Only contract.
- Whether Source Funnel should be scoped while still surfacing downline/legacy/SBE as separate additions.
- Whether Allen/Hantz/Scott stay in Downline/Override permanently or just for now.
- Whether the writing-agent spreadsheet should become an actual app data source.
