
CREATE TABLE public.operator_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  carrier text NOT NULL,
  stable_member_key text NOT NULL,
  policy_identity_key text NOT NULL,
  service_month text NOT NULL CHECK (service_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  target_scope text NOT NULL,
  reason_code text NOT NULL,
  decision_type text NOT NULL,
  internal_note text,
  messer_comment text,
  evidence_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  release_rule text NOT NULL,
  amount_payload jsonb,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','released')),
  superseded_at timestamptz,
  superseded_by_decision_id uuid,
  released_at timestamptz,
  release_trigger text CHECK (release_trigger IN ('auto_premium','commission_file','manual')),
  decided_by text,
  decided_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.operator_decisions TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.operator_decisions TO authenticated;
GRANT ALL ON public.operator_decisions TO service_role;

ALTER TABLE public.operator_decisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all access to operator_decisions"
  ON public.operator_decisions
  FOR ALL
  USING (true)
  WITH CHECK (true);

CREATE UNIQUE INDEX operator_decisions_active_grain_uniq
  ON public.operator_decisions (carrier, stable_member_key, policy_identity_key, service_month, target_scope, reason_code)
  WHERE status = 'active';

CREATE INDEX operator_decisions_member_month_idx
  ON public.operator_decisions (carrier, stable_member_key, service_month);

CREATE INDEX operator_decisions_status_idx
  ON public.operator_decisions (status);

-- record_operator_decision: atomic supersede-then-insert. Serializes
-- competing writers on the full grain via pg_advisory_xact_lock on a
-- hash of the grain, so the empty-grain first-insert race cannot
-- produce two active rows. Returns the freshly-inserted row.
CREATE OR REPLACE FUNCTION public.record_operator_decision(
  p_carrier text,
  p_stable_member_key text,
  p_policy_identity_key text,
  p_service_month text,
  p_target_scope text,
  p_reason_code text,
  p_decision_type text,
  p_release_rule text,
  p_evidence_snapshot jsonb,
  p_internal_note text DEFAULT NULL,
  p_messer_comment text DEFAULT NULL,
  p_amount_payload jsonb DEFAULT NULL,
  p_decided_by text DEFAULT NULL
)
RETURNS public.operator_decisions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lock_key bigint;
  v_new_id uuid := gen_random_uuid();
  v_row public.operator_decisions;
BEGIN
  v_lock_key := ('x' || substr(md5(
    p_carrier || '|' || p_stable_member_key || '|' || p_policy_identity_key
    || '|' || p_service_month || '|' || p_target_scope || '|' || p_reason_code
  ), 1, 16))::bit(64)::bigint;
  PERFORM pg_advisory_xact_lock(v_lock_key);

  UPDATE public.operator_decisions
     SET status = 'superseded',
         superseded_at = now(),
         superseded_by_decision_id = v_new_id
   WHERE status = 'active'
     AND carrier = p_carrier
     AND stable_member_key = p_stable_member_key
     AND policy_identity_key = p_policy_identity_key
     AND service_month = p_service_month
     AND target_scope = p_target_scope
     AND reason_code = p_reason_code;

  INSERT INTO public.operator_decisions (
    id, carrier, stable_member_key, policy_identity_key, service_month,
    target_scope, reason_code, decision_type, internal_note, messer_comment,
    evidence_snapshot, release_rule, amount_payload, status,
    decided_by, decided_at
  ) VALUES (
    v_new_id, p_carrier, p_stable_member_key, p_policy_identity_key, p_service_month,
    p_target_scope, p_reason_code, p_decision_type, p_internal_note, p_messer_comment,
    COALESCE(p_evidence_snapshot, '{}'::jsonb), p_release_rule, p_amount_payload, 'active',
    p_decided_by, now()
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_operator_decision(
  p_id uuid,
  p_trigger text,
  p_evidence jsonb DEFAULT NULL
)
RETURNS public.operator_decisions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.operator_decisions;
BEGIN
  IF p_trigger NOT IN ('auto_premium','commission_file','manual') THEN
    RAISE EXCEPTION 'release_operator_decision: invalid trigger %', p_trigger;
  END IF;

  UPDATE public.operator_decisions
     SET status = 'released',
         released_at = now(),
         release_trigger = p_trigger,
         evidence_snapshot = CASE
           WHEN p_evidence IS NULL THEN evidence_snapshot
           ELSE evidence_snapshot || jsonb_build_object('release_evidence', p_evidence)
         END
   WHERE id = p_id
     AND status = 'active'
   RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    SELECT * INTO v_row FROM public.operator_decisions WHERE id = p_id;
  END IF;

  RETURN v_row;
END;
$$;
