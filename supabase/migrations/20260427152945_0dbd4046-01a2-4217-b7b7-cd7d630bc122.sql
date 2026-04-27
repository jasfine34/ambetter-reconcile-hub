-- Weak-match overrides keyed on STABLE identifiers (spec §1c).
-- Distinct from the existing `manual_match_overrides` table (which keys on
-- left/right normalized_record ids and is used by the legacy Manual Match
-- flow). This new table keys on identity-level stable IDs that survive
-- rebuilds and union-find re-shuffles.
--
-- Priority for override_key (chosen by application layer):
--   1. ffmAppId  (if/when surfaced — currently issuerSubscriberId in EDE)
--   2. issuer_subscriber_id
--   3. exchange_subscriber_id
-- Never key on member_key (it shifts when issuer IDs resolve later).

CREATE TABLE public.weak_match_overrides (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  override_key TEXT NOT NULL,
  -- Stable id of the BO candidate the user confirmed/rejected. Same priority
  -- order as override_key (issuer_subscriber_id, then exchange_subscriber_id,
  -- then policy_number with cleanId applied). Nullable when decision is
  -- 'rejected' against ALL candidates.
  candidate_bo_member_key TEXT,
  candidate_bo_stable_key TEXT,
  decision TEXT NOT NULL CHECK (decision IN ('confirmed','rejected','deferred')),
  decided_by TEXT,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes TEXT,
  -- Snapshot of the matching signals at decision time so we can audit later
  -- without rebuilding the candidate set. Free-form JSON.
  signals JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_weak_match_overrides_key
  ON public.weak_match_overrides (override_key);

CREATE INDEX idx_weak_match_overrides_decision
  ON public.weak_match_overrides (decision);

ALTER TABLE public.weak_match_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all access to weak_match_overrides"
  ON public.weak_match_overrides
  FOR ALL
  USING (true)
  WITH CHECK (true);
