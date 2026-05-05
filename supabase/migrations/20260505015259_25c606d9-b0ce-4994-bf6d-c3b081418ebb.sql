-- Inline snapshot creation into upload_replace_file so the snapshot row,
-- the uploaded_files row, the normalized_records insert, the verify, the
-- supersede, and the promote all commit-or-rollback as a single TX.
--
-- Contract change:
--   - Drop the existing _bo_snapshot_id / _ede_snapshot_id params.
--   - Add _snapshot_kind ('bo' | 'ede' | 'none'),
--         _snapshot_source_kind text  (EDE only; e.g. 'summary'),
--         _snapshot_agent_bucket text (BO only),
--         _snapshot_date date         (optional override; defaults to today).
--   - The RPC creates the snapshot row (when applicable) and writes its id
--     into the corresponding normalized_records column.
--
-- Drop the old signature first so PostgREST resolves the new one cleanly.
DROP FUNCTION IF EXISTS public.upload_replace_file(
  uuid, text, text, text, text, text, text, date, uuid, uuid, jsonb, integer
);

CREATE OR REPLACE FUNCTION public.upload_replace_file(
  _batch_id uuid,
  _file_label text,
  _file_name text,
  _source_type text,
  _pay_entity text,
  _aor_bucket text,
  _storage_path text,
  _snapshot_date date,
  _snapshot_kind text,             -- 'bo' | 'ede' | 'none'
  _snapshot_source_kind text,      -- EDE only; nullable
  _snapshot_agent_bucket text,     -- BO only; nullable
  _rows jsonb,
  _expected_count integer
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  new_file_id uuid;
  new_bo_snapshot_id uuid;
  new_ede_snapshot_id uuid;
  inserted_count integer := 0;
  chunk_size integer := 1000;
  start_idx integer;
  chunk jsonb;
  row_count integer;
  effective_snapshot_date date := COALESCE(_snapshot_date, CURRENT_DATE);
BEGIN
  -- Validate snapshot kind contract.
  IF _snapshot_kind IS NULL OR _snapshot_kind NOT IN ('bo', 'ede', 'none') THEN
    RAISE EXCEPTION 'upload_replace_file: _snapshot_kind must be one of bo|ede|none (got %)', _snapshot_kind;
  END IF;

  -- Defensive: row count must match payload size.
  row_count := COALESCE(jsonb_array_length(_rows), 0);
  IF row_count <> _expected_count THEN
    RAISE EXCEPTION 'upload_replace_file: payload count mismatch (got %, expected %)',
      row_count, _expected_count;
  END IF;

  -- 1. Insert new uploaded_files row (staged).
  INSERT INTO public.uploaded_files (
    batch_id, file_label, file_name, source_type,
    pay_entity, aor_bucket, storage_path, snapshot_date,
    staging_status
  ) VALUES (
    _batch_id, _file_label, _file_name, _source_type,
    NULLIF(_pay_entity, ''), NULLIF(_aor_bucket, ''), _storage_path,
    effective_snapshot_date,
    'staged'
  )
  RETURNING id INTO new_file_id;

  -- 1b. Inline snapshot creation (same TX as the uploaded_files row).
  IF _snapshot_kind = 'bo' THEN
    INSERT INTO public.bo_snapshots (uploaded_file_id, snapshot_date, agent_bucket)
    VALUES (new_file_id, effective_snapshot_date, NULLIF(_snapshot_agent_bucket, ''))
    RETURNING id INTO new_bo_snapshot_id;
  ELSIF _snapshot_kind = 'ede' THEN
    INSERT INTO public.ede_snapshots (uploaded_file_id, snapshot_date, source_kind)
    VALUES (new_file_id, effective_snapshot_date, NULLIF(_snapshot_source_kind, ''))
    RETURNING id INTO new_ede_snapshot_id;
  END IF;

  -- 2. Insert normalized rows in chunks (staged, tied to new_file_id and new snapshot).
  IF row_count > 0 THEN
    start_idx := 0;
    WHILE start_idx < row_count LOOP
      SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
        INTO chunk
        FROM (
          SELECT elem
            FROM jsonb_array_elements(_rows) WITH ORDINALITY AS t(elem, ord)
           WHERE ord > start_idx AND ord <= start_idx + chunk_size
        ) sub;

      INSERT INTO public.normalized_records (
        batch_id, uploaded_file_id, bo_snapshot_id, ede_snapshot_id,
        source_type, source_file_label, carrier, applicant_name,
        first_name, last_name, dob, member_id,
        policy_number, exchange_subscriber_id, exchange_policy_id,
        issuer_policy_id, issuer_subscriber_id, agent_name, agent_npn,
        aor_bucket, pay_entity, status, effective_date,
        premium, net_premium, commission_amount, eligible_for_commission,
        policy_term_date, paid_through_date, broker_effective_date,
        broker_term_date, member_responsibility, on_off_exchange,
        auto_renewal, ede_policy_origin_type, ede_bucket, policy_modified_date,
        client_address_1, client_address_2, client_city, client_state_full,
        client_zip, paid_to_date, months_paid, writing_agent_carrier_id,
        member_key, raw_json,
        staging_status
      )
      SELECT
        _batch_id, new_file_id, new_bo_snapshot_id, new_ede_snapshot_id,
        r.source_type, r.source_file_label, r.carrier, r.applicant_name,
        r.first_name, r.last_name, r.dob, r.member_id,
        r.policy_number, r.exchange_subscriber_id, r.exchange_policy_id,
        r.issuer_policy_id, r.issuer_subscriber_id, r.agent_name, r.agent_npn,
        r.aor_bucket, r.pay_entity, r.status, r.effective_date,
        r.premium, r.net_premium, r.commission_amount, r.eligible_for_commission,
        r.policy_term_date, r.paid_through_date, r.broker_effective_date,
        r.broker_term_date, r.member_responsibility, r.on_off_exchange,
        r.auto_renewal, r.ede_policy_origin_type, r.ede_bucket, r.policy_modified_date,
        r.client_address_1, r.client_address_2, r.client_city, r.client_state_full,
        r.client_zip, r.paid_to_date, r.months_paid, r.writing_agent_carrier_id,
        r.member_key, r.raw_json,
        'staged'
      FROM jsonb_to_recordset(chunk) AS r(
        source_type text, source_file_label text, carrier text, applicant_name text,
        first_name text, last_name text, dob date, member_id text,
        policy_number text, exchange_subscriber_id text, exchange_policy_id text,
        issuer_policy_id text, issuer_subscriber_id text, agent_name text, agent_npn text,
        aor_bucket text, pay_entity text, status text, effective_date date,
        premium numeric, net_premium numeric, commission_amount numeric, eligible_for_commission text,
        policy_term_date date, paid_through_date date, broker_effective_date date,
        broker_term_date date, member_responsibility numeric, on_off_exchange text,
        auto_renewal boolean, ede_policy_origin_type text, ede_bucket text, policy_modified_date date,
        client_address_1 text, client_address_2 text, client_city text, client_state_full text,
        client_zip text, paid_to_date date, months_paid integer, writing_agent_carrier_id text,
        member_key text, raw_json jsonb
      );

      start_idx := start_idx + chunk_size;
    END LOOP;
  END IF;

  -- 3. Verify staged row count for this file.
  SELECT COUNT(*) INTO inserted_count
    FROM public.normalized_records
   WHERE uploaded_file_id = new_file_id
     AND staging_status = 'staged';

  IF inserted_count <> _expected_count THEN
    RAISE EXCEPTION 'upload_replace_file: post-insert verify failed for % (expected %, found %)',
      _file_label, _expected_count, inserted_count;
  END IF;

  -- 4. Supersede prior active rows for the same (batch, file_label).
  UPDATE public.normalized_records
     SET superseded_at = now(),
         staging_status = 'superseded'
   WHERE batch_id = _batch_id
     AND source_file_label = _file_label
     AND uploaded_file_id <> new_file_id
     AND staging_status = 'active'
     AND superseded_at IS NULL;

  UPDATE public.uploaded_files
     SET superseded_at = now(),
         staging_status = 'superseded'
   WHERE batch_id = _batch_id
     AND file_label = _file_label
     AND id <> new_file_id
     AND staging_status = 'active'
     AND superseded_at IS NULL;

  -- 5. Promote new staged rows + new file to active.
  UPDATE public.normalized_records
     SET staging_status = 'active'
   WHERE uploaded_file_id = new_file_id
     AND staging_status = 'staged';

  UPDATE public.uploaded_files
     SET staging_status = 'active'
   WHERE id = new_file_id
     AND staging_status = 'staged';

  RETURN new_file_id;
END;
$function$;