/**
 * C3b-1 — tests for the new headless 14-column commission-submission CSV
 * serializer. The existing 12-column MCE carrier CSV is unchanged and
 * tested elsewhere (those tests are NOT rewritten here).
 */
import { describe, it, expect } from 'vitest';
import Papa from 'papaparse';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  COMMISSION_SUBMISSION_COLUMNS_14,
  formatMissingMonths,
  buildCommissionSubmissionCsv,
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
): SubmissionRow => ({
  vendorFields: vendor(vendorOverrides),
  missingMonths,
  seededComment,
});

const parseRows = (csv: string): string[][] =>
  Papa.parse(csv.trim(), { header: false }).data as string[][];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('C3b-1 — commission-submission 14-col CSV', () => {
  it('(1) 14 headers; cols 13-14 are exactly Missing Month(s) + Operator Comment (append-only)', () => {
    const csv = buildCommissionSubmissionCsv([]);
    const header = parseRows(csv)[0];
    expect(header).toHaveLength(14);
    expect(header[12]).toBe('Missing Month(s)');
    expect(header[13]).toBe('Operator Comment');
  });

  it('(2) first-12 parity via the serializer boundary: BASE labels === buildMesserCsv header === COMMISSION_SUBMISSION first 12', () => {
    const mceHeader = parseRows(buildMesserCsv([]))[0];
    const baseLabels = BASE_MESSER_COLUMNS_12.map((c) => c.label);
    expect(baseLabels).toEqual(mceHeader);

    const submissionHeader = parseRows(buildCommissionSubmissionCsv([]))[0];
    expect(submissionHeader.slice(0, 12)).toEqual(mceHeader);
    expect(COMMISSION_SUBMISSION_COLUMNS_14.slice(0, 12).map((c) => c.label)).toEqual(mceHeader);
  });

  it('(3) no leak: preview/internal fields never appear in header or body even if attached to the source row', () => {
    // Build a row with EXTRA fields beyond SubmissionRow to simulate accidental leakage.
    const dirtyRow: any = {
      ...submissionRow({}, ['2026-01'], 'note'),
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
    // OK status string also must not leak in the body.
    expect(body.some((c) => c === 'OK')).toBe(false);
  });

  it('(4) formatMissingMonths: sort + de-dupe + MMM YYYY join with "; "; empty -> ""', () => {
    expect(formatMissingMonths(['2026-03', '2026-01', '2026-01'])).toBe('Jan 2026; Mar 2026');
    expect(formatMissingMonths([])).toBe('');
    expect(formatMissingMonths(['2025-12', '2026-02'])).toBe('Dec 2025; Feb 2026');
  });

  it('(5) seededComment maps verbatim to the Operator Comment cell', () => {
    const csv = buildCommissionSubmissionCsv([submissionRow({}, ['2026-01'], 'Paid through 2025-12; missing Jan 2026')]);
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

      // 14-col submission
      const subCsv = buildCommissionSubmissionCsv([submissionRow({ writingAgentCarrierId: wac })]);
      const subCell = parseRows(subCsv)[1][wacIdHeaderIdx];

      expect(subCell).toBe(mceCell);
    }
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
});
