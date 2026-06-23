/**
 * TX Ambetter plan-tier — FULL-SOURCE corrective tests.
 *
 * Asserts the binding-layer fix that feeds the helper full-union records:
 *  - Site 2: buildEstMissingInputEvidence(records, tierSourceRecords)
 *  - Site 3: buildSourceEvidenceMap respects upstream plan_variant /
 *           plan_variant_status (precedence flip)
 *
 * Site 1 (synthesizeEvidenceRow) is an internal helper of
 * assembleDiagnoseRouteRows.ts; its contract is exercised end-to-end via
 * the resolver's plan_variant_status='conflict' guard already covered in
 * planVariantTxAmbetter.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { buildEstMissingInputEvidence } from '../assembleCommissionSubmission';
import { buildSourceEvidenceMap } from '../estMissingEvidenceAdapter';

function rec(over: Record<string, any>): any {
  return {
    carrier: 'Ambetter',
    bo_state: 'TX',
    source_type: 'EDE',
    batch_id: 'b1',
    raw_json: {},
    ...over,
  };
}

describe('buildEstMissingInputEvidence — Site 2 tier-source starvation fix', () => {
  const batchMonthByBatchId = { b1: '2026-03', b2: '2026-03' };
  const opts = {
    memberKey: 'm1',
    serviceMonth: '2026-03',
    scope: 'Coverall' as const,
    batchMonthByBatchId,
    policyIdentityKey: 'k1',
  };

  it('Aaron-Barrett shape: EDE-only scoped, BO+commission tier in full union → value', () => {
    // Scope-filtered records carry NO tier signal.
    const scopedRecords = [
      rec({ source_type: 'EDE', raw_json: { State: 'TX' } }),
    ];
    // Full member-union DOES carry tier evidence (BO Plan Name + commission Product).
    const fullUnion = [
      ...scopedRecords,
      rec({ source_type: 'BACK_OFFICE', raw_json: { 'Plan Name': 'Standard Gold VALUE', State: 'TX' } }),
      rec({ source_type: 'COMMISSION', raw_json: { Product: '2026 Ambetter TX-Value' } }),
    ];
    const ev = buildEstMissingInputEvidence({
      ...opts,
      records: scopedRecords,
      tierSourceRecords: fullUnion,
    });
    expect(ev.plan_variant).toBe('value');
    expect(ev.plan_variant_status).toBe('ok');
  });

  it('Conflict in full union → plan_variant=null + status=conflict (NOT array-order pick)', () => {
    const scopedRecords = [rec({ source_type: 'EDE', raw_json: { State: 'TX' } })];
    const tierA = [
      rec({ source_type: 'COMMISSION', raw_json: { Product: 'Ambetter TX-Value' } }),
      rec({ source_type: 'COMMISSION', raw_json: { Product: 'Ambetter TX-Premier' } }),
    ];
    const tierB = [...tierA].reverse();
    const a = buildEstMissingInputEvidence({ ...opts, records: scopedRecords, tierSourceRecords: tierA });
    const b = buildEstMissingInputEvidence({ ...opts, records: scopedRecords, tierSourceRecords: tierB });
    expect(a.plan_variant).toBeNull();
    expect(a.plan_variant_status).toBe('conflict');
    expect(b.plan_variant).toBeNull();
    expect(b.plan_variant_status).toBe('conflict');
  });

  it('No tier source override defaults to records (back-compat)', () => {
    const records = [
      rec({ source_type: 'BACK_OFFICE', raw_json: { 'Plan Name': 'Standard Silver VALUE', State: 'TX' } }),
    ];
    const ev = buildEstMissingInputEvidence({ ...opts, records });
    expect(ev.plan_variant).toBe('value');
    expect(ev.plan_variant_status).toBe('ok');
  });
});

describe('buildSourceEvidenceMap — Site 3 precedence flip', () => {
  it('Upstream plan_variant survives the adapter unchanged', () => {
    const m = buildSourceEvidenceMap([
      {
        member_key: 'm1',
        carrier: 'Ambetter',
        state: 'TX',
        member_count: 1,
        plan_variant: 'value', // upstream-derived (full union)
        plan_variant_status: 'ok',
        raw_json: { Product: 'Ambetter TX-Premier' }, // stale single-record signal
      } as any,
    ]);
    const ev = m.get('m1')!;
    expect(ev.plan_variant).toBe('value');
    expect(ev.plan_variant_status).toBe('ok');
  });

  it('No upstream + single-record derive=value → resolves locally', () => {
    const m = buildSourceEvidenceMap([
      {
        member_key: 'm2',
        carrier: 'Ambetter',
        state: 'TX',
        member_count: 1,
        raw_json: { Product: 'Ambetter TX-Value' },
      } as any,
    ]);
    const ev = m.get('m2')!;
    expect(ev.plan_variant).toBe('value');
    expect(ev.plan_variant_status).toBe('ok');
  });

  it('Upstream plan_variant_status=conflict is preserved (HOLD propagates)', () => {
    const m = buildSourceEvidenceMap([
      {
        member_key: 'm3',
        carrier: 'Ambetter',
        state: 'TX',
        member_count: 1,
        plan_variant: null,
        plan_variant_status: 'conflict',
        raw_json: {},
      } as any,
    ]);
    const ev = m.get('m3')!;
    expect(ev.plan_variant).toBeNull();
    expect(ev.plan_variant_status).toBe('conflict');
  });
});
