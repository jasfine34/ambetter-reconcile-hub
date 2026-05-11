# Card Document Definitions - Plain English Review

Status: business-owner review draft  
Purpose: explain what each Dashboard card is trying to say in non-programmer language, so Jason can confirm or correct the business meaning before more Dashboard refactor or rebuild work.

This is not meant to be a code document. It is meant to help answer:

- What does this number mean?
- Who is included?
- Who is excluded?
- Should Coverall + Vix equal All?
- What could confuse an operator?
- What does Jason need to decide?

## Big Picture

The Dashboard is not just one kind of report. It mixes several kinds of questions:

1. **Enrollment questions**
   - Who should be in our book of business based on EDE/enrollment data?

2. **Back Office questions**
   - Which expected members are found in the carrier Back Office data?

3. **Commission questions**
   - What money actually paid to Coverall or Vix?

4. **Exception questions**
   - What looks missing, mismatched, unpaid, or suspicious?

5. **Debug questions**
   - What raw data did the app load, regardless of selected scope?

These questions do not always add up the same way. That is not automatically a bug. The important thing is that the card label and tooltip make the question clear.

## Scope Meanings in Plain English

### Coverall

Usually means business tied to Coverall's active AORs or money paid through Coverall.

But the exact meaning depends on the card:

- Enrollment cards usually look at **AOR-of-record**.
- Commission cards usually look at **where the money paid**.
- Some older Dashboard cards still use a broader mixed rule.

### Vix

Usually means business related to Erica/Vix.

Important: in the enrollment view, Vix is not totally separate from Coverall. Erica is marked as both Coverall and Vix-related. So a Vix member can also be inside Coverall.

That means:

> For some member-count cards, Coverall + Vix should NOT be expected to equal All.

### All

Usually means the combined view.

But there are two different ways "All" can behave:

- For overlapping member sets, All is more like "everyone in the combined universe without double-counting overlap."
- For money rows, All often equals Coverall money + Vix money.

### AOR-of-Record

The agent currently listed on the policy/enrollment record.

Used mostly for enrollment-style cards.

### Actual Pay Entity

Where the commission actually paid: Coverall, Vix, or sometimes blank/unknown.

Used mostly for money-style cards.

### Writing-Agent NPN

The agent NPN attached to the commission row as the writer.

This matters because Coverall can still own commission on business written by downline or former agents, even if the current AOR field is blank or not one of the active Coverall AORs.

### Coverall-Owned Writing Agents

These are writing-agent NPNs confirmed as Coverall-owned even though they are not active Coverall AORs:

- Allen Ford, `21077804`, downline agent
- Hantz Pierre, `21574255`, former Coverall agent
- Scott O'Toole, `15978551`, verified by DOI; carrier feed labels it as Coverall Health Group Call Center

Current note: the app has this ownership list for audit/future classification, but it does not yet change the visible Dashboard card calculations by itself.

## Card Review

### Source Funnel

What this card is trying to answer:

How many records move through the major stages: EDE, Back Office, and Commission?

Who counts:

- Records from the loaded batch.
- The card currently appears to use the whole batch, not just the selected Coverall/Vix scope.

Who does not count:

- This still needs confirmation because the card has not been fully scoped in the same way as the main metric cards.

Does Coverall + Vix equal All?

- Not currently clear, because the card appears to ignore the scope dropdown.

What could confuse someone:

- The card sits on a page with a Coverall/Vix/All dropdown, so a user may assume it changes when scope changes.
- If it is actually whole-batch, the UI should say that.

Decision for Jason:

- Should Source Funnel change when Coverall/Vix/All changes?
- Or should it be labeled as a whole-batch/all-scope funnel?

### Expected Enrollments

What this card is trying to answer:

How many members/policies does the app think should be tracked for this selected scope based on EDE enrollment data?

Who counts:

- Members from EDE/enrollment data.
- Enrollment status is one of the qualifying statuses, such as Effectuated, PendingEffectuation, or PendingTermination.
- The member is active in the batch's covered month window.
- The member's current AOR belongs to the selected scope.

Who does not count:

- Members outside the selected AOR scope.
- Members not active in the covered month window.
- Rows that fail the expected enrollment rules.

