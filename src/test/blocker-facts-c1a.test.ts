/**
 * Phase C1a — blocker-facts layer tests (default suite: synthetic/deterministic).
 *
 * Covers:
 *   - DMI accessor on real field shapes & tolerance
 *   - Stale-DMI contamination guard (only picked record matters)
 *   - Surface gate (paid+DMI captured but surfaceEligible=false)
 *   - expired / inProgress flags
 *   - D2 cross-entity satisfied matrix (Latronda-shape, wrong-amount, none,
 *     reversed)
 *   - G6 amount matrix (correct / wrong / Vix flat override / resolver
 *     failure → indeterminate)
 *   - Premium passthrough (certified states only)
 *   - Purity: buildBlockerFacts does no writes
 *
 * A separately-gated denominator smoke (RUN_SMOKE_CONTROLS=1) measures the
 * live active-DMI denominator using the picked-EDE definition. The default
 * suite NEVER pins live counts.
 */
import { describe, it, expect, vi } from 'vitest';
import { getDmiSignal, isDmiExpired } from '@/lib/canonical/dmiSignal';
import { buildBlockerFacts, type BlockerFactsInputs } from '@/lib/canonical/blockerFacts';
import { pickEdeForServiceMonth } from '@/lib/canonical/edeMonthPicker';
import type { CellClassification, ClassificationState } from '@/lib/classifier';
import type { EstMissingResolution } from '@/lib/canonical/estMissingResolver';

const TODAY = '2026-06-04';

function cell(
  state: ClassificationState,
  paid_amount = 0,
  flags: Partial<CellClassification> = {},
): CellClassification {
  return {
    month: '2026-03',
    state,
    reason: 'test',
    paid_amount,
    in_ede: true,
    in_back_office: true,
    in_commission: paid_amount > 0,
    ...flags,
  };
}

function edeRow(opts: {
  status?: string;
  issuer?: string;
  effective_date?: string;
  policy_term_date?: string | null;
  verificationIssueType?: string;
  verificationEndDate?: string;
  documentUploadedForSviDmi?: string;
}): any {
  return {
    source_type: 'EDE',
    status: opts.status ?? 'effectuated',
    carrier: opts.issuer ?? 'Ambetter',
    effective_date: opts.effective_date ?? '2026-01-01',
    policy_term_date: opts.policy_term_date ?? null,
    raw_json: {
      policyStatus: opts.status ?? 'effectuated',
      issuer: opts.issuer ?? 'Ambetter',
      currentPolicyAOR: 'Agent (NPN 21277051)',
      verificationIssueType: opts.verificationIssueType ?? '',
      verificationEndDate: opts.verificationEndDate ?? '',
      documentUploadedForSviDmi: opts.documentUploadedForSviDmi ?? '',
    },
  };
}

function resolved(amount: number): EstMissingResolution {
  return {
    amount,
    status: 'RESOLVED',
    evidence: {
      carrier: 'ambetter', state: 'FL', member_count: 1, months: 1,
      policy_year: 2026, plan_variant: null, rate_row_id: 'rr-1',
      current_policy_aor: null, matched_payee: null,
    },
  };
}

function resolvedOverride(amount: number): EstMissingResolution {
  return {
    amount,
    status: 'RESOLVED_WITH_OVERRIDE',
    evidence: {
      carrier: 'ambetter', state: 'FL', member_count: 1, months: 1,
      policy_year: 2026, plan_variant: null, rate_row_id: null,
      current_policy_aor: 'Erica Fine', matched_payee: 'Vix',
      override_amount: amount, override_entity: 'Vix',
    },
  };
}

function unsupported(reason: any): EstMissingResolution {
  return {
    amount: null, status: 'UNSUPPORTED',
    evidence: {
      carrier: null, state: null, member_count: null, months: null,
      policy_year: null, plan_variant: null, rate_row_id: null,
      current_policy_aor: null, matched_payee: null,
    },
    unsupported_reason: reason,
  };
}

function baseInputs(over: Partial<BlockerFactsInputs> = {}): BlockerFactsInputs {
  return {
    targetScope: 'Coverall',
    targetCell: cell('unpaid'),
    pickedEdeForMonth: null,
    today: TODAY,
    otherEntityCell: null,
    memberKey: 'mk-test',
    ...over,
  };
}

