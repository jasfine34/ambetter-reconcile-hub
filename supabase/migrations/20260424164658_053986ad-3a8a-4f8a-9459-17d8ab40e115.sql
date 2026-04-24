-- Sidecar table for cross-batch identity resolution.
-- Original normalized_records are NEVER mutated; this table layers known IDs
-- over them at read time for matching and display.
CREATE TABLE IF NOT EXISTS public.resolved_identities (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  match_key_type text NOT NULL CHECK (match_key_type IN ('ffmAppId','exchangeSubscriberId')),
  match_key_value text NOT NULL,
  resolved_issuer_subscriber_id text,
  resolved_issuer_policy_id text,
  resolved_exchange_policy_id text,
  source_batch_id uuid REFERENCES public.upload_batches(id) ON DELETE SET NULL,
  source_file_id uuid REFERENCES public.uploaded_files(id) ON DELETE SET NULL,
  source_kind text CHECK (source_kind IN ('commission','back_office','ede')),
  resolved_at timestamptz NOT NULL DEFAULT now(),
  conflict_count integer NOT NULL DEFAULT 0,
  conflict_details jsonb,
  reviewed_at timestamptz,
  CONSTRAINT resolved_identities_match_key_unique UNIQUE (match_key_type, match_key_value)
);

CREATE INDEX IF NOT EXISTS resolved_identities_match_key_idx
  ON public.resolved_identities (match_key_type, match_key_value);

ALTER TABLE public.resolved_identities ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all access to resolved_identities"
  ON public.resolved_identities
  FOR ALL
  USING (true)
  WITH CHECK (true);
