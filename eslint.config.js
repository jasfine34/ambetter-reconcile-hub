import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

/**
 * Sanctioned-writer policy for normalized_records (post-Feb-15:32 refactor):
 *
 *   1. Direct INSERT into normalized_records is forbidden EXCEPT inside
 *      `insertStagedNormalizedRecords` in src/lib/persistence.ts. All other
 *      writes must route through the upload_replace_file RPC (uploads) or
 *      replace_normalized_for_file_set RPC (rebuilds).
 *
 *   2. The bare predicate `.is('superseded_at', null)` (without an
 *      accompanying `.eq('staging_status', 'active')`) is forbidden in
 *      production read paths — use the canonical helpers
 *      `activeNormalizedRowsQuery` / `activeNormalizedCountQuery` /
 *      `activeUploadedFilesQuery` from src/lib/persistence.ts so reads
 *      respect both the staging discriminator and the supersede history.
 *
 *   3. The test-only deleter `__test_only_deleteCurrentNormalizedForBatch`
 *      may only be imported from `src/test/`.
 *
 * The rules are scoped to production source paths (src/, excluding src/test/
 * and src/lib/persistence.ts itself) via `files`/`ignores`.
 */
export default tseslint.config(
  { ignores: ["dist"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  // Sanctioned-writer policy: applies to production code only.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      "src/test/**",
      "src/lib/persistence.ts", // sanctioned writer + canonical helpers live here
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          // (1) Direct INSERT into normalized_records.
          selector:
            "CallExpression[callee.property.name='insert'][callee.object.callee.property.name='from'][callee.object.arguments.0.value='normalized_records']",
          message:
            "Direct INSERT into normalized_records is forbidden. Use insertStagedNormalizedRecords (rebuilds) or the upload_replace_file RPC (uploads).",
        },
        {
          // (2) Bare .is('superseded_at', null) — must be paired via the
          //     canonical helpers in persistence.ts.
          selector:
            "CallExpression[callee.property.name='is'][arguments.0.value='superseded_at']",
          message:
            "Bare .is('superseded_at', null) is forbidden. Use activeNormalizedRowsQuery / activeNormalizedCountQuery / activeUploadedFilesQuery from @/lib/persistence (canonical active predicate: staging_status='active' AND superseded_at IS NULL).",
        },
        {
          // (3) Direct UPDATE of superseded_at — promote/supersede happens
          //     inside RPCs only.
          selector:
            "Property[key.name='superseded_at'][value.type='NewExpression']",
          message:
            "Setting superseded_at from JS is forbidden. Supersede happens atomically inside upload_replace_file / replace_normalized_for_file_set.",
        },
        {
          // (3b) catch the object-literal `superseded_at: ...` pattern in
          //      .update() payloads regardless of value shape.
          selector:
            "CallExpression[callee.property.name='update'] Property[key.name='superseded_at']",
          message:
            "Setting superseded_at from JS is forbidden. Supersede happens atomically inside upload_replace_file / replace_normalized_for_file_set.",
        },
        {
          // (4) Importing the test-only deleter from production code.
          selector:
            "ImportSpecifier[imported.name='__test_only_deleteCurrentNormalizedForBatch']",
          message:
            "__test_only_deleteCurrentNormalizedForBatch is restricted to src/test/. Production rebuilds use the staged-then-promote pipeline.",
        },
        {
          // (5) Direct INSERT into bo_snapshots — upload-lifecycle artifact.
          //     Must route through upload_replace_file RPC (atomic) or the
          //     sanctioned helper in persistence.ts (lazy backfill only).
          selector:
            "CallExpression[callee.property.name='insert'][callee.object.callee.property.name='from'][callee.object.arguments.0.value='bo_snapshots']",
          message:
            "Direct INSERT into bo_snapshots is forbidden. Snapshots are upload-lifecycle artifacts — use the upload_replace_file RPC (uploads) or getOrCreateSnapshotForFile in persistence.ts (rebuild backfill, scheduled for removal).",
        },
        {
          // (6) Direct INSERT into ede_snapshots — same contract as bo_snapshots.
          selector:
            "CallExpression[callee.property.name='insert'][callee.object.callee.property.name='from'][callee.object.arguments.0.value='ede_snapshots']",
          message:
            "Direct INSERT into ede_snapshots is forbidden. Snapshots are upload-lifecycle artifacts — use the upload_replace_file RPC (uploads) or getOrCreateSnapshotForFile in persistence.ts (rebuild backfill, scheduled for removal).",
        },
      ],
    },
  },
);
