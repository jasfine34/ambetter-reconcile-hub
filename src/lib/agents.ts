/**
 * Agent / AOR helpers — single source of truth for "is this member one of ours?"
 *
 * Historically three pages carried their own hardcoded
 *   ['jason fine', 'erica fine', 'becky shuta']
 * prefix lists. They're collapsed here so adding a future agent (or removing one)
 * is a one-file change. The NPN_MAP in constants.ts remains the seed.
 *
 * This module intentionally stays backed by in-code constants for speed
 * (classifier runs over every record). The `agent_appointments` table in the
 * database is forward-looking: it stores the full FMO appointments list for
 * Phase 3's Commission Inquiry Form export (where we need per-state writing
 * agent IDs). That table does not drive the "ours?" check.
 */
import { NPN_MAP, COVERALL_OWNED_WRITING_NPNS } from './constants';

/**
 * True if the given writing-agent NPN is Coverall-owned business — either an
 * active AOR (Jason/Erica/Becky in NPN_MAP) OR a downline / former / service-
 * desk NPN listed in COVERALL_OWNED_WRITING_NPNS. Use this when attributing
 * commission rows whose `current_policy_aor` is blank or foreign but whose
 * writing-agent NPN is one we own.
 *
 * Does NOT affect AOR-string resolution or canonical scope semantics; this is
 * an ownership-metadata helper for audits and future classification.
 */
export function isCoverallOwnedWritingNPN(npn: string | null | undefined): boolean {
  if (!npn) return false;
  const key = String(npn).trim();
  if (!key) return false;
  return COVERALL_NPN_SET.has(key) || Object.prototype.hasOwnProperty.call(COVERALL_OWNED_WRITING_NPNS, key);
}

/** Set of NPNs that are currently active Coverall AORs (Jason / Erica / Becky). */
export const COVERALL_NPN_SET: ReadonlySet<string> = new Set(Object.keys(NPN_MAP));

/**
 * Lowercased agent name prefixes for matching AOR *strings* (the ones that come
 * through as e.g. "Jason Fine (21055210)" on EDE's currentPolicyAOR). Derived
 * from NPN_MAP so one table drives both lookups.
 */
export const COVERALL_AOR_NAME_PREFIXES: readonly string[] =
  Object.values(NPN_MAP).map(x => x.name.toLowerCase());

/** True if the given NPN is one of our Coverall AORs. Null/blank → false. */
export function isCoverallAORByNPN(npn: string | null | undefined): boolean {
  if (!npn) return false;
  return COVERALL_NPN_SET.has(String(npn).trim());
}

/**
 * True if the given free-form AOR string looks like one of our AORs.
 * Accepts "Jason Fine", "jason fine (21055210)", "  Erica L Fine  ", etc.
 * Prefix match on lowercased-name. First checks for an embedded NPN in
 * parentheses since that's the most reliable signal when present.
 */
export function isCoverallAORByName(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const s = String(raw).trim();
  if (!s) return false;
  const embeddedNpn = extractNpnFromAorString(s);
  if (embeddedNpn && COVERALL_NPN_SET.has(embeddedNpn)) return true;
  const lower = s.toLowerCase();
  return COVERALL_AOR_NAME_PREFIXES.some(p => lower.startsWith(p));
}

/**
 * Pull an NPN out of an AOR string formatted like "Jason Fine (21055210)".
 * Returns '' if no NPN found.
 */
export function extractNpnFromAorString(raw: string | null | undefined): string {
  if (!raw) return '';
  const m = String(raw).match(/\((\d{5,15})\)/);
  return m ? m[1] : '';
}

/**
 * Info about one of our AORs, or null if the NPN isn't ours. Thin wrapper on
 * NPN_MAP to give callers typed access (vs. the string-indexed lookup).
 */
export function getCoverallAgentByNPN(npn: string | null | undefined):
  | { npn: string; name: string; expectedPayEntity: string }
  | null {
  if (!npn) return null;
  const key = String(npn).trim();
  const info = NPN_MAP[key as keyof typeof NPN_MAP];
  if (!info) return null;
  return { npn: key, name: info.name, expectedPayEntity: info.expectedPayEntity };
}
