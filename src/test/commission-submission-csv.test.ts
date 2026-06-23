/**
 * C3b-1 — tests for the headless 15-column commission-submission CSV
 * serializer. The existing 12-column MCE carrier CSV is unchanged and
 * tested elsewhere (those tests are NOT rewritten here).
 */
import { describe, it, expect } from 'vitest';
import Papa from 'papaparse';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  COMMISSION_SUBMISSION_COLUMNS,
  formatMissingMonths,
  buildCommissionSubmissionCsv,
  toCommissionSubmissionCsvRow,
  type SubmissionRow,
} from '@/lib/canonical/commissionSubmissionCsv';
import { BASE_MESSER_COLUMNS_12 } from '@/lib/mce/messerColumns';
import { buildMesserCsv } from '@/pages/MissingCommissionExportPage';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const vendor = (overrides: Partial<SubmissionRow['vendorFields']> = {}): SubmissionRow['vendorFields'] => ({
  carrierName: 'Ambetter',
  npn: '12345',
  writingAgentCarrierId: 'CHG9852',
  writingAgentName: 'Agent Smith',
  policyEffectiveDate: '2026-01-01',
  policyNumber: 'POL-1',
  memberFirstName: 'Jane',
  memberLastName: 'Doe',
  dob: '1990-01-01',
  ssn: '',
  memberId: 'MID-1',
  address: '1 Main St, Austin, TX, 78701',
  ...overrides,
});

const submissionRow = (
  vendorOverrides: Partial<SubmissionRow['vendorFields']> = {},
  missingMonths: string[] = [],
  seededComment = '',
  payEntity: string = 'Coverall',
): SubmissionRow => ({
  vendorFields: vendor(vendorOverrides),
  missingMonths,
  seededComment,
  payEntity,
});

