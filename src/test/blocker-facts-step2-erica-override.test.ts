/**
 * Step 2 — Erica-AOR override resolver corrective.
 *
 * Locks:
 *   1. Rate basis is per_member_per_month for both Erica seed rows —
 *      the override population clears without spurious wrong-amounts on
 *      multi-member policies (target + cross-entity paths).
 *   2. The EXISTING override-aware target path
 *      (buildBlockerFacts -> resolve -> getExpectedCommissionForClearing)
 *      is preserved — no duplicate parallel path.
 *   3. Two typed exception reasons are surfaced (not free-text) and route
 *      to manual_review distinctly from generic wrong_amount:
 *        - ERICA_OVERRIDE_SCOPE_PAID_FULL_PMPM
 *        - NONERICA_AOR_OVERRIDE_AMOUNT
 *      Non-Erica AORs paying full PMPM stay 'correct'.
 */
import { describe, it, expect } from 'vitest';
import { buildBlockerFacts, type BlockerFactsInputs } from '@/lib/canonical/blockerFacts';
import {
  createEstMissingResolver,
  type EstMissingInputEvidence,
} from '@/lib/canonical/estMissingResolver';
import type { CarrierCompRateRow } from '@/lib/canonical/compGrid';
import type { CellClassification, ClassificationState } from '@/lib/classifier';
import { routeMemberMonth } from '@/lib/canonical/diagnoseAndRoute';
import { AGENCY_TIER_OVERRIDE_RATES } from '@/lib/canonical/agencyTierOverrideRates';

const TODAY = '2026-06-04';
const ERICA_AOR = 'Erica Fine (NPN 21277051)';
const JASON_AOR = 'Jason Fine (NPN 21055210)';

// Full-PMPM rate: $17 per member-month, applies to non-override path.
const FULL_PMPM = 17;

const RATE_ROWS: CarrierCompRateRow[] = [
  {
    id: 'rr-full-pmpm',
    carrier_key: 'ambetter',
    state_code: 'FL',
    plan_variant: null,
    effective_year: 2026,
    comp_basis: 'pmpm',
    per_member_per_month_amount: FULL_PMPM,
    per_policy_per_month_amount: null,
    fixed_per_payment_amount: null,
    support_status: 'supported',
    unsupported_reason: null,
  } as any,
];

function cell(state: ClassificationState, paid_amount = 0): CellClassification {
  return {
    month: '2026-03',
    state,
    reason: 'test',
    paid_amount,
    in_ede: true,
    in_back_office: true,
    in_commission: paid_amount > 0,
  } as CellClassification;
}

function evidence(over: Partial<EstMissingInputEvidence>): EstMissingInputEvidence {
  return {
    carrier: 'ambetter',
    state: 'FL',
    member_count: 1,
    months: 1,
    policy_year: 2026,
    plan_variant: null,
    current_policy_aor: ERICA_AOR,
    matched_payee: null,
    ...over,
  };
}

function boundResolver() {
  const { resolve } = createEstMissingResolver({
    rateRows: RATE_ROWS,
    batchMonth: '2026-03',
    scope: 'Coverall',
  });
  return (args: { member_key: string; inputEvidence?: EstMissingInputEvidence }) =>
    resolve({ row: { member_key: args.member_key }, inputEvidence: args.inputEvidence });
}

function baseInputs(over: Partial<BlockerFactsInputs>): BlockerFactsInputs {
  return {
    targetScope: 'Coverall',
    targetCell: cell('unpaid'),
    pickedEdeForMonth: null,
    today: TODAY,
    otherEntityCell: null,
    memberKey: 'mk-test',
    resolve: boundResolver(),
    computeFullPmpmExpected: () => FULL_PMPM * ((over.evidenceForResolver?.member_count) ?? 1),
    ...over,
  };
}

// ─────────── Seed basis lock ───────────

