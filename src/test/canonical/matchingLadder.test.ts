/**
 * Matching ladder — Ambetter dual-key regression guard.
 *
 * Locks in the EDE↔BO matching behavior validated by Codex review pass #2's
 * raw-file audit. Ambetter's BO export stores the issuer subscriber id in the
 * `Policy Number` column (see src/lib/carriers/ambetter/backOffice.ts), so a
 * BO row participates in matching with BOTH `policy_number` and
 * `issuer_subscriber_id` populated from that single column. This test pins
 * three ladder paths so future refactors don't silently regress them:
 *
 *   1. Primary  — EDE.exchange_subscriber_id ↔ BO.exchange_subscriber_id.
 *   2. Fallback — EDE.issuer_subscriber_id   ↔ BO.policy_number
 *                 (Ambetter's "Policy column = issuer sub id" quirk).
 *   3. Unmatched — EDE row with no corresponding BO row stays
 *                  in_back_office === false.
 *
 * Behavior, not totals — the big audit counts (1052/502/214) live in the
 * audit doc, not here. This is intentionally test-only: no production logic
 * change, no RECONCILE_LOGIC_VERSION bump.
 */
import { describe, it, expect } from 'vitest';
import { normalizeEDERow, normalizeBackOfficeRow, type NormalizedRecord } from '@/lib/normalize';
import { reconcile } from '@/lib/reconcile';

function ede(opts: {
  first: string;
  last: string;
  exchangeSubId?: string;
  issuerSubId?: string;
  effective?: string;
}): NormalizedRecord {
  const row: Record<string, string> = {
    issuer: 'Ambetter',
    applicantFirstName: opts.first,
    applicantLastName: opts.last,
    applicantName: `${opts.first} ${opts.last}`,
    exchangeSubscriberId: opts.exchangeSubId ?? '',
    issuerSubscriberId: opts.issuerSubId ?? '',
    policyStatus: 'Effectuated',
    effectiveDate: opts.effective ?? '2026-02-01',
    premium: '500.00',
  };
  const r = normalizeEDERow(row, 'EDE Test');
  if (!r) throw new Error('EDE normalization returned null — fixture invalid');
  return r;
}

function bo(opts: {
  first: string;
  last: string;
  // Ambetter BO: this column feeds BOTH policy_number AND issuer_subscriber_id.
  policyNumber: string;
  exchangeSubId?: string;
}): NormalizedRecord {
  const row: Record<string, string> = {
    'Broker Name': 'Test Agent',
    'Broker NPN': '12345',
    'Policy Number': opts.policyNumber,
    'Insured First Name': opts.first,
    'Insured Last Name': opts.last,
    'Broker Effective Date': '2026-01-01',
    'Broker Term Date': '12/31/9999',
    'Policy Effective Date': '2026-02-01',
    'Policy Term Date': '2026-12-31',
    'Paid Through Date': '2026-02-28',
    'Monthly Premium Amount': '500.00',
    'Exchange Subscriber ID': opts.exchangeSubId ?? '',
    'Eligible for Commission': 'Yes',
  };
  return normalizeBackOfficeRow(row, 'BO Test', 'Jason Fine');
}

describe('Ambetter EDE↔BO matching ladder', () => {
  it('preserves Ambetter BO quirk: Policy Number column populates both policy_number and issuer_subscriber_id', () => {
    const boRow = bo({ first: 'Quirk', last: 'Check', policyNumber: 'U99999001' });
    expect(boRow.policy_number).toBe('u99999001');
    expect(boRow.issuer_subscriber_id).toBe('u99999001');
  });

  it('matches all three ladder paths: primary (esid), fallback (issuer-sub→policy), and unmatched', () => {
    // (1) Primary path: EDE has exchange_subscriber_id that matches BO.Exchange Subscriber ID.
    //     Use distinct issuer ids to prove the join is via esid, not issuer.
    const edePrimary = ede({
      first: 'Primary',
      last: 'Match',
      exchangeSubId: '0001111111',
      issuerSubId: 'U10000001',
    });
    const boPrimary = bo({
      first: 'Primary',
      last: 'Match',
      policyNumber: 'U99999998', // intentionally NOT the EDE issuer id
      exchangeSubId: '0001111111',
    });

    // (2) Fallback path: EDE has issuer_subscriber_id that matches BO Policy Number
    //     (Ambetter quirk — BO's Policy column IS the issuer sub id). EDE has
    //     NO exchange_subscriber_id, so the primary path cannot fire.
    const edeFallback = ede({
      first: 'Fallback',
      last: 'Match',
      issuerSubId: 'U20000002',
      // no exchangeSubId
    });
    const boFallback = bo({
      first: 'Fallback',
      last: 'Match',
      policyNumber: 'U20000002', // BO Policy column carries the issuer sub id
      // no exchangeSubId, so primary can't fire
    });

    // (3) Unmatched: EDE-only member with no BO row anywhere.
    const edeOrphan = ede({
      first: 'Orphan',
      last: 'Member',
      exchangeSubId: '0009999999',
      issuerSubId: 'U30000003',
    });

    const records = [edePrimary, boPrimary, edeFallback, boFallback, edeOrphan];
    const { members } = reconcile(records, '2026-02');

    const byName = new Map(members.map(m => [m.applicant_name.trim().toLowerCase(), m]));
    const primary = byName.get('primary match');
    const fallback = byName.get('fallback match');
    const orphan = byName.get('orphan member');

    // Primary ladder path: joined via exchange_subscriber_id.
    expect(primary, 'primary member should exist').toBeDefined();
    expect(primary!.in_ede).toBe(true);
    expect(primary!.in_back_office).toBe(true);

    // Fallback ladder path: joined via EDE.issuer_subscriber_id ↔ BO.policy_number
    // (which equals BO.issuer_subscriber_id thanks to the Ambetter quirk).
    expect(fallback, 'fallback member should exist').toBeDefined();
    expect(fallback!.in_ede).toBe(true);
    expect(fallback!.in_back_office).toBe(true);

    // Orphan: EDE-only, no BO match by any ladder rung.
    expect(orphan, 'orphan member should exist').toBeDefined();
    expect(orphan!.in_ede).toBe(true);
    expect(orphan!.in_back_office).toBe(false);

    // Sanity: the three EDE rows produced three distinct reconciled members
    // (no spurious cross-merge between primary, fallback, and orphan).
    expect(new Set([primary!.member_key, fallback!.member_key, orphan!.member_key]).size).toBe(3);
  });
});
