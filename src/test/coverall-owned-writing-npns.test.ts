/**
 * Ownership-map tests for COVERALL_OWNED_WRITING_NPNS.
 *
 * Verifies that the three newly-added writing-agent NPNs (Allen Ford,
 * Hantz Pierre, Scott O'Toole) resolve as Coverall-owned via the new
 * `isCoverallOwnedWritingNPN` helper, while NOT contaminating the existing
 * AOR predicates (`isCoverallAORByNPN`, `isCoverallAORByName`) or the
 * canonical scope semantics — they are an ownership-metadata layer, not an
 * AOR.
 */
import { describe, it, expect } from 'vitest';
import {
  isCoverallOwnedWritingNPN,
  isCoverallAORByNPN,
  isCoverallAORByName,
} from '@/lib/agents';
import { COVERALL_OWNED_WRITING_NPNS, NPN_MAP } from '@/lib/constants';
import { aorBelongsToScope } from '@/lib/canonical/scope';

const NEW_NPNS = ['21077804', '21574255', '15978551'] as const;

describe('COVERALL_OWNED_WRITING_NPNS', () => {
  it.each(NEW_NPNS)('NPN %s is registered with name + reason', (npn) => {
    expect(COVERALL_OWNED_WRITING_NPNS[npn]).toBeDefined();
    expect(COVERALL_OWNED_WRITING_NPNS[npn].name.length).toBeGreaterThan(0);
    expect(COVERALL_OWNED_WRITING_NPNS[npn].reason.length).toBeGreaterThan(0);
  });

  it.each(NEW_NPNS)('NPN %s resolves as Coverall-owned writing agent', (npn) => {
    expect(isCoverallOwnedWritingNPN(npn)).toBe(true);
  });

  it('handles whitespace and null/undefined safely', () => {
    expect(isCoverallOwnedWritingNPN('  21077804  ')).toBe(true);
    expect(isCoverallOwnedWritingNPN(null)).toBe(false);
    expect(isCoverallOwnedWritingNPN(undefined)).toBe(false);
    expect(isCoverallOwnedWritingNPN('')).toBe(false);
  });

  it('still recognizes active AORs (Jason/Erica/Becky) as Coverall-owned', () => {
    for (const npn of Object.keys(NPN_MAP)) {
      expect(isCoverallOwnedWritingNPN(npn)).toBe(true);
    }
  });

  it('does NOT mark an unrelated NPN as Coverall-owned', () => {
    expect(isCoverallOwnedWritingNPN('19444143')).toBe(false); // Michael Farinas
  });

  it.each(NEW_NPNS)(
    'NPN %s does NOT pollute AOR predicates (still not an AOR)',
    (npn) => {
      expect(isCoverallAORByNPN(npn)).toBe(false);
      expect(isCoverallAORByName(`Some Person (${npn})`)).toBe(false);
      expect(aorBelongsToScope(`Some Person (${npn})`, 'Coverall')).toBe(false);
      expect(aorBelongsToScope(`Some Person (${npn})`, 'All')).toBe(false);
    },
  );
});
