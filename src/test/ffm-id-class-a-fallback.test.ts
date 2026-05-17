/**
 * Pure tests for the FFM-ID Class-A display/export fallback:
 *   - buildEdeFfmFallbackIndex (aorPicker)
 *   - collectFfmAppIds(recs, fallbackCandidates?)
 *   - pickFfmIdCandidate via buildMemberProfile(fallbackFfmCandidates)
 *
 * Covers safety rules 1-8 and tests 1-7 from the FFM-ID Class-A directive.
 */
import { describe, it, expect } from 'vitest';
import {
  buildEdeFfmFallbackIndex,
  collectFfmAppIds,
} from '@/lib/aorPicker';
import { buildMemberProfile } from '@/lib/canonical/memberProfileView';
import type { NormalizedRecord } from '@/lib/normalize';

function ede(o: {
  batch_id?: string;
  carrier?: string;
  ffmAppId?: string;
  exchange_subscriber_id?: string;
  issuer_subscriber_id?: string;
  effective_date?: string;
  status?: string;
  source_file_label?: string;
  member_key?: string;
}): NormalizedRecord {
  const raw: Record<string, any> = {};
  if (o.ffmAppId !== undefined) raw['ffmAppId'] = o.ffmAppId;
  if (o.status !== undefined) raw['policyStatus'] = o.status;
  return {
    source_type: 'EDE',
    source_file_label: o.source_file_label ?? 'EDE Summary',
    carrier: o.carrier ?? 'Ambetter',
    effective_date: o.effective_date ?? '2026-01-01',
    raw_json: raw,
    batch_id: o.batch_id ?? 'B1',
    exchange_subscriber_id: o.exchange_subscriber_id ?? '',
    issuer_subscriber_id: o.issuer_subscriber_id ?? '',
    member_key: o.member_key ?? 'sub:X',
  } as any;
}

function bo(o: {
  batch_id?: string;
  carrier?: string;
  exchange_subscriber_id?: string;
  issuer_subscriber_id?: string;
  member_key?: string;
}): NormalizedRecord {
  return {
    source_type: 'BACK_OFFICE',
    source_file_label: 'Jason Back Office',
    carrier: o.carrier ?? 'Ambetter',
    raw_json: {},
    batch_id: o.batch_id ?? 'B1',
    exchange_subscriber_id: o.exchange_subscriber_id ?? '',
    issuer_subscriber_id: o.issuer_subscriber_id ?? '',
    member_key: o.member_key ?? 'issub:U',
  } as any;
}

