ALTER TABLE public.upload_batches
  ADD COLUMN IF NOT EXISTS last_full_rebuild_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS last_rebuild_logic_version text;