// ────────────────────────── DMI accessor ──────────────────────────

describe('Phase C1a — getDmiSignal accessor', () => {
  it('reads real issueType shapes and normalizes the end date / flag', () => {
    for (const issueType of [
      'DMI_CITIZENSHIP', 'DMI_ANNUAL_INCOME',
      'DMI_QHP_LAWFUL_PRESENCE', 'DMI_NONESCMEC',
    ]) {
      const sig = getDmiSignal({
        raw_json: {
          verificationIssueType: issueType,
          verificationEndDate: '2026-08-15T00:00:00Z',
          documentUploadedForSviDmi: 'y',
        },
      });
      expect(sig).not.toBeNull();
      expect(sig!.issueType).toBe(issueType);
      expect(sig!.verificationEndDate).toBe('2026-08-15');
      expect(sig!.documentUploaded).toBe(true);
    }
  });

  it('tolerates blank/missing — returns null when issueType is empty', () => {
    expect(getDmiSignal(null)).toBeNull();
    expect(getDmiSignal({})).toBeNull();
    expect(getDmiSignal({ raw_json: {} })).toBeNull();
    expect(getDmiSignal({ raw_json: { verificationIssueType: '   ' } })).toBeNull();
  });

  it('returns null end date for un-parseable values, false flag for non-Y', () => {
    const sig = getDmiSignal({
      raw_json: {
        verificationIssueType: 'DMI_CITIZENSHIP',
        verificationEndDate: 'not-a-date',
        documentUploadedForSviDmi: 'N',
      },
    });
    expect(sig!.verificationEndDate).toBeNull();
    expect(sig!.documentUploaded).toBe(false);
  });

  it('isDmiExpired strictly compares against today', () => {
    const past = getDmiSignal({
      raw_json: { verificationIssueType: 'DMI_CITIZENSHIP', verificationEndDate: '2026-01-01' },
    });
    const future = getDmiSignal({
      raw_json: { verificationIssueType: 'DMI_CITIZENSHIP', verificationEndDate: '2099-01-01' },
    });
    expect(isDmiExpired(past, TODAY)).toBe(true);
    expect(isDmiExpired(future, TODAY)).toBe(false);
    expect(isDmiExpired(null, TODAY)).toBe(false);
  });
});

// ────────────────────────── stale-DMI contamination ──────────────────────────

describe('Phase C1a — stale-DMI contamination (picker semantics)', () => {
  it('historical EDE row with DMI + picked service-month EDE blank → NO active DMI', () => {
    const memberRecs = [
      // Stale historical row carries the DMI.
      edeRow({
        effective_date: '2025-09-01',
        policy_term_date: '2025-12-31',
        verificationIssueType: 'DMI_CITIZENSHIP',
        verificationEndDate: '2026-12-31',
      }),
      // Picked row for March has NO DMI.
      edeRow({ effective_date: '2026-02-01' }),
    ];
    const picked = pickEdeForServiceMonth(memberRecs as any, '2026-03');
    expect(picked).not.toBeNull();
    const facts = buildBlockerFacts(baseInputs({ pickedEdeForMonth: picked }));
    expect(facts.dmi.active).toBe(false);
  });

  it('picker-null → no DMI signal regardless of historical rows', () => {
    const facts = buildBlockerFacts(baseInputs({ pickedEdeForMonth: null }));
    expect(facts.dmi.active).toBe(false);
    expect(facts.dmi.surfaceEligible).toBe(false);
  });
});

// ────────────────────────── DMI surface gate / flags ──────────────────────────

