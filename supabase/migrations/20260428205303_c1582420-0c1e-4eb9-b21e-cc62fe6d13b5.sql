CREATE INDEX IF NOT EXISTS idx_commission_estimates_batch ON public.commission_estimates (batch_id);
CREATE INDEX IF NOT EXISTS idx_normalized_batch_id ON public.normalized_records (batch_id, id);
CREATE INDEX IF NOT EXISTS idx_normalized_batch_superseded ON public.normalized_records (batch_id, superseded_at);