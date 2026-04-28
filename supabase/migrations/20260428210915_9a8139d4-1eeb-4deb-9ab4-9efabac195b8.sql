CREATE INDEX IF NOT EXISTS idx_reconciled_members_batch_id
  ON public.reconciled_members (batch_id, id);

CREATE OR REPLACE FUNCTION public.replace_reconciled_members_for_batch(
  _batch_id uuid,
  _members jsonb,
  _estimates jsonb DEFAULT '[]'::jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  member_count integer := COALESCE(jsonb_array_length(_members), 0);
BEGIN
  DELETE FROM public.commission_estimates
  WHERE batch_id = _batch_id;

  DELETE FROM public.reconciled_members
  WHERE batch_id = _batch_id;

  IF member_count > 0 THEN
    INSERT INTO public.reconciled_members (
      batch_id,
      member_key,
      carrier,
      applicant_name,
      dob,
      policy_number,
      exchange_subscriber_id,
      exchange_policy_id,
      issuer_policy_id,
      issuer_subscriber_id,
      agent_name,
      agent_npn,
      aor_bucket,
      current_policy_aor,
      expected_pay_entity,
      actual_pay_entity,
      in_ede,
      in_back_office,
      in_commission,
      eligible_for_commission,
      premium,
      net_premium,
      actual_commission,
      positive_commission,
      clawback_amount,
      estimated_missing_commission,
      issue_type,
      issue_notes,
      is_in_expected_ede_universe,
      expected_ede_effective_month
    )
    SELECT
      _batch_id,
      m.member_key,
      m.carrier,
      m.applicant_name,
      m.dob,
      m.policy_number,
      m.exchange_subscriber_id,
      m.exchange_policy_id,
      m.issuer_policy_id,
      m.issuer_subscriber_id,
      m.agent_name,
      m.agent_npn,
      m.aor_bucket,
      m.current_policy_aor,
      m.expected_pay_entity,
      m.actual_pay_entity,
      COALESCE(m.in_ede, false),
      COALESCE(m.in_back_office, false),
      COALESCE(m.in_commission, false),
      m.eligible_for_commission,
      m.premium,
      m.net_premium,
      m.actual_commission,
      m.positive_commission,
      m.clawback_amount,
      m.estimated_missing_commission,
      m.issue_type,
      m.issue_notes,
      COALESCE(m.is_in_expected_ede_universe, false),
      m.expected_ede_effective_month
    FROM jsonb_to_recordset(_members) AS m(
      member_key text,
      carrier text,
      applicant_name text,
      dob date,
      policy_number text,
      exchange_subscriber_id text,
      exchange_policy_id text,
      issuer_policy_id text,
      issuer_subscriber_id text,
      agent_name text,
      agent_npn text,
      aor_bucket text,
      current_policy_aor text,
      expected_pay_entity text,
      actual_pay_entity text,
      in_ede boolean,
      in_back_office boolean,
      in_commission boolean,
      eligible_for_commission text,
      premium numeric,
      net_premium numeric,
      actual_commission numeric,
      positive_commission numeric,
      clawback_amount numeric,
      estimated_missing_commission numeric,
      issue_type text,
      issue_notes text,
      is_in_expected_ede_universe boolean,
      expected_ede_effective_month text
    );
  END IF;

  IF COALESCE(jsonb_array_length(_estimates), 0) > 0 THEN
    INSERT INTO public.commission_estimates (
      batch_id,
      member_key,
      basis,
      estimated_commission
    )
    SELECT
      _batch_id,
      e.member_key,
      COALESCE(e.basis, 'avg_agent_commission'),
      e.estimated_commission
    FROM jsonb_to_recordset(_estimates) AS e(
      member_key text,
      basis text,
      estimated_commission numeric
    );
  END IF;

  RETURN member_count;
END;
$$;