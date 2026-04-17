ALTER TABLE public.normalized_records 
ADD COLUMN IF NOT EXISTS policy_term_date DATE,
ADD COLUMN IF NOT EXISTS paid_through_date DATE;