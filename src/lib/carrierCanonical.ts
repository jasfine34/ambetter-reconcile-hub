/**
 * Carrier name canonicalization.
 *
 * Every source uses a slightly different carrier string:
 *   EDE issuer      — "Ambetter Health", "Ambetter from Sunshine Health", ...
 *   BO carrier_raw  — "AMBETTER" (from agent appointments), "Ambetter from Superior HealthPlan" (from BO itself)
 *   Commission      — "Ambetter" plain
 *   Agent appts     — "AMBETTER", "HCSC BCBS IL", "OSCAR ", etc.
 *
 * This helper maps any of those to a stable canonical key (e.g. 'ambetter')
 * that the rest of the app can compare against. The `carriers` table mirrors
 * this for future database-driven alias management; today we keep the authoritative
 * list in code for speed and simplicity.
 */

interface CarrierEntry {
  canonicalKey: string;
  displayName: string;
  aliasSubstrings: string[]; // lowercase substrings — any match wins
}

// Keep aliases in lowercase; match is substring-based so "Ambetter from X"
// canonicalizes to 'ambetter' without needing every variant enumerated.
const CARRIERS: CarrierEntry[] = [
  {
    canonicalKey: 'ambetter',
    displayName: 'Ambetter',
    aliasSubstrings: ['ambetter'],
  },
  // The carriers below are listed for future expansion (aligned with §3.3 of
  // ARCHITECTURE_PLAN.md) but adapters aren't implemented yet. They're here
  // so canonicalCarrier() produces stable keys even when records from other
  // carriers appear in the data (e.g. an EDE row from Cigna).
  { canonicalKey: 'molina', displayName: 'Molina', aliasSubstrings: ['molina'] },
  { canonicalKey: 'cigna', displayName: 'Cigna', aliasSubstrings: ['cigna'] },
  { canonicalKey: 'oscar', displayName: 'Oscar', aliasSubstrings: ['oscar'] },
  { canonicalKey: 'anthem', displayName: 'Anthem', aliasSubstrings: ['anthem'] },
  { canonicalKey: 'aetna', displayName: 'Aetna', aliasSubstrings: ['aetna'] },
  { canonicalKey: 'united', displayName: 'UnitedHealthcare', aliasSubstrings: ['unitedhealth', 'uhc', 'united healthcare', 'united '] },
  { canonicalKey: 'bcbs', displayName: 'BCBS', aliasSubstrings: ['bcbs', 'blue cross', 'blue shield', 'hcsc'] },
  { canonicalKey: 'humana', displayName: 'Humana', aliasSubstrings: ['humana'] },
  { canonicalKey: 'kaiser', displayName: 'Kaiser', aliasSubstrings: ['kaiser'] },
  { canonicalKey: 'centene', displayName: 'Centene', aliasSubstrings: ['centene'] },
];

/**
 * Return the canonical carrier key for any input string, or '' if unknown.
 * Case-insensitive. Substring-based so long-form issuer names normalize
 * correctly without enumerating every regional subsidiary.
 */
export function canonicalCarrier(raw: string | null | undefined): string {
  if (!raw) return '';
  const s = String(raw).toLowerCase().trim();
  if (!s) return '';
  for (const c of CARRIERS) {
    if (c.aliasSubstrings.some(a => s.includes(a))) return c.canonicalKey;
  }
  return '';
}

/** Display name for a canonical key. Empty string if unknown. */
export function carrierDisplayName(canonicalKey: string): string {
  const c = CARRIERS.find(x => x.canonicalKey === canonicalKey);
  return c ? c.displayName : '';
}

/** True if two raw carrier strings belong to the same canonical carrier. */
export function sameCarrier(a: string | null | undefined, b: string | null | undefined): boolean {
  const ca = canonicalCarrier(a);
  const cb = canonicalCarrier(b);
  return ca !== '' && ca === cb;
}
