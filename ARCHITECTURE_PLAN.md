# Architecture Plan

This document records architectural decisions and definitional contracts that
span multiple files. When something here changes, every dependent page needs
to be re-checked.

## § Canonical Definitions

### AOR (Agent of Record) vs Writing Agent

The system tracks **two distinct agent attributions** per policy and they must
not be conflated:

- **Canonical AOR** — the value of `currentPolicyAOR` on the EDE export,
  stored on `reconciled_members.current_policy_aor`. This is the
  policyholder's chosen agent on the exchange and is the single source of
  truth for "is this our member?" scope filtering and the **Expected (AOR)**
  count on Agent Summary.
- **Writing Agent** — the agent NPN that appears on the back-office /
  commission feed (`agent_npn`). The `aor_bucket` field is derived from this
  NPN and is used to route commission dollars and populate the **Written by**
  count on Agent Summary. It does NOT define ownership.

Why both exist: An agent can write a policy whose AOR is held by someone else
(common when one agent fields the call and another is the long-standing
relationship holder). The reverse also happens. Commission flows through
writing agent NPN on Ambetter statements; ownership flows through
`currentPolicyAOR` on EDE.

**Rule for future carrier adapters**: Expose the carrier's equivalent of
`currentPolicyAOR` as the canonical AOR field on the normalized record (use
the existing `current_policy_aor` column on `reconciled_members`), and expose
the writing-agent NPN as a separate field (`agent_npn`). Never collapse the
two into one column. See the comment block at the top of `src/lib/normalize.ts`
for the in-code reminder.

### Identity resolution sidecar

`resolved_identities` is a read-through sidecar that joins records across
batches when a member's stable IDs (issuer subscriber id, exchange subscriber
id, policy number) don't match cleanly because of carrier feed quirks. It is
never written-back to the source `normalized_records` rows. See
`src/lib/resolvedIdentities.ts`.

### Vix vs Coverall pay entity

`pay_entity` is the recipient of commission dollars from the carrier. Coverall
is our default; Vix is a separate downstream payee that the Mar 2026 batch
introduced. Pay entity is computed from the writing agent NPN via NPN_MAP and
is independent of AOR. Dashboard scopes filter on pay_entity, not AOR.

### Weak BO match overrides

`weak_match_overrides` records manual decisions on members where the strict
join to back office failed but ≥2 fuzzy signals matched. Overrides are keyed
by stable identity (issuer_subscriber_id, exchange_subscriber_id, or
policy_number) so they survive rebuilds. Confirmed overrides upgrade a member
to "effectively in BO" without re-running reconciliation. See
`src/lib/weakMatch.ts` and the `effInBO()` helper in `DashboardPage.tsx`.

### Canonical helpers — single source of truth for metrics

Every page that displays a scope-filtered metric (Net Paid Commission,
Expected Enrollments, Found in Back Office, Eligible Cohort, Total Covered
Lives, Direct vs Downline split, etc.) **must** derive that number from a
helper in `src/lib/canonical/` — never from page-local filter logic.

The three modules:

- **`scope.ts`** — defines the three canonical scopes (`Coverall`, `Vix`,
  `All`) and exposes `getMembersInScope`, `filterReconciledByScope`,
  `filterCommissionRowsByScope`, `aorBelongsToScope`. This is the ONLY place
  scope semantics live. New carriers extend NPN_MAP and (if needed) the
  scope set — no changes in consumer pages.
- **`metrics.ts`** — exposes `getNetPaidCommission`, `getExpectedEnrollments`,
  `getFoundInBackOffice`, `getNotInBackOffice`, `getEligibleCohort`,
  `getTotalCoveredLives`, `getMonthlyBreakdown`, `getDirectVsDownlineSplit`.
  Every dollar total comes from raw COMMISSION normalized rows (NOT from
  `reconciled_members.actual_commission`); summing the per-member field
  introduces inter-member roll-up drift (the historical $36,727.50 vs
  $36,640.50 incident on Mar 2026 Coverall scope).
- **`invariants.ts`** — `runInvariants(InvariantInputs)` returns pass/fail
  per cross-page check. Run on demand via the **Run Invariants** button on
  the Dashboard. Failures are real signals — they mean a page is computing
  a metric outside the canonical helpers.

**Rule for new pages**: import from `@/lib/canonical`. Do not write a new
`reconciled.filter(r => r.expected_pay_entity === ...)` in a component.
**Rule for new carriers**: extend `NPN_MAP` and (if a new pay entity exists)
add it to the scope helper. Consumer pages should not need to change.

## § Rebuild Discipline

Every batch-scoped table that participates in rebuild **must** follow the
DELETE → verify-zero → INSERT → verify-nonzero pattern in `src/lib/rebuild.ts`.
This is what prevents the "doubling" failure mode where a partial prior insert
leaves rows behind that the next rebuild stacks on top of.

Tables under this discipline today:
- `normalized_records` (current / non-superseded rows only — superseded
  history is preserved as an append-only audit trail)
- `reconciled_members`
- `commission_estimates`

A new batch-scoped table must opt into the same pattern or be documented here
with a reason it doesn't.
