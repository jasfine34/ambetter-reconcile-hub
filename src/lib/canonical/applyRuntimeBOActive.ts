/**
 * Phase 1 MCE-specific runtime BO-active re-evaluation utility.
 *
 * The exclusion-set return value is MCE-SPECIFIC. MCE's
 * getExpectedPaymentUniverse has an EDE Only branch with no eligibility
 * gate — disqualified BO members can leak into MCE via that branch if we
 * only flip in_back_office. The exclusion set is MCE's defense.
 *
 * Phases 2-4 may reuse `adjustedReconciled` but MUST opt into exclusion-set
 * consumption explicitly if their pipeline has an analogous leak class.
 *
 * For each reconciled member, finds matching BO normalized records and
 * evaluates them via isActiveBackOfficeRecord. Multi-record OR semantics:
 * member is BO-active iff AT LEAST ONE matching BO record passes the helper.
 *
 * Returns:
 *   - adjustedReconciled — cloned reconciled rows with in_back_office updated.
 *     Pure: does NOT mutate input arrays or row objects.
 *   - mceExclusionMemberKeys — Set<member_key> (POST-Union-Find) of members
 *     where they have at least one matching BO record AND all matching
 *     records failed the helper. Members with NO matching BO records are
 *     NOT in this set.
 *   - matchingBoRecordCounts — Map<member_key, number> for test assertions.
 *
 * Identity matching: member_key + issuer_subscriber_id +
 * exchange_subscriber_id + policy_number + normalized name. Phase 2 may
 * consolidate with computeFilteredEde's identical strategy.
 *
 * Input precondition: `normalizedBoRecords` must already be filtered to
 * source_type === 'BACK_OFFICE'.
 */
import { isActiveBackOfficeRecord } from './isActiveBackOfficeRecord';

function normName(applicantName: string | null | undefined): string {
  if (!applicantName) return '';
  return applicantName.trim().toLowerCase().replace(/[^a-z]/g, '');
}

function cleanId(v: string | null | undefined): string {
  if (!v) return '';
  return String(v).replace(/^'+/, '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface ApplyRuntimeBOActiveResult {
  adjustedReconciled: any[];
  mceExclusionMemberKeys: Set<string>;
  matchingBoRecordCounts: Map<string, number>;
}

export function applyRuntimeBOActive(
  reconciledMembers: any[],
  normalizedBoRecords: any[],
  monthBounds: { start: string; end: string },
): ApplyRuntimeBOActiveResult {
  // Index BO records by every candidate key for fast lookup.
  const boByMemberKey = new Map<string, any[]>();
  const boByIsid = new Map<string, any[]>();
  const boByEsid = new Map<string, any[]>();
  const boByPolicy = new Map<string, any[]>();
  const boByName = new Map<string, any[]>();

  const push = (m: Map<string, any[]>, k: string, r: any) => {
    if (!k) return;
    const arr = m.get(k);
    if (arr) arr.push(r);
    else m.set(k, [r]);
  };

  for (const r of normalizedBoRecords) {
    if (r?.source_type !== 'BACK_OFFICE') continue;
    if (r.member_key) push(boByMemberKey, r.member_key, r);
    const isid = cleanId(r.issuer_subscriber_id);
    if (isid) push(boByIsid, isid, r);
    const esid = cleanId(r.exchange_subscriber_id);
    if (esid) push(boByEsid, esid, r);
    const pol = cleanId(r.policy_number);
    if (pol) push(boByPolicy, pol, r);
    const nm = normName(r.applicant_name);
    if (nm) push(boByName, nm, r);
  }

  const adjustedReconciled: any[] = [];
  const mceExclusionMemberKeys = new Set<string>();
  const matchingBoRecordCounts = new Map<string, number>();

  for (const m of reconciledMembers) {
    const seen = new Map<any, any>();
    const consider = (rs: any[] | undefined) => {
      if (!rs) return;
      for (const r of rs) if (!seen.has(r)) seen.set(r, r);
    };
    consider(boByMemberKey.get(m.member_key));
    consider(boByIsid.get(cleanId(m.issuer_subscriber_id)));
    consider(boByEsid.get(cleanId(m.exchange_subscriber_id)));
    consider(boByPolicy.get(cleanId(m.policy_number)));
    consider(boByName.get(normName(m.applicant_name)));

    const matches = Array.from(seen.values());
    matchingBoRecordCounts.set(m.member_key, matches.length);

    let anyActive = false;
    for (const r of matches) {
      if (isActiveBackOfficeRecord(r, monthBounds.start, monthBounds.end)) {
        anyActive = true;
        break;
      }
    }

    // Clone — never mutate input.
    adjustedReconciled.push({ ...m, in_back_office: anyActive });

    if (matches.length > 0 && !anyActive) {
      mceExclusionMemberKeys.add(m.member_key);
    }
  }

  return { adjustedReconciled, mceExclusionMemberKeys, matchingBoRecordCounts };
}
