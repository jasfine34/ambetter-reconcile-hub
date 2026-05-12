/**
 * Bundle 7 — Cross-surface AOR-transfer parity.
 *
 * Construct synthetic rows where the writing-agent NPN differs from the
 * EDE current_policy_aor (the AOR-transfer case). Assert that ALL four
 * consuming surfaces classify ownership by current_policy_aor consistently:
 *
 *   1. Reconcile-time issue classification
 *      — uses classifyPolicyOwnerFromCurrentAor (verified via grep on
 *        reconcile.ts; behavioral lock via the classifier).
 *   2. Total Policies Paid attribution chips
 *      — getTotalPoliciesPaidAttribution.
 *   3. Agent Summary unpaid grouping
 *      — classifyPolicyOwnerFromCurrentAor on canonical unpaid rows
 *        (grep + behavioral parity).
 *   4. Exception drilldown "Current Policy AOR" column
 *      — Dashboard / Exceptions tables expose `current_policy_aor`.
 *
 * Wiring guard: no page or component contains inline ownership
 * classification — they consume the canonical helper or canonical metrics
 * output.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  classifyPolicyOwnerFromCurrentAor,
} from '@/lib/canonical/policyOwner';
import {
  classifyPaidAttribution,
  getTotalPoliciesPaidAttribution,
} from '@/lib/canonical/metrics';

// AOR-transfer fixtures: writing-agent NPN ≠ current AOR NPN.
const aorTransferRows = [
  // Written by Erica, current AOR is Jason → JF.
  { current_policy_aor: 'Jason Fine (21055210)', agent_npn: '21277051' },
  // Written by Jason, current AOR is Erica → EF.
  { current_policy_aor: 'Erica Fine (21277051)', agent_npn: '21055210' },
  // Written by Becky, current AOR transferred to a downline → Other.
  { current_policy_aor: 'Allen Ford (21077804)', agent_npn: '16531877' },
  // Blank current AOR → Other (regardless of writing NPN).
  { current_policy_aor: '', agent_npn: '21055210' },
];

describe('Bundle 7 cross-surface parity — classifier shared by all surfaces', () => {
  it('classifyPaidAttribution (Total Policies Paid) === classifyPolicyOwnerFromCurrentAor', () => {
    for (const r of aorTransferRows) {
      expect(classifyPaidAttribution(r)).toBe(
        classifyPolicyOwnerFromCurrentAor(r.current_policy_aor),
      );
    }
  });

  it('getTotalPoliciesPaidAttribution chip totals follow current AOR (writing NPN ignored)', () => {
    const out = getTotalPoliciesPaidAttribution(aorTransferRows);
    expect(out).toEqual({ JF: 1, EF: 1, BS: 0, Other: 2 });
    const sum = out.JF + out.EF + out.BS + out.Other;
    expect(sum).toBe(aorTransferRows.length);
  });

  it('Agent Summary unpaid grouping uses the same classifier on the same rows', () => {
    // Mirrors AgentSummaryPage's unpaidByOwnerBucket reduction.
    const grouped = new Map<string, number>();
    for (const r of aorTransferRows) {
      const b = classifyPolicyOwnerFromCurrentAor(r.current_policy_aor);
      grouped.set(b, (grouped.get(b) ?? 0) + 1);
    }
    const chips = getTotalPoliciesPaidAttribution(aorTransferRows);
    expect(grouped.get('JF') ?? 0).toBe(chips.JF);
    expect(grouped.get('EF') ?? 0).toBe(chips.EF);
    expect(grouped.get('BS') ?? 0).toBe(chips.BS);
    expect(grouped.get('Other') ?? 0).toBe(chips.Other);
  });
});

describe('Bundle 7 cross-surface parity — wiring guards (no inline ownership logic)', () => {
  const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');
  const reconcile = read('lib/reconcile.ts');
  const dashboard = read('pages/DashboardPage.tsx');
  const exceptions = read('pages/ExceptionsPage.tsx');
  const agentSummary = read('pages/AgentSummaryPage.tsx');
  const metrics = read('lib/canonical/metrics.ts');

  it('reconcile.ts derives ownership via classifyPolicyOwnerFromCurrentAor', () => {
    expect(reconcile).toMatch(/classifyPolicyOwnerFromCurrentAor/);
  });

  it('AgentSummaryPage.tsx derives owner bucket via classifyPolicyOwnerFromCurrentAor', () => {
    expect(agentSummary).toMatch(/classifyPolicyOwnerFromCurrentAor/);
  });

  it('Total Policies Paid attribution is derived in canonical metrics, not pages', () => {
    expect(metrics).toMatch(/classifyPolicyOwnerFromCurrentAor/);
    // Pages must NOT re-classify paid attribution inline.
    expect(dashboard).not.toMatch(/function\s+classifyPaidAttribution\b/);
    expect(dashboard).not.toMatch(/function\s+classifyPolicyOwner/);
    expect(exceptions).not.toMatch(/function\s+classifyPolicyOwner/);
    expect(agentSummary).not.toMatch(/function\s+classifyPolicyOwner/);
  });

  it('No surface re-derives ownership from writing-agent NPN', () => {
    // Common stale shapes Bundle 7 replaces. AgentSummary still references
    // agent_npn for the writing-evidence "Written by" column, but must NOT
    // bucket unpaid by writing NPN.
    expect(agentSummary).not.toMatch(/unpaidByNpn\s*=\s*useMemo/);
    expect(agentSummary).not.toMatch(/!displayedNpns\.has/);
  });

  it('Exception / drilldown tables expose current_policy_aor as Current Policy AOR', () => {
    expect(dashboard).toMatch(/key:\s*['"]current_policy_aor['"][^}]*Current Policy AOR/);
    expect(exceptions).toMatch(/key:\s*['"]current_policy_aor['"][^}]*Current Policy AOR/);
  });
});
