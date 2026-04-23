/**
 * Carrier registry.
 *
 * Each carrier contributes an adapter that normalizes its Back Office CSV
 * into a NormalizedRecord. EDE and Commission parsers stay shared because
 * those files come from Messer with a consistent schema across carriers.
 *
 * Adding a new carrier means:
 *   1. Drop a module under src/lib/carriers/<carrier>/ exporting a
 *      `normalize<Name>BackOfficeRow()` and a `detect<Name>Schema()`.
 *   2. Register it here.
 *   3. No change to normalize.ts, reconcile.ts, or UI code.
 */
import type { NormalizedRecord } from '../normalize';
import {
  AMBETTER_CARRIER,
  normalizeAmbetterBackOfficeRow,
  detectAmbetterBackOfficeSchema,
} from './ambetter/backOffice';

export interface BackOfficeCarrierAdapter {
  carrier: string;
  detectSchema: (headers: string[]) => boolean;
  normalizeRow: (row: Record<string, string>, fileLabel: string, aorBucket: string) => NormalizedRecord;
}

const ADAPTERS: BackOfficeCarrierAdapter[] = [
  {
    carrier: AMBETTER_CARRIER,
    detectSchema: detectAmbetterBackOfficeSchema,
    normalizeRow: normalizeAmbetterBackOfficeRow,
  },
];

/**
 * Return the adapter for a carrier name. Falls back to Ambetter for now, since
 * that's the only implemented carrier; when we expand this will throw or route
 * to a detected adapter instead.
 */
export function getBackOfficeAdapter(carrier: string): BackOfficeCarrierAdapter {
  const match = ADAPTERS.find(a => a.carrier.toLowerCase() === carrier.toLowerCase());
  return match ?? ADAPTERS[0];
}

/**
 * Guess the carrier from a BO file's headers. Currently only Ambetter is
 * registered, so this returns Ambetter if headers match, else undefined.
 */
export function detectCarrierFromBackOfficeHeaders(headers: string[]): BackOfficeCarrierAdapter | undefined {
  return ADAPTERS.find(a => a.detectSchema(headers));
}
