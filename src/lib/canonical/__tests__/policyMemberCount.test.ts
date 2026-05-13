import { describe, it, expect } from 'vitest';
import { resolvePolicyMemberCountForCompGrid, type PolicyMemberCountRecord } from '../policyMemberCount';

const T = (source: 'bo' | 'ede', asOfMonth: string, memberCount: number | string | null): PolicyMemberCountRecord => ({ source, asOfMonth, memberCount });

describe('resolvePolicyMemberCountForCompGrid — basic flow', () => {
  it('BO over EDE inside window', () => {
    const r = resolvePolicyMemberCountForCompGrid({
      records: [T('bo', '2026-03', 3), T('ede', '2026-03', 5)],
      targetBatchMonth: '2026-04', targetServiceMonths: ['2026-03'],
    });
    expect(r).toMatchObject({ status: 'resolved', memberCount: 3, source: 'bo' });
  });
  it('falls back to EDE', () => {
    const r = resolvePolicyMemberCountForCompGrid({
      records: [T('ede', '2026-03', 2)],
      targetBatchMonth: '2026-04', targetServiceMonths: ['2026-03'],
    });
    expect(r).toMatchObject({ status: 'resolved', memberCount: 2, source: 'ede' });
  });
});

describe('resolvePolicyMemberCountForCompGrid — conflict & numeric parsing', () => {
  it('conflicting BO counts → manual_review', () => {
    const r = resolvePolicyMemberCountForCompGrid({
      records: [T('bo', '2026-03', 2), T('bo', '2026-03', 4)],
      targetBatchMonth: '2026-04', targetServiceMonths: ['2026-03'],
    });
    expect(r.status).toBe('manual_review');
    expect(r.conflicts).toEqual(expect.arrayContaining([2, 4]));
  });
  it('parses string numerics, ignores blanks/zeros/negatives', () => {
    const r = resolvePolicyMemberCountForCompGrid({
      records: [T('bo', '2026-03', '0'), T('bo', '2026-03', ''), T('bo', '2026-03', '  3 ')],
      targetBatchMonth: '2026-04', targetServiceMonths: ['2026-03'],
    });
    expect(r).toMatchObject({ status: 'resolved', memberCount: 3 });
  });
});

describe('resolvePolicyMemberCountForCompGrid — no fallback to 1', () => {
  it('returns unresolved (NOT 1) when no records exist', () => {
    const r = resolvePolicyMemberCountForCompGrid({
      records: [],
      targetBatchMonth: '2026-04', targetServiceMonths: ['2026-03'],
    });
    expect(r).toMatchObject({ status: 'unresolved', memberCount: null });
  });
  it('returns unresolved when all records are unparseable', () => {
    const r = resolvePolicyMemberCountForCompGrid({
      records: [T('bo', '2026-03', null), T('ede', '2026-03', 'n/a')],
      targetBatchMonth: '2026-04', targetServiceMonths: ['2026-03'],
    });
    expect(r.status).toBe('unresolved');
    expect(r.memberCount).toBeNull();
  });
});

describe('resolvePolicyMemberCountForCompGrid — historical fallback', () => {
  it('uses most recent prior record when none cover the service window', () => {
    const r = resolvePolicyMemberCountForCompGrid({
      records: [T('bo', '2025-12', 4)],
      targetBatchMonth: '2026-04', targetServiceMonths: ['2026-03'],
    });
    expect(r).toMatchObject({ status: 'resolved', memberCount: 4, fallbackUsed: 'historical' });
  });
});
