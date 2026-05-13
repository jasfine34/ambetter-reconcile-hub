/**
 * Bundle 11 — Unpaid Recovery page tests.
 *
 * Strategy: exercise the page's pure helpers (filter / parse / export) on
 * synthetic canonical row sets, then back that up with file-grep wiring
 * guards proving the page consumes canonical helpers (no inline derivations).
 *
 * The page itself relies on BatchContext + Supabase; we don't render it
 * here. Rendering is covered indirectly by the wiring guards: the same
 * `filteredRows` array drives both the table and the export, so verifying
 * `filterUnpaidRecoveryRows` is correct is sufficient for V1.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Papa from 'papaparse';
import {
  filterUnpaidRecoveryRows,
  parseFiltersFromSearchParams,
  parseScopeParam,
  buildUnpaidRecoveryCsv,
  buildUnpaidRecoveryFilename,
} from '@/pages/UnpaidRecoveryPage';
import {
  classifyPolicyOwnerFromCurrentAor,
} from '@/lib/canonical/policyOwner';
import {
  getExpectedPaymentBreakdown,
  isZeroNetPremium,
  classifySourceTypeForRow,
} from '@/lib/canonical';

// ---------------------------------------------------------------------------
// Synthetic universe — small enough to reason about, exercises every bucket.
// ---------------------------------------------------------------------------
function makeRow(over: Partial<any>): any {
  return {
    member_key: 'm-' + Math.random().toString(36).slice(2, 8),
    in_back_office: true,
    in_ede: true,
    eligible_for_commission: 'Yes',
    pay_entity: 'Coverall',
    in_commission: false,
    net_premium: 100,
    applicant_name: 'Test Member',
    policy_number: 'POL-1',
    issuer_subscriber_id: 'IS-1',
    exchange_subscriber_id: 'ES-1',
    agent_npn: '21055210',
    current_policy_aor: 'Jason Fine (21055210)',
    effective_date: '2026-03-01',
    status: 'Effectuated',
    issue_type: 'Missing from Commission',
    estimated_missing_commission: 25,
    ...over,
  };
}

const ROWS: any[] = [
  makeRow({ member_key: 'jf-zero', current_policy_aor: 'Jason Fine (21055210)', net_premium: 0, applicant_name: 'Alice JF Zero' }),
  makeRow({ member_key: 'jf-has',  current_policy_aor: 'Jason Fine (21055210)', net_premium: 250, applicant_name: 'Bob JF', policy_number: 'POL-2' }),
  makeRow({ member_key: 'ef-has',  current_policy_aor: 'Erica Fine (21277051)', agent_npn: '21277051', net_premium: 300, applicant_name: 'Carol EF' }),
  makeRow({ member_key: 'bs-has',  current_policy_aor: 'Becky Shuta (16531877)', agent_npn: '16531877', net_premium: 200, applicant_name: 'Dan BS' }),
  makeRow({ member_key: 'oth-blank', current_policy_aor: '', agent_npn: '99999999', net_premium: 100, applicant_name: 'Eve Other' }),
];

// Build a real canonical breakdown so the universe carries proper bucket info.
function buildBreakdown(rows: any[], opts?: { boOnly?: any[]; edeOnly?: any[] }) {
  const boOnly = opts?.boOnly ?? [];
  const edeOnly = opts?.edeOnly ?? [];
  // Mark rows so the canonical helper places them in matched/boOnly/edeOnly.
  // Simpler: skip getExpectedPaymentBreakdown and synthesize a universe shape
  // matching what classifySourceTypeForRow consumes.
  const universe = {
    rows,
    matched: rows.filter((r) => !boOnly.includes(r) && !edeOnly.includes(r)),
    boOnly,
    edeOnly,
    total: rows.length,
  };
  return { unpaidRows: rows, universe };
}

describe('Bundle 11 — filterUnpaidRecoveryRows (pure)', () => {
  const { unpaidRows, universe } = buildBreakdown(ROWS, {
    boOnly: [ROWS[0]], // jf-zero is BO-only
    edeOnly: [ROWS[3]], // bs-has is EDE-only
  });

  it('no filters returns every unpaid row', () => {
    const out = filterUnpaidRecoveryRows(unpaidRows, universe, {
      owner: 'all', sourceType: 'all', premiumBucket: 'all', search: '',
    });
    expect(out).toHaveLength(unpaidRows.length);
  });

  it('owner=JF returns only JF rows (per classifyPolicyOwnerFromCurrentAor)', () => {
    const out = filterUnpaidRecoveryRows(unpaidRows, universe, {
      owner: 'JF', sourceType: 'all', premiumBucket: 'all', search: '',
    });
    expect(out.length).toBeGreaterThan(0);
    for (const r of out) {
      expect(classifyPolicyOwnerFromCurrentAor(r.current_policy_aor)).toBe('JF');
    }
  });

  it('sourceType=boOnly returns only BO Only rows', () => {
    const out = filterUnpaidRecoveryRows(unpaidRows, universe, {
      owner: 'all', sourceType: 'boOnly', premiumBucket: 'all', search: '',
    });
    for (const r of out) expect(classifySourceTypeForRow(r, universe)).toBe('BO Only');
    expect(out.map((r) => r.member_key)).toEqual(['jf-zero']);
  });

  it('premiumBucket=zeroNetPremium returns only zero-net-premium rows', () => {
    const out = filterUnpaidRecoveryRows(unpaidRows, universe, {
      owner: 'all', sourceType: 'all', premiumBucket: 'zeroNetPremium', search: '',
    });
    for (const r of out) expect(isZeroNetPremium(r)).toBe(true);
    expect(out.map((r) => r.member_key)).toEqual(['jf-zero']);
  });

  it('premiumBucket=hasPremium excludes zero-net-premium rows', () => {
    const out = filterUnpaidRecoveryRows(unpaidRows, universe, {
      owner: 'all', sourceType: 'all', premiumBucket: 'hasPremium', search: '',
    });
    for (const r of out) expect(isZeroNetPremium(r)).toBe(false);
  });

  it('combined filters (owner=JF AND zeroNetPremium) compose correctly', () => {
    const out = filterUnpaidRecoveryRows(unpaidRows, universe, {
      owner: 'JF', sourceType: 'all', premiumBucket: 'zeroNetPremium', search: '',
    });
    expect(out.map((r) => r.member_key)).toEqual(['jf-zero']);
  });

  it('search matches case-insensitively across name, policy, sub IDs, NPN, AOR', () => {
    const baseFilter = { owner: 'all' as const, sourceType: 'all' as const, premiumBucket: 'all' as const };
    expect(filterUnpaidRecoveryRows(unpaidRows, universe, { ...baseFilter, search: 'carol' }).map((r) => r.member_key)).toEqual(['ef-has']);
    expect(filterUnpaidRecoveryRows(unpaidRows, universe, { ...baseFilter, search: 'POL-2' }).map((r) => r.member_key)).toEqual(['jf-has']);
    expect(filterUnpaidRecoveryRows(unpaidRows, universe, { ...baseFilter, search: '16531877' }).map((r) => r.member_key)).toEqual(['bs-has']);
    expect(filterUnpaidRecoveryRows(unpaidRows, universe, { ...baseFilter, search: 'erica fine' }).map((r) => r.member_key)).toEqual(['ef-has']);
    expect(filterUnpaidRecoveryRows(unpaidRows, universe, { ...baseFilter, search: 'IS-1' }).length).toBe(unpaidRows.length);
  });
});

describe('Bundle 11 — URL param parsing', () => {
  it('parseFiltersFromSearchParams reads each known param', () => {
    const sp = new URLSearchParams('owner=JF&sourceType=boOnly&premiumBucket=zeroNetPremium&search=foo');
    expect(parseFiltersFromSearchParams(sp)).toEqual({
      owner: 'JF', sourceType: 'boOnly', premiumBucket: 'zeroNetPremium', search: 'foo',
    });
  });

  it('unknown param values fall back to "all" / empty', () => {
    const sp = new URLSearchParams('owner=ZZ&sourceType=banana&premiumBucket=other');
    expect(parseFiltersFromSearchParams(sp)).toEqual({
      owner: 'all', sourceType: 'all', premiumBucket: 'all', search: '',
    });
  });

  it('parseScopeParam normalizes coverall/vix/all', () => {
    expect(parseScopeParam('coverall')).toBe('Coverall');
    expect(parseScopeParam('vix')).toBe('Vix');
    expect(parseScopeParam('all')).toBe('All');
    expect(parseScopeParam(null)).toBe(null);
    expect(parseScopeParam('garbage')).toBe(null);
  });
});

describe('Bundle 11 — export shares filteredRows + filename', () => {
  const { unpaidRows, universe } = buildBreakdown(ROWS, { boOnly: [ROWS[0]] });

  it('CSV row count equals filtered row count (no drift)', () => {
    const filtered = filterUnpaidRecoveryRows(unpaidRows, universe, {
      owner: 'JF', sourceType: 'all', premiumBucket: 'all', search: '',
    });
    const csv = buildUnpaidRecoveryCsv(filtered, universe);
    const parsed = Papa.parse(csv.trim(), { header: true });
    expect((parsed.data as any[]).length).toBe(filtered.length);
  });

  it('CSV includes ALL filtered rows, not just one page', () => {
    // Fabricate >50 unpaid rows (PAGE_SIZE=50) so we'd see truncation if it existed.
    const many = Array.from({ length: 137 }, (_, i) =>
      makeRow({ member_key: `bulk-${i}`, applicant_name: `Bulk ${i}`, policy_number: `PB-${i}` }),
    );
    const u = { rows: many, matched: many, boOnly: [], edeOnly: [], total: many.length };
    const filtered = filterUnpaidRecoveryRows(many, u, {
      owner: 'all', sourceType: 'all', premiumBucket: 'all', search: '',
    });
    const csv = buildUnpaidRecoveryCsv(filtered, u);
    const parsed = Papa.parse(csv.trim(), { header: true });
    expect((parsed.data as any[]).length).toBe(137);
  });

  it('filename includes scope, batch month, and a date stamp', () => {
    const fn = buildUnpaidRecoveryFilename({
      scope: 'Coverall',
      batchMonth: '2026-03',
      downloadDate: new Date('2026-05-13T10:30:00Z'),
    });
    expect(fn).toMatch(/^unpaid_recovery_coverall_2026_03_\d{8}_\d{4}\.csv$/);
  });
});

describe('Bundle 11 — wiring guards (canonical helpers, no inline classifiers)', () => {
  const page = readFileSync(resolve(__dirname, '..', 'pages/UnpaidRecoveryPage.tsx'), 'utf8');
  const app = readFileSync(resolve(__dirname, '..', 'App.tsx'), 'utf8');
  const layout = readFileSync(resolve(__dirname, '..', 'components/AppLayout.tsx'), 'utf8');

  it('page consumes canonical row source: getExpectedPaymentBreakdown(...).unpaidRows', () => {
    expect(page).toMatch(/getExpectedPaymentBreakdown\(/);
    expect(page).toMatch(/\.unpaidRows/);
  });

  it('page consumes computeFilteredEde + weak-match upgrade pattern', () => {
    expect(page).toMatch(/computeFilteredEde\(/);
    expect(page).toMatch(/findWeakMatches\(/);
    expect(page).toMatch(/applyOverrides\(/);
    expect(page).toMatch(/pickStableKey\(/);
  });

  it('page consumes canonical owner + source + premium classifiers', () => {
    expect(page).toMatch(/classifyPolicyOwnerFromCurrentAor\(/);
    expect(page).toMatch(/classifySourceTypeForRow\(/);
    expect(page).toMatch(/isZeroNetPremium\(/);
  });

  it('page uses usePayEntityScope (no inline pay-entity filtering)', () => {
    expect(page).toMatch(/usePayEntityScope\(\)/);
  });

  it('page does NOT define its own ownership / source / premium classifier', () => {
    expect(page).not.toMatch(/function\s+classifyPolicyOwner/);
    expect(page).not.toMatch(/function\s+classifySourceType/);
    expect(page).not.toMatch(/function\s+isZeroNetPremium/);
  });

  it('route + nav are registered', () => {
    expect(app).toMatch(/\/unpaid-recovery/);
    expect(app).toMatch(/UnpaidRecoveryPage/);
    expect(layout).toMatch(/\/unpaid-recovery/);
    expect(layout).toMatch(/Unpaid Recovery/);
  });
});

describe('Bundle 11 — cross-surface parity with Dashboard EBU', () => {
  // Build a tiny synthetic batch that exercises real getExpectedPaymentBreakdown,
  // then assert filteredRows under no filters equals breakdown.unpaidCount.
  const reconciled = ROWS;
  const filteredEde = {
    uniqueMembers: ROWS.map((r) => ({
      member_key: r.member_key,
      issuer_subscriber_id: r.issuer_subscriber_id,
      exchange_subscriber_id: r.exchange_subscriber_id,
      policy_number: r.policy_number,
      effective_month: '2026-03',
      covered_member_count: 1,
    })),
    uniqueKeys: ROWS.length,
    missingFromBO: [],
    byMonth: { '2026-03': ROWS.length },
  } as any;

  it('unpaid row count under no filters equals breakdown.unpaidCount', () => {
    const breakdown = getExpectedPaymentBreakdown(reconciled, 'All', filteredEde, new Set());
    const out = filterUnpaidRecoveryRows(breakdown.unpaidRows, breakdown.universe, {
      owner: 'all', sourceType: 'all', premiumBucket: 'all', search: '',
    });
    expect(out.length).toBe(breakdown.unpaidCount);
  });

  it('JF filter count equals breakdown.unpaidOwnerSplit.JF (Bundle 8 chip)', () => {
    const breakdown = getExpectedPaymentBreakdown(reconciled, 'All', filteredEde, new Set());
    const jf = filterUnpaidRecoveryRows(breakdown.unpaidRows, breakdown.universe, {
      owner: 'JF', sourceType: 'all', premiumBucket: 'all', search: '',
    });
    expect(jf.length).toBe(breakdown.unpaidOwnerSplit.JF);
  });

  it('zeroNetPremium filter count equals breakdown.unpaidPremiumSplit.zeroNetPremium', () => {
    const breakdown = getExpectedPaymentBreakdown(reconciled, 'All', filteredEde, new Set());
    const z = filterUnpaidRecoveryRows(breakdown.unpaidRows, breakdown.universe, {
      owner: 'all', sourceType: 'all', premiumBucket: 'zeroNetPremium', search: '',
    });
    expect(z.length).toBe(breakdown.unpaidPremiumSplit.zeroNetPremium);
  });
});
