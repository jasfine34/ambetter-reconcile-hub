/**
 * Month-aware EDE picker (MT Stage 2.1 Slice D).
 *
 * Picks the single operative EDE row for a given service month from a
 * member's qualified EDE set. Reuses the canonical `compareEDEForAor`
 * comparator so precedence matches `pickCurrentPolicyAor`.
 */
import type { NormalizedRecord } from '@/lib/normalize';
import { compareEDEForAor } from '@/lib/aorPicker';
import { isEDEQualified } from './edeQualified';
import { lastActiveMonthForTermDate } from './termBoundary';

function dateToMonthKey(date: string | null | undefined): string {
  if (!date) return '';
  return String(date).substring(0, 7);
}

/**
 * Pick the operative EDE row for `serviceMonth`. Inputs MUST already be
 * filtered to qualified EDE rows (caller responsibility). Returns null when
 * no candidate has a nonblank `currentPolicyAOR`.
 */
export function pickEdeForServiceMonth(
  qualifiedEdes: NormalizedRecord[],
  serviceMonth: string,
): NormalizedRecord | null {
  const candidates = qualifiedEdes.filter(r => {
    if (r.source_type !== 'EDE') return false;
    const effMonth = dateToMonthKey(r.effective_date);
    if (!effMonth || effMonth > serviceMonth) return false;
    if (r.policy_term_date) {
      const lastActive = lastActiveMonthForTermDate(r.policy_term_date);
      if (lastActive && lastActive < serviceMonth) return false;
    }
    return true;
  });

  candidates.sort(compareEDEForAor);

  for (const r of candidates) {
    const aor = String(r.raw_json?.['currentPolicyAOR'] ?? '').trim();
    if (aor) return r;
  }
  return null;
}

/** Build a per-month picker map for a single member. */
export function buildMonthPickerMapForMember(
  memberRecs: NormalizedRecord[],
  monthList: string[],
): Map<string, NormalizedRecord | null> {
  const qualifiedEdes = memberRecs.filter(r => r.source_type === 'EDE' && isEDEQualified(r));
  const map = new Map<string, NormalizedRecord | null>();
  for (const m of monthList) {
    map.set(m, pickEdeForServiceMonth(qualifiedEdes, m));
  }
  return map;
}
