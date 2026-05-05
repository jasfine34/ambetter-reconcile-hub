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

- **Audit April 2026 batch for misaligned slots.** During the May 2026 Feb
  recovery, two April active rows were observed holding Feb-named files
  (uploaded ~2026-05-04 23:27Z, before the recovery session):
  - `EDE Archived Enrolled` active = `63be8a8b-94b7-4d72-8c98-87c452d554f3`
    → `BC3614-aca-enrollments-archived_enrolled--2026-02-02 (1).csv`
  - `EDE Archived Not Enrolled` active = `ff11558a-dcc4-4472-818a-1112f3b5707e`
    → `BC3614-aca-enrollments-archived_not_enrolled--2026-02-02 (1).csv`
  After Feb is fully restored and rebuilt, audit every active
  `uploaded_files` row in the April batch (`652750c4-...`), confirm
  whether each file_label's active row points at a `--2026-04-01.csv`
  file (or otherwise correct April data), and atomically replace any
  misaligned slots before re-running the April rebuild. Do NOT touch
  April further until Feb recovery completes.

- **Consider bumping `replace_reconciled_members_for_batch` statement
  timeout.** Observed during the May 2026 Feb recovery: the post-upload
  reconcile invocation from `processUpload` hit `statement_timeout`
  (SQLSTATE 57014) on the April batch at 02:50:55Z, ~27s after a
  successful `upload_replace_file`. The atomic upload is preserved —
  reconcile failure is non-fatal and the user re-runs reconcile via
  Rebuild — but the toast surface is noisy. Decide whether to apply a
  function-scoped 120s bump here too, or leave reconcile to the Rebuild
  flow.

- **Disambiguate the upload failure toast.** Today, `processUpload` in
  `src/pages/UploadPage.tsx` shows the same destructive red "Upload
  failed: <label>" toast for every failure step, including the
  post-upload auto-reconcile step. When `upload_replace_file` succeeds
  but the subsequent `replace_reconciled_members_for_batch` fails (e.g.
  reconcile statement_timeout), the operator sees a destructive toast
  even though the file is safely saved and superseded the prior active
  row. Replace with two distinct surfaces:
  - Destructive: *"Upload failed — data was not saved. {step}: {msg}"*
    (any failure where the atomic upload RPC did not promote).
  - Warning (not destructive): *"Upload saved, but auto-reconcile
    failed — click Rebuild to refresh. {msg}"* (only the
    `Reconcile after upload` branch).
  Pair with the wrong-batch confirmation-modal follow-up — both are
  operator-trust issues surfaced during the May 2026 Feb recovery.

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