describe('Step 2 — agencyTierOverrideRates seed', () => {
  it('both Erica rows use per_member_per_month basis', () => {
    const erica = AGENCY_TIER_OVERRIDE_RATES.filter((r) => r.aor_npn === '21277051');
    expect(erica).toHaveLength(2);
    for (const row of erica) {
      expect(row.rate_basis).toBe('per_member_per_month');
    }
    expect(erica.find((r) => r.pay_entity === 'Coverall')!.rate_amount).toBe(0.5);
    expect(erica.find((r) => r.pay_entity === 'Vix')!.rate_amount).toBe(4.5);
  });
});

// ─────────── Target-paid: override population clears ───────────

describe('Step 2 — target-paid override rows clear at per-member scale', () => {
  it('Erica AOR + Coverall + 2 members + $1.00 → correct (2 × $0.50)', () => {
    const ev = evidence({ member_count: 2, matched_payee: 'Coverall' });
    const facts = buildBlockerFacts(baseInputs({
      targetScope: 'Coverall',
      targetCell: cell('paid', 1.0),
      evidenceForResolver: ev,
    }));
    expect(facts.amount).toEqual({ kind: 'correct' });
  });

  it('Erica AOR + Vix + 3 members + $13.50 → correct (3 × $4.50)', () => {
    const ev = evidence({ member_count: 3, matched_payee: 'Vix' });
    const facts = buildBlockerFacts(baseInputs({
      targetScope: 'Vix',
      targetCell: cell('paid', 13.5),
      evidenceForResolver: ev,
    }));
    expect(facts.amount).toEqual({ kind: 'correct' });
  });
});

// ─────────── Cross-entity satisfaction retains override-aware basis ───────────

describe('Step 2 — cross-entity satisfied path is override-aware', () => {
  it('Coverall unpaid satisfied by Vix payment, 2 members × $4.50 = $9.00 → correct', () => {
    const ev = evidence({ member_count: 2 });
    const facts = buildBlockerFacts(baseInputs({
      targetScope: 'Coverall',
      targetCell: cell('unpaid'),
      otherEntityCell: { payEntity: 'Vix', state: 'paid', paid_amount: 9.0 },
      evidenceForResolver: ev,
    }));
    expect(facts.crossEntitySatisfied.satisfied).toBe(true);
    expect(facts.crossEntitySatisfied.amountStatus).toEqual({ kind: 'correct' });
    expect(facts.amount).toEqual({ kind: 'correct' });
  });
});

// ─────────── Typed exception: Erica full-PMPM ───────────

describe('Step 2 — ERICA_OVERRIDE_SCOPE_PAID_FULL_PMPM', () => {
  it('Erica AOR + Coverall paid at full PMPM ($34 for 2 members) → typed_review, NOT wrong_amount', () => {
    const ev = evidence({ member_count: 2, matched_payee: 'Coverall' });
    const facts = buildBlockerFacts(baseInputs({
      targetScope: 'Coverall',
      targetCell: cell('paid', FULL_PMPM * 2), // $34
      evidenceForResolver: ev,
    }));
    expect(facts.amount.kind).toBe('typed_review');
    if (facts.amount.kind === 'typed_review') {
      expect(facts.amount.reason).toBe('ERICA_OVERRIDE_SCOPE_PAID_FULL_PMPM');
      expect(facts.amount.actual).toBe(34);
      expect(facts.amount.expected).toBe(1); // 2 × $0.50
      expect(facts.amount.alt_expected).toBe(34);
    }

    // Routing
    const route = routeMemberMonth({
      row: {
        rowKey: 'r1',
        carrier: 'ambetter',
        stableMemberKey: 'mk-test',
        identity: { carrier: 'ambetter', member_key: 'mk-test' } as any,
        serviceMonth: '2026-03',
        targetScope: 'Coverall',
        facts,
        crFlag: false,
        population: 2,
      },
      activeDecisions: { all: [], byMemberMonth: new Map() } as any,
    });
    expect(route.route).toBe('manual_review');
    expect(route.rationale).toBe('erica_override_scope_paid_full_pmpm');
  });
});

