ALTER TABLE public.reconciled_members
  ADD COLUMN IF NOT EXISTS current_policy_aor TEXT;
COMMENT ON COLUMN public.reconciled_members.current_policy_aor IS
  'Canonical AOR-of-record from EDE currentPolicyAOR (winner among the member''s qualified EDE rows). Distinct from aor_bucket which is writing-agent-derived from agent_npn. NULL when the member has no EDE row.';
CREATE INDEX IF NOT EXISTS idx_reconciled_members_current_policy_aor
  ON public.reconciled_members (batch_id, current_policy_aor);