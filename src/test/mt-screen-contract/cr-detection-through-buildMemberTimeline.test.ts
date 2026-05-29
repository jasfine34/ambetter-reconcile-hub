/**
 * Test 2 — CR detection through buildMemberTimeline (pure unit).
 *
 * Enforces docs/mt-screen-contract.md "Carrier-recognition (CR) cell badge"
 * trigger condition. Exercises the exported assembly fn directly; does NOT
 * call private detectCarrierRecognition.
 */
import { describe, it, expect } from 'vitest';
import { buildMemberTimeline, buildMonthList } from '@/lib/memberTimeline';
import type { NormalizedRecord } from '@/lib/normalize';

const COVERALL_NPN = '21055210';
const COVERALL_NAME = 'Jason Fine';

function bo(over: Partial<NormalizedRecord> & { broker_name?: string } = {}): NormalizedRecord {
  const { broker_name, ...rest } = over;
  return {
    id: Math.random().toString(36).slice(2),
    source_type: 'BACK_OFFICE',
    carrier: 'Ambetter',
    agent_npn: COVERALL_NPN,
    agent_name: COVERALL_NAME,
    aor_bucket: COVERALL_NAME,
    member_key: 'issub:U1',
    applicant_name: 'Test Member',
    policy_number: 'P1',
    issuer_subscriber_id: 'U1',
    effective_date: '2026-01-01',
    broker_effective_date: '2026-01-01',
    raw_json: { 'Broker Name': broker_name ?? COVERALL_NAME },
    ...rest,
  } as any;
}

function ede(over: Partial<NormalizedRecord> & { currentPolicyAOR?: string } = {}): NormalizedRecord {
  const { currentPolicyAOR, ...rest } = over;
  return {
    id: Math.random().toString(36).slice(2),
    source_type: 'EDE',
    carrier: 'Ambetter',
    member_key: 'issub:U1',
    applicant_name: 'Test Member',
    policy_number: 'P1',
    issuer_subscriber_id: 'U1',
    effective_date: '2026-01-01',
    net_premium: 250,
    raw_json: {
      issuer: 'Ambetter',
      policyStatus: 'Effectuated',
      currentPolicyAOR: currentPolicyAOR ?? 'Michael Farago (20629024)',
    },
    ...rest,
  } as any;
}

const M = '2026-01';
const monthList = buildMonthList(M, M);

function buildOnce(
  recs: NormalizedRecord[],
  opts: Parameters<typeof buildMemberTimeline>[3],
) {
  const rawByMember = new Map<string, NormalizedRecord[]>();
  for (const r of recs) {
    const key = r.member_key || 'unknown';
    let a = rawByMember.get(key);
    if (!a) { a = []; rawByMember.set(key, a); }
    a.push(r);
  }
  return buildMemberTimeline(recs, monthList, () => true, {
    rawRecordsByMemberKey: rawByMember,
    ...opts,
  });
}

describe('Test 2 — CR detection through buildMemberTimeline', () => {
  it('positive fire: in-scope BO + non-scope picked EDE → carrier_recognition=true', () => {
    const rows = buildOnce([bo(), ede()], {
      selectedAorScope: 'official',
      payEntity: 'Coverall',
    });
    const cell = rows[0].cells[M];
    expect(cell.carrier_recognition).toBe(true);
    expect(cell.carrier_recognition_premium).toBe(250);
  });

  it('negative — selectedAorScope=all → CR not flagged', () => {
    const rows = buildOnce([bo(), ede()], {
      selectedAorScope: 'all',
      payEntity: 'Coverall',
    });
    const cell = rows[0].cells[M];
    expect(cell.carrier_recognition).toBeFalsy();
  });

  it('negative — picked EDE has in-scope AOR → CR not flagged', () => {
    const rows = buildOnce([bo(), ede({ raw_json: {
      issuer: 'Ambetter', policyStatus: 'Effectuated',
      currentPolicyAOR: `${COVERALL_NAME} (${COVERALL_NPN})`,
    } })], {
      selectedAorScope: 'official',
      payEntity: 'Coverall',
    });
    const cell = rows[0].cells[M];
    expect(cell.carrier_recognition).toBeFalsy();
  });

  it('negative — no in-scope BO row → CR not flagged', () => {
    const rows = buildOnce([ede()], {
      selectedAorScope: 'official',
      payEntity: 'Coverall',
    });
    const cell = rows[0]?.cells[M];
    expect(cell?.carrier_recognition).toBeFalsy();
  });
});