Does Coverall + Vix equal All?

- Usually no.
- Under the current AOR setup, Vix is inside Coverall because Erica is both Coverall and Vix-related.
- That is why All can equal Coverall on this card.

What could confuse someone:

- A user may expect Coverall + Vix to equal All. For this card, that is not the right expectation because Vix overlaps with Coverall.

Decision for Jason:

- Is it correct that Vix enrollment members are treated as a subset of Coverall enrollment members?
- Should the UI explain this overlap directly?

### Not in Back Office

What this card is trying to answer:

Of the expected enrollment members, how many are not strictly found in the Back Office data?

Who counts:

- Members in Expected Enrollments.
- No strict Back Office match.
- Not already upgraded by a confirmed manual weak match.

Who does not count:

- Members already found in Back Office.
- Members manually confirmed as weak matches.
- Members outside the expected enrollment universe.

Does Coverall + Vix equal All?

- Usually no, because this follows the same overlapping enrollment universe as Expected Enrollments.

What could confuse someone:

- The Expected Enrollments tooltip has a raw Back Office tie-out.
- This card is not raw. It is adjusted after confirmed manual weak matches.

Decision for Jason:

- Does the current split into disputable, waiting, and weak match make sense operationally?

### Weak BO Match Queue

What this card is trying to answer:

How many expected enrollment members look like they probably match a Back Office row, but the automatic join was not clean enough?

Who counts:

- Expected enrollment members missing a strict Back Office match.
- A likely Back Office match exists by fuzzy signals.
- Back Office row is active for the batch period.
- The match has not yet been confirmed or rejected.

Who does not count:

- Confirmed weak matches.
- Rejected weak matches.
- Terminated Back Office rows that should not count for the period.

Does Coverall + Vix equal All?

- Usually no, because this follows the expected enrollment universe.

What could confuse someone:

- A weak match is not necessarily a real gap. It means the app found a likely match but needs human confirmation.

Decision for Jason:

- Is the current review workflow enough, or should some high-confidence weak matches auto-resolve later?

### Total Covered Lives

What this card is trying to answer:

How many insured lives are represented by the expected enrollment members?

Example:

- One subscriber with two dependents may count as 3 covered lives.

Who counts:

- Members in the same expected enrollment universe as Expected Enrollments.
- The card sums covered member count across those members.

Who does not count:

- Members outside the selected enrollment/AOR scope.
- Members not in the expected enrollment universe.

Does Coverall + Vix equal All?

- Usually no, for the same reason as Expected Enrollments.

What could confuse someone:

- Before the recent fix, this card used a whole-batch number and did not respect scope.
- Now it should move with Expected Enrollments.

Decision for Jason:

- Does the current wording make it clear that Vix means Erica AOR for this card?

### Should Be Paid

What this card is trying to answer:

How many members should have generated commission?

Who counts:

- Member is in Expected Enrollments.
- Member is found in Back Office, or has a confirmed manual upgrade.
- Member is marked eligible for commission.

Who does not count:

- Members not in Expected Enrollments.
- Members not found in Back Office unless manually upgraded.
- Members not eligible for commission.

Does Coverall + Vix equal All?

- Not guaranteed.
- This card uses both enrollment membership and actual pay-entity logic.

What could confuse someone:

- It may look like it lines up perfectly with Expected Enrollments today, but that depends on the current data.
- If future Vix-paid members do not have Erica as AOR, this card could diverge from enrollment-style cards.

Decision for Jason:

- Should this card use the same Vix definition as Expected Enrollments, or is the stricter payment-aware Vix definition correct?

### Paid Commission Records

What this card is trying to answer:

How many records in the current broad Dashboard filter have commission?

Who counts:

- Rows in the Dashboard's broad filtered set.
- `in_commission` is true.

Who does not count:

- Rows not in the Dashboard's broad filtered set.
- Rows without commission.

Does Coverall + Vix equal All?

- Not reliably.

What could confuse someone:

- This card is still based on the broad Dashboard filter, not a clean payment-only rule.
- Recent audit showed many suspicious rows were actually Coverall-owned writing-agent business, not bad data.

Decision for Jason:

