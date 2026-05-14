/**
 * Bundle 13a — Comp grid loader. Thin DB-fetch wrapper around
 * public.carrier_comp_rates. Pure-helper compGrid.ts must NOT import this.
 */
import { supabase } from '@/integrations/supabase/client';
import type { CarrierCompRateRow } from './compGrid';

export interface LoadCarrierCompRatesOptions {
  effectiveYear?: number;
  carrierKey?: string;
}

export async function loadCarrierCompRates(
  options: LoadCarrierCompRatesOptions = {},
): Promise<CarrierCompRateRow[]> {
  const effectiveYear = options.effectiveYear ?? 2026;
  let query = supabase
    .from('carrier_comp_rates')
    .select(
      'id, rate_key, carrier_key, carrier_display, state_code, plan_variant, comp_basis, calculation_basis, rate_value, rate_unit, member_min, member_max, member_cap, effective_year, support_status, unsupported_reason',
    )
    .eq('effective_year', effectiveYear);
  if (options.carrierKey) query = query.eq('carrier_key', options.carrierKey);

  const { data, error } = await query;
  if (error) throw new Error(`loadCarrierCompRates: ${error.message}`);
  return (data ?? []).map(r => ({
    ...r,
    rate_value: r.rate_value == null ? null : Number(r.rate_value),
  })) as CarrierCompRateRow[];
}
