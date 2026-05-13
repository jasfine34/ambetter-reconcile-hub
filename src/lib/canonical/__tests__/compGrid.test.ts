/**
 * Bundle 13a — compGrid pure helper tests, including seed-integrity assertions
 * sourced from outputs/bundle13a_carrier_comp_rates_seed.sql.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getExpectedCommission, type CarrierCompRateRow } from '../compGrid';

// ---------- Seed parser ----------

function parseTuple(body: string): CarrierCompRateRow | null {
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
  for (const raw of sql.split('\n')) {
    const line = raw.trim();
    // Each tuple line begins with "(" and ends with ")," or ");"
    if (!line.startsWith('(')) continue;
    const closeIdx = line.lastIndexOf(')');
    if (closeIdx < 0) continue;
    const body = line.slice(1, closeIdx);
    const row = parseTuple(body);
    if (row) rows.push(row);
  }
  return rows;
}

const SEED = parseSeed();

describe('compGrid — seed integrity', () => {
  it('parses 173 rows from the canonical seed file', () => {
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

// ---------- Synthetic rows for math + branch tests ----------

const mk = (over: Partial<CarrierCompRateRow> = {}): CarrierCompRateRow => ({
  rate_key: 'k', carrier_key: 'ambetter', carrier_display: 'Ambetter',
  state_code: 'FL', plan_variant: null, comp_basis: 'pmpm',
  calculation_basis: 'per_member_pmpm', rate_value: 10, rate_unit: 'dollar',
  member_min: null, member_max: null, member_cap: null,
  effective_year: 2026, support_status: 'supported', unsupported_reason: null,
  ...over,
});

describe('getExpectedCommission — calculation_basis math', () => {
  it('per_member_pmpm = rate * members * months', () => {
    const r = getExpectedCommission(
      { carrier: 'ambetter', state: 'FL', members: 3, months: 4, effectiveYear: 2026 },
      [mk({ rate_value: 24 })],
    );
    expect(r.ok && r.expectedCommission).toBe(24 * 3 * 4);
  });
  it('capped_member_pmpm caps members at member_cap', () => {
    const r = getExpectedCommission(
      { carrier: 'ambetter', state: 'FL', members: 10, months: 6, effectiveYear: 2026 },
      [mk({ calculation_basis: 'capped_member_pmpm', rate_value: 5, member_cap: 4 })],
    );
    expect(r.ok && r.expectedCommission).toBe(5 * 4 * 6);
  });
  it('per_policy_monthly_bracket = rate * months for the matched bracket', () => {
    const rows = [
      mk({ calculation_basis: 'per_policy_monthly_bracket', rate_value: 100, member_min: 1, member_max: 1 }),
      mk({ calculation_basis: 'per_policy_monthly_bracket', rate_value: 200, member_min: 2, member_max: 4 }),
      mk({ calculation_basis: 'per_policy_monthly_bracket', rate_value: 300, member_min: 5, member_max: null }),
    ];
    const r = getExpectedCommission(
      { carrier: 'ambetter', state: 'FL', members: 3, months: 12, effectiveYear: 2026 },
      rows,
    );
    expect(r.ok && r.expectedCommission).toBe(200 * 12);
  });
  it('pmpy = rate * members (months ignored)', () => {
    const r = getExpectedCommission(
      { carrier: 'ambetter', state: 'FL', members: 4, months: 6, effectiveYear: 2026 },
      [mk({ calculation_basis: 'pmpy', rate_value: 50 })],
    );
    expect(r.ok && r.expectedCommission).toBe(50 * 4);
  });
});

describe('getExpectedCommission — short-circuits', () => {
  it('zero_rate returns ok with 0', () => {
    const r = getExpectedCommission(
      { carrier: 'ambetter', state: 'FL', members: 5, months: 12, effectiveYear: 2026 },
      [mk({ calculation_basis: 'zero_rate', rate_value: 0 })],
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.expectedCommission).toBe(0);
  });
  it('unsupported_v1 returns reason=unsupported_v1', () => {
    const r = getExpectedCommission(
      { carrier: 'ambetter', state: 'FL', members: 1, months: 1, effectiveYear: 2026 },
      [mk({ support_status: 'unsupported_v1', calculation_basis: 'per_member_pmpm' })],
    );
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.reason).toBe('unsupported_v1');
  });
  it('percent_premium_unsupported returns its specific reason', () => {
    const r = getExpectedCommission(
      { carrier: 'ambetter', state: 'FL', members: 1, months: 1, effectiveYear: 2026 },
      [mk({ support_status: 'unsupported_v1', calculation_basis: 'percent_premium_unsupported', rate_value: null })],
    );
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.reason).toBe('percent_premium_unsupported');
  });
});

describe('getExpectedCommission — plan_variant resolution', () => {
  it('provided planVariant must match exactly or returns plan_variant_not_found', () => {
    const rows = [mk({ plan_variant: 'standard' })];
    const r = getExpectedCommission(
      { carrier: 'ambetter', state: 'FL', members: 1, months: 1, planVariant: 'value', effectiveYear: 2026 },
      rows,
    );
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.reason).toBe('plan_variant_not_found');
  });
  it('null planVariant prefers bracket rows even when non-bracket rows exist', () => {
    const rows = [
      mk({ calculation_basis: 'per_member_pmpm', rate_value: 999 }),
      mk({ calculation_basis: 'per_policy_monthly_bracket', rate_value: 50, member_min: 1, member_max: 10 }),
    ];
    const r = getExpectedCommission(
      { carrier: 'ambetter', state: 'FL', members: 2, months: 3, effectiveYear: 2026 },
      rows,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.basis).toBe('per_policy_monthly_bracket');
      expect(r.expectedCommission).toBe(50 * 3);
    }
  });
  it('null planVariant + mixed-basis prefers plan_variant=standard tag', () => {
    const rows = [
      mk({ calculation_basis: 'per_member_pmpm', rate_value: 24, plan_variant: 'standard' }),
      mk({ calculation_basis: 'pmpy', rate_value: 9999, plan_variant: 'enhanced' }),
    ];
    const r = getExpectedCommission(
      { carrier: 'ambetter', state: 'FL', members: 1, months: 1, effectiveYear: 2026 },
      rows,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.expectedCommission).toBe(24);
  });
});

describe('getExpectedCommission — state fallback & no-numeric-fallback', () => {
  it('state_code IS NULL row is used when no exact-state row exists', () => {
    const r = getExpectedCommission(
      { carrier: 'alliant', state: 'TX', members: 2, months: 6, effectiveYear: 2026 },
      [mk({ carrier_key: 'alliant', state_code: null, rate_value: 9.4 })],
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.expectedCommission).toBeCloseTo(9.4 * 2 * 6);
  });
  it('no carrier rows returns no_carrier_year_rows (no silent default)', () => {
    const r = getExpectedCommission(
      { carrier: 'unknown', state: 'FL', members: 1, months: 1, effectiveYear: 2026 },
      [mk()],
    );
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.reason).toBe('no_carrier_year_rows');
  });
  it('bracket with no matching member range returns no_bracket_match', () => {
    const r = getExpectedCommission(
      { carrier: 'ambetter', state: 'FL', members: 99, months: 1, effectiveYear: 2026 },
      [mk({ calculation_basis: 'per_policy_monthly_bracket', rate_value: 1, member_min: 1, member_max: 5 })],
    );
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.reason).toBe('no_bracket_match');
  });
});

describe('getExpectedCommission — bracket priority precedes highest-rate fallback', () => {
  it('with bracket rows present, never picks highest-rate non-bracket row', () => {
    const rows = [
      mk({ calculation_basis: 'per_member_pmpm', rate_value: 100000 }),
      mk({ calculation_basis: 'per_policy_monthly_bracket', rate_value: 1, member_min: 1, member_max: 1 }),
    ];
    const r = getExpectedCommission(
      { carrier: 'ambetter', state: 'FL', members: 1, months: 1, effectiveYear: 2026 },
      rows,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.basis).toBe('per_policy_monthly_bracket');
  });
});
