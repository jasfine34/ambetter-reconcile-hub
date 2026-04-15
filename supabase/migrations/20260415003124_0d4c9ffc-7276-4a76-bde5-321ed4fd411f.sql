
-- Create tables
CREATE TABLE IF NOT EXISTS public.upload_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  carrier TEXT NOT NULL DEFAULT 'Ambetter',
  statement_month DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes TEXT
);

CREATE TABLE IF NOT EXISTS public.uploaded_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES public.upload_batches(id) ON DELETE CASCADE,
  file_label TEXT NOT NULL,
  file_name TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('EDE','BACK_OFFICE','COMMISSION')),
  pay_entity TEXT,
  aor_bucket TEXT,
  storage_path TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.normalized_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES public.upload_batches(id) ON DELETE CASCADE,
  uploaded_file_id UUID NOT NULL REFERENCES public.uploaded_files(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  source_file_label TEXT NOT NULL,
  carrier TEXT,
  applicant_name TEXT,
  first_name TEXT,
  last_name TEXT,
  dob DATE,
  member_id TEXT,
  policy_number TEXT,
  exchange_subscriber_id TEXT,
  exchange_policy_id TEXT,
  issuer_policy_id TEXT,
  agent_name TEXT,
  agent_npn TEXT,
  aor_bucket TEXT,
  pay_entity TEXT,
  status TEXT,
  effective_date DATE,
  premium NUMERIC(12,2),
  net_premium NUMERIC(12,2),
  commission_amount NUMERIC(12,2),
  eligible_for_commission TEXT,
  member_key TEXT,
  raw_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_normalized_member_key ON public.normalized_records(member_key);
CREATE INDEX IF NOT EXISTS idx_normalized_policy_number ON public.normalized_records(policy_number);
CREATE INDEX IF NOT EXISTS idx_normalized_exchange_subscriber_id ON public.normalized_records(exchange_subscriber_id);
CREATE INDEX IF NOT EXISTS idx_normalized_agent_npn ON public.normalized_records(agent_npn);

CREATE TABLE IF NOT EXISTS public.reconciled_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES public.upload_batches(id) ON DELETE CASCADE,
  member_key TEXT NOT NULL,
  carrier TEXT,
  applicant_name TEXT,
  dob DATE,
  policy_number TEXT,
  exchange_subscriber_id TEXT,
  exchange_policy_id TEXT,
  issuer_policy_id TEXT,
  agent_name TEXT,
  agent_npn TEXT,
  aor_bucket TEXT,
  expected_pay_entity TEXT,
  actual_pay_entity TEXT,
  in_ede BOOLEAN NOT NULL DEFAULT false,
  in_back_office BOOLEAN NOT NULL DEFAULT false,
  in_commission BOOLEAN NOT NULL DEFAULT false,
  eligible_for_commission TEXT,
  premium NUMERIC(12,2),
  net_premium NUMERIC(12,2),
  actual_commission NUMERIC(12,2),
  estimated_missing_commission NUMERIC(12,2),
  issue_type TEXT,
  issue_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reconciled_batch ON public.reconciled_members(batch_id);
CREATE INDEX IF NOT EXISTS idx_reconciled_issue_type ON public.reconciled_members(issue_type);
CREATE INDEX IF NOT EXISTS idx_reconciled_agent_npn ON public.reconciled_members(agent_npn);

CREATE TABLE IF NOT EXISTS public.commission_estimates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES public.upload_batches(id) ON DELETE CASCADE,
  member_key TEXT NOT NULL,
  basis TEXT,
  estimated_commission NUMERIC(12,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.manual_match_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  carrier TEXT NOT NULL DEFAULT 'Ambetter',
  left_source_record_id UUID REFERENCES public.normalized_records(id) ON DELETE CASCADE,
  right_source_record_id UUID REFERENCES public.normalized_records(id) ON DELETE CASCADE,
  override_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS on all tables
ALTER TABLE public.upload_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.uploaded_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.normalized_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reconciled_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commission_estimates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.manual_match_overrides ENABLE ROW LEVEL SECURITY;

-- Public access policies (internal tool, no auth required)
CREATE POLICY "Allow all access to upload_batches" ON public.upload_batches FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all access to uploaded_files" ON public.uploaded_files FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all access to normalized_records" ON public.normalized_records FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all access to reconciled_members" ON public.reconciled_members FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all access to commission_estimates" ON public.commission_estimates FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all access to manual_match_overrides" ON public.manual_match_overrides FOR ALL USING (true) WITH CHECK (true);

-- Storage bucket for CSV files
INSERT INTO storage.buckets (id, name, public) VALUES ('commission-files', 'commission-files', true);

CREATE POLICY "Allow public read on commission-files" ON storage.objects FOR SELECT USING (bucket_id = 'commission-files');
CREATE POLICY "Allow public insert on commission-files" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'commission-files');
CREATE POLICY "Allow public update on commission-files" ON storage.objects FOR UPDATE USING (bucket_id = 'commission-files');
CREATE POLICY "Allow public delete on commission-files" ON storage.objects FOR DELETE USING (bucket_id = 'commission-files');