- Should this remain a broad source-coverage count?
- Or should it become a cleaner commission-row count based only on where money paid?

### Paid Within Eligible Cohort

What this card is trying to answer:

Of the members who should be paid, how many actually have commission?

Who counts:

- Member is in Should Be Paid.
- Member has commission.

Who does not count:

- Members outside Should Be Paid.
- Members in Should Be Paid but without commission.

Does Coverall + Vix equal All?

- Not guaranteed.

What could confuse someone:

- This card depends on the same rule as Should Be Paid, not just raw commission rows.

Decision for Jason:

- Does "paid within eligible cohort" match how you think about this card, or should the label be simpler?

### Unpaid Policies

What this card is trying to answer:

How many members should have been paid but were not paid?

Who counts:

- Member is in Should Be Paid.
- Member does not have commission.

Who does not count:

- Members not expected to be paid.
- Members already paid.
- Paid rows outside the expected enrollment universe.

Does Coverall + Vix equal All?

- Not guaranteed.

What could confuse someone:

- This is not every row with no commission. It is only rows that pass the "should be paid" rules.

Decision for Jason:

- Should this be the main recovery target card?

### Net Paid Commission

What this card is trying to answer:

How much money actually paid, after subtracting clawbacks and adjustments?

Who counts:

- Commission rows in the selected payment scope.
- Positive commission increases the number.
- Negative commission/clawbacks reduce it.

Who does not count:

- Enrollment rows with no commission.
- Back Office rows with no commission.

Does Coverall + Vix equal All?

- Usually yes, if commission rows have clean pay entities.

What could confuse someone:

- This is a money-flow card, not an enrollment/AOR card.
- It can include Coverall-owned downline or former-agent commission even if the current AOR does not look like active Coverall.

Decision for Jason:

- Should Net Paid continue to be based on actual money flow, even when AOR is blank/downline/former?

### Coverall Direct / Downline Split

What this card is trying to answer:

Within Net Paid, how much came from direct Coverall writing agents versus downline/override business?

Who counts as direct today:

- Writing-agent NPN is one of the active Coverall AOR NPNs: Jason, Erica, Becky.

Who counts as downline today:

- Commission paid to Coverall where the writing-agent NPN is not one of those active direct NPNs.

Does Coverall + Vix equal All?

- This is a split of commission money, so it behaves differently from enrollment cards.

What could confuse someone:

- The newly verified Coverall-owned writing NPNs, Allen/Hantz/Scott, are not currently direct. They likely remain downline/override under today's split.
- A Vix-paid row written by Erica can still show in the direct bucket because direct is based on writing-agent NPN, not pay entity.

Decision for Jason:

- Should Allen/Hantz/Scott stay in Downline/Override?
- Or should there be a separate "Coverall-owned legacy/downline" bucket?

### Clawbacks / Adjustments

What this card is trying to answer:

How much commission was reversed, charged back, or adjusted downward?

Who counts:

- Negative commission rows.
- Reversal/chargeback-style commission rows.

Who does not count:

- Positive commission rows.
- Enrollment/Back Office rows without commission.

Does Coverall + Vix equal All?

- Usually yes if commission pay entities are clean.

What could confuse someone:

- This is part of Net Paid, not a separate enrollment issue.

Decision for Jason:

- No major business decision identified. Mainly needs row-sum parity protection if not already tested.

### Est. Missing Commission

What this card is trying to answer:

How much commission might be missing.

Who counts today:

- Rows in the Dashboard's broad filtered set.
- The card sums the stored estimated missing commission value.

Who does not count:

- Rows outside that broad filter.

Does Coverall + Vix equal All?

- Not reliably.

What could confuse someone:

- This card is not yet using the same strict "should be paid but unpaid" rule as Unpaid Policies.
- The Missing Commission Export may not match this card today.
- The Feb audit found 5 dollar-bearing rows with junk/downline AOR totaling $147.26. Those should probably be surfaced, not silently hidden.

Decision for Jason:

- Should this be calculated only from the official unpaid recovery list?
- Should the 5 junk/downline AOR missing-dollar rows become an exception queue item?

## Reconciliation Validation Panel

