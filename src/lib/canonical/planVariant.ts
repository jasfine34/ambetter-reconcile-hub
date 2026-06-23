/**
 * TX Ambetter plan-tier expected-basis fix (Yellow lane).
 *
 * Derive the canonical LOWERCASE plan_variant ('value' | 'premier') for
 * TX Ambetter members from the raw evidence we already carry, with bounded
 * conflict detection. Conflict detection prevents a silent, array-order-
 * dependent pick when the member's full-union records carry BOTH a Value
 * and a Premier signal at the SAME winning precedence tier (mid-year tier
 * change, data error, or multi-policy bleed). A 'conflict' result is
 * mapped by the evidence builders to plan_variant=null +
 * plan_variant_status='conflict', and the resolver holds the row as
 * PLAN_TIER_UNRECOVERABLE rather than guessing.
 *
 * Precedence (first tier that produces ANY signal wins; lower tiers are
 * NOT consulted once a higher tier produces a signal):
 *   1. raw_json.plan_variant canonicalized lowercase, if recognized
 *      ('value' | 'premier').
 *   2. Commission raw_json.Product explicitly containing 'TX-Value' or
 *      'TX-Premier' (case-insensitive).
 *   3. BO / EDE raw_json['Plan Name'] containing 'VALUE' (case-insensitive)
 *      → 'value'. Absence of VALUE is NOT proof of Premier — return null.
 *
 * Within the winning tier: one distinct value → return it; two distinct
 * values (value AND premier) → 'conflict'.
 *
 * Applied ONLY when carrier canonicalizes to 'ambetter' AND state is 'TX'.
 * All other rows: helper returns null without inspection.
 */
import { canonicalCarrier } from '../carrierCanonical';

export type AmbetterTxPlanVariant = 'value' | 'premier';
export type AmbetterTxPlanVariantDerivation = AmbetterTxPlanVariant | 'conflict' | null;

export interface PlanVariantSource {
  raw_json?: any;
  source_type?: string | null;
}

function canonState(state: string | null | undefined): string {
  return String(state ?? '').trim().toUpperCase();
}

function recognizeLowercase(v: unknown): AmbetterTxPlanVariant | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return s === 'value' || s === 'premier' ? s : null;
}

function fromProduct(raw: any): AmbetterTxPlanVariant | null {
  const product = raw?.Product ?? raw?.product;
  if (typeof product !== 'string') return null;
  const s = product.toLowerCase();
  if (s.includes('tx-value') || s.includes('tx value')) return 'value';
  if (s.includes('tx-premier') || s.includes('tx premier')) return 'premier';
  return null;
}

function fromPlanName(raw: any): AmbetterTxPlanVariant | null {
  const plan = raw?.['Plan Name'] ?? raw?.plan_name ?? raw?.planName;
  if (typeof plan !== 'string') return null;
  if (/\bvalue\b/i.test(plan)) return 'value';
  // Premier is NOT inferable from absence of VALUE — see comment above.
  return null;
}

/** Collapse a list of within-tier signals to a single derivation. */
function collapseTier(
  signals: ReadonlyArray<AmbetterTxPlanVariant>,
): AmbetterTxPlanVariantDerivation {
  if (signals.length === 0) return null;
  const distinct = new Set<AmbetterTxPlanVariant>(signals);
  if (distinct.size === 1) return signals[0];
  return 'conflict';
}

export function deriveAmbetterTxPlanVariant(args: {
  carrier: string | null | undefined;
  state: string | null | undefined;
  sources: ReadonlyArray<PlanVariantSource | null | undefined>;
}): AmbetterTxPlanVariantDerivation {
  if (canonicalCarrier(args.carrier) !== 'ambetter') return null;
  if (canonState(args.state) !== 'TX') return null;

  const tier1: AmbetterTxPlanVariant[] = [];
  const tier2: AmbetterTxPlanVariant[] = [];
  const tier3: AmbetterTxPlanVariant[] = [];

  for (const s of args.sources) {
    if (!s || !s.raw_json) continue;
    const v = recognizeLowercase(s.raw_json.plan_variant);
    if (v) tier1.push(v);
  }
  if (tier1.length > 0) return collapseTier(tier1);

  for (const s of args.sources) {
    if (!s || !s.raw_json) continue;
    const v = fromProduct(s.raw_json);
    if (v) tier2.push(v);
  }
  if (tier2.length > 0) return collapseTier(tier2);

  for (const s of args.sources) {
    if (!s || !s.raw_json) continue;
    const v = fromPlanName(s.raw_json);
    if (v) tier3.push(v);
  }
  return collapseTier(tier3);
}
