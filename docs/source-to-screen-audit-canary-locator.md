# Source-to-Screen Audit Canary Locator

Created: 2026-05-17

This is a living document. Phase 2.1 updates it as canaries are verified against live data.

Mutation policy: READ ONLY ONLY. Do not click Rebuild, Upload, Save, Submit, Delete, or any action that changes live data.

## Status Codes

```text
FOUND_IN_SCOPE
FOUND_OUT_OF_SCOPE
NOT_FOUND
EDGE_SHIFTED
NEW_EDGE_FOUND
PENDING_LOOKUP
```

## Locator Schema

```text
canary_id:
name:
batch_month:
scope:
member_key:
reconciled_member_id:
policy_identity_key:
target_service_month:
clearing_state:
why_selected:
status:
last_verified:
```

## Canaries

### 1. Diedric Mccullough

```text
canary_id: canary-ffm-class-a-diedric-mccullough
name: Diedric Mccullough
batch_month:
scope:
member_key:
reconciled_member_id:
policy_identity_key:
target_service_month:
clearing_state:
why_selected: Class-A FFM fallback example. Earlier diagnostics identified EDE ffmAppId 7299388894 with a BO/EDE member-key split pattern.
status: PENDING_LOOKUP
last_verified:
```

### 2. Lisa Taylor

```text
canary_id: canary-georgia-sbe-lisa-taylor
name: Lisa Taylor
batch_month: 2026-01
scope: Ambetter Coverall Zero Net Premium
member_key:
reconciled_member_id:
policy_identity_key:
target_service_month:
clearing_state:
why_selected: Georgia SBE valid application ID 9690062026. Earlier live MCE format-distribution test showed Member ID u71844259 and confirmed this was not a member-ID leak.
status: FOUND_IN_SCOPE
last_verified: 2026-05-17 live MCE test / Jason confirmation
```

### 3. Frederick Williams

```text
canary_id: canary-georgia-sbe-frederick-williams
name: Frederick Williams
batch_month: 2026-01
scope: Ambetter Coverall Zero Net Premium
member_key:
reconciled_member_id:
policy_identity_key:
target_service_month:
clearing_state:
why_selected: Georgia SBE valid application ID 2457662026. Earlier live MCE format-distribution test showed Member ID u71620007 and confirmed this was not a member-ID leak.
status: FOUND_IN_SCOPE
last_verified: 2026-05-17 live MCE test / Jason confirmation
```

### 4. Patty Lott

```text
canary_id: canary-13d-override-patty-lott
name: Patty Lott
batch_month:
scope:
member_key:
reconciled_member_id:
policy_identity_key:
target_service_month:
clearing_state:
why_selected: Bundle 13d override-rate smoke canary. Significance must be re-established from live rows before assertion.
status: PENDING_LOOKUP
last_verified:
```

### 5. Alicia Diaby

```text
canary_id: canary-13d-override-alicia-diaby
name: Alicia Diaby
batch_month:
scope:
member_key:
reconciled_member_id:
policy_identity_key:
target_service_month:
clearing_state:
why_selected: Bundle 13d override-rate smoke canary. Significance must be re-established from live rows before assertion.
status: PENDING_LOOKUP
last_verified:
```

### 6. Alicia Lopez

```text
canary_id: canary-13d-override-alicia-lopez
name: Alicia Lopez
batch_month:
scope:
member_key:
reconciled_member_id:
policy_identity_key:
target_service_month:
clearing_state:
why_selected: Bundle 13d override-rate smoke canary. Significance must be re-established from live rows before assertion.
status: PENDING_LOOKUP
last_verified:
```

### 7. Erica-Owned Coverall Row

```text
canary_id: canary-erica-owned-coverall
name: Erica-owned Coverall row (Coverall-paid Erica writing evidence present)
batch_month: 2026-01
scope: Coverall
member_key: multiple; examples in phase-2-1-dashboard helper artifact under canaries.ericaCommissionRows
reconciled_member_id:
policy_identity_key:
target_service_month:
clearing_state:
why_selected: Erica AOR paid by Coverall can be expected overage/override behavior and should not be confused with Messer master-table missing commission.
status: FOUND_IN_SCOPE
last_verified: 2026-05-17 Phase 2.1 Dashboard audit
```

### 8. Erica / Vix Row

```text
canary_id: canary-erica-vix-payee
name: Erica/Vix row (Anthony Ceasar)
batch_month: 2026-01
scope: Vix
member_key: issub:u73040140
reconciled_member_id: 00fb91d6-fd27-4288-bd3e-42016b408090
policy_identity_key:
target_service_month:
clearing_state:
why_selected: Vix is pay entity while ownership remains AOR. Must not leak into Coverall money unless the scope helper intentionally includes it.
status: FOUND_IN_SCOPE
last_verified: 2026-05-17 Phase 2.1 Dashboard audit
```