const parseRows = (csv: string): string[][] =>
  Papa.parse(csv.trim(), { header: false }).data as string[][];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('C3b-1 — commission-submission 15-col CSV', () => {
  it('(1) 15 headers; cols 13-15 are exactly Missing Month(s) + Operator Comment + Pay Entity (append-only)', () => {
    const csv = buildCommissionSubmissionCsv([]);
    const header = parseRows(csv)[0];
    expect(header).toHaveLength(15);
    expect(header[12]).toBe('Missing Month(s)');
    expect(header[13]).toBe('Operator Comment');
    expect(header[14]).toBe('Pay Entity');
  });

  it('(2) first-12 parity via the serializer boundary: BASE labels === buildMesserCsv header === COMMISSION_SUBMISSION first 12', () => {
    const mceHeader = parseRows(buildMesserCsv([]))[0];
    const baseLabels = BASE_MESSER_COLUMNS_12.map((c) => c.label);
    expect(baseLabels).toEqual(mceHeader);

    const submissionHeader = parseRows(buildCommissionSubmissionCsv([]))[0];
    expect(submissionHeader.slice(0, 12)).toEqual(mceHeader);
    expect(COMMISSION_SUBMISSION_COLUMNS.slice(0, 12).map((c) => c.label)).toEqual(mceHeader);
  });

  it('(3) no leak: preview/internal/grain fields never appear in header or body even if attached to the source row (only allowed scope passes through)', () => {
    // Build a row with EXTRA fields beyond SubmissionRow to simulate accidental leakage.
    const dirtyRow: any = {
      ...submissionRow({}, ['2026-01'], 'note', 'Coverall'),
      estimatedMissingCommission: 987654321,
      estMissingStatus: 'LEAK_STATUS_SENTINEL',
      previewEstimatedTotal: 123456789,
      previewEstimatedStatus: 'LEAK_PREV_SENTINEL',
      grainKey: 'LEAK_GRAIN_SENTINEL',
      rowMonthAnchors: ['LEAK_ANCHOR_SENTINEL'],
      _sourceType: 'LEAK_SRC_SENTINEL',
      _clearingStatus: 'LEAK_CLEAR_SENTINEL',
      _memberKey: 'LEAK_MK_SENTINEL',
    };
    const csv = buildCommissionSubmissionCsv([dirtyRow]);
    const [header, body] = parseRows(csv);

    for (const leaked of [
      '987654321', '123456789',
      'LEAK_STATUS_SENTINEL', 'LEAK_PREV_SENTINEL', 'LEAK_GRAIN_SENTINEL',
      'LEAK_ANCHOR_SENTINEL', 'LEAK_SRC_SENTINEL', 'LEAK_CLEAR_SENTINEL', 'LEAK_MK_SENTINEL',
      'estimatedMissingCommission', 'estMissingStatus',
      'previewEstimatedTotal', 'previewEstimatedStatus',
      'grainKey', 'rowMonthAnchors',
      'Source Type', 'Clearing',
      '_sourceType', '_clearingStatus', '_memberKey',
    ]) {
      expect(header).not.toContain(leaked);
      expect(body).not.toContain(leaked);
    }
  });

  it('(4) formatMissingMonths: sort + de-dupe + MMM YYYY join with "; "; empty -> ""', () => {
    expect(formatMissingMonths(['2026-03', '2026-01', '2026-01'])).toBe('Jan 2026; Mar 2026');
    expect(formatMissingMonths([])).toBe('');
    expect(formatMissingMonths(['2025-12', '2026-02'])).toBe('Dec 2025; Feb 2026');
  });

  it('(5) seededComment maps verbatim to the Operator Comment cell', () => {
    const csv = buildCommissionSubmissionCsv([
      submissionRow({}, ['2026-01'], 'Paid through 2025-12; missing Jan 2026', 'Coverall'),
    ]);
    const [, body] = parseRows(csv);
    expect(body[13]).toBe('Paid through 2025-12; missing Jan 2026');
  });

  it('(6) WAC-ID apostrophe-strip parity vs. buildMesserCsv (parsed cell, not raw string)', () => {
    const wacIdHeaderIdx = 2; // 'Writing Agent Carrier ID'
    for (const wac of ["CHG9852", "'CHG9852", "'CHG'9852"]) {
      // 12-col MCE
      const mceCsv = buildMesserCsv([{
        carrierName: 'Ambetter', npn: '12345', writingAgentCarrierId: wac,
        writingAgentName: '', policyEffectiveDate: '', policyNumber: '',
        memberFirstName: '', memberLastName: '', dob: '', ssn: '', memberId: '', address: '',
      } as any]);
      const mceCell = parseRows(mceCsv)[1][wacIdHeaderIdx];

      // 15-col submission
      const subCsv = buildCommissionSubmissionCsv([submissionRow({ writingAgentCarrierId: wac })]);
      const subCell = parseRows(subCsv)[1][wacIdHeaderIdx];

      expect(subCell).toBe(mceCell);
    }
  });

  it('(7) Pay Entity written on every row from row.payEntity (Coverall and Vix)', () => {
    const csv = buildCommissionSubmissionCsv([
      submissionRow({ policyNumber: 'POL-A' }, ['2026-01'], '', 'Coverall'),
      submissionRow({ policyNumber: 'POL-B' }, ['2026-02'], '', 'Vix'),
    ]);
    const rows = parseRows(csv);
    expect(rows[1][14]).toBe('Coverall');
    expect(rows[2][14]).toBe('Vix');
  });

  it('(7b) dual-scope synthetic pair: identical 12 vendor cells, disambiguated ONLY by Pay Entity', () => {
    const v = { policyNumber: 'POL-DUAL', memberId: 'MID-DUAL' };
    const csv = buildCommissionSubmissionCsv([
      submissionRow(v, ['2026-01'], 'note', 'Coverall'),
      submissionRow(v, ['2026-01'], 'note', 'Vix'),
    ]);
    const rows = parseRows(csv);
    // Cols 0..13 identical between the two rows; only col 14 differs.
    for (let c = 0; c < 14; c++) {
      expect(rows[1][c]).toBe(rows[2][c]);
    }
    expect(rows[1][14]).toBe('Coverall');
    expect(rows[2][14]).toBe('Vix');
  });

  it('(8) dependency direction: the two new lib modules import no page/React/Supabase/loader', () => {
    const files = [
      'src/lib/mce/messerColumns.ts',
      'src/lib/canonical/commissionSubmissionCsv.ts',
    ];
    for (const f of files) {
      const src = readFileSync(resolve(process.cwd(), f), 'utf8');
      expect(src).not.toMatch(/from\s+['"]@\/pages\//);
      expect(src).not.toMatch(/from\s+['"]react['"]/);
      expect(src).not.toMatch(/from\s+['"]@supabase/);
      expect(src).not.toMatch(/from\s+['"]@\/integrations\/supabase/);
      expect(src).not.toMatch(/from\s+['"]@\/hooks\//);
      expect(src).not.toMatch(/from\s+['"][^'"]*[Ll]oader[^'"]*['"]/);
    }
  });

  it('(9) toCommissionSubmissionCsvRow: maps a C3a top-level vendor-field row into the serializer-nested shape; preview-only fields dropped; ONLY grainKey.targetScope -> payEntity passes through', () => {
    const c3aRow: any = {
      carrierName: 'Ambetter',
      npn: '12345',
      writingAgentCarrierId: "'CHG9852",
      writingAgentName: 'Agent Smith',
      policyEffectiveDate: '2026-01-01',
      policyNumber: 'POL-Q',
      memberFirstName: 'Jane',
      memberLastName: 'Doe',
      dob: '1990-01-01',
      ssn: '',
      memberId: 'MID-7',
      address: '1 Main St, Austin, TX, 78701',
      // preview-only / internal — must be dropped:
      estimatedMissingCommission: 42.5,
      estMissingStatus: 'OK',
      previewEstimatedTotal: 42.5,
      previewEstimatedStatus: 'OK',
      grainKey: {
        carrier: 'LEAK_CARRIER_SENTINEL',
        targetScope: 'Vix',
        stableMemberKey: 'LEAK_SMK_SENTINEL',
        policy_identity_key: 'LEAK_PIK_SENTINEL',
      },
      rowMonthAnchors: [],
      missingMonths: ['2026-02', '2026-01'],
      seededComment: 'Verbatim comment',
    };
    const adapted = toCommissionSubmissionCsvRow(c3aRow);
    // Vendor fields land NESTED under vendorFields (the serializer's shape).
    expect(adapted.vendorFields.carrierName).toBe('Ambetter');
    expect(adapted.vendorFields.memberId).toBe('MID-7');
    expect(adapted.missingMonths).toEqual(['2026-02', '2026-01']);
    expect(adapted.seededComment).toBe('Verbatim comment');
    expect(adapted.payEntity).toBe('Vix');
    // Preview-only keys are NOT carried through.
    expect((adapted as any).estimatedMissingCommission).toBeUndefined();
    expect((adapted as any).previewEstimatedTotal).toBeUndefined();
    expect((adapted as any).grainKey).toBeUndefined();

    // End-to-end: feeding the adapter output through the serializer produces
    // populated vendor cells + the appended cells (proving the adapter bridge).
    const csv = buildCommissionSubmissionCsv([adapted]);
    const [, body] = parseRows(csv);
    expect(body[0]).toBe('Ambetter');
    expect(body[2]).toBe('CHG9852'); // apostrophe stripped
    expect(body[10]).toBe('MID-7');
    expect(body[12]).toBe('Jan 2026; Feb 2026');
    expect(body[13]).toBe('Verbatim comment');
    expect(body[14]).toBe('Vix');
    // No preview leakage and no other grainKey fields leaked.
    expect(csv).not.toMatch(/42\.5/);
    expect(csv).not.toMatch(/LEAK_CARRIER_SENTINEL/);
    expect(csv).not.toMatch(/LEAK_SMK_SENTINEL/);
    expect(csv).not.toMatch(/LEAK_PIK_SENTINEL/);
  });

  it('(10) MESSER_COLUMNS-derive: the page-local literal is derived verbatim from BASE_MESSER_COLUMNS_12 (same keys + labels + order)', async () => {
    // Source-level check — page literal is the derive expression.
    const src = readFileSync(
      resolve(process.cwd(), 'src/pages/MissingCommissionExportPage.tsx'),
      'utf8',
    );
    expect(src).toMatch(/const\s+MESSER_COLUMNS[^=]*=\s*BASE_MESSER_COLUMNS_12\.map/);
    // Behavioural check — header byte-identical to BASE labels.
    const header = parseRows(buildMesserCsv([]))[0];
    expect(header).toEqual(BASE_MESSER_COLUMNS_12.map((c) => c.label));
  });
});
