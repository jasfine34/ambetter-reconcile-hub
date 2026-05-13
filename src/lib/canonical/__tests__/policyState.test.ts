import { describe, it, expect } from 'vitest';
import { resolvePolicyStateForCompGrid, type PolicyStateRecord } from '../policyState';

const T = (source: 'bo' | 'ede', asOfMonth: string, state: string | null): PolicyStateRecord => ({ source, asOfMonth, state });

describe('resolvePolicyStateForCompGrid — BO-first / EDE-fallback', () => {
  it('prefers BO over EDE when both are present in window', () => {
    const r = resolvePolicyStateForCompGrid({
      records: [T('bo', '2026-03', 'FL'), T('ede', '2026-03', 'GA')],
      targetBatchMonth: '2026-04',
      targetServiceMonths: ['2026-03'],
    });
    expect(r).toMatchObject({ status: 'resolved', state: 'FL', source: 'bo' });
  });
  it('falls back to EDE when no BO records exist', () => {
    const r = resolvePolicyStateForCompGrid({
      records: [T('ede', '2026-03', 'TX')],
      targetBatchMonth: '2026-04',
      targetServiceMonths: ['2026-03'],
    });
    expect(r).toMatchObject({ status: 'resolved', state: 'TX', source: 'ede' });
  });
  it('returns unresolved when no records before batch month', () => {
    const r = resolvePolicyStateForCompGrid({
      records: [T('bo', '2026-09', 'FL')],
      targetBatchMonth: '2026-03',
      targetServiceMonths: ['2026-03'],
    });
    expect(r.status).toBe('unresolved');
  });
});

describe('resolvePolicyStateForCompGrid — conflict resolution', () => {
  it('multiple distinct BO states → manual_review', () => {
    const r = resolvePolicyStateForCompGrid({
      records: [T('bo', '2026-03', 'FL'), T('bo', '2026-03', 'GA')],
      targetBatchMonth: '2026-04',
      targetServiceMonths: ['2026-03'],
    });
    expect(r.status).toBe('manual_review');
    expect(r.source).toBe('bo');
    expect(r.conflicts).toEqual(expect.arrayContaining(['FL', 'GA']));
  });
  it('multiple agreeing BO rows still resolve cleanly', () => {
    const r = resolvePolicyStateForCompGrid({
      records: [T('bo', '2026-02', 'FL'), T('bo', '2026-03', 'FL')],
      targetBatchMonth: '2026-04',
      targetServiceMonths: ['2026-02', '2026-03'],
    });
    expect(r).toMatchObject({ status: 'resolved', state: 'FL', source: 'bo' });
  });
});

describe('resolvePolicyStateForCompGrid — historical fallback', () => {
  it('uses most recent prior record when none cover service window', () => {
    const r = resolvePolicyStateForCompGrid({
      records: [T('bo', '2025-11', 'FL')],
      targetBatchMonth: '2026-04',
      targetServiceMonths: ['2026-03'],
    });
    expect(r.status).toBe('resolved');
    expect(r.state).toBe('FL');
    expect(r.fallbackUsed).toBe('historical');
  });
});
