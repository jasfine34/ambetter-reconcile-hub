/**
 * Bundle 1.5 — shared Source Type classifier contract.
 *
 * Locks the exact string literals and precedence shared by DashboardPage
 * (unpaid drilldown annotation) and MissingCommissionExportPage (export
 * `_sourceType` column).
 */
import { describe, it, expect } from 'vitest';
import { classifySourceTypeForRow } from '@/lib/canonical/sourceTypeForRow';

describe('classifySourceTypeForRow', () => {
  it('returns "BO Only" when the row is in universe.boOnly', () => {
    const row = { id: 'b' };
    expect(classifySourceTypeForRow(row, { boOnly: [row], edeOnly: [] })).toBe('BO Only');
  });

  it('returns "EDE Only" when the row is in universe.edeOnly', () => {
    const row = { id: 'e' };
    expect(classifySourceTypeForRow(row, { boOnly: [], edeOnly: [row] })).toBe('EDE Only');
  });

  it('returns "Matched" when the row is in neither set', () => {
    const row = { id: 'm' };
    expect(classifySourceTypeForRow(row, { boOnly: [], edeOnly: [] })).toBe('Matched');
  });

  it('locks precedence: boOnly wins when a row appears in both (disjoint by construction)', () => {
    const row = { id: 'x' };
    expect(classifySourceTypeForRow(row, { boOnly: [row], edeOnly: [row] })).toBe('BO Only');
  });

  it('empty universe → every row classifies as "Matched"', () => {
    expect(classifySourceTypeForRow({ id: 'a' }, { boOnly: [], edeOnly: [] })).toBe('Matched');
    expect(classifySourceTypeForRow({ id: 'b' }, { boOnly: [], edeOnly: [] })).toBe('Matched');
  });
});
