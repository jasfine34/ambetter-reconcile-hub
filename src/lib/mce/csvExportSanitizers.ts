/**
 * C3b-1 — neutral CSV export sanitizers shared by the existing single-month
 * MCE (12-col) export and the new multi-month commission-submission (14-col)
 * serializer. Pure / headless: no React, no Supabase, no page imports.
 *
 * `stripExcelTextMarker` was moved verbatim from
 * `src/pages/MissingCommissionExportPage.tsx`. Behavior is unchanged.
 */

/**
 * #109 finishing touch — strip a single leading apostrophe (Excel text-format
 * marker) from a value at the CSV-render boundary only. Source data, the
 * derived lookup, and the in-memory preview remain untouched.
 */
export const stripExcelTextMarker = (value: unknown): string =>
  (value == null ? '' : String(value)).replace(/^'/, '');
