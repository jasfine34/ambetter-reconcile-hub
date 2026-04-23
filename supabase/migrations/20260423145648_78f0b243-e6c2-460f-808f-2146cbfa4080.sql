ALTER TABLE public.normalized_records
  ADD COLUMN IF NOT EXISTS broker_effective_date DATE,
  ADD COLUMN IF NOT EXISTS broker_term_date DATE,
  ADD COLUMN IF NOT EXISTS member_responsibility NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS on_off_exchange TEXT,
  ADD COLUMN IF NOT EXISTS auto_renewal BOOLEAN,
  ADD COLUMN IF NOT EXISTS ede_policy_origin_type TEXT,
  ADD COLUMN IF NOT EXISTS ede_bucket TEXT,
  ADD COLUMN IF NOT EXISTS policy_modified_date DATE,
  ADD COLUMN IF NOT EXISTS client_address_1 TEXT,
  ADD COLUMN IF NOT EXISTS client_address_2 TEXT,
  ADD COLUMN IF NOT EXISTS client_city TEXT,
  ADD COLUMN IF NOT EXISTS client_state_full TEXT,
  ADD COLUMN IF NOT EXISTS client_zip TEXT,
  ADD COLUMN IF NOT EXISTS paid_to_date DATE,
  ADD COLUMN IF NOT EXISTS months_paid INTEGER,
  ADD COLUMN IF NOT EXISTS writing_agent_carrier_id TEXT;

CREATE INDEX IF NOT EXISTS idx_normalized_broker_effective
  ON public.normalized_records (broker_effective_date)
  WHERE broker_effective_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_normalized_paid_to_date
  ON public.normalized_records (paid_to_date)
  WHERE paid_to_date IS NOT NULL;