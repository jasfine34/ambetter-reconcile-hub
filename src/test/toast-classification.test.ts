/**
 * #123 — Toast UX Rewrite by Failure Mode.
 *
 * Verifies that every known upload / rebuild failure surface maps to the
 * correct (variant, title, description) bucket. These tests are the
 * regression lock against future "rebuild failed" generic-toast drift —
 * the exact UX failure that caused the Feb recovery misread.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyUploadError,
  classifyRebuildError,
} from '@/lib/toastClassification';
import { ReconcileAfterPromoteError } from '@/lib/rebuild';

describe('classifyUploadError', () => {
  it('class 1: upload RPC failure → destructive "Upload failed. Data was not saved."', () => {
    const t = classifyUploadError(new Error('upload_replace_file failed: boom'), {
      phase: 'rpc',
      fileLabel: 'EDE',
    });
    expect(t.variant).toBe('destructive');
    expect(t.classId).toBe('upload-rpc-failed');
    expect(t.title).toContain('Upload failed');
    expect(t.title).toContain('EDE');
    expect(t.description).toMatch(/not saved/i);
    expect(t.description).toMatch(/try again/i);
  });

  it('class 2: post-upload reconcile failure → warning "Upload saved… metrics may be stale"', () => {
    const t = classifyUploadError(new Error('reconcile boom'), {
      phase: 'after-upload',
      fileLabel: 'COMM_DM',
    });
    expect(t.variant).toBe('warning');
    expect(t.classId).toBe('upload-saved-reconcile-failed');
    expect(t.title).toMatch(/upload saved/i);
    expect(t.title).toContain('COMM_DM');
    expect(t.description).toMatch(/auto-reconcile failed/i);
    expect(t.description).toMatch(/may be stale/i);
    expect(t.description).toMatch(/click rebuild/i);
  });

  it('class 2 must NOT look like an upload failure', () => {
    const t = classifyUploadError(new Error('reconcile boom'), {
      phase: 'after-upload',
      fileLabel: 'EDE',
    });
    expect(t.title.toLowerCase()).not.toContain('upload failed');
    expect(t.variant).not.toBe('destructive');
  });
});

describe('classifyRebuildError', () => {
  it('class 5: ReconcileAfterPromoteError → warning "partially completed… metrics may be stale"', () => {
    const err = new ReconcileAfterPromoteError(new Error('phase 4 boom'));
    const t = classifyRebuildError(err, { batchLabel: 'Jan 2026' });
    expect(t.variant).toBe('warning');
    expect(t.classId).toBe('rebuild-promoted-reconcile-failed');
    expect(t.title).toMatch(/partially completed/i);
    expect(t.title).toContain('Jan 2026');
    expect(t.description).toMatch(/promoted/i);
    expect(t.description).toMatch(/reconcile failed/i);
    expect(t.description).toMatch(/may be stale/i);
    expect(t.description).toMatch(/click rebuild to complete/i);
  });

  it('class 6: lock_not_available message → info "Another rebuild is already running"', () => {
    const err: any = new Error('acquireRebuildLock failed for batch b1: lock_not_available');
    err.code = '55P03';
    const t = classifyRebuildError(err);
    expect(t.variant).toBe('info');
    expect(t.classId).toBe('rebuild-lock-contention');
    expect(t.description).toMatch(/another rebuild is already running/i);
    expect(t.description).toMatch(/wait/i);
  });

  it('class 6: SQLSTATE 55P03 alone is enough', () => {
    const err: any = new Error('something');
    err.code = '55P03';
    const t = classifyRebuildError(err);
    expect(t.classId).toBe('rebuild-lock-contention');
    expect(t.variant).toBe('info');
  });

  it('class 4a: aggregate guard (zero-EDE wipe) → destructive "row count was zero… preserved"', () => {
    const err = new Error(
      'replaceNormalizedForFileSet failed: required source type EDE has 0 staged rows for batch b1 (refusing to promote — would wipe active EDE data)',
    );
    const t = classifyRebuildError(err);
    expect(t.variant).toBe('destructive');
    expect(t.classId).toBe('rebuild-aggregate-guard');
    expect(t.description).toMatch(/EDE/);
    expect(t.description).toMatch(/row count was zero/i);
    expect(t.description).toMatch(/old active data was preserved/i);
  });

  it('class 4b: per-file count mismatch → destructive "staged row count did not match… preserved"', () => {
    const err = new Error(
      'replaceNormalizedForFileSet failed: count mismatch for file f1 (expected 100, staged 99)',
    );
    const t = classifyRebuildError(err);
    expect(t.variant).toBe('destructive');
    expect(t.classId).toBe('rebuild-count-mismatch');
    expect(t.description).toMatch(/staged row count did not match/i);
    expect(t.description).toMatch(/old active data was preserved/i);
  });

  it('class 3: staging / parse failure → destructive "Old active data was preserved"', () => {
    const err = new Error('Storage download failed for batches/x.csv: not found');
    const t = classifyRebuildError(err, { batchLabel: 'Feb 2026', fileLabel: 'EDE' });
    expect(t.variant).toBe('destructive');
    expect(t.classId).toBe('rebuild-staging-failed');
    expect(t.title).toMatch(/staging/i);
    expect(t.description).toMatch(/old active data was preserved/i);
    expect(t.description).toContain('EDE');
  });

  it('class 7: unknown error → destructive "Operation failed unexpectedly"', () => {
    const t = classifyRebuildError(new Error('weird sideways failure'));
    expect(t.variant).toBe('destructive');
    expect(t.classId).toBe('unexpected');
    expect(t.title).toMatch(/unexpectedly/i);
    expect(t.description).toMatch(/check console details/i);
  });

  it('class 7: matches even when err is not an Error', () => {
    const t = classifyRebuildError({ foo: 'bar' });
    expect(t.classId).toBe('unexpected');
    expect(t.variant).toBe('destructive');
  });

  it('class 5 wins over class 4 when promote already committed (ReconcileAfterPromoteError carries underlying message)', () => {
    // Even if the underlying message looks like a count mismatch, the
    // outer ReconcileAfterPromoteError must still classify as the
    // promoted-but-reconcile-failed bucket.
    const inner = new Error('count mismatch for file f1 (expected 5, staged 4)');
    const err = new ReconcileAfterPromoteError(inner);
    const t = classifyRebuildError(err);
    expect(t.classId).toBe('rebuild-promoted-reconcile-failed');
    expect(t.variant).toBe('warning');
  });
});

describe('variant-to-severity contract', () => {
  it('every "data not saved / rolled back" class is destructive', () => {
    const destructiveClasses = [
      classifyUploadError(new Error('rpc x'), { phase: 'rpc' }),
      classifyRebuildError(new Error('required source type EDE has 0 staged rows')),
      classifyRebuildError(new Error('count mismatch for file f1')),
      classifyRebuildError(new Error('Storage download failed: x')),
      classifyRebuildError(new Error('totally unknown')),
    ];
    for (const t of destructiveClasses) {
      expect(t.variant).toBe('destructive');
    }
  });

  it('every "saved but stale" class is warning, never destructive', () => {
    const warningClasses = [
      classifyUploadError(new Error('reconcile x'), { phase: 'after-upload' }),
      classifyRebuildError(new ReconcileAfterPromoteError(new Error('x'))),
    ];
    for (const t of warningClasses) {
      expect(t.variant).toBe('warning');
      expect(t.title.toLowerCase()).not.toMatch(/^upload failed|^rebuild failed/);
    }
  });

  it('lock contention is info, not destructive (operator just waits)', () => {
    const t = classifyRebuildError(
      Object.assign(new Error('lock_not_available'), { code: '55P03' }),
    );
    expect(t.variant).toBe('info');
  });
});