What this panel is trying to answer:

Does the main payment logic tie out internally?

Trusted parts:

- Should Be Paid
- Paid Within Eligible
- Unpaid Policies
- Difference
- Unpaid Variance

Diagnostic parts:

- Raw Records
- Unique Member Keys
- Avg Records/Key
- has_any_ede
- persistent expected enrollment flags
- persistent expected enrollment plus Back Office

What could confuse someone:

- Some values are current scoped logic.
- Some values are batch-wide diagnostics.
- Some values are persistent values from the last rebuild and may differ from current helper logic after rule changes.

Decision for Jason:

- Should the diagnostic labels explicitly say "whole batch" or "persistent diagnostic"?

## Source Coverage Analysis

What this section is trying to answer:

Where do rows exist across EDE, Back Office, and Commission?

Cards:

- Fully Matched & Paid
- Paid but Missing from EDE
- Commission Statement Only
- Back Office Only (Not Paid)
- Unpaid Expected Policies
- Total Paid (All Sources)
- Paid Outside Expected Universe

Who counts:

- Rows in the Dashboard's broad filtered set.
- Each card applies its own source-combination rule.

Does Coverall + Vix equal All?

- Not reliably.

What could confuse someone:

- These are broad source-diagnostic cards, not pure expected-enrollment cards.
- They may include legacy, downline, blank-AOR, or paid-outside-EDE rows.

Decision for Jason:

- Should this stay as broad source coverage?
- Or should it be split into scoped operational cards plus a separate whole-batch anomaly section?

## Exception Summary

What this section is trying to answer:

How many rows fall into each issue type?

Who counts:

- Rows in the Dashboard's broad filtered set.
- Grouped by issue type.

Does Coverall + Vix equal All?

- Not reliably.

What could confuse someone:

- Dashboard Exception Summary may not match the Exceptions page if the page uses a different scope.

Decision for Jason:

- Should exceptions be scoped to the Dashboard dropdown?
- Or should exceptions be whole-batch unless a separate scope is selected?

## Manual Match Review

What this page is trying to answer:

Which weak Back Office matches need human review?

Who counts:

- Expected enrollment members missing a strict Back Office match.
- Likely Back Office match exists.
- Not confirmed or rejected yet.

What could confuse someone:

- These are not necessarily missing policies. They are likely identity/join issues.

Decision for Jason:

- No major business decision identified. The workflow now appears aligned with the Dashboard weak-match count.

## Missing Commission Export

What this page is trying to answer:

Which unpaid policies should be exported for carrier follow-up?

Who counts:

- Members from the same unpaid eligible cohort as the Dashboard Unpaid Policies card.

What could confuse someone:

- The row count should align with Unpaid Policies.
- The dollar estimate may not align with Est. Missing Commission until that card's source is decided.

Decision for Jason:

- Should Est. Missing Commission use the same dollar calculation as this export?

## Jason Decision List

1. Should Source Funnel be scoped, or clearly labeled/moved as whole-batch?
2. Should Source Coverage remain broad source diagnostics, or become stricter scoped metrics?
3. Should Est. Missing Commission come from the official unpaid recovery list?
4. Should the 5 junk/downline AOR missing-dollar rows become an exception queue item?
5. Should Allen/Hantz/Scott stay in Downline/Override, or get a separate Coverall-owned legacy/downline bucket?
6. Should the UI explicitly explain that Vix overlaps with Coverall for enrollment-style cards?
7. Should Dashboard exceptions match the selected scope, or be whole-batch?
8. Should enrollment cards and eligible/payment cards use the same Vix definition?
9. Should the Coverall-owned writing NPN list remain audit-only, or feed visible classification?
10. Should debug labels explicitly say whole-batch or persistent diagnostic?
11. Should we continue refactoring the current Dashboard, or rebuild the Dashboard after these definitions are approved?

## Review Instructions for Jason

For each card, you do not need to review the code. Just answer:

- Does this card mean what I think it means?
- Is anyone included who should not be?
- Is anyone excluded who should count?
- Would this confuse an operator?
- Does the label need to change?

After those answers are written down, this document can become the business contract for Lovable/Codex/Claude before more Dashboard work.
