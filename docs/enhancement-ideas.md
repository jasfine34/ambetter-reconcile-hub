# Enhancement Ideas

This file is a lightweight parking lot for future improvements. It is not an active bundle directive, acceptance checklist, or implementation plan. Ideas here should stay out of current bundle scope unless Jason explicitly promotes them into a dedicated directive.

## Multi-Period Missing Commission Report

Status: Idea

Priority: High

Related bundles: Bundle 13b, Bundle 13c, future reporting bundle

Summary:

Allow missing-commission reports over a service-month range, for example January through March, grouping missing commission by policy/person and exporting a `Missing Periods` column such as `Jan`, `Jan, Feb`, or `Jan, Feb, Mar`.

Why it matters:

This would let Jason identify multi-month commission gaps without running separate monthly reports and manually combining them.

Architecture notes:

- Treat the selected range as a service-month range, not a batch statement-month range, unless a future directive explicitly decides otherwise.
- Keep current Dashboard, Missing Commission Export, Agent Summary, and Unpaid Recovery single-batch flows intact.
- Add a report-specific multi-period pipeline instead of rewriting `BatchContext` around date ranges.
- Group first by `policy_identity_key + target_service_month` to avoid double-counting a policy-month across multiple batches.
- Then roll grouped policy-months up to export rows by policy/person.
- Use `reconciled_members.expected_ede_effective_month` and `cross_batch_clearings.target_service_month` as the canonical month fields.
- Apply cross-batch clearing overlay logic so cleared months do not appear as missing.
- Export should include `Missing Periods` and may later include `Missing Period Count` and `Total Estimated Missing`.

Risks:

- Double-counting the same policy-month when it appears in more than one batch.
- Confusing statement month with service month.
- Pulling too much data at once and reintroducing timeout-prone queries.
- Grouping by member name instead of stable policy identity.
- Accidentally changing existing single-batch surface behavior while adding range reporting.

Suggested path:

Build this as a dedicated future reporting bundle after Bundle 13c closes. Start with pure helpers and tests, then add report-local loaders, then wire UI/export.
