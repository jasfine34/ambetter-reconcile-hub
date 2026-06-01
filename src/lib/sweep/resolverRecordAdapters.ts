/**
 * Bundle 13b — sweep-internal adapters that index normalized BO/EDE records
 * and shape them into PolicyState/PolicyMemberCount records.
 */
import { canonicalCarrier } from '@/lib/carrierCanonical';
import { cleanId, cleanSubscriberId } from '@/lib/normalize';
import { statementMonthKey } from '@/lib/dateRange';
import { isValidMonthKey } from '@/lib/canonical/monthKey';
import { normalizeUsStateCode } from '@/lib/canonical/stateCode';
import { derivePolicyIdentityKey } from '@/lib/canonical/policyIdentityKey';
import type { PolicyStateRecord } from '@/lib/canonical/policyState';
import type { PolicyMemberCountRecord } from '@/lib/canonical/policyMemberCount';
import { firstNonblankString } from '@/lib/utils/firstNonblankString';

export interface NormalizedRecordShape {
  id: string;
  batch_id: string;
  source_type: string;
  carrier?: string | null;
  policy_number?: string | null;
  issuer_subscriber_id?: string | null;
  effective_date?: string | null;
  broker_effective_date?: string | null;
  client_state_full?: string | null;
  raw_json?: any;
}

function sourceLetter(source_type: string): 'bo' | 'ede' | null {
  if (source_type === 'BACK_OFFICE') return 'bo';
  if (source_type === 'EDE') return 'ede';
  return null;
}

export function buildResolverRecordIndex(args: {
  normalizedRecords: NormalizedRecordShape[];
}): Map<string, NormalizedRecordShape[]> {
  const index = new Map<string, NormalizedRecordShape[]>();
  const seenPerKey = new Map<string, Set<string>>();
  const push = (key: string, row: NormalizedRecordShape) => {
    let bucket = index.get(key);
    if (!bucket) {
      bucket = [];
      index.set(key, bucket);
      seenPerKey.set(key, new Set());
    }
    const seen = seenPerKey.get(key)!;
    if (seen.has(row.id)) return;
    seen.add(row.id);
    bucket.push(row);
  };

  for (const row of args.normalizedRecords) {
    if (sourceLetter(row.source_type) == null) continue;
    const cc = canonicalCarrier(row.carrier);
    if (!cc) continue;
    const idk = derivePolicyIdentityKey({
      carrier: row.carrier ?? null,
      policy_number: row.policy_number ?? null,
      issuer_subscriber_id: row.issuer_subscriber_id ?? null,
    });
    if (idk.status !== 'resolved') continue;
    push(idk.key, row);

    if (cc === 'ambetter') {
      const pn = cleanId(row.policy_number);
      const sid = cleanSubscriberId(row.issuer_subscriber_id);
      if (pn) push(`ambetter|${pn}`, row);
      if (sid) {
        push(`ambetter|sub:${sid}`, row);
        push(`ambetter|${sid}`, row);
      }
    }
  }
  return index;
}

function asOfMonthFor(row: NormalizedRecordShape, batchMonthById: Record<string, string>): string | null {
  const candidates = [row.effective_date, row.broker_effective_date, batchMonthById[row.batch_id]];
  for (const c of candidates) {
    const key = statementMonthKey(c == null ? '' : String(c));
    if (isValidMonthKey(key)) return key;
  }
  return null;
}

export function buildPolicyStateRecords(args: {
  normalizedRecords: NormalizedRecordShape[];
  batchMonthById: Record<string, string>;
}): PolicyStateRecord[] {
  const out: PolicyStateRecord[] = [];
  for (const row of args.normalizedRecords) {
    const src = sourceLetter(row.source_type);
    if (!src) continue;
    const asOf = asOfMonthFor(row, args.batchMonthById);
    if (!asOf) continue;
    const stateRaw = firstNonblankString(
      row.client_state_full,
      row.raw_json?.clientState,
      row.raw_json?.state,
      row.raw_json?.State,
    );
    const state = normalizeUsStateCode(stateRaw);
    if (!state) continue;
    out.push({ source: src, asOfMonth: asOf, state });
  }
  return out;
}

function parseMemberCountFromRow(row: NormalizedRecordShape): number | null {
  const r = row.raw_json ?? {};
  const candidates = [
    r.coveredMemberCount,
    r.CoveredMemberCount,
    r.covered_member_count,
    r['Number of Members'],   // BO raw — authoritative member count (no typed column); BO-first per resolver
    (row as any).member_count,
  ];
  for (const v of candidates) {
    if (v == null || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n) && Number.isInteger(n) && n > 0) return n;
  }
  return null;
}

export function buildPolicyMemberCountRecords(args: {
  normalizedRecords: NormalizedRecordShape[];
  batchMonthById: Record<string, string>;
}): PolicyMemberCountRecord[] {
  const out: PolicyMemberCountRecord[] = [];
  for (const row of args.normalizedRecords) {
    const src = sourceLetter(row.source_type);
    if (!src) continue;
    const asOf = asOfMonthFor(row, args.batchMonthById);
    if (!asOf) continue;
    const count = parseMemberCountFromRow(row);
    if (count == null) continue;
    out.push({ source: src, asOfMonth: asOf, memberCount: count });
  }
  return out;
}
