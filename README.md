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

- **Pre-upload destination-confirmation modal.** Before any
  `upload_replace_file` call, show a modal that displays the destination
  batch month, `file_label`, file name, and file size, and require an
  explicit click-to-confirm before the RPC fires. All four fields must
  be shown — three concrete operator errors observed during the May
  2026 Feb recovery prove that any single field alone is insufficient
  (operator can match on one and miss another):
    1. **Wrong-batch upload.** Feb EDE Summary file landed in the April
       batch — batch selector drifted, file name was correct.
    2. **Misaligned April slots from earlier sessions.** Feb-named
       files sitting in April's `EDE Archived Enrolled` /
       `EDE Archived Not Enrolled` slots — file_label correct, file
       name wrong for the destination month.
    3. **Wrong-file upload into correct batch (2026-05-05 03:06–03:07Z).**
       Batch selector correctly on Feb 2026 and `file_label` correctly
       `EDE Summary`, but the operator picked the April-anchored
       `BC3614-…summary--2026-04-01.csv` from disk instead of the
       intended `BC3614-…summary--2026-02-02.csv`. Destination month
       and label alone would not have caught this; the file name (and
       likely size) would have.
  All three trace to the same root cause: the active destination is
  not visually anchored to the action. A modal makes destination
  batch + label + file name + file size explicit at the point of
  action and is unmissable in a way the inline `UploadPage` banner is
  not. Pair with the toast disambiguation and the April misaligned-
  slots audit — same recovery, same operator-trust theme.

- **Upload tile last-uploaded summary.** Each upload tile on
  `UploadPage` should display a "last uploaded" timestamp + filename
  for its slot at a glance, so operators can visually confirm slot
  state without querying the DB. Surfaced during the May 2026 Feb
  recovery: after the wrong-file Feb EDE Summary upload (and again
  after the Coverall Commission misleading toast), the only way to
  confirm what was actually active in each slot was an out-of-band
  DB query. Tile-level visibility would close the loop and let the
  operator self-verify each upload before proceeding to the next
  step. Same operator-trust theme as the confirmation modal and
  toast disambiguation.

- **Toast header for post-upload reconcile failures.** The toast
  body was improved to say *"file saved — try Rebuild"*, but the
  red header still reads *"Upload failed: {label}"* even though the
  upload succeeded and only the post-upload auto-reconcile timed
  out. Header should match the body's semantics — e.g. *"Saved,
  reconcile pending: {label}"* with a yellow/warning style instead
  of red/destructive. Observed twice during the May 2026 Feb
  recovery (EDE Summary 1c, Coverall Commission 2a).

- **Sweep ghost `uploaded_files` rows with zero normalized rows.**
  Surfaced during the May 2026 Feb recovery Vix verification: the
  superseded Vix Commission Statement file `bf2fb7ca-b449-4285-bd25-9b74775e65ea`
  (uploaded 2026-04-23 19:40Z, file_name `Renewal Agent Statement -
  2026-03-21 Vix.csv`) has 0 rows in `normalized_records`. Predates
  the atomic `upload_replace_file` refactor and is consistent with an
  earlier upload session committing the `uploaded_files` row without
  committing the per-file normalized rows. Add a one-time audit query
  (`SELECT f.id, f.batch_id, f.file_label, f.staging_status FROM
  uploaded_files f LEFT JOIN normalized_records n ON
  n.uploaded_file_id = f.id GROUP BY f.id HAVING COUNT(n.id) = 0`) and
  decide per-row whether to delete the ghost or backfill from storage.
  Pair with the misaligned-April-slots audit — both clean up
  pre-refactor data drift before the next rebuild cycle.

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

---

## Open Tickets

### #113 (P1) — Member-key alignment drift between rebuild reconciler and in-browser canonical recompute

**Status**: Open — diagnosis-only, no patches until fix shape is reviewed.
**Parent**: #112 (Feb 2026 recovery) — stays open until #113 is resolved or
explicitly split off as an accepted follow-up.

