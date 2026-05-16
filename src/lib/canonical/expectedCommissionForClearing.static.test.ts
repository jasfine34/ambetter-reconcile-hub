/**
 * Bundle 13d — static import boundary guards for the wrapper + override seed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WRAPPER = readFileSync(resolve(__dirname, './expectedCommissionForClearing.ts'), 'utf8');
const SEED = readFileSync(resolve(__dirname, './agencyTierOverrideRates.ts'), 'utf8');
const SWEEP = readFileSync(resolve(__dirname, '../sweep/crossBatchClearingSweep.ts'), 'utf8');
const COMP_GRID = readFileSync(resolve(__dirname, './compGrid.ts'), 'utf8');

function importLines(src: string): string[] {
  return src.split('\n').filter(l => /^\s*import\s/.test(l));
}

const FORBIDDEN_IMPORTS = [
  '@/integrations/supabase',
  '@supabase',
  'reconcile',
  './metrics',
  'expectedEde',
  'pages/',
  'components/',
  'react',
];

describe('expectedCommissionForClearing.ts — boundary', () => {
  for (const f of FORBIDDEN_IMPORTS) {
    it(`does not import "${f}"`, () => {
      expect(importLines(WRAPPER).some(l => l.includes(f))).toBe(false);
    });
  }
});

describe('agencyTierOverrideRates.ts — boundary', () => {
  for (const f of [...FORBIDDEN_IMPORTS, 'crossBatchClearingSweep']) {
    it(`does not import "${f}"`, () => {
      expect(importLines(SEED).some(l => l.includes(f))).toBe(false);
    });
  }
});

describe('crossBatchClearingSweep.ts — wrapper-only consumer', () => {
  it('imports getExpectedCommissionForClearing', () => {
    expect(SWEEP.includes('getExpectedCommissionForClearing')).toBe(true);
  });
  it('does NOT import getExpectedCommission directly', () => {
    // Must not match "getExpectedCommission" without "ForClearing" suffix.
    const bareRefs = SWEEP.match(/getExpectedCommission(?!ForClearing)/g) ?? [];
    expect(bareRefs).toEqual([]);
  });
});

describe('compGrid.ts — purity vs override concepts', () => {
  for (const tok of ['agencyTier', 'override', 'Coverall', 'Vix', 'current_policy_aor']) {
    it(`does not mention "${tok}"`, () => {
      expect(COMP_GRID.includes(tok)).toBe(false);
    });
  }
});
