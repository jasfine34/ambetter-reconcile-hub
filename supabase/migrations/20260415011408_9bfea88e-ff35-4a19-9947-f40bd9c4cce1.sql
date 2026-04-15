ALTER TABLE public.normalized_records
ADD COLUMN IF NOT EXISTS issuer_subscriber_id text;

ALTER TABLE public.reconciled_members
ADD COLUMN IF NOT EXISTS issuer_subscriber_id text;

CREATE INDEX IF NOT EXISTS idx_normalized_issuer_subscriber_id
ON public.normalized_records(issuer_subscriber_id);