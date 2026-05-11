/**
 * Phase 1.5 mechanical cleanup — shared Source Type classifier.
 *
 * Both DashboardPage (unpaid drilldown annotation) and
 * MissingCommissionExportPage (export row `_sourceType` column) need to
 * classify an unpaid/missing row as one of:
 *
 *   - 'BO Only'   — row is in `universe.boOnly`
 *   - 'EDE Only'  — row is in `universe.edeOnly`
 *   - 'Matched'   — neither
 *
 * Precedence is locked: `boOnly` is checked first, then `edeOnly`. The two
 * universe buckets are disjoint by construction, so this only matters as a
 * defensive tiebreaker; the locked order matches DashboardPage's inline
 * derivation prior to extraction.
 *
 * String literals are pinned to the exact values previously emitted by the
 * two pages; downstream UI (drilldown column rendering, CSV column,
 * Messer export gating) reads them verbatim.
 */

export type SourceTypeForRow = 'BO Only' | 'EDE Only' | 'Matched';

export interface SourceTypeUniverse {
  boOnly: readonly any[];
  edeOnly: readonly any[];
}

export function classifySourceTypeForRow(row: any, universe: SourceTypeUniverse): SourceTypeForRow {
  if (universe.boOnly.includes(row)) return 'BO Only';
  if (universe.edeOnly.includes(row)) return 'EDE Only';
  return 'Matched';
}
