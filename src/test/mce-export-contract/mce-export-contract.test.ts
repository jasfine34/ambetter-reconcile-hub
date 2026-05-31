/**
 * MCE Export Contract — Phase B Item 1.
 *
 * Spec: docs/mce-export-contract.md.
 *
 * Assertion-level tests for the five contract invariants:
 *   §7.1 — Vendor CSV column lock (12 R-MCE-002 labels, in order)
 *   §7.2 — Preview retains dollar (INTERNAL_COLUMNS includes
 *          'Est. missing commission'); status is backing field only
 *   §7.3 — Dollar resolves on full evidence → RESOLVED, non-null
 *   §7.4 — Dollar stays UNSUPPORTED when evidence absent (no false positive)
 *   §7.5 — PED uses policy effective date, not broker effective date (AC-3)
 */
import { describe, it, expect } from 'vitest';
import Papa from 'papaparse';
import * as fs from 'fs';
import * as path from 'path';
import {
  buildMesserCsv,
  resolvePolicyEffectiveDate,
} from '@/pages/MissingCommissionExportPage';
import {
  createEstMissingResolver,
  type EstMissingInputEvidence,
} from '@/lib/canonical/estMissingResolver';
import { buildSourceEvidenceMap } from '@/lib/canonical/estMissingEvidenceAdapter';
import type { CarrierCompRateRow } from '@/lib/canonical/compGrid';

const PAGE_SRC = fs.readFileSync(
  path.join(process.cwd(), 'src/pages/MissingCommissionExportPage.tsx'),
  'utf8',
);

// ---------------------------------------------------------------------------
// §7.1 — Vendor CSV column lock
// ---------------------------------------------------------------------------

describe('MCE contract §7.1 — vendor CSV column lock (12 locked R-MCE-002 columns)', () => {
  const EXPECTED_12 = [
    'Carrier Name',
    'NPN',
    'Writing Agent Carrier ID',
    'Writing Agent Name',
    'Policy Effective Date',
    'Policy #',
    'Member First Name',
    'Member Last Name',
    'DOB',
    'SSN',
    'Member ID',
    'Address (Street, City, State, Zip)',
  ];

  it('buildMesserCsv header equals the 12 locked labels in order', () => {
    const csv = buildMesserCsv([]);
    const parsed = Papa.parse(csv.trim(), { header: false });
    expect((parsed.data as string[][])[0]).toEqual(EXPECTED_12);
  });

  it('vendor CSV header does NOT contain "Estimated Missing Commission"', () => {
    const csv = buildMesserCsv([]);
    expect(csv).not.toContain('Estimated Missing Commission');
  });

  it('vendor CSV header does NOT contain "Est_Missing_Status"', () => {
    const csv = buildMesserCsv([]);
    expect(csv).not.toContain('Est_Missing_Status');
  });

  it('MESSER_COLUMNS source block does NOT mention estimatedMissingCommission or estMissingStatus', () => {
    const messerBlock = PAGE_SRC.match(/const MESSER_COLUMNS[\s\S]*?\];/)?.[0] ?? '';
    expect(messerBlock).not.toMatch(/estimatedMissingCommission/);
    expect(messerBlock).not.toMatch(/estMissingStatus/);
    expect(messerBlock).not.toMatch(/Estimated Missing Commission/);
    expect(messerBlock).not.toMatch(/Est_Missing_Status/);
  });
});

// ---------------------------------------------------------------------------
// §7.2 — Preview retains the dollar; status is backing-field-only
// ---------------------------------------------------------------------------

describe('MCE contract §7.2 — preview retains Est. missing commission dollar', () => {
  it('INTERNAL_COLUMNS includes _estimatedMissingCommission with label "Est. missing commission"', () => {
    const internalBlock = PAGE_SRC.match(/const INTERNAL_COLUMNS[\s\S]*?\];/)?.[0] ?? '';
    expect(internalBlock).toMatch(
      /_estimatedMissingCommission[\s\S]*Est\. missing commission/,
    );
  });

  it('INTERNAL_COLUMNS does NOT include _estMissingStatus as a standalone preview column', () => {
    const internalBlock = PAGE_SRC.match(/const INTERNAL_COLUMNS[\s\S]*?\];/)?.[0] ?? '';
    expect(internalBlock).not.toMatch(/_estMissingStatus/);
  });
});

// ---------------------------------------------------------------------------
// §7.3 / §7.4 — Resolver behavior driven by adapter-built evidence
// ---------------------------------------------------------------------------

