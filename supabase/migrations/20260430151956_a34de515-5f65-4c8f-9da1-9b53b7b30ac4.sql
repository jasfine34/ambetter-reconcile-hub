CREATE OR REPLACE FUNCTION public.replace_reconciled_members_for_batch(_batch_id uuid, _members jsonb, _estimates jsonb DEFAULT '[]'::jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  member_count integer := COALESCE(jsonb_array_length(_members), 0);
  estimate_count integer := COALESCE(jsonb_array_length(_estimates), 0);
  chunk_size integer := 1000;
  start_idx integer;
  chunk jsonb;
BEGIN
  -- Atomic replace: DELETE + chunked INSERT all run in this function's
  -- single implicit transaction, so any failure rolls the batch back to
  -- its prior reconciled state. Each INSERT statement is bounded to
  -- chunk_size (1000) rows so it stays under statement_timeout even on
  -- the largest batches (~3,890 members for March 2026).
  DELETE FROM public.commission_estimates WHERE batch_id = _batch_id;
  DELETE FROM public.reconciled_members   WHERE batch_id = _batch_id;

  IF member_count > 0 THEN
    start_idx := 0;
    WHILE start_idx < member_count LOOP
      -- Slice _members[start_idx : start_idx + chunk_size) into a jsonb array.
      SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
      INTO chunk
      FROM (
        SELECT elem
        FROM jsonb_array_elements(_members) WITH ORDINALITY AS t(elem, ord)
        WHERE ord > start_idx AND ord <= start_idx + chunk_size
      ) sub;

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
      FROM jsonb_to_recordset(chunk) AS m(
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

      start_idx := start_idx + chunk_size;
    END LOOP;
  END IF;

  IF estimate_count > 0 THEN
    start_idx := 0;
    WHILE start_idx < estimate_count LOOP
      SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
      INTO chunk
      FROM (
        SELECT elem
        FROM jsonb_array_elements(_estimates) WITH ORDINALITY AS t(elem, ord)
        WHERE ord > start_idx AND ord <= start_idx + chunk_size
      ) sub;

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
      FROM jsonb_to_recordset(chunk) AS e(
        member_key text,
        basis text,
        estimated_commission numeric
      );

      start_idx := start_idx + chunk_size;
    END LOOP;
  END IF;

  RETURN member_count;
END;
$function$;