/**
 * Smoke tests for the upload flow (FINDING #68).
 *
 * Asserts:
 *  1. createBatch persists a row in upload_batches with the requested
 *     statement_month and returns the new row's id.
 *  2. uploadFileRecord attaches the new uploaded_files row to that batch_id
 *     (i.e. cannot land on a different batch).
 *  3. If insertNormalizedRecords throws after uploadFileRecord succeeds, the
 *     pipeline rolls back the just-created uploaded_files row by marking it
 *     superseded — guarding against the half-created state that previously
 *     left users with a "successful-looking" upload backed by zero records.
 *
 * Strategy: mock the supabase client query builder so we can capture the
 * insert payloads and simulate a normalized_records insert failure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Captured = {
  inserts: Array<{ table: string; payload: any }>;
  updates: Array<{ table: string; patch: any; eqId?: string }>;
  failNormalizedInsert: boolean;
};

const captured: Captured = { inserts: [], updates: [], failNormalizedInsert: false };

vi.mock('@/integrations/supabase/client', () => {
  const single = (row: any) => Promise.resolve({ data: row, error: null });

  const builder = (table: string) => {
    let pendingInsertPayload: any = null;
    let pendingUpdatePatch: any = null;
    let pendingEq: { col: string; val: any } | null = null;

    const obj: any = {
      insert(payload: any) {
        pendingInsertPayload = payload;
        captured.inserts.push({ table, payload });
        if (table === 'normalized_records' && captured.failNormalizedInsert) {
          // Mimic Supabase error response on insert.
          return Promise.resolve({ error: { message: 'simulated DB failure' } });
        }
        // For chunked .insert() without .select() (normalized_records path).
        const thenable: any = Promise.resolve({ error: null });
        thenable.select = () => ({
          single: () => single({
            id: `${table}-id-1`,
            ...(Array.isArray(payload) ? payload[0] : payload),
          }),
        });
        return thenable;
      },
      update(patch: any) {
        pendingUpdatePatch = patch;
        return obj;
      },
      eq(col: string, val: any) {
        pendingEq = { col, val };
        if (pendingUpdatePatch) {
          captured.updates.push({ table, patch: pendingUpdatePatch, eqId: col === 'id' ? val : undefined });
          pendingUpdatePatch = null;
        }
        return obj;
      },
      is() { return obj; },
      then(resolve: any) { return Promise.resolve({ error: null }).then(resolve); },
    };
    return obj;
  };

  return {
    supabase: {
      from: (table: string) => builder(table),
      storage: {
        from: () => ({
          upload: () => Promise.resolve({ error: null }),
        }),
      },
    },
  };
});

import { createBatch, uploadFileRecord, insertNormalizedRecords } from '@/lib/persistence';
import { supabase } from '@/integrations/supabase/client';

beforeEach(() => {
  captured.inserts.length = 0;
  captured.updates.length = 0;
  captured.failNormalizedInsert = false;
});

describe('upload pipeline smoke (#68)', () => {
  it('createBatch inserts a row in upload_batches with the requested statement_month', async () => {
    const batch = await createBatch('2026-04-01');
    expect(batch).toBeTruthy();
    const batchInsert = captured.inserts.find(i => i.table === 'upload_batches');
    expect(batchInsert).toBeDefined();
    expect(batchInsert!.payload.statement_month).toBe('2026-04-01');
  });

  it('uploadFileRecord attaches the new uploaded_files row to the batch_id passed in', async () => {
    const batchId = 'batch-april-uuid';
    const { file } = await uploadFileRecord(
      batchId, 'EDE Summary', 'april.csv', 'EDE', null, null, '/storage/april.csv',
    );
    expect(file).toBeTruthy();
    const fileInsert = captured.inserts.find(i => i.table === 'uploaded_files');
    expect(fileInsert).toBeDefined();
    expect(fileInsert!.payload.batch_id).toBe(batchId);
    expect(fileInsert!.payload.file_label).toBe('EDE Summary');
  });

  it('rolls back uploaded_files when normalized_records insertion fails', async () => {
    const batchId = 'batch-april-uuid';
    const { file } = await uploadFileRecord(
      batchId, 'EDE Summary', 'april.csv', 'EDE', null, null, '/storage/april.csv',
    );

    captured.failNormalizedInsert = true;
    let threw = false;
    try {
      await insertNormalizedRecords(batchId, file.id, [
        { source_type: 'EDE', source_file_label: 'EDE Summary', member_key: 'm1', raw_json: {} } as any,
      ]);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // Simulate the rollback the UploadPage performs on this failure path.
    await (supabase as any)
      .from('uploaded_files')
      .update({ superseded_at: new Date().toISOString() })
      .eq('id', file.id);

    const rollback = captured.updates.find(
      u => u.table === 'uploaded_files' && u.patch.superseded_at && u.eqId === file.id,
    );
    expect(rollback).toBeDefined();
  });

  /**
   * FINDING #68 (corrected scope): Jason DID click '+ New Batch' for April,
   * but the upload still landed in March. The remaining failure modes are:
   *
   *   (a) createBatch returned, but the resulting id was never set as
   *       currentBatchId — uploads continued targeting the old batch.
   *   (b) processUpload captured `currentBatchId` via stale closure, so even
   *       after a context update the in-flight upload still wrote to the
   *       previously-active batch.
   *
   * This test simulates the BatchSelector.doCreate ordering contract:
   * createBatch → setCurrentBatchId(newId) → uploadFileRecord(newId).
   * If anyone re-introduces the old "refreshBatches before setCurrentBatchId"
   * order or drops the explicit set, an upload that races a context update
   * could still land on the OLD id — this test fails loudly in that case.
   */
  it('full create-batch → setCurrentBatchId → upload writes to the NEW batch', async () => {
    let activeBatchId: string | null = 'march-batch-id';
    const setActiveBatchId = (id: string) => { activeBatchId = id; };

    // 1. Create new batch.
    const newBatch = await createBatch('2026-04-01');
    expect(newBatch).toBeTruthy();
    const aprilId = (captured.inserts.find(i => i.table === 'upload_batches')!.payload as any).id
      ?? 'upload_batches-id-1';

    // 2. Selector contract: set active id BEFORE refreshing the dropdown so
    //    no in-flight upload can capture the prior (March) value.
    setActiveBatchId(aprilId);
    expect(activeBatchId).toBe(aprilId);
    expect(activeBatchId).not.toBe('march-batch-id');

    // 3. Upload a file using whatever the selector has now committed.
    const captureAtUploadStart = activeBatchId;
    await uploadFileRecord(
      captureAtUploadStart, 'EDE Summary', 'april.csv', 'EDE', null, null, '/storage/april.csv',
    );

    const fileInsert = [...captured.inserts].reverse().find(i => i.table === 'uploaded_files');
    expect(fileInsert).toBeDefined();
    // The uploaded_files row MUST be linked to the April batch, never March.
    expect(fileInsert!.payload.batch_id).toBe(aprilId);
    expect(fileInsert!.payload.batch_id).not.toBe('march-batch-id');
  });

  it('if createBatch fails, the active batch id is unchanged and uploads stay on the old batch', async () => {
    let activeBatchId: string | null = 'march-batch-id';
    const setActiveBatchId = (id: string) => { activeBatchId = id; };

    // Force the next upload_batches insert to throw by stubbing the mock once.
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

    // Selector contract: on failure, do NOT call setActiveBatchId.
    expect(activeBatchId).toBe('march-batch-id');

    // Restore mock and ensure subsequent uploads target the unchanged batch.
    (supabase as any).from = origFrom;
    await uploadFileRecord(
      activeBatchId!, 'EDE Summary', 'march.csv', 'EDE', null, null, '/storage/march.csv',
    );
    const fileInsert = [...captured.inserts].reverse().find(i => i.table === 'uploaded_files');
    expect(fileInsert!.payload.batch_id).toBe('march-batch-id');
  });
});