const AMBETTER_FL_RATE_2026: CarrierCompRateRow = {
  id: 'rate-fl-2026',
  rate_key: 'ambetter|FL|standard|2026',
  carrier_key: 'ambetter',
  carrier_display: 'Ambetter',
  state_code: 'FL',
  plan_variant: 'standard',
  comp_basis: 'pmpm',
  calculation_basis: 'per_member_pmpm',
  rate_value: 25,
  rate_unit: 'USD',
  member_min: null,
  member_max: null,
  member_cap: null,
  effective_year: 2026,
  support_status: 'supported',
  unsupported_reason: null,
};

describe('MCE contract §7.3 — full-evidence dollar resolves to RESOLVED', () => {
  it('synthetic missing member with state + member_count + months + policy_year → RESOLVED, non-null amount', () => {
    // Synthetic reconciled-style row enriched with the resolved state +
    // member_count the contract requires (AC-2 wires these in from the
    // normalized BO/EDE evidence via the resolver-record adapters).
    const syntheticRow = {
      member_key: 'mk-full-evidence',
      carrier: 'Ambetter',
      state: 'FL',
      member_count: 2,
      target_service_month: '2026-03',
      plan_variant: 'standard',
      current_policy_aor: 'Jason Fine (21055210)',
      actual_pay_entity: 'Coverall',
      policy_identity_key: 'pik-1',
    };
    const evidenceMap = buildSourceEvidenceMap([syntheticRow]);
    const ev = evidenceMap.get('mk-full-evidence') as EstMissingInputEvidence;
    expect(ev.state).toBe('FL');
    expect(ev.member_count).toBe(2);
    expect(ev.policy_year).toBe(2026);

    const resolver = createEstMissingResolver({
      rateRows: [AMBETTER_FL_RATE_2026],
      batchMonth: '2026-03',
      scope: 'Coverall',
      sourceEvidenceByMemberKey: evidenceMap,
    });
    const res = resolver.resolve({ row: { member_key: 'mk-full-evidence' } });
    expect(res.status).toBe('RESOLVED');
    expect(res.amount).not.toBeNull();
    expect(res.amount).toBeGreaterThan(0);
  });
});

describe('MCE contract §7.4 — no-evidence row stays UNSUPPORTED (no false positive)', () => {
  it('row with no state and no member_count → UNSUPPORTED, blank amount', () => {
    const syntheticRow = {
      member_key: 'mk-no-evidence',
      carrier: 'Ambetter',
      state: null,
      member_count: null,
      target_service_month: '2026-03',
      current_policy_aor: 'Jason Fine (21055210)',
      actual_pay_entity: 'Coverall',
    };
    const evidenceMap = buildSourceEvidenceMap([syntheticRow]);
    const resolver = createEstMissingResolver({
      rateRows: [AMBETTER_FL_RATE_2026],
      batchMonth: '2026-03',
      scope: 'Coverall',
      sourceEvidenceByMemberKey: evidenceMap,
    });
    const res = resolver.resolve({ row: { member_key: 'mk-no-evidence' } });
    expect(res.status).toBe('UNSUPPORTED');
    expect(res.amount).toBeNull();
    // Legitimate failure mode — first missing input wins.
    expect(['MISSING_STATE', 'MISSING_MEMBER_COUNT']).toContain(
      res.unsupported_reason,
    );
  });
});

// ---------------------------------------------------------------------------
// §7.5 — Policy Effective Date uses policy date, not broker date
// ---------------------------------------------------------------------------

describe('MCE contract §7.5 / AC-3 — Policy Effective Date precedence', () => {
  it('BO-only row: typed effective_date wins over broker_effective_date AND raw Policy Effective Date', () => {
    const records = [
      {
        source_type: 'BACK_OFFICE',
        effective_date: '2026-01-01',
        broker_effective_date: '2026-02-15',
        raw_json: { 'Policy Effective Date': '1/1/2026' },
      },
    ];
    const eff = resolvePolicyEffectiveDate({ records, reconciledEffectiveDate: null });
    expect(eff).toBe('2026-01-01');
    expect(eff).not.toBe('2026-02-15');
  });

  it('EDE row still wins when both EDE and BO present', () => {
    const records = [
      {
        source_type: 'EDE',
        effective_date: '2026-03-01',
        raw_json: { effectiveDate: '2026-03-01' },
      },
      {
        source_type: 'BACK_OFFICE',
        effective_date: '2026-01-01',
        broker_effective_date: '2026-02-15',
      },
    ];
    const eff = resolvePolicyEffectiveDate({ records, reconciledEffectiveDate: null });
    expect(eff).toBe('2026-03-01');
  });

  it('BO broker_effective_date is last-ditch ONLY (never ahead of typed BO effective_date)', () => {
    const records = [
      {
        source_type: 'BACK_OFFICE',
        effective_date: null,
        broker_effective_date: '2026-02-15',
      },
    ];
    const eff = resolvePolicyEffectiveDate({ records, reconciledEffectiveDate: null });
    expect(eff).toBe('2026-02-15');
  });
});
