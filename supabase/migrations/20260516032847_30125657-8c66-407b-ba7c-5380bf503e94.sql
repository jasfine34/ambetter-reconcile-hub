CREATE INDEX IF NOT EXISTS cross_batch_clearings_active_status_idx
  ON public.cross_batch_clearings (staging_status, superseded_at);

CREATE OR REPLACE FUNCTION public.replace_cross_batch_clearings_for_run(
  p_run_id uuid,
  p_rows jsonb,
  p_scope text DEFAULT 'global_full_rebuild'
) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
BEGIN
  SET LOCAL statement_timeout = '60s';

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