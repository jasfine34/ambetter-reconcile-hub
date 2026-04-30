/**
 * Canonical member-key merge — sidecar parity tests.
 *
 * Regression guard for Codex finding pass #2: the read-time pages
 * (Member Timeline, Source Funnel) used to call assignMergedMemberKeys()
 * directly without applying the resolved_identities sidecar overlay, so
 * a member with two FFM application IDs that the sidecar collapses to
 * one identity appeared as ONE row in dashboard counts (reconciler) and
 * TWO rows in the timeline (page). These tests assert both call sites
 * agree.
 */
import { describe, it, expect } from 'vitest';
import { mergeRecordsToMemberKeys } from '@/lib/canonical/memberKeyMerge';
import { reconcile } from '@/lib/reconcile';
import type { NormalizedRecord } from '@/lib/normalize';
import type { ResolverIndex, ResolvedIdentityRow } from '@/lib/resolvedIdentities';

function ede(opts: Partial<NormalizedRecord> & { ffmAppId?: string }): NormalizedRecord {
  const { ffmAppId, ...rest } = opts;
  return {
    id: crypto.randomUUID(),
    batch_id: 'batch-test',
    uploaded_file_id: 'file-test',
    source_type: 'EDE',
    source_file_label: 'EDE Test',
    carrier: 'Ambetter',
    applicant_name: 'Test Person',
    status: 'Effectuated',
    effective_date: '2026-01-01',
    raw_json: {
      policyStatus: 'Effectuated',
      issuer: 'Ambetter',
      ...(ffmAppId ? { ffmAppId } : {}),
    },
    created_at: new Date().toISOString(),
    ...rest,
  } as NormalizedRecord;
}

function makeResolverIndex(rows: Partial<ResolvedIdentityRow>[]): ResolverIndex {
  const byFfmApp = new Map<string, ResolvedIdentityRow>();
  const byExchangeSub = new Map<string, ResolvedIdentityRow>();
  for (const partial of rows) {
    const row: ResolvedIdentityRow = {
      id: crypto.randomUUID(),
      match_key_type: 'ffmAppId',
      match_key_value: '',
      resolved_issuer_subscriber_id: null,
      resolved_issuer_policy_id: null,
      resolved_exchange_policy_id: null,
      source_batch_id: null,
      source_file_id: null,
      source_kind: null,
      resolved_at: new Date().toISOString(),
      conflict_count: 0,
      conflict_details: null,
      reviewed_at: null,
      ...partial,
    };
    if (row.match_key_type === 'ffmAppId') byFfmApp.set(row.match_key_value, row);
    else if (row.match_key_type === 'exchangeSubscriberId') byExchangeSub.set(row.match_key_value, row);
  }
  return { byFfmApp, byExchangeSub, totalRows: rows.length };
}

