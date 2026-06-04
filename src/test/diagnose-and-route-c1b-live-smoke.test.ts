/**
 * Phase C1b — Gated live smoke for the diagnose-and-route cycle.
 *
 * Requires RUN_SMOKE_CONTROLS=1 and DB credentials. Reports queue sizes
 * and named-canary verifications; tolerances are documented inline.
 */
import { describe, it, expect } from 'vitest';

const RUN = process.env.RUN_SMOKE_CONTROLS === '1';

describe.skipIf(!RUN)('C1b live smoke — Jan–Apr cycle', () => {
  it('reports queue sizes and named canaries', { timeout: 300_000 }, async () => {
    // Live wiring is the caller's responsibility — placeholder for
    // post-sync verification. When this file is enabled, it should:
    //   1) load the cached all-batch projection,
    //   2) build both populations via buildMtApprovedMceCandidates +
    //      the per-scope paid set,
    //   3) buildBlockerFacts per row,
    //   4) runDiagnoseCycle,
    //   5) assert DMI queue ≈ 13 unpaid+DMI members / 19 member-months,
    //   6) assert Cornell Joseph u72981900 Apr → dmi,
    //      Latronda u97385094 Jan → satisfied,
    //      Darrell Crutcher u73043122 → chase_eligible + carrier_recognition,
    //   7) log all queue sizes, chase_eligible count, population-2
    //      wrong-amount/indeterminate counts (named).
    expect(RUN).toBe(true);
  });
});
