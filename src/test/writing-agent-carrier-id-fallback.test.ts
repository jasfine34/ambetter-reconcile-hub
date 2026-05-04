/**
 * #109 — Writing Agent Carrier ID fallback ladder tests.
 *
 * Pure helper tests (no React render). Cover:
 *   1. Direct commission row wins over historical lookup
 *   2. Historical fallback fills blank when no current commission row exists
 *   3. Pay-entity differentiation (same NPN, different pay_entity → different ID)
 *   4. Conflict tie-break: most-recent batch month wins; warning info surfaces
 *   5. No history available → blank, not error
 *   6. Cache invalidation: rebuilding the lookup with expanded inputs reflects
 *      the new mapping (no hidden state)
 */
import { describe, it, expect, vi } from 'vitest';
import {
  buildWritingAgentCarrierIdLookup,
  resolveWritingAgentCarrierId,
} from '@/pages/MissingCommissionExportPage';

const monthMap = new Map([
  ['b-jan', '2026-01'],
  ['b-feb', '2026-02'],
  ['b-mar', '2026-03'],
]);

function comm(overrides: any) {
  return {
    id: Math.random().toString(36).slice(2),
    source_type: 'COMMISSION',
    carrier: 'Ambetter',
    pay_entity: 'Coverall',
    agent_npn: '21055210',
    writing_agent_carrier_id: 'CHG9852',
    batch_id: 'b-feb',
    created_at: '2026-02-15T00:00:00Z',
    ...overrides,
  };
}