describe('FFM-ID Class-A fallback — pure helpers', () => {
  it('Test 1 — resolves Class A via fallback (BO same-key has no FFM; EDE under different key shares exchange_subscriber_id)', () => {
    const boRec = bo({ exchange_subscriber_id: '4079093', issuer_subscriber_id: 'u70033864' });
    const edeRec = ede({
      member_key: 'sub:4079093',
      exchange_subscriber_id: '4079093',
      ffmAppId: 'FFM-NEW-123',
    });
    const idx = buildEdeFfmFallbackIndex([boRec, edeRec]);
    const cands = idx.lookup({
      batch_id: 'B1',
      carrier: 'Ambetter',
      exchange_subscriber_id: '4079093',
      issuer_subscriber_id: 'u70033864',
    });
    expect(cands).toHaveLength(1);
    const profile = buildMemberProfile('issub:u70033864', {
      records: [boRec],
      fallbackFfmCandidates: cands,
    });
    expect(profile.ffm_id.value).toBe('FFM-NEW-123');
    expect(profile.ffm_id.source_type).toBe('ede');
  });

  it('Test 2 — Class D unchanged (no matching EDE candidate → blank)', () => {
    const boRec = bo({ exchange_subscriber_id: '999', issuer_subscriber_id: 'u999' });
    const idx = buildEdeFfmFallbackIndex([boRec]); // no EDE at all
    const cands = idx.lookup({
      batch_id: 'B1',
      carrier: 'Ambetter',
      exchange_subscriber_id: '999',
      issuer_subscriber_id: 'u999',
    });
    expect(cands).toEqual([]);
    const profile = buildMemberProfile('issub:u999', {
      records: [boRec],
      fallbackFfmCandidates: cands,
    });
    expect(profile.ffm_id.value).toBeNull();
  });

  it('Test 3 — same-key FFM wins; fallback is ignored', () => {
    const sameKeyEde = ede({
      member_key: 'sub:1',
      exchange_subscriber_id: '1',
      ffmAppId: 'FFM-SAME-KEY-999',
    });
    const fallbackEde = ede({
      member_key: 'sub:OTHER',
      exchange_subscriber_id: '1',
      ffmAppId: 'FFM-FALLBACK-888',
    });
    // collectFfmAppIds direct check
    const ids = collectFfmAppIds([sameKeyEde], [fallbackEde]);
    expect(ids).toEqual(['FFM-SAME-KEY-999']);
    // profile check
    const profile = buildMemberProfile('sub:1', {
      records: [sameKeyEde],
      fallbackFfmCandidates: [fallbackEde],
    });
    expect(profile.ffm_id.value).toBe('FFM-SAME-KEY-999');
  });

  it('Test 4 — batch scope: same subscriber id in different batch does NOT match', () => {
    const otherBatchEde = ede({
      batch_id: 'B2',
      member_key: 'sub:1',
      exchange_subscriber_id: '1',
      ffmAppId: 'FFM-OTHER-BATCH',
    });
    const idx = buildEdeFfmFallbackIndex([otherBatchEde]);
    const cands = idx.lookup({
      batch_id: 'B1',
      carrier: 'Ambetter',
      exchange_subscriber_id: '1',
    });
    expect(cands).toEqual([]);
  });

  it('Test 5 — carrier scope: mismatched carrier excluded; blank carrier on either side allows match', () => {
    const aetnaEde = ede({
      member_key: 'sub:1',
      exchange_subscriber_id: '1',
      carrier: 'Aetna',
      ffmAppId: 'FFM-AETNA',
    });
    const idx = buildEdeFfmFallbackIndex([aetnaEde]);
    // Both sides nonblank, mismatch → excluded
    expect(
      idx.lookup({ batch_id: 'B1', carrier: 'Ambetter', exchange_subscriber_id: '1' }),
    ).toEqual([]);
    // Scope blank → allowed
    expect(
      idx.lookup({ batch_id: 'B1', carrier: undefined, exchange_subscriber_id: '1' }),
    ).toHaveLength(1);
    // Candidate blank carrier → allowed
    const blankCarrierEde = ede({
      member_key: 'sub:2',
      exchange_subscriber_id: '2',
      carrier: '',
      ffmAppId: 'FFM-BLANK-CARRIER',
    });
    const idx2 = buildEdeFfmFallbackIndex([blankCarrierEde]);
    expect(
      idx2.lookup({ batch_id: 'B1', carrier: 'Ambetter', exchange_subscriber_id: '2' }),
    ).toHaveLength(1);
  });

  it('Test 6 — #76 precedence wins: newer effective_date wins among fallback candidates', () => {
    const older = ede({
      member_key: 'sub:OLD',
      exchange_subscriber_id: '1',
      effective_date: '2025-09-01',
      status: 'Effectuated',
      ffmAppId: 'FFM-OLD',
    });
    const newer = ede({
      member_key: 'sub:NEW',
      exchange_subscriber_id: '1',
      effective_date: '2026-02-01',
      status: 'Effectuated',
      ffmAppId: 'FFM-NEW',
    });
    const boRec = bo({ exchange_subscriber_id: '1' });
    const idx = buildEdeFfmFallbackIndex([older, newer, boRec]);
    const cands = idx.lookup({
      batch_id: 'B1',
      carrier: 'Ambetter',
      exchange_subscriber_id: '1',
    });
    const profile = buildMemberProfile('issub:U', {
      records: [boRec],
      fallbackFfmCandidates: cands,
    });
    expect(profile.ffm_id.value).toBe('FFM-NEW');
  });

  it('Test 7 — conflict metadata surfaces distinct losing fallback FFM IDs', () => {
    const winner = ede({
      member_key: 'sub:W',
      exchange_subscriber_id: '1',
      effective_date: '2026-02-01',
      status: 'Effectuated',
      ffmAppId: 'FFM-WIN',
    });
    const loser = ede({
      member_key: 'sub:L',
      exchange_subscriber_id: '1',
      effective_date: '2025-09-01',
      status: 'Effectuated',
      ffmAppId: 'FFM-LOSE',
    });
    const boRec = bo({ exchange_subscriber_id: '1' });
    const idx = buildEdeFfmFallbackIndex([winner, loser, boRec]);
    const cands = idx.lookup({
      batch_id: 'B1',
      carrier: 'Ambetter',
      exchange_subscriber_id: '1',
    });
    const profile = buildMemberProfile('issub:U', {
      records: [boRec],
      fallbackFfmCandidates: cands,
    });
    expect(profile.ffm_id.value).toBe('FFM-WIN');
    expect(profile.ffm_id.conflict).toBe(true);
    expect(profile.ffm_id.conflict_values.map((c) => c.value)).toContain('FFM-LOSE');
  });

  it('Reconcile-path guard — collectFfmAppIds(recs) with no second arg is byte-equivalent to pre-fallback behavior', () => {
    const r1 = ede({ ffmAppId: 'A' });
    const r2 = ede({ ffmAppId: 'B' });
    const r3 = ede({ ffmAppId: '' });
    expect(collectFfmAppIds([r1, r2, r3])).toEqual(['A', 'B']);
    expect(collectFfmAppIds([])).toEqual([]);
  });

  it('Member Timeline Test 9 — buildMemberTimeline surfaces ffm_app_ids via fallback when same-key empty', async () => {
    const { buildMemberTimeline, buildMemberTimelineExportRows, buildMonthList } = await import('@/lib/memberTimeline');
    const boRec = bo({
      member_key: 'issub:u70033864',
      exchange_subscriber_id: '4079093',
      issuer_subscriber_id: 'u70033864',
    });
    (boRec as any).effective_date = '2026-01-01';
    (boRec as any).applicant_name = 'Diedric Mccullough';
    const edeRec = ede({
      member_key: 'sub:4079093',
      exchange_subscriber_id: '4079093',
      ffmAppId: '7299388894',
      effective_date: '2026-01-01',
      status: 'Effectuated',
    });
    (edeRec as any).raw_json.issuer = 'Ambetter';
    const monthList = buildMonthList('2026-01', '2026-01');
    const rows = buildMemberTimeline([boRec, edeRec], monthList);
    const target = rows.find((r) => r.member_key === 'issub:u70033864');
    expect(target).toBeDefined();
    expect(target!.ffm_app_ids).toEqual(['7299388894']);
    const exportRows = buildMemberTimelineExportRows(rows, monthList);
    const exp = exportRows.find((r) => r.member === 'Diedric Mccullough');
    expect(exp).toBeDefined();
    expect(Object.keys(exp!)[0]).toBe('ffm_app_id');
    expect(exp!.ffm_app_id).toBe('7299388894');
  });
});