**Symptoms**
- Missing Commission Export for Feb / Coverall returns **0 rows** while DB
  and Dashboard show **~51–55 unpaid / missing-commission candidates**
  (`commission_estimates` count = 55, Dashboard "Unpaid Policies" = 55).
- Dashboard *Found in Back Office* / *Eligible* values diverge from
  Source Funnel BO attributed counts.
- Source Funnel Feb BO attributed = **1,439** while
  `reconciled_members.in_back_office = true` count = **210**
  (only Erica's 359 BO bucket flips the flag; Jason's 2,295 and Becky's
  594 do not).
- `reconciled_members.in_back_office` / eligible predicates do not align
  with the restored Jason / Becky BO data.
- In-browser `filteredEde` / `getEligibleCohort` cannot see the same
  members that the rebuilt `reconciled_members` snapshot contains.

**Working hypothesis**
`computeFilteredEde` (`src/lib/expectedEde.ts`) and `getEligibleCohort`
(`src/lib/canonical/metrics.ts`) rebuild member keys *in-browser* from raw
/ current-batch records, while `reconciled_members.member_key` was written
by the rebuild reconciler **after** the resolver / canonical merge pass
(`mergeRecordsToMemberKeys` in `src/lib/canonical/memberKeyMerge.ts`,
which layers `resolved_identities` overlay on top of the union-find).
The two key spaces are not aligning post-recovery, so
`eeUniverse.has(member_key)` fails even though the DB-level predicate
fields are populated.

This is the same family of defect as the BO attribution flag mismatch:
the reconciler-written `in_back_office` flag is computed against one
key space; downstream UI predicates evaluate against a different one.

**Diagnosis plan (next session)**
1. Compare key derivation between:
   - `reconcile.ts` (writes `reconciled_members.member_key`)
   - `computeFilteredEde` / `filteredEde` uniqueMembers
   - `getEligibleCohort` predicate
   - `mergeRecordsToMemberKeys` (canonical) vs `assignMergedMemberKeys`
     (raw union, no sidecar overlay)
2. Inspect 5–10 of the 55 unpaid Feb members. For each, capture:
   - `reconciled_members.member_key`
   - EDE-derived raw key (pre-merge)
   - resolved / canonical key (post-`mergeRecordsToMemberKeys`)
   - `filteredEde` uniqueMembers key
3. Identify the divergence point — is the in-browser path skipping the
   `resolved_identities` overlay? Using `assignMergedMemberKeys` directly
   instead of `mergeRecordsToMemberKeys`?
4. Decide fix location:
   - in-browser path adopts the canonical `mergeRecordsToMemberKeys`
     (preferred — matches reconciler), **or**
   - reconciler output contract is adjusted so downstream consumers can
     re-derive without the sidecar.
5. Apply canonical-predicate-pattern discipline: one helper / source of
   truth, both Dashboard and Export paths route through it. See
   `ARCHITECTURE_PLAN.md § Canonical Helpers — Consumer Adoption Status`.

**Hard rule**: diagnose first. **No mutations or patches** until the fix
shape is reviewed and approved.

**Recovered state (from #112) — preserved**
- Active `normalized_records` restored: **7,293**
- All 8 Feb source slots clean (Coverall 1,525 / Vix 107 / Jason 2,295 /
  Becky 594 / Erica 359 / EDE Summary 1,657 / EDE Archived Enrolled 222 /
  EDE Archived Not Enrolled 534).
- Rebuild pipeline completed; lock clean; 0 staged stragglers.
- DB / Dashboard correctly show 55 unpaid / missing-commission candidates.

**Related follow-ups (separate tickets, do not bundle)**
- `preflush_stale_staged_rows` `57014` timeout + UI retry-status surfacing
- Rebuild error-toast misclassification (showed "failed" on silent retry success)
- Loading-state UX (spinner / skeleton / empty state) on data-fetching pages
- Explicit "Run Report" action on filter-driven pages
- Misaligned April slots audit
- Ghost `uploaded_files` rows audit (zero normalized children)
