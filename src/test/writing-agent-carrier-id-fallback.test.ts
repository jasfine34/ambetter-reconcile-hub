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
