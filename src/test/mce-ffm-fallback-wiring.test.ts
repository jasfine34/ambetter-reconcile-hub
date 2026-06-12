/**
 * Static wiring guard for FFM-ID Class-A fallback on MissingCommissionExportPage.
 *
 * The full page-render harness in missing-commission-export-page.test.tsx
 * mocks `buildMemberProfile` wholesale, so it cannot observe the fallback
 * wiring. This static check guarantees the MCE source actually builds and
 * threads the fallback index — paired with the pure unit tests in
 * `ffm-id-class-a-fallback.test.ts` which prove the contract.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('MCE FFM-ID Class-A fallback wiring (static)', () => {
  const src = readFileSync(
    resolve(process.cwd(), 'src/pages/MissingCommissionExportPage.tsx'),
    'utf-8',
  );

  it('imports buildEdeFfmFallbackIndex from aorPicker', () => {
    expect(src).toMatch(/buildEdeFfmFallbackIndex.*from\s+['"]@\/lib\/aorPicker['"]/s);
  });

  it('builds the index from selectedBatchRecords', () => {
    expect(src).toMatch(/buildEdeFfmFallbackIndex\(selectedBatchRecords\)/);
  });

  it('passes fallbackFfmCandidates into buildMemberProfile', () => {
    expect(src).toMatch(/fallbackFfmCandidates/);
    expect(src).toMatch(/ffmFallbackIndex\.lookup\(/);
  });

});
