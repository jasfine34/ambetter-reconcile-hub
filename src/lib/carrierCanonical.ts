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
//
// ORDER MATTERS — first matching entry wins. Specific aliases must come
// BEFORE the generic carrier they overlap with (e.g. anthem_bcbs before
// anthem and bcbs; bs_ca before bcbs).
const CARRIERS: CarrierEntry[] = [
  // Specific-before-generic overrides (Bundle 13a additions).
  { canonicalKey: 'anthem_bcbs', displayName: 'Anthem BCBS', aliasSubstrings: ['anthem bcbs'] },
  { canonicalKey: 'bs_ca', displayName: 'Blue Shield CA', aliasSubstrings: ['bs ca', 'blue shield ca'] },
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
  // Bundle 13a Messer 2026 grid additions. Aliases are deliberately full
  // brand names (no vague tokens like 'health', 'care', 'first', 'med').
  { canonicalKey: 'alliant', displayName: 'Alliant', aliasSubstrings: ['alliant'] },
  { canonicalKey: 'amerihealth_caritas', displayName: 'AmeriHealth Caritas', aliasSubstrings: ['amerihealth caritas'] },
  { canonicalKey: 'antidote', displayName: 'Antidote', aliasSubstrings: ['antidote'] },
  { canonicalKey: 'avmed', displayName: 'AvMed', aliasSubstrings: ['avmed'] },
  { canonicalKey: 'baylor_scott_white', displayName: 'Baylor Scott & White', aliasSubstrings: ['baylor scott', 'baylor'] },
  { canonicalKey: 'caresource', displayName: 'Caresource', aliasSubstrings: ['caresource'] },
  { canonicalKey: 'christus', displayName: 'Christus', aliasSubstrings: ['christus'] },
  { canonicalKey: 'health_first', displayName: 'Health First', aliasSubstrings: ['health first'] },
  { canonicalKey: 'highmark', displayName: 'Highmark', aliasSubstrings: ['highmark'] },
  { canonicalKey: 'imperial', displayName: 'Imperial', aliasSubstrings: ['imperial'] },
  { canonicalKey: 'wellpoint', displayName: 'Wellpoint', aliasSubstrings: ['wellpoint'] },
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
