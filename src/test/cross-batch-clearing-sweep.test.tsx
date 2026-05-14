/**
 * Bundle 13b — sweep safety-guard + abort tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fromMock = vi.fn();
const rpcMock = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: (...a: any[]) => fromMock(...a), rpc: (...a: any[]) => rpcMock(...a) },
}));
vi.mock('@/lib/canonical/compGridLoader', () => ({
  loadCarrierCompRates: async () => [],
}));

import { runCrossBatchClearingSweep } from '@/lib/sweep/crossBatchClearingSweep';

beforeEach(() => {
  fromMock.mockReset();
  rpcMock.mockReset();
});

function batchesQuery(data: any, error: any = null) {
  return { select: () => Promise.resolve({ data, error }) };
}

describe('crossBatchClearingSweep — safety guards', () => {
  it('aborts with stale_generation when shouldContinue is false', async () => {
    const r = await runCrossBatchClearingSweep({ generationId: 1, shouldContinue: () => false });
    expect(r.aborted).toBe(true);
    expect(r.abortReason).toBe('stale_generation');
  });

  it('aborts with no_upload_batches when zero rows', async () => {
    fromMock.mockReturnValueOnce(batchesQuery([]));
    const r = await runCrossBatchClearingSweep({ generationId: 1, shouldContinue: () => true });
    expect(r.aborted).toBe(true);
    expect(r.abortReason).toBe('no_upload_batches');
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('aborts with upload_batches_load_failed on error', async () => {
    fromMock.mockReturnValueOnce(batchesQuery(null, new Error('boom')));
    const r = await runCrossBatchClearingSweep({ generationId: 1, shouldContinue: () => true });
    expect(r.aborted).toBe(true);
    expect(r.abortReason).toBe('upload_batches_load_failed');
  });

  it('aborts with no_valid_batch_months when no valid statement_month', async () => {
    fromMock.mockReturnValueOnce(batchesQuery([{ id: 'B1', statement_month: 'garbage', created_at: '2026-01-01' }]));
    const r = await runCrossBatchClearingSweep({ generationId: 1, shouldContinue: () => true });
    expect(r.aborted).toBe(true);
    expect(r.abortReason).toBe('no_valid_batch_months');
  });

  it('returns success when no unpaid rows (RPC supersedes)', async () => {
    // upload_batches
    fromMock.mockReturnValueOnce(batchesQuery([{ id: 'B1', statement_month: '2026-02-01', created_at: '2026-02-01' }]));
    // reconciled_members range query
    const reconciledChain: any = {
      select: () => reconciledChain,
      eq: () => reconciledChain,
      range: () => Promise.resolve({ data: [], error: null }),
    };
    fromMock.mockReturnValueOnce(reconciledChain);
    rpcMock.mockResolvedValueOnce({ error: null });
    const r = await runCrossBatchClearingSweep({ generationId: 1, shouldContinue: () => true });
    expect(r.aborted).toBe(false);
    expect(r.clearingRowsWritten).toBe(0);
    expect(rpcMock).toHaveBeenCalledWith(
      'replace_cross_batch_clearings_for_run',
      expect.objectContaining({ p_scope: 'global_full_rebuild' }),
    );
  });

  it('records target_service_month_unresolved input error', async () => {
    fromMock.mockReturnValueOnce(batchesQuery([{ id: 'B1', statement_month: '2026-02-01', created_at: '2026-02-01' }]));
    const reconciledChain: any = {
      select: () => reconciledChain, eq: () => reconciledChain,
      range: vi.fn()
        .mockResolvedValueOnce({ data: [{ id: 'M1', batch_id: 'B1', in_commission: false, expected_ede_effective_month: 'BAD', carrier: 'Ambetter', policy_number: 'P1', issuer_subscriber_id: null }], error: null })
        .mockResolvedValueOnce({ data: [], error: null }),
    };
    fromMock.mockReturnValueOnce(reconciledChain);
    rpcMock.mockResolvedValueOnce({ error: null });
    const r = await runCrossBatchClearingSweep({ generationId: 1, shouldContinue: () => true });
    expect(r.aborted).toBe(false);
    expect(r.inputErrors[0].reason).toBe('target_service_month_unresolved');
  });

  it('records no_carrier input error', async () => {
    fromMock.mockReturnValueOnce(batchesQuery([{ id: 'B1', statement_month: '2026-02-01', created_at: '2026-02-01' }]));
    const reconciledChain: any = {
      select: () => reconciledChain, eq: () => reconciledChain,
      range: vi.fn()
        .mockResolvedValueOnce({ data: [{ id: 'M1', batch_id: 'B1', in_commission: false, expected_ede_effective_month: '2026-02', carrier: 'WeirdCo', policy_number: 'P1', issuer_subscriber_id: null }], error: null })
        .mockResolvedValueOnce({ data: [], error: null }),
    };
    fromMock.mockReturnValueOnce(reconciledChain);
    rpcMock.mockResolvedValueOnce({ error: null });
    const r = await runCrossBatchClearingSweep({ generationId: 1, shouldContinue: () => true });
    expect(r.inputErrors.find(e => e.reason === 'no_carrier')).toBeTruthy();
  });

  it('rejects on RPC failure (unexpected path)', async () => {
    fromMock.mockReturnValueOnce(batchesQuery([{ id: 'B1', statement_month: '2026-02-01', created_at: '2026-02-01' }]));
    const reconciledChain: any = {
      select: () => reconciledChain, eq: () => reconciledChain,
      range: () => Promise.resolve({ data: [], error: null }),
    };
    fromMock.mockReturnValueOnce(reconciledChain);
    rpcMock.mockResolvedValueOnce({ error: new Error('rpc fail') });
    await expect(runCrossBatchClearingSweep({ generationId: 1, shouldContinue: () => true })).rejects.toThrow();
  });
});
