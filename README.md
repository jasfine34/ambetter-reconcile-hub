# Welcome to your Lovable project

TODO: Document your project here

## Sanctioned-writer policy for normalized_records

After the Feb 15:32 zero-EDE-wipe regression, normalized_records writes are
restricted to a small set of sanctioned paths. The ESLint rules in
`eslint.config.js` enforce these at the source level.

**Reads**: production code MUST go through the canonical active predicate
helpers in `src/lib/persistence.ts`:

- `activeNormalizedRowsQuery(batchId?)`
- `activeNormalizedCountQuery(batchId?)`
- `activeUploadedFilesQuery(batchId?)`

The canonical predicate is `staging_status = 'active' AND superseded_at IS NULL`.
Bare `.is('superseded_at', null)` is forbidden — it would count an in-flight
rebuild's staged rows as live data.

**Writes**: only two paths may write normalized_records.

1. **Uploads** → `upload_replace_file` RPC (via `uploadReplaceFile()`).
   Atomic: insert uploaded_files + insert snapshot + insert normalized
   (staged) + verify + supersede prior + promote, all in one TX.
2. **Rebuilds** → `insertStagedNormalizedRecords()` for staging, then
   `replace_normalized_for_file_set` RPC (via `replaceNormalizedForFileSet()`)
   to atomically check lock + per-file count + required-source-type aggregate
   guard + supersede + promote.

Direct INSERT into normalized_records and direct UPDATE of `superseded_at`
from JavaScript are both lint errors outside `src/lib/persistence.ts`.

`__test_only_deleteCurrentNormalizedForBatch` is for fixture cleanup only and
may not be imported outside `src/test/`.

**Rebuild pipeline ordering** (enforced by `rebuildBatch` in `src/lib/rebuild.ts`):

```
acquireRebuildLock → preflushStaleStagedRows → per-file stage →
replaceNormalizedForFileSet (with derived requiredSourceTypes) →
reconcile → releaseRebuildLock (in finally)
```

A reconcile failure AFTER a successful promote raises
`ReconcileAfterPromoteError` so the UI can surface the explicit message:
*"rebuild promoted new normalized data but reconcile failed — click
Rebuild to complete."*