### 9. Cleared-Then-Reversed Row

```text
canary_id: canary-cleared-then-reversed
name: Cleared-then-reversed row
batch_month:
scope:
member_key:
reconciled_member_id:
policy_identity_key:
target_service_month:
clearing_state: cleared_then_reversed
why_selected: Cross-batch terminal state. Must not be treated as fully cleared or ordinary unpaid.
status: NOT_FOUND
last_verified: 2026-05-17 Phase 2.1 Dashboard audit found zero active cross_batch_clearings rows with clearing_state='cleared_then_reversed'
```

### 10. Manual-Review Clearing Row

```text
canary_id: canary-clearing-manual-review
name: Manual-review clearing row (Toronto Smith)
batch_month: 2026-01
scope: Coverall
member_key: issub:u72731324
reconciled_member_id: 08ab914a-92df-4a2f-bebe-0e6cf18b929d
policy_identity_key:
target_service_month: 2026-01
clearing_state: manual_review_required
why_selected: Row remains unresolved and must be visibly flagged rather than silently counted as normal.
status: FOUND_IN_SCOPE
last_verified: 2026-05-17 Phase 2.1 Dashboard audit
```

### 11. Partial-Cleared Row

```text
canary_id: canary-partial-cleared
name: Partial-cleared row
batch_month:
scope:
member_key:
reconciled_member_id:
policy_identity_key:
target_service_month:
clearing_state: partially_cleared
why_selected: Remaining dollars should display as the clearing remainder, not original estimated missing commission.
status: NOT_FOUND
last_verified: 2026-05-17 Phase 2.1 Dashboard audit found zero active cross_batch_clearings rows with clearing_state='partially_cleared'
```

### 12. Zero-Expected Row

```text
canary_id: canary-zero-expected
name: Zero-expected row
batch_month:
scope:
member_key:
reconciled_member_id:
policy_identity_key:
target_service_month:
clearing_state: zero_expected_no_payment_required
why_selected: No payment required; should be removed from unpaid counts and exports.
status: NOT_FOUND
last_verified: 2026-05-17 Phase 2.1 Dashboard audit found zero active cross_batch_clearings rows with clearing_state='zero_expected_no_payment_required'
```

### 13. True BO-Only Member

```text
canary_id: canary-true-bo-only-blank-ffm
name: True BO-only member
batch_month:
scope:
member_key:
reconciled_member_id:
policy_identity_key:
target_service_month:
clearing_state:
why_selected: Correct blank FFM case when no EDE row exists.
status: PENDING_LOOKUP
last_verified:
```

### 14. Multi-FFM Member

```text
canary_id: canary-multi-ffm
name: Multi-FFM member
batch_month:
scope:
member_key:
reconciled_member_id:
policy_identity_key:
target_service_month:
clearing_state:
why_selected: Validates multi-FFM picker order, tooltip/badge behavior, and joined export behavior.
status: PENDING_LOOKUP
last_verified:
```

### 15. State-Normalization Canary

```text
canary_id: canary-state-normalization-erica-flowers-pattern
name: State-normalization canary
batch_month:
scope:
member_key:
reconciled_member_id:
policy_identity_key:
target_service_month:
clearing_state:
why_selected: Prior state mismatch caused manual-review clearing inflation. Erica Flowers live case drove the fix; locate a current row with the same raw state-field shape.
status: PENDING_LOOKUP
last_verified:
```

### 16. SBA Direct-Write Georgia Member

```text
canary_id: canary-sba-direct-write-georgia
name: SBA direct-write Georgia member
batch_month:
scope:
member_key:
reconciled_member_id:
policy_identity_key:
target_service_month:
clearing_state:
why_selected: Georgia rows may have valid SBE application IDs or no EDE row depending on write path. Expected behavior must be source-supported.
status: PENDING_LOOKUP
last_verified:
```

### 17. Anthony Lembrick Timeline Anomaly

```text
canary_id: canary-member-timeline-anthony-lembrick-null-aor
name: ANTHONY LEMBRICK
batch_month:
scope:
member_key:
reconciled_member_id:
policy_identity_key:
target_service_month:
clearing_state:
why_selected: Jason-observed Member Timeline anomaly: row sublabel showed Jason Fine while AOR/current-agent column rendered "null null (null)", and January cell showed B+C while unpaid. Source-to-screen audit should determine whether this is display drift, data gap, or category/money bug.
status: NEW_EDGE_FOUND
last_verified: 2026-05-17 screenshot observation
```
