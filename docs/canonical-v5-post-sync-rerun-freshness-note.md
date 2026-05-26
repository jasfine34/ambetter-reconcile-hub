# Canonical v5 Post-Sync Rerun Freshness Note

Status: Claude-facing repo note.
Date: 2026-05-26.

## What Codex Just Verified

Codex processed:

`codex-comm/requests/canonical-rule-corrections-prerequisite-v5-post-sync-rerun_NEW.md`

The request was marked:

`codex-comm/requests/canonical-rule-corrections-prerequisite-v5-post-sync-rerun_DONE.md`

Codex wrote the verdict:

`codex-comm/verdicts/canonical-rule-corrections-prerequisite-v5-post-sync-rerun_NEW.md`

## Bottom Line

The rerun still cannot certify the v5 live deltas because the freshness gate failed.

Three Ambetter batches are fresh after the v5 ship commit `b210bde0`:

- January 2026
- March 2026
- April 2026

February 2026 Ambetter is still stale:

- Batch ID: `1569468f-8962-41c7-bd05-10bc509fa31b`
- `last_full_rebuild_at`: `2026-05-18T00:59:11.649Z`
- Required freshness threshold: after `2026-05-26T18:35:14Z`

Because February is stale, Codex did not run the requested live deltas, SQL invariants, or similar-blind-spot magnitude checks. Running those checks on a mixed-fresh dataset would risk a false clean or false regression.

## What Claude Should Do Next

Do not treat canonical v5 as live-certified yet.

Do not draft or advance any directive that depends on the v5 post-sync rerun being clean until February 2026 Ambetter is rebuilt after `2026-05-26T18:35:14Z` and Codex reruns the same targeted verification.

The immediate operational ask is narrow:

1. Rebuild / rerun the February 2026 Ambetter batch only, unless Jason chooses to rebuild all four again.
2. Ask Codex to rerun `canonical-rule-corrections-prerequisite-v5-post-sync-rerun`.
3. Only after the freshness gate passes should Claude use the live delta sections to decide whether Stage 2.1 v5 can proceed.

## Related Repo Note

The separate Dannielle Coe issue is documented here:

`docs/mt-dannielle-coe-reversal-finding.md`

That issue is not part of the canonical v5 freshness rerun. It should remain a separate MT paid-then-reversed / chargeback-review classification directive.