describe('#109 writing_agent_carrier_id fallback', () => {
  it('1. direct commission row wins over historical lookup', () => {
    const lookup = buildWritingAgentCarrierIdLookup({
      records: [comm({ batch_id: 'b-jan', writing_agent_carrier_id: 'HISTORICAL-VAL' })],
      batchMonthByBatchId: monthMap,
    });
    const memberRecords = [comm({ writing_agent_carrier_id: 'CHG9852' })];
    const out = resolveWritingAgentCarrierId({
      records: memberRecords,
      carrier: 'Ambetter',
      payEntity: 'Coverall',
      agentNpn: '21055210',
      lookup,
    });
    expect(out).toBe('CHG9852');
  });

  it('2. historical fallback fills blank when no current commission row exists', () => {
    const lookup = buildWritingAgentCarrierIdLookup({
      records: [comm({ batch_id: 'b-jan', writing_agent_carrier_id: 'CHG9852' })],
      batchMonthByBatchId: monthMap,
    });
    // Member has only EDE/BO records — no commission row.
    const memberRecords = [
      { source_type: 'EDE', writing_agent_carrier_id: '' },
      { source_type: 'BACK_OFFICE', writing_agent_carrier_id: '' },
    ];
    const out = resolveWritingAgentCarrierId({
      records: memberRecords,
      carrier: 'Ambetter',
      payEntity: 'Coverall',
      agentNpn: '21055210',
      lookup,
    });
    expect(out).toBe('CHG9852');
  });

  it('3. pay-entity differentiation: same NPN, Coverall=CHG9852, Vix=VIX9696', () => {
    const lookup = buildWritingAgentCarrierIdLookup({
      records: [
        comm({ pay_entity: 'Coverall', writing_agent_carrier_id: 'CHG9852', agent_npn: '21277051' }),
        comm({ pay_entity: 'Vix', writing_agent_carrier_id: 'VIX9696', agent_npn: '21277051' }),
      ],
      batchMonthByBatchId: monthMap,
    });
    expect(resolveWritingAgentCarrierId({
      records: [], carrier: 'Ambetter', payEntity: 'Coverall', agentNpn: '21277051', lookup,
    })).toBe('CHG9852');
    expect(resolveWritingAgentCarrierId({
      records: [], carrier: 'Ambetter', payEntity: 'Vix', agentNpn: '21277051', lookup,
    })).toBe('VIX9696');
  });

  it('4. conflict tie-break: most-recent month wins; losers tracked in conflicts', () => {
    const lookup = buildWritingAgentCarrierIdLookup({
      records: [
        comm({ batch_id: 'b-jan', writing_agent_carrier_id: 'OLD-ID' }),
        comm({ batch_id: 'b-mar', writing_agent_carrier_id: 'NEW-ID' }),
        comm({ batch_id: 'b-feb', writing_agent_carrier_id: 'MID-ID' }),
      ],
      batchMonthByBatchId: monthMap,
    });
    const entry = Array.from(lookup.values())[0];
    expect(entry.id).toBe('NEW-ID');
    expect(entry.conflicts.sort()).toEqual(['MID-ID', 'OLD-ID']);
  });

  it('5. no history available → blank, not error', () => {
    const lookup = buildWritingAgentCarrierIdLookup({ records: [], batchMonthByBatchId: monthMap });
    const out = resolveWritingAgentCarrierId({
      records: [],
      carrier: 'Ambetter',
      payEntity: 'Coverall',
      agentNpn: '99999999',
      lookup,
    });
    expect(out).toBe('');
  });

  it('5b. blank NPN → blank (don\'t guess)', () => {
    const lookup = buildWritingAgentCarrierIdLookup({
      records: [comm({ writing_agent_carrier_id: 'CHG9852' })],
      batchMonthByBatchId: monthMap,
    });
    const out = resolveWritingAgentCarrierId({
      records: [], carrier: 'Ambetter', payEntity: 'Coverall', agentNpn: '', lookup,
    });
    expect(out).toBe('');
  });

  it('6. cache invalidation: rebuilding with expanded inputs reflects new mapping', () => {
    // Initial: empty
    let lookup = buildWritingAgentCarrierIdLookup({ records: [], batchMonthByBatchId: monthMap });
    expect(resolveWritingAgentCarrierId({
      records: [], carrier: 'Ambetter', payEntity: 'Coverall', agentNpn: '21055210', lookup,
    })).toBe('');
    // Simulate Re-run Reconciliation adding new commission rows
    lookup = buildWritingAgentCarrierIdLookup({
      records: [comm({ writing_agent_carrier_id: 'CHG9852' })],
      batchMonthByBatchId: monthMap,
    });
    expect(resolveWritingAgentCarrierId({
      records: [], carrier: 'Ambetter', payEntity: 'Coverall', agentNpn: '21055210', lookup,
    })).toBe('CHG9852');
  });

  it('7. rows with blank writing_agent_carrier_id or blank NPN are skipped at build', () => {
    const lookup = buildWritingAgentCarrierIdLookup({
      records: [
        comm({ writing_agent_carrier_id: '' }), // skip
        comm({ agent_npn: '' }), // skip
        comm({ writing_agent_carrier_id: 'CHG9852' }), // keep
      ],
      batchMonthByBatchId: monthMap,
    });
    expect(lookup.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// #109 finishing touch — strip leading Excel text-format apostrophe at the
// CSV-render boundary (Writing Agent Carrier ID column only). Source data,
// derived lookup, and in-memory preview must stay untouched.
// ---------------------------------------------------------------------------

describe('#109 stripExcelTextMarker — CSV export boundary', () => {
  const importExport = async () => await import('@/pages/MissingCommissionExportPage');

  function exportRow(overrides: Partial<any> = {}): any {
    return {
      carrierName: 'Ambetter',
      npn: '21055210',
      writingAgentCarrierId: '',
      writingAgentName: 'Jason Fine',
      policyEffectiveDate: '2026-01-01',
      policyNumber: 'P1',
      memberFirstName: 'Jane',
      memberLastName: 'Doe',
      dob: '1980-01-01',
      ssn: '',
      memberId: 'M1',
      address: '1 Main St, Macon, GA 31201',
      _memberKey: 'm1',
      _ffmId: { value: null, source_type: null, source_month: null, source_file_label: null, conflict: false, conflict_values: [] },
      _exchangeSubscriberId: '',
      _issuerSubscriberId: '',
      _aor: '',
      _netPremiumBucket: 'zero_premium',
      _missingReason: 'Missing from Commission',
      _estimatedMissingCommission: 18,
      _profile: {} as any,
      _hasConflict: false,
      ...overrides,
    };
  }

  it('1. apostrophe stripped on export — value "\'CHG9852" → "CHG9852"', async () => {
    const Papa = (await import('papaparse')).default;
    const { buildMesserCsv } = await importExport();
    const csv = buildMesserCsv([exportRow({ writingAgentCarrierId: "'CHG9852" })]);
    const parsed = Papa.parse(csv, { header: true });
    expect((parsed.data as any[])[0]['Writing Agent Carrier ID']).toBe('CHG9852');
  });

  it('2. no apostrophe = no change — "CHG9852" stays "CHG9852"', async () => {
    const Papa = (await import('papaparse')).default;
    const { buildMesserCsv } = await importExport();
    const csv = buildMesserCsv([exportRow({ writingAgentCarrierId: 'CHG9852' })]);
    const parsed = Papa.parse(csv, { header: true });
    expect((parsed.data as any[])[0]['Writing Agent Carrier ID']).toBe('CHG9852');
  });

  it('3. empty value stays empty (no exception)', async () => {
    const Papa = (await import('papaparse')).default;
    const { buildMesserCsv } = await importExport();
    const csv = buildMesserCsv([
      exportRow({ writingAgentCarrierId: '' }),
      exportRow({ writingAgentCarrierId: null as any }),
    ]);
    const parsed = Papa.parse(csv, { header: true });
    expect((parsed.data as any[])[0]['Writing Agent Carrier ID']).toBe('');
    expect((parsed.data as any[])[1]['Writing Agent Carrier ID']).toBe('');
  });

  it('4. only LEADING apostrophe stripped — "\'CHG\'9852" → "CHG\'9852"', async () => {
    const Papa = (await import('papaparse')).default;
    const { buildMesserCsv } = await importExport();
    const csv = buildMesserCsv([exportRow({ writingAgentCarrierId: "'CHG'9852" })]);
    const parsed = Papa.parse(csv, { header: true });
    expect((parsed.data as any[])[0]['Writing Agent Carrier ID']).toBe("CHG'9852");
  });

  it('5. source values unchanged after export render', async () => {
    const { buildMesserCsv } = await importExport();
    const sourceRow = { writing_agent_carrier_id: "'CHG9852", agent_npn: '21055210' };
    const before = sourceRow.writing_agent_carrier_id;
    buildMesserCsv([exportRow({ writingAgentCarrierId: sourceRow.writing_agent_carrier_id })]);
    expect(sourceRow.writing_agent_carrier_id).toBe(before);
    expect(sourceRow.writing_agent_carrier_id).toBe("'CHG9852");
  });

  it('6. strip applies ONLY to Writing Agent Carrier ID column (sibling columns untouched)', async () => {
    const Papa = (await import('papaparse')).default;
    const { buildMesserCsv } = await importExport();
    const csv = buildMesserCsv([exportRow({
      writingAgentCarrierId: "'CHG9852",
      memberId: "'U12345",
      policyNumber: "'P98765",
    })]);
    const parsed = Papa.parse(csv, { header: true });
    const row = (parsed.data as any[])[0];
    expect(row['Writing Agent Carrier ID']).toBe('CHG9852');
    expect(row['Member ID']).toBe("'U12345");
    expect(row['Policy #']).toBe("'P98765");
  });
});

describe('#109 stripExcelTextMarker — unit', () => {
  it('handles null/undefined/empty/single-apostrophe', async () => {
    const { stripExcelTextMarker } = await import('@/pages/MissingCommissionExportPage');
    expect(stripExcelTextMarker(null)).toBe('');
    expect(stripExcelTextMarker(undefined)).toBe('');
    expect(stripExcelTextMarker('')).toBe('');
    expect(stripExcelTextMarker("'")).toBe('');
    expect(stripExcelTextMarker("''X")).toBe("'X"); // only ONE leading apostrophe stripped
  });
});

// ---------------------------------------------------------------------------
// #110 — Tier-1 must be scope+NPN aware, AND Coverall_or_Vix / blank EPE must
// resolve to the active scope (or per-NPN default in All scope).
// Locks in the Anderson-Gregory AOR-transfer pattern fix.
// ---------------------------------------------------------------------------

describe('#110 resolveTargetPayEntity — scope + EPE normalization', () => {
  const importExport = async () => await import('@/pages/MissingCommissionExportPage');

  it('Coverall scope is authoritative — overrides actual_pay_entity=Vix (Deanna pattern)', async () => {
    const { resolveTargetPayEntity } = await importExport();
    expect(resolveTargetPayEntity({
      expectedPayEntity: 'Coverall_or_Vix', actualPayEntity: 'Vix',
      scope: 'Coverall', agentNpn: '21277051',
    })).toBe('Coverall');
  });

  it('Vix scope is authoritative — overrides actual_pay_entity=Coverall', async () => {
    const { resolveTargetPayEntity } = await importExport();
    expect(resolveTargetPayEntity({
      expectedPayEntity: 'Coverall', actualPayEntity: 'Coverall',
      scope: 'Vix', agentNpn: '21055210',
    })).toBe('Vix');
  });

  it('All scope: actual_pay_entity wins when set', async () => {
    const { resolveTargetPayEntity } = await importExport();
    expect(resolveTargetPayEntity({
      expectedPayEntity: 'Coverall_or_Vix', actualPayEntity: 'Vix',
      scope: 'All', agentNpn: '21277051',
    })).toBe('Vix');
  });

  it('All scope: concrete expected_pay_entity wins when actual is blank', async () => {
    const { resolveTargetPayEntity } = await importExport();
    expect(resolveTargetPayEntity({
      expectedPayEntity: 'Coverall', actualPayEntity: '',
      scope: 'All', agentNpn: '21055210',
    })).toBe('Coverall');
  });

  it('Coverall_or_Vix + Coverall scope → Coverall', async () => {
    const { resolveTargetPayEntity } = await importExport();
    expect(resolveTargetPayEntity({
      expectedPayEntity: 'Coverall_or_Vix', actualPayEntity: '',
      scope: 'Coverall', agentNpn: '21277051',
    })).toBe('Coverall');
  });

  it('blank EPE + Vix scope → Vix', async () => {
    const { resolveTargetPayEntity } = await importExport();
    expect(resolveTargetPayEntity({
      expectedPayEntity: '', actualPayEntity: '',
      scope: 'Vix', agentNpn: '21277051',
    })).toBe('Vix');
  });

  it('All scope: Jason Fine NPN → Coverall', async () => {
    const { resolveTargetPayEntity } = await importExport();
    expect(resolveTargetPayEntity({
      expectedPayEntity: '', actualPayEntity: '',
      scope: 'All', agentNpn: '21055210',
    })).toBe('Coverall');
  });

  it('All scope: Becky Shuta NPN → Coverall', async () => {
    const { resolveTargetPayEntity } = await importExport();
    expect(resolveTargetPayEntity({
      expectedPayEntity: '', actualPayEntity: '',
      scope: 'All', agentNpn: '16531877',
    })).toBe('Coverall');
  });

  it('All scope: Erica Fine NPN → ambiguous (blank)', async () => {
    const { resolveTargetPayEntity } = await importExport();
    expect(resolveTargetPayEntity({
      expectedPayEntity: '', actualPayEntity: '',
      scope: 'All', agentNpn: '21277051',
    })).toBe('');
  });

  it('All scope: unknown NPN → blank', async () => {
    const { resolveTargetPayEntity } = await importExport();
    expect(resolveTargetPayEntity({
      expectedPayEntity: '', actualPayEntity: '',
      scope: 'All', agentNpn: '99999999',
    })).toBe('');
  });
});

describe('#110 resolveWritingAgentCarrierId — Tier-1 scope+NPN tightening', () => {
  it('Anderson Gregory shape: Coverall scope, member has only a Vix/Erica historical commission row → Tier-1 rejects, Tier-2 resolves Coverall+Jason ID', () => {
    // Member current AOR = Jason Fine (Coverall, NPN 21055210).
    // Member's only historical commission row is for Vix + Erica's NPN
    // (this is the AOR-transfer leakage we're guarding against).
    const memberRecords = [
      {
        source_type: 'COMMISSION',
        carrier: 'Ambetter',
        pay_entity: 'Vix',
        agent_npn: '21277051',           // Erica
        writing_agent_carrier_id: 'VIX9696',
        batch_id: 'b-mar',
        created_at: '2026-03-15T00:00:00Z',
      },
    ];
    // Lookup is built from the broader population (Coverall+Jason history
    // exists for OTHER members and feeds the (carrier, pe, npn) map).
    const lookup = buildWritingAgentCarrierIdLookup({
      records: [
        ...memberRecords,
        comm({ pay_entity: 'Coverall', agent_npn: '21055210', writing_agent_carrier_id: 'CHG9852' }),
      ],
      batchMonthByBatchId: monthMap,
    });

    const out = resolveWritingAgentCarrierId({
      records: memberRecords,
      carrier: 'Ambetter',
      payEntity: 'Coverall',   // resolved target for Coverall-scope export
      agentNpn: '21055210',    // resolved current AOR NPN (Jason)
      lookup,
    });
    // Tier-1 must reject the Vix/Erica row (scope mismatch + NPN mismatch);
    // Tier-2 hits the (ambetter|coverall|21055210) bucket → CHG9852.
    expect(out).toBe('CHG9852');
  });

  it('Tier-1 accepts when commission row matches BOTH pay_entity AND agent_npn', () => {
    const memberRecords = [
      {
        source_type: 'COMMISSION',
        carrier: 'Ambetter',
        pay_entity: 'Coverall',
        agent_npn: '21055210',
        writing_agent_carrier_id: 'DIRECT-WIN',
        batch_id: 'b-feb',
        created_at: '2026-02-01T00:00:00Z',
      },
    ];
    const lookup = buildWritingAgentCarrierIdLookup({
      records: [comm({ writing_agent_carrier_id: 'HISTORICAL-LOSE' })],
      batchMonthByBatchId: monthMap,
    });
    const out = resolveWritingAgentCarrierId({
      records: memberRecords, carrier: 'Ambetter', payEntity: 'Coverall',
      agentNpn: '21055210', lookup,
    });
    expect(out).toBe('DIRECT-WIN');
  });

  it('Tier-1 rejects when only pay_entity matches but NPN differs', () => {
    const memberRecords = [
      {
        source_type: 'COMMISSION', carrier: 'Ambetter',
        pay_entity: 'Coverall', agent_npn: '99999999',  // wrong NPN
        writing_agent_carrier_id: 'STALE-ID',
        batch_id: 'b-feb', created_at: '2026-02-01T00:00:00Z',
      },
    ];
    const lookup = buildWritingAgentCarrierIdLookup({
      records: [comm({ writing_agent_carrier_id: 'CHG9852' })],
      batchMonthByBatchId: monthMap,
    });
    const out = resolveWritingAgentCarrierId({
      records: memberRecords, carrier: 'Ambetter', payEntity: 'Coverall',
      agentNpn: '21055210', lookup,
    });
    // Tier-1 rejects (NPN mismatch); Tier-2 finds CHG9852.
    expect(out).toBe('CHG9852');
  });

  it('Tier-1 rejects when only NPN matches but pay_entity differs (Vix→Coverall scope leak)', () => {
    const memberRecords = [
      {
        source_type: 'COMMISSION', carrier: 'Ambetter',
        pay_entity: 'Vix', agent_npn: '21055210',  // wrong PE
        writing_agent_carrier_id: 'VIX-LEAK',
        batch_id: 'b-feb', created_at: '2026-02-01T00:00:00Z',
      },
    ];
    const lookup = buildWritingAgentCarrierIdLookup({
      records: [comm({ writing_agent_carrier_id: 'CHG9852' })],
      batchMonthByBatchId: monthMap,
    });
    const out = resolveWritingAgentCarrierId({
      records: memberRecords, carrier: 'Ambetter', payEntity: 'Coverall',
      agentNpn: '21055210', lookup,
    });
    expect(out).toBe('CHG9852');
  });

  it('Ambiguous target pay entity (blank) → blank, even if Tier-2 has data', () => {
    const lookup = buildWritingAgentCarrierIdLookup({
      records: [comm({ writing_agent_carrier_id: 'CHG9852' })],
      batchMonthByBatchId: monthMap,
    });
    const out = resolveWritingAgentCarrierId({
      records: [], carrier: 'Ambetter', payEntity: '',
      agentNpn: '21055210', lookup,
    });
    expect(out).toBe('');
  });
});
