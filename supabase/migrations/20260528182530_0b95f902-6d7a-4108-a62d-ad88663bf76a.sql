CREATE INDEX IF NOT EXISTS idx_normalized_active_id
  ON public.normalized_records (id)
  WHERE staging_status = 'active' AND superseded_at IS NULL;