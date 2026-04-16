ALTER TABLE public.reconciled_members
  ADD COLUMN IF NOT EXISTS positive_commission numeric,
  ADD COLUMN IF NOT EXISTS clawback_amount numeric;