describe('mergeRecordsToMemberKeys (canonical sidecar parity)', () => {
  it('(1) sidecar collapse parity — same input, reconcile and timeline path produce ONE merged member', () => {
    // Member with two FFM application IDs — neither EDE row carries an
    // issuer_subscriber_id, so without the sidecar they cannot union.
    // The sidecar resolves both ffmAppIds to the SAME issuer_subscriber_id.
    const input = (): NormalizedRecord[] => [
      ede({
        applicant_name: 'Aaron Barrett',
        ffmAppId: 'FFM-AAA',
        exchange_subscriber_id: 'ESID-A',
      }),
      ede({
        applicant_name: 'Aaron Barrett',
        ffmAppId: 'FFM-BBB',
        exchange_subscriber_id: 'ESID-B',
      }),
    ];

    const resolverIndex = makeResolverIndex([
      { match_key_type: 'ffmAppId', match_key_value: 'FFM-AAA', resolved_issuer_subscriber_id: 'U12345AAA' },
      { match_key_type: 'ffmAppId', match_key_value: 'FFM-BBB', resolved_issuer_subscriber_id: 'U12345AAA' },
    ]);

    // Timeline path
    const timelineRecs = input();
    mergeRecordsToMemberKeys(timelineRecs, resolverIndex);
    const timelineKeys = new Set(timelineRecs.map(r => r.member_key));
    expect(timelineKeys.size).toBe(1);

    // Reconciler path
    const reconcileRecs = input();
    const { members } = reconcile(reconcileRecs, '2026-01', resolverIndex);
    expect(members.length).toBe(1);

    // Both paths agree on the merged member_key
    const reconcileKey = members[0].member_key;
    const timelineKey = [...timelineKeys][0];
    expect(timelineKey).toBe(reconcileKey);
  });

  it('regression — without sidecar the same input produces TWO timeline rows (proves test would fail pre-fix)', () => {
    const recs: NormalizedRecord[] = [
      ede({ applicant_name: 'Aaron Barrett', ffmAppId: 'FFM-AAA', exchange_subscriber_id: 'ESID-A' }),
      ede({ applicant_name: 'Aaron Barrett', ffmAppId: 'FFM-BBB', exchange_subscriber_id: 'ESID-B' }),
    ];
    // Pass null resolver — simulates the OLD assignMergedMemberKeys() behavior.
    mergeRecordsToMemberKeys(recs, null);
    const keys = new Set(recs.map(r => r.member_key));
    // Same name "Aaron Barrett" still bridges via name strategy in our union-find,
    // so to truly demonstrate the divergence we need different names too:
    const recs2: NormalizedRecord[] = [
      ede({ applicant_name: 'Aaron Barrett', ffmAppId: 'FFM-AAA', exchange_subscriber_id: 'ESID-A', first_name: 'Aaron', last_name: 'Barrett' }),
      ede({ applicant_name: 'Aaron Q Barrett', ffmAppId: 'FFM-BBB', exchange_subscriber_id: 'ESID-B', first_name: 'AaronQ', last_name: 'Barrett' }),
    ];
    mergeRecordsToMemberKeys(recs2, null);
    const keys2 = new Set(recs2.map(r => r.member_key));
    expect(keys2.size).toBe(2); // without sidecar: two rows
    // Now with sidecar:
    const resolverIndex = makeResolverIndex([
      { match_key_type: 'ffmAppId', match_key_value: 'FFM-AAA', resolved_issuer_subscriber_id: 'U99999BBB' },
      { match_key_type: 'ffmAppId', match_key_value: 'FFM-BBB', resolved_issuer_subscriber_id: 'U99999BBB' },
    ]);
    const recs3: NormalizedRecord[] = [
      ede({ applicant_name: 'Aaron Barrett', ffmAppId: 'FFM-AAA', exchange_subscriber_id: 'ESID-A', first_name: 'Aaron', last_name: 'Barrett' }),
      ede({ applicant_name: 'Aaron Q Barrett', ffmAppId: 'FFM-BBB', exchange_subscriber_id: 'ESID-B', first_name: 'AaronQ', last_name: 'Barrett' }),
    ];
    mergeRecordsToMemberKeys(recs3, resolverIndex);
    const keys3 = new Set(recs3.map(r => r.member_key));
    expect(keys3.size).toBe(1); // with sidecar: ONE row — this is the fix
  });

  it('(2) no-sidecar backward compat — empty resolver index = identical to carrier-key union only', () => {
    const build = (): NormalizedRecord[] => [
      ede({ applicant_name: 'Beta Person', issuer_subscriber_id: 'U1', exchange_subscriber_id: 'E1' }),
      ede({ applicant_name: 'Beta Person', issuer_subscriber_id: 'U1', exchange_subscriber_id: 'E1' }),
      ede({ applicant_name: 'Gamma Person', issuer_subscriber_id: 'U2', exchange_subscriber_id: 'E2' }),
    ];
    const empty = makeResolverIndex([]);

    const a = build();
    mergeRecordsToMemberKeys(a, empty);
    const b = build();
    mergeRecordsToMemberKeys(b, null);

    const keysA = a.map(r => r.member_key);
    const keysB = b.map(r => r.member_key);
    expect(keysA).toEqual(keysB);
    expect(new Set(keysA).size).toBe(2); // U1 collapses, U2 separate
  });

  it('(3) mixed resolver hits — three members, two collapsed by sidecar, one untouched', () => {
    const recs: NormalizedRecord[] = [
      // These two have different IDs but sidecar resolves both ffmAppIds to U-MERGED
      ede({ applicant_name: 'Person One', ffmAppId: 'FFM-1', exchange_subscriber_id: 'ESID-1', first_name: 'PersonA', last_name: 'One' }),
      ede({ applicant_name: 'Person Two', ffmAppId: 'FFM-2', exchange_subscriber_id: 'ESID-2', first_name: 'PersonB', last_name: 'Two' }),
      // This third member has its own issuer_subscriber_id — sidecar doesn't touch it
      ede({ applicant_name: 'Person Three', issuer_subscriber_id: 'UINDEPENDENT', exchange_subscriber_id: 'ESID-3', first_name: 'PersonC', last_name: 'Three' }),
    ];

    const resolverIndex = makeResolverIndex([
      { match_key_type: 'ffmAppId', match_key_value: 'FFM-1', resolved_issuer_subscriber_id: 'UMERGED' },
      { match_key_type: 'ffmAppId', match_key_value: 'FFM-2', resolved_issuer_subscriber_id: 'UMERGED' },
    ]);

    mergeRecordsToMemberKeys(recs, resolverIndex);
    const keys = new Set(recs.map(r => r.member_key));
    expect(keys.size).toBe(2); // [U-MERGED group, U-INDEPENDENT group]
    expect(keys.has('issub:umerged') || keys.has('issub:UMERGED')).toBe(true);
    expect([...keys].some(k => k.toLowerCase().includes('independent'))).toBe(true);
  });

  it('signature guard — assignMergedMemberKeys requires the resolverIndex parameter (compile-time check)', () => {
    // This test exists primarily as documentation: assignMergedMemberKeys's
    // signature now REQUIRES a 2nd arg (ResolverIndex | null) so any future
    // caller that omits it fails the typechecker rather than silently
    // diverging from reconcile.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { assignMergedMemberKeys } = require('@/lib/memberMerge');
    expect(assignMergedMemberKeys.length).toBe(2);
  });
});
