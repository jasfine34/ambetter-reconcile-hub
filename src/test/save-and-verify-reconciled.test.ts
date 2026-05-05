/**
 * Tests for the canonical saveAndVerifyReconciled() helper (Codex Finding 2)
 * and for the supersede-error capture in uploadFileRecord (Codex Finding 1).
 *
 * The three rebuild/save call sites (rebuildBatch, UploadPage, DashboardPage)
 * all route through saveAndVerifyReconciled() so a silent zero-row write
 * cannot succeed-toast through ANY of them. These tests pin the contract.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Captured = {
  rpcCalls: Array<{ name: string; args: any }>;
  reconciledCount: number;
  upload_batches_updates: Array<{ patch: any; eqId?: string }>;
  upload_batches_update_error: any | null;
  normalized_supersede_error: any | null;
  uploaded_files_supersede_error: any | null;
  inserts: Array<{ table: string; payload: any }>;
};

const captured: Captured = {
  rpcCalls: [],
  reconciledCount: 0,
  upload_batches_updates: [],
  upload_batches_update_error: null,
  normalized_supersede_error: null,
  uploaded_files_supersede_error: null,
  inserts: [],
};

vi.mock('@/integrations/supabase/client', () => {
  const builder = (table: string) => {
    let pendingInsertPayload: any = null;
    let pendingUpdatePatch: any = null;
    let isUpdate = false;
    let isCount = false;
    let pendingEq: { col: string; val: any } | null = null;
    // For supersede UPDATE detection we track whether .is('superseded_at', null) was called.
    let isSupersedeFilter = false;

    const obj: any = {
      insert(payload: any) {
        pendingInsertPayload = payload;
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
      update(patch: any) {
        pendingUpdatePatch = patch;
        isUpdate = true;
        return obj;
      },
      select(_cols?: string, opts?: { count?: string; head?: boolean }) {
        if (opts?.count === 'exact') isCount = true;
        return obj;
      },
      eq(col: string, val: any) {
        pendingEq = { col, val };
        return obj;
      },
      is(_col: string, _val: any) {
        isSupersedeFilter = true;
        return obj;
      },
      order() { return obj; },
      range() {
        return Promise.resolve({ data: [], error: null });
      },
      then(resolve: any) {
        // Terminal awaited state — resolve based on operation type.
        if (isCount && table === 'reconciled_members') {
          return Promise.resolve({ count: captured.reconciledCount, error: null }).then(resolve);
        }
        if (isUpdate && table === 'upload_batches') {
          captured.upload_batches_updates.push({
            patch: pendingUpdatePatch,
            eqId: pendingEq?.col === 'id' ? pendingEq.val : undefined,
          });
          return Promise.resolve({ error: captured.upload_batches_update_error }).then(resolve);
        }
        if (isUpdate && table === 'normalized_records' && isSupersedeFilter) {
          return Promise.resolve({ error: captured.normalized_supersede_error }).then(resolve);
        }
        if (isUpdate && table === 'uploaded_files' && isSupersedeFilter) {
          return Promise.resolve({ error: captured.uploaded_files_supersede_error }).then(resolve);
        }
        return Promise.resolve({ data: null, error: null }).then(resolve);
      },
    };
    return obj;
  };

  return {
    supabase: {
      from: (table: string) => builder(table),
      rpc: (name: string, args: any) => {
        captured.rpcCalls.push({ name, args });
        return Promise.resolve({ error: null });
      },
      storage: { from: () => ({ upload: () => Promise.resolve({ error: null }) }) },
    },
  };
});

import {
  saveAndVerifyReconciled,
  uploadReplaceFile,
} from '@/lib/persistence';

beforeEach(() => {
  captured.rpcCalls.length = 0;
  captured.reconciledCount = 0;
  captured.upload_batches_updates.length = 0;
  captured.upload_batches_update_error = null;
  captured.normalized_supersede_error = null;
  captured.uploaded_files_supersede_error = null;
  captured.inserts.length = 0;
});

describe('saveAndVerifyReconciled — canonical save+verify+stamp (Finding 2)', () => {
  it('throws a descriptive error when post-save count is 0 but members.length > 0', async () => {
    captured.reconciledCount = 0;
    const members = [{ member_key: 'm1' } as any, { member_key: 'm2' } as any];

    let caught: Error | null = null;
    try {
      await saveAndVerifyReconciled('batch-x', members);
    } catch (err: any) {
      caught = err;
    }

    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/batch-x/);
    expect(caught!.message).toMatch(/expected 2/);
    expect(caught!.message).toMatch(/found 0/i);
    // Stamp must NOT have been written on a verification failure.
    expect(captured.upload_batches_updates).toHaveLength(0);
  });

  it('returns the row count and does NOT stamp when stampLogicVersion is unset', async () => {
    captured.reconciledCount = 1234;
    const members = [{ member_key: 'm1' } as any];

    const result = await saveAndVerifyReconciled('batch-y', members);
    expect(result.rowCount).toBe(1234);
    expect(result.version).toBeUndefined();
    expect(captured.upload_batches_updates).toHaveLength(0);
  });

  it('stamps last_rebuild_logic_version when stampLogicVersion:true', async () => {
    captured.reconciledCount = 50;
    const members = [{ member_key: 'm1' } as any];

    const result = await saveAndVerifyReconciled('batch-z', members, {
      stampLogicVersion: true,
      logicVersion: '2026.04.30-canonical-save-verify',
    });

    expect(result.rowCount).toBe(50);
    expect(result.version).toBe('2026.04.30-canonical-save-verify');
    expect(captured.upload_batches_updates).toHaveLength(1);
    const upd = captured.upload_batches_updates[0];
    expect(upd.eqId).toBe('batch-z');
    expect(upd.patch.last_rebuild_logic_version).toBe('2026.04.30-canonical-save-verify');
    expect(upd.patch.last_full_rebuild_at).toBeTruthy();
  });

  it('accepts 0 verified rows when members.length === 0 (legitimately empty batch)', async () => {
    captured.reconciledCount = 0;
    const result = await saveAndVerifyReconciled('batch-empty', []);
    expect(result.rowCount).toBe(0);
  });

  it('throws if stampLogicVersion:true is passed without a logicVersion', async () => {
    captured.reconciledCount = 1;
    let caught: Error | null = null;
    try {
      await saveAndVerifyReconciled('batch-q', [{ member_key: 'm1' } as any], {
        stampLogicVersion: true,
      });
    } catch (err: any) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/logicVersion/);
  });
});

describe('uploadFileRecord — supersede error capture (Finding 1)', () => {
  it('throws if the normalized_records supersede UPDATE returns a Postgres error', async () => {
    captured.normalized_supersede_error = {
      message: 'permission denied for table normalized_records',
      code: '42501',
    };

    let caught: Error | null = null;
    try {
      await uploadFileRecord(
        'batch-1', 'EDE Summary', 'a.csv', 'EDE', null, null, '/p/a.csv',
      );
    } catch (err: any) {
      caught = err;
    }

    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/Failed to supersede prior normalized_records/);
    expect(caught!.message).toMatch(/permission denied/);
    expect(caught!.message).toMatch(/42501/);

    // CRITICAL: the uploaded_files INSERT must NOT have run.
    const fileInsert = captured.inserts.find(i => i.table === 'uploaded_files');
    expect(fileInsert).toBeUndefined();
  });

  it('throws if the uploaded_files supersede UPDATE returns a Postgres error', async () => {
    captured.uploaded_files_supersede_error = {
      message: 'connection terminated',
      code: '57P01',
    };

    let caught: Error | null = null;
    try {
      await uploadFileRecord(
        'batch-1', 'EDE Summary', 'a.csv', 'EDE', null, null, '/p/a.csv',
      );
    } catch (err: any) {
      caught = err;
    }

    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/Failed to supersede prior uploaded_files/);
    expect(caught!.message).toMatch(/connection terminated/);

    // INSERT must NOT have run after the second supersede failed.
    const fileInsert = captured.inserts.find(i => i.table === 'uploaded_files');
    expect(fileInsert).toBeUndefined();
  });

  it('proceeds to INSERT when both supersedes succeed', async () => {
    captured.normalized_supersede_error = null;
    captured.uploaded_files_supersede_error = null;

    const result = await uploadFileRecord(
      'batch-1', 'EDE Summary', 'a.csv', 'EDE', null, null, '/p/a.csv',
    );
    expect(result.file).toBeTruthy();
    const fileInsert = captured.inserts.find(i => i.table === 'uploaded_files');
    expect(fileInsert).toBeDefined();
    expect(fileInsert!.payload.batch_id).toBe('batch-1');
  });
});
