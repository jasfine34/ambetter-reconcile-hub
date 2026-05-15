CREATE TABLE public.cross_batch_clearings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_identity_key text NOT NULL,
  target_service_month text NOT NULL CHECK (target_service_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  reconciled_member_id uuid REFERENCES public.reconciled_members(id) ON DELETE SET NULL,
  unpaid_batch_id uuid NOT NULL,
  unpaid_batch_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  payment_batch_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  unpaid_statement_month text NOT NULL CHECK (unpaid_statement_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  policy_number text,
  issuer_subscriber_id text,
  carrier text NOT NULL,
  pay_entity text,
  agent_npn text,
  clearing_state text NOT NULL CHECK (clearing_state IN (
    'fully_cleared',
    'partially_cleared',
    'not_cleared',
    'cleared_then_reversed',
    'zero_expected_no_payment_required',
    'manual_review_required'
  )),
  expected_amount numeric,
  threshold_amount numeric,
  actual_positive_amount numeric,
  actual_reversal_amount numeric,
  actual_net_amount numeric,
  remainder_owed numeric,
  comp_rate_id uuid REFERENCES public.carrier_comp_rates(id),
  comp_grid_evidence jsonb,
  state_resolution_evidence jsonb,
  member_count integer,
  months_covered integer,
  policy_year integer,
  identity_match_keys jsonb,
  identity_match_evidence jsonb,
  matched_paid_record_ids jsonb,
  reversal_record_ids jsonb,
  ignored_record_ids jsonb,
  source_batch_ids jsonb,
  clearing_statement_months jsonb,
  reversed_at_statement_month text,
  first_full_clear_statement_month text,
  reason text,
  manual_review_reason text,
  run_id uuid NOT NULL,
  logic_version text NOT NULL,
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  staging_status text NOT NULL DEFAULT 'active' CHECK (staging_status IN ('active', 'superseded')),
  superseded_at timestamptz
);

CREATE UNIQUE INDEX cross_batch_clearings_active_grain_unique
  ON public.cross_batch_clearings (policy_identity_key, target_service_month)
  WHERE staging_status = 'active' AND superseded_at IS NULL;

CREATE INDEX cross_batch_clearings_history_idx
  ON public.cross_batch_clearings (policy_identity_key, target_service_month, evaluated_at);

CREATE INDEX cross_batch_clearings_canonical_unpaid_batch_idx
  ON public.cross_batch_clearings (unpaid_batch_id, clearing_state, staging_status);

CREATE INDEX cross_batch_clearings_unpaid_batch_ids_gin
  ON public.cross_batch_clearings USING gin (unpaid_batch_ids);

CREATE INDEX cross_batch_clearings_payment_batch_ids_gin
  ON public.cross_batch_clearings USING gin (payment_batch_ids);

CREATE INDEX cross_batch_clearings_carrier_month_idx
  ON public.cross_batch_clearings (carrier, target_service_month);

CREATE INDEX cross_batch_clearings_run_idx
  ON public.cross_batch_clearings (run_id);

ALTER TABLE public.cross_batch_clearings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all access to cross_batch_clearings"
  ON public.cross_batch_clearings
  FOR ALL
  USING (true)
  WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.replace_cross_batch_clearings_for_run(
  p_run_id uuid,
  p_rows jsonb,
  p_scope text DEFAULT 'global_full_rebuild'
) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('cross_batch_clearings_global_full_rebuild'));

  IF p_scope = 'global_full_rebuild' THEN
    UPDATE public.cross_batch_clearings
    SET superseded_at = now(),
        staging_status = 'superseded'
    WHERE staging_status = 'active' AND superseded_at IS NULL;
  ELSE
    RAISE EXCEPTION 'Unsupported p_scope value: %', p_scope;
  END IF;

  INSERT INTO public.cross_batch_clearings (
    policy_identity_key, target_service_month, reconciled_member_id,
    unpaid_batch_id, unpaid_batch_ids, payment_batch_ids,
    unpaid_statement_month, policy_number, issuer_subscriber_id,
    carrier, pay_entity, agent_npn, clearing_state,
    expected_amount, threshold_amount, actual_positive_amount, actual_reversal_amount,
    actual_net_amount, remainder_owed, comp_rate_id, comp_grid_evidence,
    state_resolution_evidence, member_count, months_covered, policy_year,
    identity_match_keys, identity_match_evidence, matched_paid_record_ids,
    reversal_record_ids, ignored_record_ids, source_batch_ids, clearing_statement_months,
    reversed_at_statement_month, first_full_clear_statement_month, reason,
    manual_review_reason, run_id, logic_version, evaluated_at, staging_status
  )
  SELECT
    r->>'policy_identity_key',
    r->>'target_service_month',
    NULLIF(r->>'reconciled_member_id', '')::uuid,
    (r->>'unpaid_batch_id')::uuid,
    COALESCE(r->'unpaid_batch_ids', '[]'::jsonb),
    COALESCE(r->'payment_batch_ids', '[]'::jsonb),
    r->>'unpaid_statement_month',
    r->>'policy_number',
    r->>'issuer_subscriber_id',
    r->>'carrier',
    r->>'pay_entity',
    r->>'agent_npn',
    r->>'clearing_state',
    NULLIF(r->>'expected_amount', '')::numeric,
    NULLIF(r->>'threshold_amount', '')::numeric,
    NULLIF(r->>'actual_positive_amount', '')::numeric,
    NULLIF(r->>'actual_reversal_amount', '')::numeric,
    NULLIF(r->>'actual_net_amount', '')::numeric,
    NULLIF(r->>'remainder_owed', '')::numeric,
    NULLIF(r->>'comp_rate_id', '')::uuid,
    r->'comp_grid_evidence',
    r->'state_resolution_evidence',
    NULLIF(r->>'member_count', '')::integer,
    NULLIF(r->>'months_covered', '')::integer,
    NULLIF(r->>'policy_year', '')::integer,
    r->'identity_match_keys',
    r->'identity_match_evidence',
    r->'matched_paid_record_ids',
    r->'reversal_record_ids',
    r->'ignored_record_ids',
    r->'source_batch_ids',
    r->'clearing_statement_months',
    r->>'reversed_at_statement_month',
    r->>'first_full_clear_statement_month',
    r->>'reason',
    r->>'manual_review_reason',
    p_run_id,
    r->>'logic_version',
    now(),
    'active'
  FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) r;
END;
$$;