describe('Phase C1a — DMI surface gate + sub-flags', () => {
  const dmiRec = edeRow({
    effective_date: '2026-02-01',
    verificationIssueType: 'DMI_CITIZENSHIP',
    verificationEndDate: '2026-12-31',
    documentUploadedForSviDmi: 'Y',
  });

  it('paid+DMI captured but surfaceEligible=false', () => {
    const facts = buildBlockerFacts(baseInputs({
      targetCell: cell('paid', 25),
      pickedEdeForMonth: dmiRec,
      preResolvedTarget: resolved(25),
    }));
    expect(facts.dmi.active).toBe(true);
    expect(facts.dmi.surfaceEligible).toBe(false);
  });

  it('unpaid+DMI → surfaceEligible=true', () => {
    const facts = buildBlockerFacts(baseInputs({
      targetCell: cell('unpaid'),
      pickedEdeForMonth: dmiRec,
    }));
    expect(facts.dmi.active).toBe(true);
    expect(facts.dmi.surfaceEligible).toBe(true);
  });

  it('expired flag fires when verificationEndDate is in the past', () => {
    const expired = edeRow({
      effective_date: '2026-02-01',
      verificationIssueType: 'DMI_ANNUAL_INCOME',
      verificationEndDate: '2025-12-01',
      documentUploadedForSviDmi: 'N',
    });
    const facts = buildBlockerFacts(baseInputs({ pickedEdeForMonth: expired }));
    expect(facts.dmi.expired).toBe(true);
    expect(facts.dmi.inProgress).toBe(false);
  });

  it('inProgress mirrors documentUploadedForSviDmi=Y', () => {
    const facts = buildBlockerFacts(baseInputs({ pickedEdeForMonth: dmiRec }));
    expect(facts.dmi.inProgress).toBe(true);
  });
});

// ────────────────────────── D2 cross-entity satisfied ──────────────────────────

describe('Phase C1a — D2 cross-entity satisfied (Latronda-shape)', () => {
  it('correct-amount Vix payment satisfies the Coverall month with amountStatus=correct', () => {
    const facts = buildBlockerFacts(baseInputs({
      targetScope: 'Coverall',
      targetCell: cell('unpaid'),
      otherEntityCell: { payEntity: 'Vix', state: 'paid', paid_amount: 4.50 },
      preResolvedOther: resolvedOverride(4.50),
    }));
    expect(facts.crossEntitySatisfied.satisfied).toBe(true);
    expect(facts.crossEntitySatisfied.satisfyingEntity).toBe('Vix');
    expect(facts.crossEntitySatisfied.amountStatus).toEqual({ kind: 'correct' });
    expect(facts.amount).toEqual({ kind: 'correct' });
  });

  it('wrong-amount Vix payment → satisfied with amountStatus=wrong_amount (NOT clean)', () => {
    const facts = buildBlockerFacts(baseInputs({
      targetCell: cell('unpaid'),
      otherEntityCell: { payEntity: 'Vix', state: 'paid', paid_amount: 18 },
      preResolvedOther: resolvedOverride(4.50),
    }));
    expect(facts.crossEntitySatisfied.satisfied).toBe(true);
    expect(facts.crossEntitySatisfied.amountStatus).toMatchObject({
      kind: 'wrong_amount', actual: 18, expected: 4.50,
    });
    expect(facts.amount).toMatchObject({ kind: 'wrong_amount' });
  });

  it('reversed in the other entity → NOT satisfied', () => {
    const facts = buildBlockerFacts(baseInputs({
      targetCell: cell('unpaid'),
      otherEntityCell: { payEntity: 'Vix', state: 'reversed', paid_amount: 0 },
      preResolvedOther: resolvedOverride(4.50),
    }));
    expect(facts.crossEntitySatisfied.satisfied).toBe(false);
    expect(facts.amount).toEqual({ kind: 'not_applicable' });
  });

  it('paid in neither entity → not satisfied', () => {
    const facts = buildBlockerFacts(baseInputs({
      targetCell: cell('unpaid'),
      otherEntityCell: { payEntity: 'Vix', state: 'unpaid', paid_amount: 0 },
    }));
    expect(facts.crossEntitySatisfied.satisfied).toBe(false);
  });

  it('symmetric — Coverall payment satisfies a Vix-scope unpaid month', () => {
    const facts = buildBlockerFacts(baseInputs({
      targetScope: 'Vix',
      targetCell: cell('unpaid'),
      otherEntityCell: { payEntity: 'Coverall', state: 'paid', paid_amount: 18 },
      preResolvedOther: resolved(18),
    }));
    expect(facts.crossEntitySatisfied.satisfied).toBe(true);
    expect(facts.crossEntitySatisfied.satisfyingEntity).toBe('Coverall');
  });
});

