-- Phase 1a — snapshot tables and history retention
CREATE TABLE IF NOT EXISTS public.bo_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  carrier TEXT NOT NULL DEFAULT 'Ambetter',
  agent_bucket TEXT,
  snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
  uploaded_file_id UUID REFERENCES public.uploaded_files(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ede_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
  source_kind TEXT,
  uploaded_file_id UUID REFERENCES public.uploaded_files(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.normalized_records
  ADD COLUMN IF NOT EXISTS bo_snapshot_id UUID REFERENCES public.bo_snapshots(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS ede_snapshot_id UUID REFERENCES public.ede_snapshots(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;

ALTER TABLE public.uploaded_files
  ADD COLUMN IF NOT EXISTS snapshot_date DATE DEFAULT CURRENT_DATE,
  ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_normalized_current
  ON public.normalized_records (batch_id, source_file_label)
  WHERE superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_normalized_bo_snapshot
  ON public.normalized_records (bo_snapshot_id)
  WHERE bo_snapshot_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_normalized_ede_snapshot
  ON public.normalized_records (ede_snapshot_id)
  WHERE ede_snapshot_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_uploaded_files_current
  ON public.uploaded_files (batch_id, file_label)
  WHERE superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_bo_snapshots_file ON public.bo_snapshots (uploaded_file_id);
CREATE INDEX IF NOT EXISTS idx_ede_snapshots_file ON public.ede_snapshots (uploaded_file_id);

ALTER TABLE public.bo_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ede_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all access to bo_snapshots" ON public.bo_snapshots
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Allow all access to ede_snapshots" ON public.ede_snapshots
  FOR ALL USING (true) WITH CHECK (true);