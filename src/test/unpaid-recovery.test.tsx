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
  buildFfmIdResolver,
  UNPAID_RECOVERY_COLUMNS,
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

// ---------------------------------------------------------------------------
// Bundle 12.5 — column cleanup + FFM ID re-source
// ---------------------------------------------------------------------------
describe('Bundle 12.5 — column order + Current Policy AOR removal', () => {
  const EXPECTED_VISIBLE_LABELS = [
    'FFM ID',
    'Member Name',
    'Policy #',
    'Exchange Sub ID',
    'Owner',
    'Source Type',
    'Premium Bucket',
    'Net Premium',
    'Est. Missing Commission',
    'Clearing',
    'Effective Date',
    'Policy Status',
    'Issue / Missing Reason',
  ];

  // CSV intentionally excludes the UI-only `_clearingStatus` column.
  const EXPECTED_CSV_LABELS = EXPECTED_VISIBLE_LABELS.filter((l) => l !== 'Clearing');

  it('UNPAID_RECOVERY_COLUMNS labels match the spec order exactly', () => {
    expect(UNPAID_RECOVERY_COLUMNS.map((c) => c.label)).toEqual(EXPECTED_VISIBLE_LABELS);
  });

  it('Current Policy AOR column is removed', () => {
    expect(UNPAID_RECOVERY_COLUMNS.find((c) => c.key === 'current_policy_aor')).toBeUndefined();
    expect(UNPAID_RECOVERY_COLUMNS.find((c) => c.label === 'Current Policy AOR')).toBeUndefined();
  });

  it('FFM ID column key is ffm_id (not issuer_subscriber_id)', () => {
    expect(UNPAID_RECOVERY_COLUMNS[0]).toEqual({ key: 'ffm_id', label: 'FFM ID' });
    expect(UNPAID_RECOVERY_COLUMNS.find((c) => c.key === 'issuer_subscriber_id')).toBeUndefined();
  });

  it('CSV header excludes UI-only Clearing column but keeps every other label', () => {
    const csv = buildUnpaidRecoveryCsv([], { boOnly: [], edeOnly: [] });
    const parsed = Papa.parse(csv.trim(), { header: false });
    expect((parsed.data as string[][])[0]).toEqual(EXPECTED_CSV_LABELS);
    expect(csv).not.toContain('Current Policy AOR');
    expect(csv).not.toContain('Clearing');
  });
});

describe('Bundle 13c — partial_amount_unavailable badge regression', () => {
  const page = readFileSync(resolve(__dirname, '..', 'pages/UnpaidRecoveryPage.tsx'), 'utf8');
  const overlay = readFileSync(
    resolve(__dirname, '..', 'lib/canonical/crossBatchOverlay.ts'),
    'utf8',
  );

  it('classifyOverlay yields partial_amount_unavailable for partially_cleared with no remainder', () => {
    // Guard the source-of-truth in crossBatchOverlay.ts:151-156 so this test
    // catches any future drift in the classifier branch the badge depends on.
    expect(overlay).toMatch(/case 'partially_cleared':[\s\S]*partial_amount_unavailable/);
  });

  it('Needs review badge fires for both mark_needs_review AND partial_amount_unavailable', () => {
    // The inline JSX uses a single `needsReview` predicate; both adjustment
    // kinds must light it up so partially-cleared rows missing a remainder
    // still surface the amber chip.
    expect(page).toMatch(/needsReview\s*=[\s\S]*'mark_needs_review'[\s\S]*'partial_amount_unavailable'/);
    expect(page).toMatch(/data-testid="ur-needs-review-badge"/);
  });
});


describe('Bundle 12.5 — buildFfmIdResolver (FFM ID re-source)', () => {
  it('resolves FFM ID from matched EDE record raw_json.ffmAppId — never falls back to policy/subscriber IDs', () => {
    const row = makeRow({
      member_key: 'mk-1',
      issuer_subscriber_id: 'POLICY-XYZ',
      policy_number: 'POLICY-XYZ',
      exchange_subscriber_id: 'POLICY-XYZ',
    });
    const recs = [
      { source_type: 'EDE', member_key: 'mk-1', raw_json: { ffmAppId: 'FFM-789' } },
    ];
    const get = buildFfmIdResolver(recs);
    expect(get(row)).toBe('FFM-789');
    expect(get(row)).not.toContain('POLICY-XYZ');
  });

  it('returns empty when no matched EDE record carries an ffmAppId (BO-only row)', () => {
    const row = makeRow({
      member_key: 'mk-bo',
      issuer_subscriber_id: 'IS-555',
      policy_number: 'POL-555',
      exchange_subscriber_id: 'ES-555',
    });
    // Only a BO normalized record — no EDE record at all.
    const recs = [
      { source_type: 'BACK_OFFICE', member_key: 'mk-bo', raw_json: { ffmAppId: 'WRONG' } },
    ];
    const get = buildFfmIdResolver(recs);
    expect(get(row)).toBe('');
  });

  it('returns empty when matched EDE record has no ffmAppId (no fallback to policy_number/issuer/exchange ids)', () => {
    const row = makeRow({
      member_key: 'mk-2',
      issuer_subscriber_id: 'IS-222',
      policy_number: 'POL-222',
      exchange_subscriber_id: 'ES-222',
    });
    const recs = [
      { source_type: 'EDE', member_key: 'mk-2', raw_json: { /* no ffmAppId */ } },
    ];
    const get = buildFfmIdResolver(recs);
    const v = get(row);
    expect(v).toBe('');
    expect(v).not.toContain('IS-222');
    expect(v).not.toContain('POL-222');
    expect(v).not.toContain('ES-222');
  });

  it('joins distinct multi-FFM-ID values with ", " preserving normalizedRecords order', () => {
    const row = makeRow({ member_key: 'mk-3' });
    const recs = [
      { source_type: 'EDE', member_key: 'mk-3', raw_json: { ffmAppId: 'FFM-AAA' } },
      { source_type: 'EDE', member_key: 'mk-3', raw_json: { ffmAppId: 'FFM-BBB' } },
      { source_type: 'EDE', member_key: 'mk-3', raw_json: { ffmAppId: 'FFM-AAA' } }, // dedupe
    ];
    const get = buildFfmIdResolver(recs);
    expect(get(row)).toBe('FFM-AAA, FFM-BBB');
  });

  it('CSV row uses resolved FFM ID display value (not issuer_subscriber_id)', () => {
    const row = makeRow({
      member_key: 'mk-csv',
      issuer_subscriber_id: 'POLICY-XYZ',
      policy_number: 'POLICY-XYZ',
    });
    const recs = [
      { source_type: 'EDE', member_key: 'mk-csv', raw_json: { ffmAppId: 'FFM-CSV-1' } },
    ];
    const get = buildFfmIdResolver(recs);
    const csv = buildUnpaidRecoveryCsv([row], { boOnly: [], edeOnly: [] }, get);
    const parsed = Papa.parse(csv.trim(), { header: true });
    const r0 = (parsed.data as Array<Record<string, string>>)[0];
    expect(r0['FFM ID']).toBe('FFM-CSV-1');
    expect(r0['FFM ID']).not.toBe('POLICY-XYZ');
  });
});