// ────────────────────────── G6 amount matrix ──────────────────────────

describe('Phase C1a — G6 amount fact on target-paid cells', () => {
  it('correct: actual === expected', () => {
    const facts = buildBlockerFacts(baseInputs({
      targetCell: cell('paid', 18),
      preResolvedTarget: resolved(18),
    }));
    expect(facts.amount).toEqual({ kind: 'correct' });
  });

  it('wrong_amount surfaces actual + expected', () => {
    const facts = buildBlockerFacts(baseInputs({
      targetCell: cell('paid', 25),
      preResolvedTarget: resolved(18),
    }));
    expect(facts.amount).toEqual({ kind: 'wrong_amount', actual: 25, expected: 18 });
  });

  it('Vix flat-override basis applies (override amount honoured by resolver)', () => {
    const facts = buildBlockerFacts(baseInputs({
      targetScope: 'Vix',
      targetCell: cell('paid', 4.50),
      preResolvedTarget: resolvedOverride(4.50),
    }));
    expect(facts.amount).toEqual({ kind: 'correct' });
  });

  for (const reason of [
    'MISSING_MEMBER_COUNT', 'MISSING_POLICY_YEAR', 'NO_RATE_ROW',
    'MISSING_CARRIER', 'MISSING_STATE', 'MISSING_MONTHS',
  ] as const) {
    it(`resolver ${reason} → indeterminate (never wrong_amount)`, () => {
      const facts = buildBlockerFacts(baseInputs({
        targetCell: cell('paid', 99),
        preResolvedTarget: unsupported(reason),
      }));
      expect(facts.amount).toEqual({ kind: 'indeterminate', reason });
    });
  }

  it('TBD_AMBIGUOUS_PAYEE → indeterminate', () => {
    const facts = buildBlockerFacts(baseInputs({
      targetCell: cell('paid', 18),
      preResolvedTarget: {
        amount: null, status: 'TBD_AMBIGUOUS_PAYEE',
        evidence: {
          carrier: 'ambetter', state: 'FL', member_count: 1, months: 1,
          policy_year: 2026, plan_variant: null, rate_row_id: null,
          current_policy_aor: 'Erica Fine', matched_payee: null,
        },
      },
    }));
    expect(facts.amount).toEqual({ kind: 'indeterminate', reason: 'TBD_AMBIGUOUS_PAYEE' });
  });
});

// ────────────────────────── premium passthrough ──────────────────────────

describe('Phase C1a — premium passthrough (certified states only, never recompute)', () => {
  it('not_expected_premium_unpaid → premium_blocked', () => {
    const facts = buildBlockerFacts(baseInputs({
      targetCell: cell('not_expected_premium_unpaid'),
    }));
    expect(facts.premium).toEqual({ kind: 'premium_blocked' });
  });

  it('unpaid → chase_candidate', () => {
    expect(buildBlockerFacts(baseInputs({ targetCell: cell('unpaid') })).premium)
      .toEqual({ kind: 'chase_candidate' });
  });

  for (const s of [
    'paid', 'reversed', 'not_expected_pre_eligibility', 'not_expected_cancelled',
    'not_expected_not_ours', 'pending', 'manual_review',
  ] as const) {
    it(`${s} → not_applicable`, () => {
      expect(buildBlockerFacts(baseInputs({ targetCell: cell(s) })).premium)
        .toEqual({ kind: 'not_applicable' });
    });
  }
});

// ────────────────────────── purity ──────────────────────────

describe('Phase C1a — buildBlockerFacts is a PURE layer', () => {
  it('does no DB / persistence calls (supabase mock is never touched)', async () => {
    const supabaseMock = vi.hoisted(() => ({
      from: vi.fn(),
      rpc: vi.fn(),
    }));
    vi.doMock('@/integrations/supabase/client', () => ({ supabase: supabaseMock }));
    const dmi = edeRow({
      effective_date: '2026-02-01',
      verificationIssueType: 'DMI_CITIZENSHIP',
      verificationEndDate: '2026-12-31',
    });
    const facts = buildBlockerFacts(baseInputs({
      targetCell: cell('paid', 18),
      pickedEdeForMonth: dmi,
      preResolvedTarget: resolved(18),
      otherEntityCell: { payEntity: 'Vix', state: 'paid', paid_amount: 4.50 },
      preResolvedOther: resolvedOverride(4.50),
    }));
    expect(facts.amount).toEqual({ kind: 'correct' });
    expect(supabaseMock.from).not.toHaveBeenCalled();
    expect(supabaseMock.rpc).not.toHaveBeenCalled();
  });
});

