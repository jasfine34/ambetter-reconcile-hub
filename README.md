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

**Snapshots** (`bo_snapshots` / `ede_snapshots`) are upload-lifecycle
artifacts and follow the same writer policy: direct INSERT outside
`src/lib/persistence.ts` is a lint error. The sanctioned writers are
`upload_replace_file` (atomic with the file/normalized rows) and
`getOrCreateSnapshotForFile()` (rebuild lazy-backfill — see follow-ups).

`__test_only_deleteCurrentNormalizedForBatch` is for fixture cleanup only and
may not be imported outside `src/test/`.

## Post-Feb-recovery follow-ups

- **Remove `getOrCreateSnapshotForFile` lazy-backfill helper.** This exists
  only to backfill snapshot rows for files uploaded before the Phase 1a
  inline-snapshot RPC change. **Removal criterion:** when a query confirms
  every `uploaded_files` row in the Feb–Apr 2026 batches has an associated
  `bo_snapshots` / `ede_snapshots` row, delete `getOrCreateSnapshotForFile`
  from `src/lib/persistence.ts`, drop its call site in `src/lib/rebuild.ts`
  (rebuilds will then look up the existing snapshot id off the file
  directly), and remove the carve-out language from the snapshot lint
  messages.
  Verification query (must return zero rows before removal):
  ```sql
  SELECT uf.id, uf.source_type
    FROM uploaded_files uf
    LEFT JOIN bo_snapshots  bs ON bs.uploaded_file_id = uf.id
    LEFT JOIN ede_snapshots es ON es.uploaded_file_id = uf.id
   WHERE uf.batch_id IN (<feb..apr batch ids>)
     AND uf.staging_status = 'active'
     AND ((uf.source_type = 'BACK_OFFICE' AND bs.id IS NULL)
       OR (uf.source_type = 'EDE'         AND es.id IS NULL));
  ```

- **Storage-orphan sweep job.** `uploadFileToStorage` writes to a
  per-attempt path (`<batchId>/<label>_<Date.now()>.csv`), so an
  `upload_replace_file` RPC rollback after the storage upload completes
  leaves the object in the `commission-files` bucket with no
  `uploaded_files` row pointing at it. Add a periodic sweep that lists
  bucket objects under each batch prefix and deletes any whose path is
  not referenced by an active or staged `uploaded_files.storage_path`.

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
