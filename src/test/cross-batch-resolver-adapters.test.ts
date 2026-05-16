import { describe, it, expect } from 'vitest';
import {
  buildResolverRecordIndex,
  buildPolicyStateRecords,
  buildPolicyMemberCountRecords,
} from '@/lib/sweep/resolverRecordAdapters';

const batchMonthById = { B1: '2026-02', B2: '2026-03' };

function row(over: any = {}) {
  return {
    id: over.id ?? `r-${Math.random().toString(36).slice(2, 8)}`,
    batch_id: over.batch_id ?? 'B1',
    source_type: over.source_type ?? 'BACK_OFFICE',
    carrier: 'Ambetter',
    policy_number: over.policy_number ?? 'P1',
    issuer_subscriber_id: over.issuer_subscriber_id ?? null,
    effective_date: over.effective_date ?? null,
    broker_effective_date: over.broker_effective_date ?? null,
    client_state_full: over.client_state_full ?? 'FL',
    raw_json: over.raw_json ?? {},
    ...over,
  };
}

describe('resolverRecordAdapters - buildResolverRecordIndex', () => {
  it('indexes BO record by primary key', () => {
    const idx = buildResolverRecordIndex({ normalizedRecords: [row({ id: 'a', policy_number: 'P1' })] });
    expect(idx.get('ambetter|p1')?.length).toBe(1);
  });

  it('aliases ambetter under both pn and sub:sid', () => {
    const idx = buildResolverRecordIndex({
      normalizedRecords: [row({ id: 'a', policy_number: 'P1', issuer_subscriber_id: 'S2' })],
    });
    expect(idx.get('ambetter|p1')?.length).toBe(1);
    expect(idx.get('ambetter|sub:s2')?.length).toBe(1);
    expect(idx.get('ambetter|s2')?.length).toBe(1);
  });

  it('ambetter with only sub indexed under both keyed forms', () => {
    const idx = buildResolverRecordIndex({
      normalizedRecords: [row({ id: 'a', policy_number: null, issuer_subscriber_id: 'S2' })],
    });
    expect(idx.get('ambetter|sub:s2')?.length).toBe(1);
  });

  it('non-ambetter does NOT alias', () => {
    const idx = buildResolverRecordIndex({
      normalizedRecords: [row({ carrier: 'Cigna', policy_number: 'P9', issuer_subscriber_id: 'S9' })],
    });
    expect(idx.get('cigna|p9')?.length).toBe(1);
    expect(idx.get('cigna|sub:s9')).toBeUndefined();
  });

  it('excludes commission rows', () => {
    const idx = buildResolverRecordIndex({
      normalizedRecords: [row({ source_type: 'COMMISSION' })],
    });
    expect(idx.size).toBe(0);
  });

  it('dedupes by id within a bucket', () => {
    const idx = buildResolverRecordIndex({
      normalizedRecords: [
        row({ id: 'a', policy_number: 'P1', issuer_subscriber_id: 'P1' }),
      ],
    });
    expect(idx.get('ambetter|p1')?.length).toBe(1);
  });

  it('source_type EDE included', () => {
    const idx = buildResolverRecordIndex({
      normalizedRecords: [row({ source_type: 'EDE' })],
    });
    expect(idx.size).toBeGreaterThan(0);
  });
});

describe('buildPolicyStateRecords', () => {
  it('maps BACK_OFFICE → bo', () => {
    const out = buildPolicyStateRecords({
      normalizedRecords: [row({ effective_date: '2026-02-15' })],
      batchMonthById,
    });
    expect(out[0].source).toBe('bo');
    expect(out[0].asOfMonth).toBe('2026-02');
    expect(out[0].state).toBe('FL');
  });

  it('uses broker_effective_date when effective_date missing', () => {
    const out = buildPolicyStateRecords({
      normalizedRecords: [row({ effective_date: null, broker_effective_date: '2026-01-15' })],
      batchMonthById,
    });
    expect(out[0].asOfMonth).toBe('2026-01');
  });

  it('falls back to batchMonthById when both dates missing', () => {
    const out = buildPolicyStateRecords({
      normalizedRecords: [row({ effective_date: null, broker_effective_date: null })],
      batchMonthById,
    });
    expect(out[0].asOfMonth).toBe('2026-02');
  });

  it('omits when state cannot normalize', () => {
    const out = buildPolicyStateRecords({
      normalizedRecords: [row({ client_state_full: 'NotARealState' })],
      batchMonthById,
    });
    expect(out).toHaveLength(0);
  });

  it('uses raw_json.clientState as fallback', () => {
    const out = buildPolicyStateRecords({
      normalizedRecords: [row({ client_state_full: null, raw_json: { clientState: 'Texas' } })],
      batchMonthById,
    });
    expect(out[0].state).toBe('TX');
  });

  it('client_state_full="FL" emits FL', () => {
    const out = buildPolicyStateRecords({
      normalizedRecords: [row({ client_state_full: 'FL', effective_date: '2026-02-15' })],
      batchMonthById,
    });
    expect(out[0].state).toBe('FL');
  });

  it('blank client_state_full falls back to raw_json.clientState', () => {
    const out = buildPolicyStateRecords({
      normalizedRecords: [row({ client_state_full: '', raw_json: { clientState: 'FL' }, effective_date: '2026-02-15' })],
      batchMonthById,
    });
    expect(out[0].state).toBe('FL');
  });

  it('CRITICAL: blank client_state_full and blank raw_json.clientState falls through to raw_json.State (Erica Flowers)', () => {
    const out = buildPolicyStateRecords({
      normalizedRecords: [row({ client_state_full: '', raw_json: { clientState: '', State: 'FL' }, effective_date: '2026-02-15' })],
      batchMonthById,
    });
    expect(out[0].state).toBe('FL');
  });

  it('blank client_state_full falls through to raw_json.State (capital)', () => {
    const out = buildPolicyStateRecords({
      normalizedRecords: [row({ client_state_full: '', raw_json: { State: 'TX' }, effective_date: '2026-02-15' })],
      batchMonthById,
    });
    expect(out[0].state).toBe('TX');
  });

  it('blank client_state_full and blank raw_json.clientState falls through to raw_json.state', () => {
    const out = buildPolicyStateRecords({
      normalizedRecords: [row({ client_state_full: '', raw_json: { clientState: '', state: 'FL' }, effective_date: '2026-02-15' })],
      batchMonthById,
    });
    expect(out[0].state).toBe('FL');
  });

  it('no state fields anywhere → adapter skips', () => {
    const out = buildPolicyStateRecords({
      normalizedRecords: [row({ client_state_full: '', raw_json: {}, effective_date: '2026-02-15' })],
      batchMonthById,
    });
    expect(out).toHaveLength(0);
  });
});

describe('buildPolicyMemberCountRecords', () => {
  it('parses raw_json.coveredMemberCount', () => {
    const out = buildPolicyMemberCountRecords({
      normalizedRecords: [row({ raw_json: { coveredMemberCount: '3' } })],
      batchMonthById,
    });
    expect(out[0].memberCount).toBe(3);
    expect(out[0].source).toBe('bo');
  });

  it('parses CoveredMemberCount casing variant', () => {
    const out = buildPolicyMemberCountRecords({
      normalizedRecords: [row({ raw_json: { CoveredMemberCount: 4 } })],
      batchMonthById,
    });
    expect(out[0].memberCount).toBe(4);
  });

  it('omits when no count parseable', () => {
    const out = buildPolicyMemberCountRecords({
      normalizedRecords: [row({ raw_json: {} })],
      batchMonthById,
    });
    expect(out).toHaveLength(0);
  });
});