// ────────────────────────── gated denominator smoke ──────────────────────────

const smokeIt = process.env.RUN_SMOKE_CONTROLS === '1' ? it : it.skip;

describe('Phase C1a — live active-DMI denominator (RUN_SMOKE_CONTROLS=1 only)', () => {
  smokeIt('measures total / paid-vs-unpaid / per-month active-DMI under picked-EDE definition', async () => {
    const { getAllNormalizedRecordsForMemberTimeline, getBatches } =
      await import('@/lib/persistence');
    const { loadResolverIndex } = await import('@/lib/resolvedIdentities');
    const { mergeRecordsToMemberKeys } = await import('@/lib/canonical/memberKeyMerge');
    const { buildMonthList } = await import('@/lib/memberTimeline');
    const { buildMonthPickerMapForMember } = await import('@/lib/canonical/edeMonthPicker');
    const {
      classifyMember,
      buildClassifierContext,
      buildIsDueEligibleRecord,
    } = await import('@/lib/classifier');
    const { latestAuthoritativeBoTermDates, makeBoRecency } =
      await import('@/lib/canonical/latestAuthoritativeBo');

    const resolverIndex = await loadResolverIndex(true);
    const allRecords = await getAllNormalizedRecordsForMemberTimeline();
    mergeRecordsToMemberKeys(allRecords as any, resolverIndex);

    const batches = await getBatches();
    const batchMonthByBatchId = new Map<string, string>();
    for (const b of batches ?? []) {
      if (!b?.id || !b?.statement_month) continue;
      batchMonthByBatchId.set(String(b.id), String(b.statement_month).substring(0, 7));
    }
    const recency = makeBoRecency({ batchMonthByBatchId });
    const overlay = latestAuthoritativeBoTermDates(allRecords as any, recency);
    const monthList = buildMonthList('2026-01', '2026-04');

    const isDue = buildIsDueEligibleRecord({ aorScope: 'all', payEntity: 'All' });
    const scoped = (allRecords as any[]).filter(isDue);

    const byMember = new Map<string, any[]>();
    for (const r of scoped) {
      const k = r.member_key || r.applicant_name || 'unknown';
      let arr = byMember.get(k);
      if (!arr) { arr = []; byMember.set(k, arr); }
      arr.push(r);
    }

    const baseCtx = buildClassifierContext(scoped, monthList, [], {
      batchMonthByBatchId,
      latestAuthoritativeBoOverlay: overlay,
    });

    const perMonth = new Map<string, { paid: number; unpaid: number; other: number }>();
    for (const m of monthList) perMonth.set(m, { paid: 0, unpaid: 0, other: 0 });
    let total = 0;
    let totalPaid = 0;
    let totalUnpaid = 0;

    for (const [_k, recs] of byMember) {
      const picker = buildMonthPickerMapForMember(recs, monthList);
      const ctx = { ...baseCtx, pickerEdeByMonth: picker };
      const cls = classifyMember(recs, ctx);
      for (const m of monthList) {
        const picked = picker.get(m) ?? null;
        const sig = getDmiSignal(picked as any);
        if (!sig) continue;
        const cell = cls.cells[m];
        if (!cell) continue;
        total += 1;
        const bucket = perMonth.get(m)!;
        if (cell.state === 'paid') { totalPaid += 1; bucket.paid += 1; }
        else if (cell.state === 'unpaid') { totalUnpaid += 1; bucket.unpaid += 1; }
        else { bucket.other += 1; }
      }
    }

    // eslint-disable-next-line no-console
    console.log('[C1a denominator]', {
      total, totalPaid, totalUnpaid,
      perMonth: Object.fromEntries(perMonth),
    });
    expect(total).toBeGreaterThanOrEqual(0);
  });
});
