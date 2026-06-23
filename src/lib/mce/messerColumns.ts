/**
 * C3b-1 — neutral base descriptors for the 12 vendor Messer-form columns.
 * Pure / headless: no React, no Supabase, no page imports.
 *
 * `BASE_MESSER_COLUMNS_12` is the single source of truth for the locked
 * 12-column carrier-facing schema. The existing page-local `MESSER_COLUMNS`
 * derives from this; the new multi-month commission-submission serializer
 * builds its 15-column header on top of these 12 (append-only).
 */
import type { VendorFieldsOutput } from '@/lib/mce/vendorEnrichment';

/**
 * Neutral union of the 12 vendor field keys on `VendorFieldsOutput`. The
 * preview-only fields (`estimatedMissingCommission`, `estMissingStatus`) are
 * intentionally excluded — they are NEVER part of the carrier CSV.
 */
export type MesserVendorKey = Exclude<
  keyof VendorFieldsOutput,
  'estimatedMissingCommission' | 'estMissingStatus'
>;

export interface MesserColumnDescriptor {
  key: MesserVendorKey;
  label: string;
}

/**
 * The 12 locked Messer-form columns in carrier-required order. Mirrors the
 * page-local `MESSER_COLUMNS` exactly (keys + labels + order). Changing this
 * is a CSV schema change — see docs/mce-export-contract.md.
 */
export const BASE_MESSER_COLUMNS_12: ReadonlyArray<MesserColumnDescriptor> = [
  { key: 'carrierName', label: 'Carrier Name' },
  { key: 'npn', label: 'NPN' },
  { key: 'writingAgentCarrierId', label: 'Writing Agent Carrier ID' },
  { key: 'writingAgentName', label: 'Writing Agent Name' },
  { key: 'policyEffectiveDate', label: 'Policy Effective Date' },
  { key: 'policyNumber', label: 'Policy #' },
  { key: 'memberFirstName', label: 'Member First Name' },
  { key: 'memberLastName', label: 'Member Last Name' },
  { key: 'dob', label: 'DOB' },
  { key: 'ssn', label: 'SSN' },
  { key: 'memberId', label: 'Member ID' },
  { key: 'address', label: 'Address (Street, City, State, Zip)' },
];
