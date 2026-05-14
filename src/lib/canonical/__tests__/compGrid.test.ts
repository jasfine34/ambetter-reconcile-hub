/**
 * Bundle 13a v8 — compGrid pure helper tests, including seed-integrity
 * assertions sourced from outputs/bundle13a_carrier_comp_rates_seed.sql.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  getExpectedCommission,
  mapPolicyYearTo2026Grid,
  type CarrierCompRateRow,
  type GetExpectedCommissionArgs,
} from '../compGrid';

// ---------- Seed parser ----------

function parseTuple(body: string, index: number): CarrierCompRateRow | null {
  const tokens: (string | number | null)[] = [];
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === ' ' || ch === ',' || ch === '\n' || ch === '\t') { i++; continue; }
    if (ch === "'") {
      let j = i + 1;
      let s = '';
      while (j < body.length) {
        if (body[j] === "'" && body[j + 1] === "'") { s += "'"; j += 2; continue; }
        if (body[j] === "'") break;
        s += body[j]; j++;
      }
      tokens.push(s);
      i = j + 1;
    } else {
      let j = i;
      while (j < body.length && body[j] !== ',') j++;
      const tok = body.slice(i, j).trim();
      if (tok.toUpperCase() === 'NULL') tokens.push(null);
      else if (tok !== '' && !Number.isNaN(Number(tok))) tokens.push(Number(tok));
      else if (tok !== '') tokens.push(tok);
      i = j;
    }
  }
  if (tokens.length < 21) return null;
  const [
    rate_key, _source_name, _source_file_name, carrier_key, carrier_display,
    state_code, plan_variant, _comp_level, _production_threshold, comp_basis,
    calculation_basis, rate_value, rate_unit, member_min, member_max, member_cap,
    effective_year, _eff_start, _eff_end, support_status, unsupported_reason,
  ] = tokens;
  return {
    // Per Addition E/Fix 4: parsed-seed fixtures synthesize a deterministic
    // test id (use rate_key) so CarrierCompRateRow has a string id.
    id: String(rate_key),
    rate_key: String(rate_key),
    carrier_key: String(carrier_key),
    carrier_display: String(carrier_display),
    state_code: state_code as string | null,
    plan_variant: plan_variant as string | null,
    comp_basis: String(comp_basis),
    calculation_basis: String(calculation_basis),
    rate_value: rate_value == null ? null : Number(rate_value),
    rate_unit: rate_unit as string | null,
    member_min: member_min == null ? null : Number(member_min),
    member_max: member_max == null ? null : Number(member_max),
    member_cap: member_cap == null ? null : Number(member_cap),
    effective_year: Number(effective_year),
    support_status: String(support_status),
    unsupported_reason: unsupported_reason as string | null,
  };
}

function parseSeed(): CarrierCompRateRow[] {
  const sql = readFileSync(
    resolve(__dirname, '../../../../outputs/bundle13a_carrier_comp_rates_seed.sql'),
    'utf8',
  );
  const rows: CarrierCompRateRow[] = [];
  let idx = 0;
  for (const raw of sql.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('(')) continue;
    const closeIdx = line.lastIndexOf(')');
    if (closeIdx < 0) continue;
    const body = line.slice(1, closeIdx);
    const row = parseTuple(body, idx);
    if (row) { rows.push(row); idx++; }
  }
  return rows;
}

const SEED = parseSeed();

// ---------- Synthetic fixture ----------

let _uuidSeq = 0;
const uid = () => {
  _uuidSeq++;
  return `00000000-0000-0000-0000-${_uuidSeq.toString().padStart(12, '0')}`;
};

const mk = (over: Partial<CarrierCompRateRow> = {}): CarrierCompRateRow => ({
  id: uid(),
  rate_key: 'k',
  carrier_key: 'ambetter',
  carrier_display: 'Ambetter',
  state_code: 'FL',
  plan_variant: null,
  comp_basis: 'pmpm',
  calculation_basis: 'per_member_pmpm',
  rate_value: 10,
  rate_unit: 'dollar',
  member_min: null,
  member_max: null,
  member_cap: null,
  effective_year: 2026,
  support_status: 'supported',
  unsupported_reason: null,
  ...over,
});

const baseArgs = (over: Partial<GetExpectedCommissionArgs> = {}): GetExpectedCommissionArgs => ({
  carrier: 'ambetter',
  state: 'FL',
  members: 1,
  months: 1,
  policyYear: 2026,
  ...over,
});

// ---------- Tests ----------

describe('compGrid — seed integrity', () => {
  it('parses 173 rows from canonical seed', () => {
    expect(SEED.length).toBe(173);
  });
  it('every row is effective_year=2026', () => {
    expect(SEED.every(r => r.effective_year === 2026)).toBe(true);
  });
  it('every row has a recognized calculation_basis', () => {
    const allowed = new Set([
      'per_member_pmpm', 'capped_member_pmpm', 'per_policy_monthly_bracket',
      'pmpy', 'percent_premium_unsupported', 'zero_rate',
    ]);
    expect(SEED.every(r => allowed.has(r.calculation_basis))).toBe(true);
  });
  it('every row has support_status in {supported, unsupported_v1}', () => {
    const allowed = new Set(['supported', 'unsupported_v1']);
    expect(SEED.every(r => allowed.has(r.support_status))).toBe(true);
  });
});

describe('mapPolicyYearTo2026Grid', () => {
  it('maps 2025 and 2026 to 2026', () => {
    expect(mapPolicyYearTo2026Grid(2025)).toBe(2026);
    expect(mapPolicyYearTo2026Grid(2026)).toBe(2026);
  });
  it('passes through unknown years (forward compatibility)', () => {
    expect(mapPolicyYearTo2026Grid(2024)).toBe(2024);
    expect(mapPolicyYearTo2026Grid(2027)).toBe(2027);
    expect(mapPolicyYearTo2026Grid(2030)).toBe(2030);
  });
});

describe('getExpectedCommission — calculation_basis math', () => {
  it('per_member_pmpm = rate * members * months', () => {
    const row = mk({ rate_value: 24 });
    const r = getExpectedCommission(baseArgs({ members: 3, months: 4 }), [row]);
    expect(r.expectedAmount).toBe(24 * 3 * 4);
    expect(r.supportStatus).toBe('supported');
    expect(r.compBasis).toBe('pmpm');
    expect(r.rateRecordId).toBe(row.id);
  });
  it('capped_member_pmpm caps members at member_cap', () => {
    const row = mk({ calculation_basis: 'capped_member_pmpm', rate_value: 5, member_cap: 4 });
    const r = getExpectedCommission(baseArgs({ members: 10, months: 6 }), [row]);
    expect(r.expectedAmount).toBe(5 * 4 * 6);
    expect(r.rateRecordId).toBe(row.id);
  });
  it('per_policy_monthly_bracket = rate * months for matched bracket', () => {
    const rows = [
      mk({ calculation_basis: 'per_policy_monthly_bracket', rate_value: 100, member_min: 1, member_max: 1 }),
      mk({ calculation_basis: 'per_policy_monthly_bracket', rate_value: 200, member_min: 2, member_max: 4 }),
      mk({ calculation_basis: 'per_policy_monthly_bracket', rate_value: 300, member_min: 5, member_max: null }),
    ];
    const r = getExpectedCommission(baseArgs({ members: 3, months: 12 }), rows);
    expect(r.expectedAmount).toBe(200 * 12);
    expect(r.rateRecordId).toBe(rows[1].id);
  });
  it('pmpy = rate * members * (months / 12), rounded to cents', () => {
    const row = mk({ calculation_basis: 'pmpy', comp_basis: 'pmpy', rate_value: 100 });
    const r = getExpectedCommission(baseArgs({ members: 1, months: 1 }), [row]);
    expect(r.expectedAmount).toBe(8.33);
    expect(r.compBasis).toBe('pmpy');
  });
  it('zero_rate returns supported with 0', () => {
    const row = mk({ calculation_basis: 'zero_rate', rate_value: 0 });
    const r = getExpectedCommission(baseArgs({ members: 5, months: 12 }), [row]);
    expect(r.expectedAmount).toBe(0);
    expect(r.supportStatus).toBe('supported');
  });
});

describe('getExpectedCommission — real seed regressions', () => {
  it.each([
    [1, 12, 292.80],
    [1, 6, 146.40],
    [2, 12, 585.60],
    [2, 6, 292.80],
  ])('BCBS TN Blue Elite PMPY: %i members × %i months → $%s', (members, months, expected) => {
    const r = getExpectedCommission(
      { carrier: 'bcbs', state: 'TN', members, months, planVariant: 'blue_elite', policyYear: 2026 },
      SEED,
    );
    expect(r.supportStatus).toBe('supported');
    expect(r.compBasis).toBe('pmpy');
    expect(r.expectedAmount).toBe(expected);
  });
  it('BCBS TN planVariant=null returns standard PMPM $25 (mixed-basis "standard" tag wins)', () => {
    const r = getExpectedCommission(
      { carrier: 'bcbs', state: 'TN', members: 2, months: 3, policyYear: 2026 },
      SEED,
    );
    expect(r.supportStatus).toBe('supported');
    expect(r.expectedAmount).toBe(25 * 2 * 3);
  });
  it('BCBS SC default lookup brackets: members=1 → $30', () => {
    const r = getExpectedCommission(
      { carrier: 'bcbs', state: 'SC', members: 1, months: 1, policyYear: 2026 },
      SEED,
    );
    expect(r.expectedAmount).toBe(30);
  });
  it('BCBS SC default lookup brackets: members=3 → $61', () => {
    const r = getExpectedCommission(
      { carrier: 'bcbs', state: 'SC', members: 3, months: 1, policyYear: 2026 },
      SEED,
    );
    expect(r.expectedAmount).toBe(61);
  });
  it('BCBS SC default lookup brackets: members=5 → $61 (open upper bound)', () => {
    const r = getExpectedCommission(
      { carrier: 'bcbs', state: 'SC', members: 5, months: 1, policyYear: 2026 },
      SEED,
    );
    expect(r.expectedAmount).toBe(61);
  });
  it('Blue Shield CA percent → unsupported_v1 with percent_of_premium_not_implemented', () => {
    const r = getExpectedCommission(
      { carrier: 'bs_ca', state: 'CA', members: 1, months: 1, policyYear: 2026 },
      SEED,
    );
    expect(r.supportStatus).toBe('unsupported_v1');
    expect(r.unsupportedReason).toBe('percent_of_premium_not_implemented');
    expect(r.compBasis).toBe('percent_premium');
    expect(r.rateRecordId).not.toBeNull();
  });
});

describe('getExpectedCommission — plan_variant resolution', () => {
  it('provided planVariant with no match → plan_variant_not_found', () => {
    const r = getExpectedCommission(
      baseArgs({ planVariant: 'value' }),
      [mk({ plan_variant: 'standard' })],
    );
    expect(r.supportStatus).toBe('not_found');
    expect(r.unsupportedReason).toBe('plan_variant_not_found');
    expect(r.rateRecordId).toBeNull();
    expect(r.evidence.availablePlanVariants).toEqual(['standard']);
  });
  it('null planVariant prefers bracket rows over non-bracket', () => {
    const rows = [
      mk({ calculation_basis: 'per_member_pmpm', rate_value: 999 }),
      mk({ calculation_basis: 'per_policy_monthly_bracket', rate_value: 50, member_min: 1, member_max: 10 }),
    ];
    const r = getExpectedCommission(baseArgs({ members: 2, months: 3 }), rows);
    expect(r.expectedAmount).toBe(50 * 3);
  });
  it('null planVariant + mixed-basis prefers plan_variant=standard tag', () => {
    const rows = [
      mk({ calculation_basis: 'per_member_pmpm', rate_value: 24, plan_variant: 'standard' }),
      mk({ calculation_basis: 'pmpy', comp_basis: 'pmpy', rate_value: 9999, plan_variant: 'enhanced' }),
    ];
    const r = getExpectedCommission(baseArgs(), rows);
    expect(r.expectedAmount).toBe(24);
  });
  it('null planVariant + mixed-basis with NO standard tag → ambiguous_rate_variant', () => {
    const rows = [
      mk({ calculation_basis: 'per_member_pmpm', rate_value: 10, plan_variant: 'foo' }),
      mk({ calculation_basis: 'pmpy', comp_basis: 'pmpy', rate_value: 100, plan_variant: 'bar' }),
    ];
    const r = getExpectedCommission(baseArgs(), rows);
    expect(r.supportStatus).toBe('not_found');
    expect(r.unsupportedReason).toBe('ambiguous_rate_variant');
  });
  it('explicit planVariant routes through bracket matching', () => {
    const rows = [
      mk({ calculation_basis: 'per_policy_monthly_bracket', rate_value: 30, member_min: 1, member_max: 1, plan_variant: 'special_bracket' }),
      mk({ calculation_basis: 'per_policy_monthly_bracket', rate_value: 61, member_min: 2, member_max: null, plan_variant: 'special_bracket' }),
    ];
    const r1 = getExpectedCommission(baseArgs({ members: 1, planVariant: 'special_bracket' }), rows);
    expect(r1.expectedAmount).toBe(30);
    const r3 = getExpectedCommission(baseArgs({ members: 3, planVariant: 'special_bracket' }), rows);
    expect(r3.expectedAmount).toBe(61);
  });
  it('explicit planVariant mixed-basis (Addition I): no "standard" fallback → data_inconsistency', () => {
    const rows = [
      mk({ calculation_basis: 'per_member_pmpm', rate_value: 10, plan_variant: 'standard' }),
      mk({ calculation_basis: 'pmpy', comp_basis: 'pmpy', rate_value: 100, plan_variant: 'standard' }),
    ];
    const r = getExpectedCommission(baseArgs({ planVariant: 'standard' }), rows);
    expect(r.supportStatus).toBe('not_found');
    expect(r.unsupportedReason).toBe('data_inconsistency_supported_unsupported_basis');
  });
});

describe('getExpectedCommission — bracket overlap detection (Fix 5)', () => {
  it('zero matching brackets → no_matching_member_bracket', () => {
    const rows = [
      mk({ calculation_basis: 'per_policy_monthly_bracket', rate_value: 1, member_min: 1, member_max: 1 }),
      mk({ calculation_basis: 'per_policy_monthly_bracket', rate_value: 2, member_min: 2, member_max: 3 }),
      mk({ calculation_basis: 'per_policy_monthly_bracket', rate_value: 3, member_min: 4, member_max: null }),
    ];
    // members=0 fails missing_required_input first; use a number outside ranges via nulls — but ranges are 1-1, 2-3, 4+ so all positives match. Use shifted ranges.
    const rows2 = [
      mk({ calculation_basis: 'per_policy_monthly_bracket', rate_value: 1, member_min: 5, member_max: 5 }),
    ];
    const r = getExpectedCommission(baseArgs({ members: 1 }), rows2);
    expect(r.supportStatus).toBe('not_found');
    expect(r.unsupportedReason).toBe('no_matching_member_bracket');
  });
  it('overlapping brackets (1-3 and 2-4) at members=2 → ambiguous_member_bracket', () => {
    const rows = [
      mk({ calculation_basis: 'per_policy_monthly_bracket', rate_value: 50, member_min: 1, member_max: 3 }),
      mk({ calculation_basis: 'per_policy_monthly_bracket', rate_value: 60, member_min: 2, member_max: 4 }),
    ];
    const r = getExpectedCommission(baseArgs({ members: 2 }), rows);
    expect(r.supportStatus).toBe('not_found');
    expect(r.unsupportedReason).toBe('ambiguous_member_bracket');
  });
});

describe('getExpectedCommission — state fallback', () => {
  it('state_code IS NULL row used when no exact-state row exists', () => {
    const r = getExpectedCommission(
      { carrier: 'alliant', state: 'TX', members: 2, months: 6, policyYear: 2026 },
      [mk({ carrier_key: 'alliant', state_code: null, rate_value: 9.4 })],
    );
    expect(r.expectedAmount).toBeCloseTo(9.4 * 2 * 6);
  });
  it('no carrier rows → carrier_state_not_in_grid (matchedRows empty)', () => {
    const r = getExpectedCommission(
      { carrier: 'unknown', state: 'FL', members: 1, months: 1, policyYear: 2026 },
      [mk()],
    );
    expect(r.supportStatus).toBe('not_found');
    expect(r.unsupportedReason).toBe('carrier_state_not_in_grid');
    expect(r.evidence.matchedRows).toEqual([]);
  });
});

describe('getExpectedCommission — policy-year passthrough', () => {
  it('policyYear=2025 routes to 2026 grid (Ambetter FL)', () => {
    const r = getExpectedCommission(
      { carrier: 'ambetter', state: 'FL', members: 2, months: 1, policyYear: 2025 },
      SEED,
    );
    expect(r.supportStatus).toBe('supported');
    expect(r.expectedAmount).toBe(68);
  });
  it('policyYear=2026 routes to 2026 grid (Ambetter FL)', () => {
    const r = getExpectedCommission(
      { carrier: 'ambetter', state: 'FL', members: 2, months: 1, policyYear: 2026 },
      SEED,
    );
    expect(r.supportStatus).toBe('supported');
    expect(r.expectedAmount).toBe(68);
  });
  it('policyYear=2027 passes through → not_found (no rows seeded for 2027)', () => {
    const r = getExpectedCommission(
      { carrier: 'ambetter', state: 'FL', members: 2, months: 1, policyYear: 2027 },
      SEED,
    );
    expect(r.supportStatus).toBe('not_found');
    expect(r.unsupportedReason).toBe('carrier_state_not_in_grid');
  });
});
describe('getExpectedCommission — missing-input validation (Fix 6)', () => {
  for (const [label, args] of [
    ['members=0', { members: 0 }],
    ['members=-1', { members: -1 }],
    ['months=0', { months: 0 }],
    ['months=-1', { months: -1 }],
    ['carrier=""', { carrier: '' }],
    ['state=""', { state: '' }],
  ] as const) {
    it(`${label} → missing_required_input`, () => {
      const r = getExpectedCommission(baseArgs(args as Partial<GetExpectedCommissionArgs>), [mk()]);
      expect(r.supportStatus).toBe('not_found');
      expect(r.unsupportedReason).toBe('missing_required_input');
      expect(r.evidence.matchedRows).toEqual([]);
    });
  }
});

describe('getExpectedCommission — Addition E (rateRecordId rule)', () => {
  it('single supported row → rateRecordId = row.id', () => {
    const row = mk({ id: '00000000-0000-0000-0000-000000000777', rate_value: 10 });
    const r = getExpectedCommission(baseArgs(), [row]);
    expect(r.rateRecordId).toBe('00000000-0000-0000-0000-000000000777');
  });
  it('single unsupported_v1 row → rateRecordId = that row id', () => {
    const row = mk({
      id: '00000000-0000-0000-0000-000000000888',
      support_status: 'unsupported_v1',
      calculation_basis: 'percent_premium_unsupported',
      comp_basis: 'percent_premium',
      rate_value: 5,
      unsupported_reason: 'percent_of_premium_not_implemented',
    });
    const r = getExpectedCommission(baseArgs(), [row]);
    expect(r.supportStatus).toBe('unsupported_v1');
    expect(r.rateRecordId).toBe('00000000-0000-0000-0000-000000000888');
  });
  it('multiple unsupported_v1 sharing same row-level reason → rateRecordId=null, supportStatus=unsupported_v1', () => {
    const rows = [
      mk({ support_status: 'unsupported_v1', calculation_basis: 'percent_premium_unsupported', comp_basis: 'percent_premium', rate_value: 1, unsupported_reason: 'percent_of_premium_not_implemented', plan_variant: 'a' }),
      mk({ support_status: 'unsupported_v1', calculation_basis: 'percent_premium_unsupported', comp_basis: 'percent_premium', rate_value: 2, unsupported_reason: 'percent_of_premium_not_implemented', plan_variant: 'b' }),
    ];
    const r = getExpectedCommission(baseArgs(), rows);
    expect(r.supportStatus).toBe('unsupported_v1');
    expect(r.unsupportedReason).toBe('percent_of_premium_not_implemented');
    expect(r.rateRecordId).toBeNull();
  });
  it('synthetic supported + unsupported_v1 (matchedRows): selection picks supported row, ignores unsupported in selection', () => {
    const supportedRow = mk({ id: uid(), rate_value: 10, plan_variant: 'standard' });
    const unsupportedRow = mk({ support_status: 'unsupported_v1', calculation_basis: 'percent_premium_unsupported', comp_basis: 'percent_premium', rate_value: 2, unsupported_reason: 'percent_of_premium_not_implemented', plan_variant: 'standard' });
    const r = getExpectedCommission(baseArgs({ planVariant: 'standard' }), [supportedRow, unsupportedRow]);
    expect(r.supportStatus).toBe('supported');
    expect(r.rateRecordId).toBe(supportedRow.id);
    // Addition F: matchedRows includes ALL rows from steps 1+2.
    expect(r.evidence.matchedRows.length).toBe(2);
  });
  it('synthetic only-unsupported with multiple reasons → ambiguous_rate_variant, rateRecordId=null', () => {
    const rows = [
      mk({ support_status: 'unsupported_v1', calculation_basis: 'percent_premium_unsupported', comp_basis: 'percent_premium', rate_value: 1, unsupported_reason: 'percent_of_premium_not_implemented' }),
      mk({ support_status: 'unsupported_v1', calculation_basis: 'per_member_pmpm', comp_basis: 'pmpm', rate_value: 1, unsupported_reason: 'bracket_math_not_confirmed' }),
    ];
    const r = getExpectedCommission(baseArgs(), rows);
    expect(r.supportStatus).toBe('not_found');
    expect(r.unsupportedReason).toBe('ambiguous_rate_variant');
    expect(r.rateRecordId).toBeNull();
  });
});

describe('getExpectedCommission — Addition J revised (row-level vs not_found)', () => {
  it('single unsupported_v1 with bracket_math_not_confirmed → supportStatus=unsupported_v1', () => {
    const row = mk({ support_status: 'unsupported_v1', unsupported_reason: 'bracket_math_not_confirmed', rate_value: 1 });
    const r = getExpectedCommission(baseArgs(), [row]);
    expect(r.supportStatus).toBe('unsupported_v1');
    expect(r.unsupportedReason).toBe('bracket_math_not_confirmed');
    expect(r.rateRecordId).toBe(row.id);
  });
});

describe('getExpectedCommission — Addition L (unknown unsupported_reason)', () => {
  it('unsupported_reason=null → data_inconsistency, rateRecordId=null', () => {
    const row = mk({ support_status: 'unsupported_v1', unsupported_reason: null });
    const r = getExpectedCommission(baseArgs(), [row]);
    expect(r.supportStatus).toBe('not_found');
    expect(r.unsupportedReason).toBe('data_inconsistency_supported_unsupported_basis');
    expect(r.rateRecordId).toBeNull();
  });
  it('unsupported_reason="" → data_inconsistency', () => {
    const row = mk({ support_status: 'unsupported_v1', unsupported_reason: '' });
    const r = getExpectedCommission(baseArgs(), [row]);
    expect(r.unsupportedReason).toBe('data_inconsistency_supported_unsupported_basis');
  });
  it('unsupported_reason="foo_bar_not_in_enum" → data_inconsistency, raw value in computation', () => {
    const row = mk({ support_status: 'unsupported_v1', unsupported_reason: 'foo_bar_not_in_enum' });
    const r = getExpectedCommission(baseArgs(), [row]);
    expect(r.unsupportedReason).toBe('data_inconsistency_supported_unsupported_basis');
    expect(r.evidence.computation).toContain('foo_bar_not_in_enum');
  });
});

describe('getExpectedCommission — bracket priority precedes highest-rate fallback', () => {
  it('with bracket rows present, never picks highest-rate non-bracket row', () => {
    const rows = [
      mk({ calculation_basis: 'per_member_pmpm', rate_value: 100000 }),
      mk({ calculation_basis: 'per_policy_monthly_bracket', rate_value: 1, member_min: 1, member_max: 1 }),
    ];
    const r = getExpectedCommission(baseArgs(), rows);
    expect(r.expectedAmount).toBe(1);
  });
});

// ---------- Static guards (FIX 7 + ADDITION K) ----------

function walk(dir: string, results: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules' || entry.startsWith('.')) continue;
      walk(full, results);
    } else {
      results.push(full);
    }
  }
  return results;
}

describe('compGrid — Fix 7 static no-consumer guard', () => {
  const root = resolve(__dirname, '../../..');
  const scopes = ['pages', 'lib', 'components'].map(s => join(root, s));
  const files: string[] = [];
  for (const s of scopes) {
    try { walk(s, files); } catch { /* missing dir is fine */ }
  }
  const inScope = files.filter(f =>
    /\.(ts|tsx)$/.test(f) &&
    !/\.test\.tsx?$/.test(f) &&
    !f.endsWith('compGrid.ts') &&
    !f.endsWith('crossBatchClearingSweep.ts'),
  );
  it('no production file references getExpectedCommission', () => {
    const offenders: string[] = [];
    for (const f of inScope) {
      const src = readFileSync(f, 'utf8');
      if (src.includes('getExpectedCommission')) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});

describe('compGridLoader — Addition K column-list parser', () => {
  function extractSelectArg(src: string): string | null {
    const m = src.match(/\.select\(\s*([\s\S]*?)\s*\)/);
    if (!m) return null;
    return m[1].trim().replace(/,\s*$/, '').trim();
  }
  function parseLiteralColumnList(arg: string): { ok: true; cols: string[] } | { ok: false; reason: string } {
    if (arg.includes('${') || /[`'"]\s*\+/.test(arg) || /\+\s*[`'"]/.test(arg)) {
      return { ok: false, reason: 'dynamic-or-concat' };
    }
    const first = arg[0];
    const last = arg[arg.length - 1];
    if (!((first === "'" && last === "'") || (first === '"' && last === '"') || (first === '`' && last === '`'))) {
      return { ok: false, reason: 'not-a-string-literal' };
    }
    const inner = arg.slice(1, -1);
    if (inner.trim() === '*') return { ok: false, reason: 'star' };
    const cols = inner.split(',').map(c => c.trim().replace(/^["`[]|["`\]]$/g, '').trim()).filter(Boolean);
    return { ok: true, cols };
  }

  it('parser: explicit single-quoted list with id passes', () => {
    const r = parseLiteralColumnList("'id, rate_key, foo'");
    expect(r.ok && r.cols.includes('id')).toBe(true);
  });
  it('parser: double-quoted with id passes', () => {
    const r = parseLiteralColumnList('"id, rate_key"');
    expect(r.ok && r.cols.includes('id')).toBe(true);
  });
  it('parser: backtick (no interpolation) passes', () => {
    const r = parseLiteralColumnList('`id, rate_key`');
    expect(r.ok && r.cols.includes('id')).toBe(true);
  });
  it('parser: backtick with ${} interpolation fails', () => {
    const r = parseLiteralColumnList('`id, ${cols}`');
    expect(r.ok).toBe(false);
  });
  it('parser: string concatenation fails', () => {
    const r = parseLiteralColumnList(`'id, ' + extra`);
    expect(r.ok).toBe(false);
  });
  it("parser: '*' fails", () => {
    const r = parseLiteralColumnList("'*'");
    expect(r.ok).toBe(false);
  });
  it("parser: 'plan_variant_id, rate_key' fails (no standalone id)", () => {
    const r = parseLiteralColumnList("'plan_variant_id, rate_key'");
    expect(r.ok && r.cols.includes('id')).toBe(false);
  });

  it('compGridLoader.ts has explicit standalone id in its select() call', () => {
    const loader = readFileSync(resolve(__dirname, '../compGridLoader.ts'), 'utf8');
    const arg = extractSelectArg(loader);
    expect(arg).not.toBeNull();
    const parsed = parseLiteralColumnList(arg!);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.cols).toContain('id');
  });
});
