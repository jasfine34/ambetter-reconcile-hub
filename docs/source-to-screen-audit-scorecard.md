# Source-To-Screen Audit Scorecard

Last updated: 2026-05-18

This is the plain-English scorecard for Jason. It summarizes what each audit has actually proven. A `CERTIFIED` cell means the audit traced the output from source data through the app calculation to the visible UI or export for the named scope. It does not automatically certify other months, scopes, tabs, or carriers.

## Legend

| Status | Meaning |
| --- | --- |
| `CERTIFIED` | Source data, normalized data, app logic, UI/export, and exclusions all matched for the named scope. |
| `CERTIFIED PILOT` | Same as certified, but only for a narrow pilot slice. |
| `TARGETED PASS` | One known bug class or risk area was tested and passed. Not a full tab certification. |
| `HELPER PARITY ONLY` | The UI matches the app helper/calculation, but the helper has not yet been proven against raw source truth. |
| `NEEDS RERUN` | A bug, rule change, or audit-standard upgrade means the prior result is not enough. |
| `PENDING` | Not yet audited to the current 100% source-traceability standard. |

## Current Certification Matrix

| Tab / Surface | Scope Audited | Raw Rows Included Correctly | Wrong Rows Excluded | Calculations / Dollars | Cross-Batch / Overlay | UI / Export Output | Current Result | Plain-English Meaning |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Missing Commission Export | Jan 2026, Ambetter, Coverall, All Premium | `CERTIFIED` | `CERTIFIED` | `CERTIFIED` | `CERTIFIED` | `CERTIFIED` | `CERTIFIED PILOT` | For this one MCE export slice, the data is accurate: no extra rows, no missing rows, and export values match the source-backed ledger. |
| Missing Commission Export | Other Ambetter months / scopes / premium buckets | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | Expected to use the same machinery, but not certified until the Stage 2 matrix runs. |
| Dashboard | Current audited portions | `PENDING` | `TARGETED PASS` for stale-BO contamination | `HELPER PARITY ONLY` | `TARGETED PASS` in some paths | `HELPER PARITY ONLY` | `HELPER PARITY ONLY` | We know some display/helper agreement and stale-BO checks passed, but not full raw-source certification. |
| Member Timeline | Current audited portions | `NEEDS RERUN` | `NEEDS RERUN` | `NEEDS RERUN` | `PENDING` | `HELPER PARITY ONLY` | `NEEDS RERUN` | This is where stale historical BO rows exposed the weakness in earlier audits. It must be rerun under the raw-source standard after the classifier fix. |
| Agent Summary | Current audited portions | `PENDING` | `TARGETED PASS` for stale-BO contamination | `HELPER PARITY ONLY` | `PENDING` | `HELPER PARITY ONLY` | `HELPER PARITY ONLY` | Useful confidence that the UI follows helpers, but not yet source-certified. |
| Unpaid Recovery | Current audited portions | `PENDING` | `TARGETED PASS` for stale-BO contamination | `HELPER PARITY ONLY` | `PENDING` | `HELPER PARITY ONLY` | `HELPER PARITY ONLY` | Needs a raw-ledger audit before calling it accurate against source truth. |
| Cross-Batch Clearings | Jan 2026 Ambetter Coverall MCE pilot impact | `CERTIFIED` | `CERTIFIED` | `CERTIFIED` | `CERTIFIED` | `CERTIFIED` inside MCE output | `CERTIFIED PILOT` | Late payments, including later-statement payments for January, were removed correctly from the pilot MCE owed bucket. |
| Cross-Batch Clearings | Global behavior across all tabs/months | `PENDING` | `PENDING` | `PENDING` | `HELPER PARITY ONLY / TARGETED PASS` | `PENDING` | `PENDING` | The mechanism has strong evidence, but global source-truth certification needs broader coverage. |
| Source Coverage / EBU surfaces | Current audited portions | `PENDING` | `TARGETED PASS` for stale-BO contamination | `HELPER PARITY ONLY` | `PENDING` | `HELPER PARITY ONLY` | `HELPER PARITY ONLY` | Not certified against raw source truth yet. |
| All Records / Upload Status / operational tabs | None under this standard | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | `PENDING` | Not part of the source-to-screen certification yet. |

## Required Test Categories Going Forward

Every future `CLEAN` audit should populate these categories for the relevant tab or slice:

| Test Category | Plain-English Question It Answers |
| --- | --- |
| Raw source selection | Did the audit use the exact uploaded BO, EDE, commission, and batch files the app used? |
| Inclusion | Did every row that should appear actually appear? |
| Exclusion | Did rows that should not count stay out, including stale BO, ineligible BO, wrong AOR, wrong scope, no current source, and invalid FFM fallback? |
| Transformation | Did raw file values become the correct normalized and reconciled values? |
| Calculation | Did counts, dollars, buckets, badges, statuses, and flags compute correctly? |
| Cross-batch / overlay | Did late payments, clearings, reversals, and manual-review overlays affect the output correctly? |
| UI/export parity | Did the screen and downloaded file show exactly what the certified calculation says? |

## Update Rule

After each Codex verdict, update this scorecard with:

1. The tab or surface audited.
2. The exact scope, such as month, carrier, scope, premium bucket, or agent.
3. The result for each test category.
4. A one-sentence plain-English meaning.
5. Whether the result is full certification, pilot certification, helper parity only, targeted pass, or needs rerun.

