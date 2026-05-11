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
- This likely needs a careful design distinction between:
  - "Eligible and found in BO, should pay now"
  - "Expected from EDE but missing in BO, still needs carrier/BO resolution"

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

### 13. Est. Missing Commission should use the unpaid/export calculation

Decision: Est. Missing Commission should use the same dollar calculation as the Missing Commission Export, assuming "official unpaid recovery list" means Unpaid Policies / export rows.

Jason caveat: needs better understanding of how downline payment could be considered missing if the member is not in our EDE or Back Office.

Implementation implication:

- Move toward aligning Est. Missing Commission with the Missing Commission Export.
- Do not silently hide the 5 junk/downline AOR missing-dollar rows until the business meaning is discussed.

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

### 16. Missing Commission Export should align with Est. Missing Commission dollars

Decision: yes, Est. Missing Commission should use the same dollar calculation as the export, subject to the caveat above about understanding downline/junk-AOR missing dollars.

Implementation implication:

- Future contract should define one official missing-commission dollar calculation.

## New Business Concepts Jason Introduced

### Writing-agent master spreadsheet as ownership authority

Jason suggested using the spreadsheet that contains writing IDs, NPNs, agents, and carriers.

Proposed business rule:

If an agent/NPN appears in that spreadsheet, and appears on a commission statement, and is not a current Coverall AOR, treat it similarly to Allen Ford or Scott O'Toole: Coverall-owned writing-agent business rather than outside leakage.

Needs follow-up:

- Identify the spreadsheet.
- Confirm fields and carrier coverage.
- Decide whether it becomes an app data source or remains an audit/reference file.

### Carrier-submitted reconciliation holding status

Jason asked whether there is or should be a way to mark records as submitted to carrier for reconciliation.

Potential workflow:

1. Record is missing/disputable.
2. Operator submits to carrier.
3. App marks it as submitted/holding.
4. Later file upload resolves it automatically, or carrier denial removes/changes the status.

Needs follow-up:

- Decide if this belongs in Not in Back Office, Missing Commission, or a broader exception workflow.

### Premium due versus zero-net-premium split

Jason wants missing/unpaid views to distinguish:

- zero-net-premium plans
- plans with net premium due

Reason:

- Some missing commissions may be explainable by unpaid premiums.
- Others remain unexplained and should be prioritized differently.

Needs follow-up:

- Identify where premium due / net premium fields live.
- Decide which cards/drilldowns should show the split.

## Questions Still Open or Needing Discussion

1. What exactly should "Should Be Paid" include?
   - Current definition requires found in Back Office.
   - Jason wants EDE-eligible missing-from-BO members represented until resolved.
   - This may require two related metrics instead of one.

2. Should the UI explain Vix/Coverall overlap directly?
   - Jason confirmed the overlap is correct but asked what this question means.
   - Proposed translation: add a tooltip note saying Vix is included inside Coverall for enrollment-style cards because Erica is a Coverall_or_Vix AOR.

3. How should the 5 junk/downline AOR missing-dollar rows be treated?
   - Jason wants to understand how downline missing payment can be known if not in EDE/Back Office.
   - Requires a short data explanation before deciding exception behavior.

4. What exactly are the whole-batch/persistent diagnostics for?
   - Jason wants discussion before deciding labels.
   - Need to explain why raw records/persistent flags can differ from current scoped card logic.

5. Should Source Coverage be redesigned or just renamed?
   - Jason wants separation among core EDE expected business, SBE payments, downline/legacy AOR business, and auto-renewal not-in-EDE cases.

6. Does the 128 vs 56 Paid but Missing from EDE discrepancy represent two useful definitions?
   - Likely yes, but needs a read-only audit to prove what each number includes.

## Suggested Next Lovable / Codex Work

Do not jump straight into broad Dashboard refactor. The next useful steps are targeted and decision-driven.

### Recommended read-only audits first

1. **Paid but Missing from EDE 128 vs 56 audit**
   - Compare Exception Summary "Paid but Missing from EDE" rows against Source Coverage "Paid but Missing from EDE" rows for Feb 2026.
   - Explain the difference in plain English.
   - Recommend clearer labels.

2. **Should Be Paid expansion scoping**
   - Compare current Should Be Paid against EDE-eligible missing-from-BO rows.
   - Propose whether this should be one card, two cards, or one card plus sub-status.

3. **Premium due / zero-net-premium field audit**
   - Identify where premium due data exists.
   - Determine whether unpaid/missing cards can show zero-net-premium vs premium-due split.

4. **Writing-agent spreadsheet feasibility check**
   - Locate and inspect the spreadsheet of writing IDs/NPNs/agents/carriers.
   - Determine whether it can power the Coverall-owned writing-agent map.

### Safe build tickets after audits

1. Rename "Paid Within Eligible Cohort" to **Expected Payments Received**.
2. Scope Source Funnel to the dropdown, with separate visibility for downline/legacy/SBE payments.
3. Scope Exception Summary to the Dashboard dropdown after label audit.
4. Improve Clawback detail popup/export with member-level consolidation.
5. Align Est. Missing Commission with Missing Commission Export after resolving the junk/downline missing-dollar question.

## Interpretation Caveats

These are Codex's interpretations of Jason's first-pass Word edits. Before implementation, Jason should confirm:

- Whether the "Should Be Paid" expansion is understood correctly.
- Whether Source Funnel should be scoped while still surfacing downline/legacy/SBE as separate additions.
- Whether Allen/Hantz/Scott stay in Downline/Override permanently or just for now.
- Whether the writing-agent spreadsheet should become an actual app data source.