// ─────────── Typed exception: non-Erica override amount ───────────

describe('Step 2 — NONERICA_AOR_OVERRIDE_AMOUNT', () => {
  // These use `preResolvedTarget` so the test file need not carry a full
  // carrier-rate-grid row shape; the typed-review detector operates on the
  // resolution + evidence + fullPMPM callback, which is what we're locking.
  const resolved = (amount: number, matched_payee: 'Coverall' | 'Vix' | null = null): any => ({
    amount,
    status: 'RESOLVED',
    evidence: {
      carrier: 'ambetter', state: 'FL', member_count: 1, months: 1,
      policy_year: 2026, plan_variant: null, rate_row_id: 'rr-full',
      current_policy_aor: JASON_AOR, matched_payee,
    },
  });

  it('Jason AOR + Coverall paid $0.50 (per-member override amount) → typed_review', () => {
    const ev = evidence({ member_count: 1, current_policy_aor: JASON_AOR, matched_payee: 'Coverall' });
    const facts = buildBlockerFacts(baseInputs({
      targetScope: 'Coverall',
      targetCell: cell('paid', 0.5),
      evidenceForResolver: ev,
      preResolvedTarget: resolved(FULL_PMPM, 'Coverall'),
    }));
    expect(facts.amount.kind).toBe('typed_review');
    if (facts.amount.kind === 'typed_review') {
      expect(facts.amount.reason).toBe('NONERICA_AOR_OVERRIDE_AMOUNT');
      expect(facts.amount.alt_expected).toBe(0.5);
    }

    const route = routeMemberMonth({
      row: {
        rowKey: 'r2',
        carrier: 'ambetter',
        stableMemberKey: 'mk-test',
        identity: { carrier: 'ambetter', member_key: 'mk-test' } as any,
        serviceMonth: '2026-03',
        targetScope: 'Coverall',
        facts,
        crFlag: false,
        population: 2,
      },
      activeDecisions: { all: [], byMemberMonth: new Map() } as any,
    });
    expect(route.route).toBe('manual_review');
    expect(route.rationale).toBe('nonerica_aor_override_amount');
  });

  it('Jason AOR + Coverall paid full PMPM ($17 for 1 member) → correct (unchanged legacy behavior)', () => {
    const ev = evidence({ member_count: 1, current_policy_aor: JASON_AOR, matched_payee: 'Coverall' });
    const facts = buildBlockerFacts(baseInputs({
      targetScope: 'Coverall',
      targetCell: cell('paid', FULL_PMPM),
      evidenceForResolver: ev,
      preResolvedTarget: resolved(FULL_PMPM, 'Coverall'),
    }));
    expect(facts.amount).toEqual({ kind: 'correct' });
  });
});

// ─────────── Preserve existing target resolver path ───────────

describe('Step 2 — no duplicate resolver path / no target bypass', () => {
  it('target amount is computed via the SAME resolve callback (single invocation per row)', () => {
    let calls = 0;
    const inner = boundResolver();
    const resolve = (args: { member_key: string; inputEvidence?: EstMissingInputEvidence }) => {
      calls += 1;
      return inner(args);
    };
    const ev = evidence({ member_count: 2, matched_payee: 'Coverall' });
    buildBlockerFacts({
      targetScope: 'Coverall',
      targetCell: cell('paid', 1.0),
      pickedEdeForMonth: null,
      today: TODAY,
      otherEntityCell: null,
      memberKey: 'mk-test',
      resolve,
      evidenceForResolver: ev,
      computeFullPmpmExpected: () => FULL_PMPM * 2,
    });
    // Exactly one resolver call — target only. No parallel/duplicate path.
    expect(calls).toBe(1);
  });
});
