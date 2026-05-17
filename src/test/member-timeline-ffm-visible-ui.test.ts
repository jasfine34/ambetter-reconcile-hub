/**
 * FFM ID Class-A visible-UI lock-in test.
 *
 * Asserts that fallback FFM IDs (recovered from EDE rows under a different
 * member_key) surface in `row.ffm_app_ids`, which feeds both the AOR-cell
 * tooltip (`ffmAppIds: …`) and the `Nx FFM` badge in MemberTimelinePage.
 *
 * Test-only patch — no source code changes.
 */
import { describe, it, expect } from 'vitest';
import { buildMemberTimeline, buildMonthList } from '@/lib/memberTimeline';
import type { NormalizedRecord } from '@/lib/normalize';

function bo(o: {
  batch_id?: string;
  carrier?: string;
  exchange_subscriber_id?: string;
  issuer_subscriber_id?: string;
  member_key?: string;
  applicant_name?: string;
  effective_date?: string;
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
    applicant_name: o.applicant_name ?? 'Diedric Mccullough',
    effective_date: o.effective_date ?? '2026-01-01',
  } as any;
}

function ede(o: {
  batch_id?: string;
  carrier?: string;
  ffmAppId?: string;
  exchange_subscriber_id?: string;
  issuer_subscriber_id?: string;
  member_key?: string;
  effective_date?: string;
  status?: string;
}): NormalizedRecord {
  const raw: Record<string, any> = {};
  if (o.ffmAppId !== undefined) raw['ffmAppId'] = o.ffmAppId;
  if (o.status !== undefined) raw['policyStatus'] = o.status;
  raw['issuer'] = 'Ambetter';
  return {
    source_type: 'EDE',
    source_file_label: 'EDE Summary',
    carrier: o.carrier ?? 'Ambetter',
    effective_date: o.effective_date ?? '2026-01-01',
    raw_json: raw,
    batch_id: o.batch_id ?? 'B1',
    exchange_subscriber_id: o.exchange_subscriber_id ?? '',
    issuer_subscriber_id: o.issuer_subscriber_id ?? '',
    member_key: o.member_key ?? 'sub:X',
  } as any;
}

describe('Member Timeline visible UI — fallback FFM IDs (Class-A)', () => {
  it('surfaces fallback FFM ID in ffm_app_ids for the BO-key row', () => {
    const boRec = bo({
      member_key: 'issub:u70033864',
      exchange_subscriber_id: '4079093',
      issuer_subscriber_id: 'u70033864',
      applicant_name: 'Diedric Mccullough',
    });

    const edeRec = ede({
      member_key: 'sub:4079093',
      exchange_subscriber_id: '4079093',
      ffmAppId: 'FFM-VISIBLE-TEST-7299388894',
      status: 'Effectuated',
    });

    const monthList = buildMonthList('2026-01', '2026-01');
    const rows = buildMemberTimeline([boRec, edeRec], monthList);

    // buildMemberTimeline groups by member_key, so we get two rows.
    const boRow = rows.find((r) => r.member_key === 'issub:u70033864');
    const edeRow = rows.find((r) => r.member_key === 'sub:4079093');

    expect(boRow).toBeDefined();
    expect(edeRow).toBeDefined();

    // The BO-key row receives the fallback FFM ID from the EDE row.
    expect(boRow!.ffm_app_ids).toContain('FFM-VISIBLE-TEST-7299388894');

    // Subscriber IDs are lookup keys only and must NOT be surfaced as FFM IDs.
    expect(boRow!.ffm_app_ids).not.toContain('4079093');
    expect(boRow!.ffm_app_ids).not.toContain('u70033864');

    // The EDE-key row carries its own FFM ID via same-key collection.
    expect(edeRow!.ffm_app_ids).toContain('FFM-VISIBLE-TEST-7299388894');
  });

  it('shows 2x FFM badge when two distinct fallback candidates exist', () => {
    const boRec = bo({
      member_key: 'issub:u70033864',
      exchange_subscriber_id: '4079093',
      issuer_subscriber_id: 'u70033864',
      applicant_name: 'Diedric Mccullough',
    });

    const edeRec1 = ede({
      member_key: 'sub:4079093',
      exchange_subscriber_id: '4079093',
      ffmAppId: 'FFM-VISIBLE-TEST-7299388894',
      status: 'Effectuated',
    });

    const edeRec2 = ede({
      member_key: 'sub:OTHER',
      exchange_subscriber_id: '4079093',
      ffmAppId: 'FFM-VISIBLE-TEST-SECOND-111',
      status: 'Effectuated',
      effective_date: '2026-02-01',
    });

    const monthList = buildMonthList('2026-01', '2026-02');
    const rows = buildMemberTimeline([boRec, edeRec1, edeRec2], monthList);

    const boRow = rows.find((r) => r.member_key === 'issub:u70033864');
    expect(boRow).toBeDefined();
    expect(boRow!.ffm_app_ids).toEqual(
      expect.arrayContaining([
        'FFM-VISIBLE-TEST-7299388894',
        'FFM-VISIBLE-TEST-SECOND-111',
      ])
    );
    // The badge renders when length > 1, so this locks that visible path.
    expect(boRow!.ffm_app_ids.length).toBeGreaterThan(1);
  });
});
