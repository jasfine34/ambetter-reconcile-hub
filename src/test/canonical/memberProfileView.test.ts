/**
 * Pure tests for the FFM ID picker special-cased inside
 * buildMemberProfile (#76 multi-FFM precedence via compareEDEForAor).
 */
import { describe, it, expect } from 'vitest';
import { buildMemberProfile } from '@/lib/canonical/memberProfileView';
import type { NormalizedRecord } from '@/lib/normalize';

function ede(overrides: Partial<NormalizedRecord> & { ffmAppId?: string; status?: string; effective_date?: string; source_file_label?: string; lastEDESync?: string; batch_id?: string }): NormalizedRecord {
  const raw: Record<string, any> = {};
  if (overrides.ffmAppId !== undefined) raw['ffmAppId'] = overrides.ffmAppId;
  if (overrides.status !== undefined) raw['policyStatus'] = overrides.status;
  if (overrides.lastEDESync !== undefined) raw['lastEDESync'] = overrides.lastEDESync;
  return {
    source_type: 'EDE',
    source_file_label: overrides.source_file_label ?? 'EDE Summary',
    effective_date: overrides.effective_date ?? '2026-01-01',
    raw_json: raw,
    batch_id: overrides.batch_id ?? 'b1',
    ...overrides,
  } as any;
}

function bo(overrides: Partial<NormalizedRecord> = {}): NormalizedRecord {
  return {
    source_type: 'BACK_OFFICE',
    source_file_label: 'Jason Back Office',
    raw_json: {},
    batch_id: 'b1',
    ...overrides,
  } as any;
}

describe('buildMemberProfile — pickFfmIdCandidate (#76 picker)', () => {
  it('single EDE row with ffmAppId wins', () => {
    const p = buildMemberProfile('m1', { records: [ede({ ffmAppId: 'FFM-123' })] });
    expect(p.ffm_id.value).toBe('FFM-123');
    expect(p.ffm_id.source_type).toBe('ede');
  });

  it('BO-only member has empty ffm_id', () => {
    const p = buildMemberProfile('m1', { records: [bo()] });
    expect(p.ffm_id.value).toBeNull();
    expect(p.ffm_id.source_type).toBeNull();
  });

  it('newer effective_date wins', () => {
    const records = [
      ede({ ffmAppId: 'FFM-OLD-111', effective_date: '2025-09-01', status: 'Effectuated' }),
      ede({ ffmAppId: 'FFM-NEW-222', effective_date: '2026-02-01', status: 'PendingEffectuation' }),
    ];
    const p = buildMemberProfile('m1', { records });
    expect(p.ffm_id.value).toBe('FFM-NEW-222');
  });

  it('same effective_date — higher status priority wins (Effectuated > PendingEffectuation)', () => {
    const records = [
      ede({ ffmAppId: 'FFM-PEND', effective_date: '2026-01-01', status: 'PendingEffectuation' }),
      ede({ ffmAppId: 'FFM-EFF', effective_date: '2026-01-01', status: 'Effectuated' }),
    ];
    const p = buildMemberProfile('m1', { records });
    expect(p.ffm_id.value).toBe('FFM-EFF');
  });

  it('conflict metadata surfaces distinct losing FFM IDs', () => {
    const records = [
      ede({ ffmAppId: 'FFM-WIN', effective_date: '2026-02-01', status: 'Effectuated' }),
      ede({ ffmAppId: 'FFM-LOSE', effective_date: '2025-09-01', status: 'Effectuated' }),
    ];
    const p = buildMemberProfile('m1', { records });
    expect(p.ffm_id.value).toBe('FFM-WIN');
    expect(p.ffm_id.conflict).toBe(true);
    expect(p.ffm_id.conflict_values.map(c => c.value)).toContain('FFM-LOSE');
  });

  it('skips EDE rows with blank ffmAppId — picks next qualifying EDE row', () => {
    // Blank-ffmAppId rows are filtered out of the candidate pool, so the
    // populated row wins even if it would otherwise lose by precedence.
    const records = [
      ede({ ffmAppId: '', effective_date: '2026-02-01', status: 'Effectuated' }),
      ede({ ffmAppId: 'FFM-FALLBACK', effective_date: '2025-09-01', status: 'Effectuated' }),
    ];
    const p = buildMemberProfile('m1', { records });
    expect(p.ffm_id.value).toBe('FFM-FALLBACK');
  });
});
