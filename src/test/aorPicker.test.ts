import { describe, it, expect } from 'vitest';
import { pickCurrentPolicyAor } from '@/lib/aorPicker';
import { aorBelongsToScope } from '@/lib/canonical/scope';
import type { NormalizedRecord } from '@/lib/normalize';

/**
 * Tests for aorPicker.pickCurrentPolicyAor — documenting both the CURRENT
 * (#75) contract and the EXPECTED post-#76 contract.
 *
 * Fixture shape modeled on Marjorie McCoy / Aiselmo case:
 *   issuerSubscriberId U98270260
 *   ffmAppIds: 7227764196 (Coverall original) and 7885566780 (duplicate)
 *   AORs: Jason Fine (21055210) Coverall vs Camden Brech (21648873) external
 */

function ede(overrides: {
  ffmAppId?: string;
  status: string;
  effective_date: string | null;
  aor: string;
  source_file_label?: string;
  lastEDESync?: string;
  issuerSubscriberId?: string;
}): NormalizedRecord {
  return {
    source_type: 'EDE',
    source_file_label: overrides.source_file_label ?? 'EDE Summary',
    effective_date: overrides.effective_date,
    status: overrides.status,
    raw_json: {
      policyStatus: overrides.status,
      currentPolicyAOR: overrides.aor,
      ffmAppId: overrides.ffmAppId ?? '7227764196',
      issuerSubscriberId: overrides.issuerSubscriberId ?? 'U98270260',
      lastEDESync: overrides.lastEDESync,
    },
  } as unknown as NormalizedRecord;
}

describe('aorPicker.pickCurrentPolicyAor — picker contract (post-#76)', () => {
  it('A: same effective_date — status priority wins (Effectuated > PendingEffectuation)', () => {
    const rowA = ede({
      status: 'Effectuated',
      effective_date: '2026-04-01',
      aor: 'Jason Fine (21055210)',
    });
    const rowB = ede({
      status: 'PendingEffectuation',
      effective_date: '2026-04-01',
      aor: 'External Agent (99999999)',
    });
    expect(pickCurrentPolicyAor([rowA, rowB])).toBe('Jason Fine (21055210)');
    // Order-independent
    expect(pickCurrentPolicyAor([rowB, rowA])).toBe('Jason Fine (21055210)');
  });

  it('B: multi-FFM — newer eff_date wins over older Effectuated (post-#76)', () => {
    // Post-#76: eff_date desc is the primary tiebreaker, so the newer
    // PendingEffectuation row beats the older Effectuated row.
    const rowA = ede({
      ffmAppId: '7885566780',
      status: 'Effectuated',
      effective_date: '2026-03-01',
      aor: 'Camden Brech (21648873)',
      lastEDESync: '2026-03-06',
    });
    const rowB = ede({
      ffmAppId: '7227764196',
      status: 'PendingEffectuation',
      effective_date: '2026-04-01',
      aor: 'Jason Fine (21055210)',
      lastEDESync: '2026-04-27',
    });
    expect(pickCurrentPolicyAor([rowA, rowB])).toBe('Jason Fine (21055210)');
    expect(pickCurrentPolicyAor([rowB, rowA])).toBe('Jason Fine (21055210)');
  });

  it('C: drift-OUT case — picker is scope-agnostic; scope filtering happens AFTER picking', () => {
    const row = ede({
      status: 'Effectuated',
      effective_date: '2026-04-01',
      aor: 'External Agent (12345678)',
    });
    const picked = pickCurrentPolicyAor([row]);
    expect(picked).toBe('External Agent (12345678)');
    expect(aorBelongsToScope(picked, 'Coverall')).toBe(false);
  });
});

describe('aorPicker.pickCurrentPolicyAor — post-#76 contract (eff_date desc + lastEDESync tiebreak)', () => {
  it('D: newer PendingEffectuation beats older Effectuated (Marjorie/Aiselmo case)', () => {
    const rowA = ede({
      ffmAppId: '7885566780',
      status: 'Effectuated',
      effective_date: '2026-03-01',
      aor: 'Camden Brech (21648873)',
      lastEDESync: '2026-03-06',
    });
    const rowB = ede({
      ffmAppId: '7227764196',
      status: 'PendingEffectuation',
      effective_date: '2026-04-01',
      aor: 'Jason Fine (21055210)',
      lastEDESync: '2026-04-27',
    });
    expect(pickCurrentPolicyAor([rowA, rowB])).toBe('Jason Fine (21055210)');
  });

  it('E: same eff_date and status — lastEDESync desc wins', () => {
    const rowA = ede({
      status: 'Effectuated',
      effective_date: '2026-04-01',
      aor: 'Camden Brech (21648873)',
      lastEDESync: '2026-03-06',
    });
    const rowB = ede({
      status: 'Effectuated',
      effective_date: '2026-04-01',
      aor: 'Jason Fine (21055210)',
      lastEDESync: '2026-04-27',
    });
    expect(pickCurrentPolicyAor([rowA, rowB])).toBe('Jason Fine (21055210)');
  });
});
