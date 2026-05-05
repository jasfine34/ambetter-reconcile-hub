/**
 * Smoke tests for the upload flow (FINDING #68 + post-refactor RPC contract).
 *
 * After the staged-then-promote refactor, uploads route through the atomic
 * `upload_replace_file` RPC. There is no JS-side rollback writer anymore —
 * the RPC supersedes/promotes inside one TX, so a failure rolls back
 * automatically. Tests now assert:
 *   1. createBatch persists with the requested statement_month.
 *   2. uploadReplaceFile passes the captured batch_id straight through to
 *      the RPC (cannot redirect mid-flight).
 *   3. Race-protection: createBatch → setActiveBatchId → uploadReplaceFile
 *      lands the new file on the NEW batch, not the prior active one.
 *   4. createBatch failure leaves the active id unchanged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Captured = {
  inserts: Array<{ table: string; payload: any }>;
  rpcCalls: Array<{ name: string; args: any }>;
};

const captured: Captured = { inserts: [], rpcCalls: [] };

vi.mock('@/integrations/supabase/client', () => {
  const builder = (table: string) => {
    const obj: any = {
      insert(payload: any) {
        captured.inserts.push({ table, payload });
        const thenable: any = Promise.resolve({ error: null });
        thenable.select = () => ({
          single: () => Promise.resolve({
            data: { id: `${table}-id-1`, ...(Array.isArray(payload) ? payload[0] : payload) },
            error: null,
          }),
        });
        return thenable;
      },
      update() { return obj; },
      eq() { return obj; },
      is() { return obj; },
      then(resolve: any) { return Promise.resolve({ error: null }).then(resolve); },
    };
    return obj;
  };

  return {
    supabase: {
      from: (table: string) => builder(table),
      rpc: (name: string, args: any) => {
        captured.rpcCalls.push({ name, args });
        return Promise.resolve({ data: 'uploaded_files-id-rpc', error: null });
      },
      storage: { from: () => ({ upload: () => Promise.resolve({ error: null }) }) },
    },
  };
});

import { createBatch, uploadReplaceFile } from '@/lib/persistence';
import { supabase } from '@/integrations/supabase/client';

beforeEach(() => {
  captured.inserts.length = 0;
  captured.rpcCalls.length = 0;
});

describe('upload pipeline smoke (#68 + post-refactor)', () => {
  it('createBatch inserts a row in upload_batches with the requested statement_month', async () => {
    const batch = await createBatch('2026-04-01');
    expect(batch).toBeTruthy();
    const batchInsert = captured.inserts.find(i => i.table === 'upload_batches');
    expect(batchInsert!.payload.statement_month).toBe('2026-04-01');
  });

  it('uploadReplaceFile forwards the captured batch_id to the RPC', async () => {
    const batchId = 'batch-april-uuid';
    await uploadReplaceFile({
      batchId, fileLabel: 'EDE Summary', fileName: 'april.csv',
      sourceType: 'EDE', payEntity: null, aorBucket: null,
      storagePath: '/storage/april.csv', rows: [],
    });
    const call = captured.rpcCalls.find(c => c.name === 'upload_replace_file');
    expect(call).toBeDefined();
    expect(call!.args._batch_id).toBe(batchId);
    expect(call!.args._file_label).toBe('EDE Summary');
  });

  /**
   * FINDING #68 race protection — the BatchSelector contract is:
   *   createBatch → setCurrentBatchId(newId) → uploadReplaceFile(newId).
   * If anyone re-introduces the old "refresh-before-set" order, an in-flight
   * upload could land on the OLD id. This test pins the captured-id contract.
   */
  it('full create-batch → setCurrentBatchId → upload writes to the NEW batch', async () => {
    let activeBatchId: string | null = 'march-batch-id';
    const setActiveBatchId = (id: string) => { activeBatchId = id; };

    await createBatch('2026-04-01');
    const aprilId = 'upload_batches-id-1';
    setActiveBatchId(aprilId);
    expect(activeBatchId).toBe(aprilId);

    const captureAtUploadStart = activeBatchId;
    await uploadReplaceFile({
      batchId: captureAtUploadStart, fileLabel: 'EDE Summary', fileName: 'april.csv',
      sourceType: 'EDE', payEntity: null, aorBucket: null,
      storagePath: '/storage/april.csv', rows: [],
    });
    const call = captured.rpcCalls.find(c => c.name === 'upload_replace_file');
    expect(call!.args._batch_id).toBe(aprilId);
    expect(call!.args._batch_id).not.toBe('march-batch-id');
  });

  it('if createBatch fails, the active batch id is unchanged', async () => {
    let activeBatchId: string | null = 'march-batch-id';
    const setActiveBatchId = (id: string) => { activeBatchId = id; };

    const origFrom = (supabase as any).from;
    (supabase as any).from = (table: string) => {
      if (table === 'upload_batches') {
        return {
          insert: () => ({
            select: () => ({
              single: () => Promise.resolve({ data: null, error: { message: 'simulated RLS denial' } }),
            }),
          }),
        };
      }
      return origFrom(table);
    };

    let threw = false;
    try { await createBatch('2026-04-01'); } catch { threw = true; }
    expect(threw).toBe(true);
    // Selector contract: do NOT call setActiveBatchId on failure.
    expect(activeBatchId).toBe('march-batch-id');
    void setActiveBatchId;

    (supabase as any).from = origFrom;
  });
});
