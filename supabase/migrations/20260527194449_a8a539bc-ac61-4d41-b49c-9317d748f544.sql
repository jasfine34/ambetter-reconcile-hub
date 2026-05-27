CREATE INDEX IF NOT EXISTS idx_normalized_active_batch_id_id
  ON public.normalized_records (batch_id, id)
  WHERE staging_status = 'active' AND superseded_at IS NULL;

ANALYZE public.normalized_records;