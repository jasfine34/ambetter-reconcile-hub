# MT Dannielle Coe Reversal Finding

Status: targeted finding for Claude/directive drafting.
Date: 2026-05-26.

## Plain-English Finding

Dannielle Coe's January 2026 Member Timeline cell should not be treated as a simple "missing commission" case.

The raw commission evidence shows a January commission was paid and then later reversed:

- Original payment: `+$48.00` Coverall commission for service month January 2026.
- Later reversal: `-$48.00` Coverall commission against the same policy and same January paid-to month.
- Net result in active normalized data: `$0.00`.

So MT showing total paid `$0.00` is mathematically explainable, but the current plain `unpaid` label is misleading. The better semantic is paid-then-reversed / chargeback review / cleared-then-reversed, not ordinary unpaid.

## Evidence

Raw file shown by Jason:

`C:/Users/jasfi/Downloads/Renewal Agent Statement - 2026-02-21 (51).CSV`

Relevant original payment row:

- Policyholder Name: `DANNIELLE COE`
- Policy Number: `U96332808-AR`
- Writing Agent ID: `21055210`
- Agent Name: `COVERALL HEALTH GROUP CALL CENTER`
- Paid-To Date: `01/31/2026`
- Months Paid: `1`
- Gross Commission: `$48.00`
- Transaction ID: `8245546`

Active normalized original payment row:

- `normalized_records.id`: `c61f45a1-e2f4-411a-b1e4-537b66fe4b8d`
- `member_key`: `issub:u96332808`
- `source_type`: `COMMISSION`
- `pay_entity`: `Coverall`
- `paid_to_date`: `2026-01-31`
- `months_paid`: `1`
- `commission_amount`: `48.00`
- `staging_status`: `active`

Active normalized reversal row:

- `normalized_records.id`: `d37b722e-843f-4086-953c-79d7d4b3ab85`
- `member_key`: `issub:u96332808`
- `source_type`: `COMMISSION`
- `pay_entity`: `Coverall`
- `paid_to_date`: `2026-01-31`
- `months_paid`: `1`
- `commission_amount`: `-48.00`
- `premium`: `-1.00`
- `raw_json.Transaction ID`: `8705401`
- `raw_json.Gross Commission`: `($48.00)`
- `raw_json.Commissionable`: `($1.00)`
- `staging_status`: `active`

## Code Path Implication

MT currently adds commission amounts for the service month:

- `src/lib/memberTimeline.ts` uses `commissionServiceMonths()` and adds `per` into `cell.paid_amount`.
- `src/lib/classifier.ts` treats `paid_amount > 0.0001` as paid.
- If positive and negative commission rows net to zero, the current classifier falls through to unpaid-style states.

That means a paid-then-reversed member can visually look like an ordinary unpaid member even though the commission statement history is materially different.

## Recommended Directive Handling

Treat this as Red + Yellow:

- Red because it changes payment-status/classifier semantics.
- Yellow because the MT cell label/badge/tooltip should change.

Recommended canary:

`Dannielle Coe Jan 2026: +$48 commission then -$48 reversal for the same paid-to month. Expected outcome: not ordinary paid, not ordinary unpaid. Expected MT state should surface paid-then-reversed / chargeback review / cleared-then-reversed semantics.`

Recommended implementation direction:

- Reuse or align with `src/lib/canonical/crossBatchAmountClearing.ts`, which already has a `cleared_then_reversed` clearing state.
- If MT cannot reuse that helper directly, the directive should require an explicit explanation and equivalent logic for per-cell reversal detection.
- The tooltip/debug detail should show both contributing rows, not just the net `$0.00`.

## Stop / Confirm Point

Before shipping a new MT state name, confirm the operator-facing label with Jason. Suggested plain-English labels:

- `reversed`
- `paid then reversed`
- `chargeback review`

The business meaning is settled enough to avoid plain `unpaid`; the final label can be chosen in the directive.
