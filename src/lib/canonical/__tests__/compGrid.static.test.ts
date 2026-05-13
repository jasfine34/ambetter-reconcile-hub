/**
 * Bundle 13a — compGrid.ts safety guard.
 * compGrid.ts must remain pure: no DB access, no metric/reconcile coupling,
 * and no references to legacy estimate-fallback constants.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(resolve(__dirname, '../compGrid.ts'), 'utf8');
// eslint-disable-next-line no-console
console.log('[compGrid.static] SRC length', SRC.length, 'has DEFAULT?', SRC.includes('DEFAULT_COMMISSION_ESTIMATE'));

describe('compGrid.ts — forbidden imports', () => {
  for (const forbidden of [
    '@supabase',
    "from '@/integrations/supabase",
    'reconcile',
    './metrics',
    'expectedEde',
  ]) {
    it(`does not import "${forbidden}"`, () => {
      // Look only at import lines.
      const importLines = SRC.split('\n').filter(l => /^\s*import\s/.test(l));
      expect(importLines.some(l => l.includes(forbidden))).toBe(false);
    });
  }
});

describe('compGrid.ts — forbidden strings', () => {
  for (const forbidden of [
    'DEFAULT_COMMISSION_ESTIMATE',
    'estimated_missing_commission',
    'batch_average',
  ]) {
    it(`does not reference "${forbidden}"`, () => {
      expect(SRC.includes(forbidden)).toBe(false);
    });
  }
});
