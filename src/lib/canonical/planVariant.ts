/**
 * TX Ambetter plan-tier expected-basis fix (Yellow lane).
 *
 * Derive the canonical LOWERCASE plan_variant ('value' | 'premier') for
 * TX Ambetter members from the raw evidence we already carry. The live
 * carrier_comp_rates table has both TX rows (value=$24, premier=$29);
 * the historical miss was read-side — evidence only set plan_variant from
 * raw_json.plan_variant which is absent in production data, so the comp-grid
 * lookup with plan_variant=null defaulted to the highest TX rate ($29).
 *
 * Precedence (first non-null wins):
 *   1. raw_json.plan_variant canonicalized lowercase, if recognized
 *      ('value' | 'premier').
 *   2. Commission raw_json.Product explicitly containing 'TX-Value' or
 *      'TX-Premier' (case-insensitive).
 *   3. BO / EDE raw_json['Plan Name'] containing 'VALUE' (case-insensitive)
 *      → 'value'. Absence of VALUE is NOT proof of Premier — return null.
 *   4. null.
 *
 * Applied ONLY when carrier canonicalizes to 'ambetter' AND state is 'TX'.
 * All other rows: helper returns null without inspection. Callers MUST fall
 * back to their existing plan_variant resolution path in that case.
 */
import { canonicalCarrier } from '../carrierCanonical';

export type AmbetterTxPlanVariant = 'value' | 'premier';

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

export function deriveAmbetterTxPlanVariant(args: {
  carrier: string | null | undefined;
  state: string | null | undefined;
  sources: ReadonlyArray<PlanVariantSource | null | undefined>;
}): AmbetterTxPlanVariant | null {
  if (canonicalCarrier(args.carrier) !== 'ambetter') return null;
  if (canonState(args.state) !== 'TX') return null;

  for (const s of args.sources) {
    if (!s || !s.raw_json) continue;
    const direct = recognizeLowercase(s.raw_json.plan_variant);
    if (direct) return direct;
  }
  for (const s of args.sources) {
    if (!s || !s.raw_json) continue;
    const fromProd = fromProduct(s.raw_json);
    if (fromProd) return fromProd;
  }
  for (const s of args.sources) {
    if (!s || !s.raw_json) continue;
    const fromPlan = fromPlanName(s.raw_json);
    if (fromPlan) return fromPlan;
  }
  return null;
}
