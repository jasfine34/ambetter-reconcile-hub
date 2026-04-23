-- Phase 1b — typed columns on normalized_records
-- Promotes several fields from raw_json lookups to typed columns so the
-- Phase 2 classifier can query them directly. New columns are nullable to
-- keep existing data valid; they populate naturally as files are re-uploaded
-- or as the user runs Rebuild Entire Batch.

ALTER TABLE public.normalized_records
  -- Back office: broker-period + carrier-side premium signal (Ambetter, Molina, Cigna supply BED)
  ADD COLUMN IF NOT EXISTS broker_effective_date DATE,
  ADD COLUMN IF NOT EXISTS broker_term_date DATE,
  ADD COLUMN IF NOT EXISTS member_responsibility NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS on_off_exchange TEXT,
  -- EDE: enrichment signals used by classifier and inquiry-form export
  ADD COLUMN IF NOT EXISTS auto_renewal BOOLEAN,
  ADD COLUMN IF NOT EXISTS ede_policy_origin_type TEXT,
  ADD COLUMN IF NOT EXISTS ede_bucket TEXT,
  ADD COLUMN IF NOT EXISTS policy_modified_date DATE,
  ADD COLUMN IF NOT EXISTS client_address_1 TEXT,
  ADD COLUMN IF NOT EXISTS client_address_2 TEXT,
  ADD COLUMN IF NOT EXISTS client_city TEXT,
  ADD COLUMN IF NOT EXISTS client_state_full TEXT,
  ADD COLUMN IF NOT EXISTS client_zip TEXT,
  -- Commission: cross-month service attribution + per-state writing agent ID
  ADD COLUMN IF NOT EXISTS paid_to_date DATE,
  ADD COLUMN IF NOT EXISTS months_paid INTEGER,
  ADD COLUMN IF NOT EXISTS writing_agent_carrier_id TEXT;

-- Useful indexes for Phase 2 classifier queries
CREATE INDEX IF NOT EXISTS idx_normalized_broker_effective
  ON public.normalized_records (broker_effective_date)
  WHERE broker_effective_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_normalized_paid_to_date
  ON public.normalized_records (paid_to_date)
  WHERE paid_to_date IS NOT NULL;
