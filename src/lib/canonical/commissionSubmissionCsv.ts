/**
 * C3b-1 — headless 15-column commission-submission CSV serializer.
 *
 * Pure / headless: imports NO page module, NO React, NO Supabase, NO loader.
 * The existing single-month 12-column MCE carrier CSV
 * (`buildMesserCsv` in `MissingCommissionExportPage.tsx`) is unchanged and
 * stays byte-identical. This serializer is the new multi-month surface; it
 * appends three columns (Missing Month(s), Operator Comment, Pay Entity)
 * after the locked 12 base columns.
 *
 * Download wiring is intentionally NOT done here — that lands in C3b-2.
 */
import Papa from 'papaparse';
import {
  BASE_MESSER_COLUMNS_12,
  type MesserColumnDescriptor,
  type MesserVendorKey,
} from '@/lib/mce/messerColumns';
import { stripExcelTextMarker } from '@/lib/mce/csvExportSanitizers';
import type { VendorFieldsOutput } from '@/lib/mce/vendorEnrichment';

/** Synthetic keys for the appended columns. Live OUTSIDE MesserVendorKey
 *  so the locked 12-key base type does NOT widen.
 */
export type CommissionSubmissionAppendedKey =
  | 'missingMonths'
  | 'operatorComment'
  | 'payEntity';

export interface CommissionSubmissionAppendedDescriptor {
  key: CommissionSubmissionAppendedKey;
  label: string;
}

export type CommissionSubmissionColumnDescriptor =
  | MesserColumnDescriptor
  | CommissionSubmissionAppendedDescriptor;

const APPENDED_COLUMNS: ReadonlyArray<CommissionSubmissionAppendedDescriptor> = [
  { key: 'missingMonths', label: 'Missing Month(s)' },
  { key: 'operatorComment', label: 'Operator Comment' },
  { key: 'payEntity', label: 'Pay Entity' },
];

/**
 * The 15 commission-submission columns in vendor-required order: the 12
 * locked base Messer columns followed by Missing Month(s), Operator
 * Comment, and Pay Entity. Append-only — do NOT reorder.
 */
export const COMMISSION_SUBMISSION_COLUMNS: ReadonlyArray<CommissionSubmissionColumnDescriptor> = [
  ...BASE_MESSER_COLUMNS_12,
  ...APPENDED_COLUMNS,
];

/** One submission row = the 12 vendor fields + a list of missing months + the
 *  operator-seeded comment text + the row's pay-entity scope. Caller
 *  (commission-submission assembler) produces this shape. Preview/dollar/
 *  internal fields are NEVER included.
 */
export interface SubmissionRow {
  /** The 12 vendor fields produced by `enrichVendorFields`. */
  vendorFields: Pick<VendorFieldsOutput, MesserVendorKey>;
  /** Months in 'YYYY-MM' form, any order, possibly with duplicates/empties. */
  missingMonths: string[];
  /** Operator-seeded comment (already built upstream); written verbatim. */
  seededComment: string;
  /** Pay-entity scope for this row (Coverall/Vix); disambiguates dual-scope
   *  members emitted as two rows with otherwise-identical vendor fields. */
  payEntity: string;
}

const MONTH_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/**
 * Sort chronologically, de-dupe, and map 'YYYY-MM' -> 'MMM YYYY', joined with
 * '; '. Empty / invalid entries are dropped. Empty list -> ''.
 */
export function formatMissingMonths(months: string[]): string {
  if (!Array.isArray(months) || months.length === 0) return '';
  const valid: string[] = [];
  const seen = new Set<string>();
  for (const raw of months) {
    if (typeof raw !== 'string') continue;
    const m = raw.trim();
    if (!/^\d{4}-\d{2}$/.test(m)) continue;
    if (seen.has(m)) continue;
    seen.add(m);
    valid.push(m);
  }
  valid.sort();
  return valid
    .map((ym) => {
      const [y, mm] = ym.split('-');
      const idx = Number(mm) - 1;
      if (idx < 0 || idx > 11) return '';
      return `${MONTH_LABELS[idx]} ${y}`;
    })
    .filter(Boolean)
    .join('; ');
}

/**
 * Convert SubmissionRow[] → CSV with EXACTLY the 15 commission-submission
 * columns. Cols 1-12 come from `row.vendorFields` (same value mapping as the
 * 12-col `buildMesserCsv`, applying `stripExcelTextMarker` to the Writing
 * Agent Carrier ID column only). Col 13 = formatted missing months. Col 14
 * = operator comment verbatim. Col 15 = pay-entity scope.
 *
 * Only the 12 vendor fields + 3 appended cells are selected — the whole row
 * is NEVER spread, so preview/dollar/status/internal fields cannot leak.
 */
export function buildCommissionSubmissionCsv(rows: SubmissionRow[]): string {
  const labels = COMMISSION_SUBMISSION_COLUMNS.map((c) => c.label);
  const data = rows.map((row) => {
    const obj: Record<string, string> = {};
    for (const col of BASE_MESSER_COLUMNS_12) {
      const v = row.vendorFields[col.key];
      const raw = v == null ? '' : String(v);
      obj[col.label] = col.key === 'writingAgentCarrierId'
        ? stripExcelTextMarker(raw)
        : raw;
    }
    obj['Missing Month(s)'] = formatMissingMonths(row.missingMonths || []);
    obj['Operator Comment'] = row.seededComment == null ? '' : String(row.seededComment);
    obj['Pay Entity'] = row.payEntity == null ? '' : String(row.payEntity);
    return obj;
  });
  return Papa.unparse({ fields: labels, data });
}

/**
 * C3b-2 — pure row-shape adapter bridging the C3a headless assembler output
 * (vendor fields TOP-LEVEL on the row, via `VendorFieldsOutput`) into the
 * shape this serializer expects (vendor fields NESTED under
 * `row.vendorFields`). Only the 12 base Messer keys + `missingMonths` +
 * `seededComment` + the single `grainKey.targetScope` field (-> `payEntity`)
 * are copied — preview-only / internal / grain fields
 * (`estimatedMissingCommission`, `estMissingStatus`, `previewEstimatedTotal`,
 * `previewEstimatedStatus`, `rowMonthAnchors`, the rest of `grainKey`, etc.)
 * are intentionally dropped at this boundary so they can never leak into the
 * 15-column CSV.
 *
 * Does NOT change `buildCommissionSubmissionCsv`'s row contract.
 */
export type C3aSubmissionRowLike =
  & Partial<Pick<VendorFieldsOutput, MesserVendorKey>>
  & {
    missingMonths?: string[];
    seededComment?: string | null;
    grainKey?: { targetScope?: 'Coverall' | 'Vix' };
  };

export function toCommissionSubmissionCsvRow(c3aRow: C3aSubmissionRowLike): SubmissionRow {
  const vendorFields = {} as Record<MesserVendorKey, string>;
  for (const col of BASE_MESSER_COLUMNS_12) {
    const v = (c3aRow as Record<string, unknown>)[col.key];
    vendorFields[col.key] = v == null ? '' : String(v);
  }
  // Read only the single allowed scope field — never spread grainKey.
  const payEntity = c3aRow.grainKey?.targetScope ?? '';
  return {
    vendorFields: vendorFields as Pick<VendorFieldsOutput, MesserVendorKey>,
    missingMonths: Array.isArray(c3aRow.missingMonths) ? c3aRow.missingMonths : [],
    seededComment: typeof c3aRow.seededComment === 'string' ? c3aRow.seededComment : '',
    payEntity: typeof payEntity === 'string' ? payEntity : '',
  };
}
