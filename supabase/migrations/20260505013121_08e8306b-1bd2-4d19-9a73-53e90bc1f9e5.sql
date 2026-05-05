-- =====================================================================
-- Atomic rebuild + safe upload infrastructure
-- =====================================================================
-- Adds:
--   * staging_status enum-like text column on normalized_records + uploaded_files
--   * rebuild_session_id on normalized_records (session-scoped staging)
--   * single-flight session lock on upload_batches
--   * upload_replace_file RPC (atomic upload-and-supersede)
--   * replace_normalized_for_file_set RPC (atomic batch-level rebuild promote)
--   * acquire_rebuild_lock / release_rebuild_lock helpers
--   * partial indexes matching the canonical active predicate
--   * drops redundant idx_normalized_batch_superseded
--
-- Backfill: all existing rows -> staging_status='active'.
-- All existing data remains visible; this is purely additive.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Schema additions
-- ---------------------------------------------------------------------

ALTER TABLE public.normalized_records
  ADD COLUMN IF NOT EXISTS staging_status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS rebuild_session_id uuid;

ALTER TABLE public.uploaded_files
  ADD COLUMN IF NOT EXISTS staging_status text NOT NULL DEFAULT 'active';

ALTER TABLE public.upload_batches
  ADD COLUMN IF NOT EXISTS current_rebuild_session_id uuid,
  ADD COLUMN IF NOT EXISTS rebuild_started_at timestamptz;

-- Domain check (cheap, fast). 'active' | 'staged' | 'superseded'.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'normalized_records_staging_status_chk'
  ) THEN
    ALTER TABLE public.normalized_records
      ADD CONSTRAINT normalized_records_staging_status_chk
      CHECK (staging_status IN ('active', 'staged', 'superseded'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uploaded_files_staging_status_chk'
  ) THEN
    ALTER TABLE public.uploaded_files
      ADD CONSTRAINT uploaded_files_staging_status_chk
      CHECK (staging_status IN ('active', 'staged', 'superseded'));
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 2. Backfill: every existing superseded row -> 'superseded',
--    everything else stays 'active' (already the default).
-- ---------------------------------------------------------------------

UPDATE public.normalized_records
   SET staging_status = 'superseded'
 WHERE superseded_at IS NOT NULL
   AND staging_status = 'active';

UPDATE public.uploaded_files
   SET staging_status = 'superseded'
 WHERE superseded_at IS NOT NULL
   AND staging_status = 'active';

-- ---------------------------------------------------------------------
-- 3. Indexes
-- ---------------------------------------------------------------------

-- Drop the now-redundant index (canonical reads no longer use bare superseded_at).
DROP INDEX IF EXISTS public.idx_normalized_batch_superseded;

-- Hot path: canonical active reads filter (batch_id, staging_status='active', superseded_at IS NULL).
CREATE INDEX IF NOT EXISTS idx_normalized_active
  ON public.normalized_records (batch_id)
  WHERE staging_status = 'active' AND superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_uploaded_files_active
  ON public.uploaded_files (batch_id)
  WHERE staging_status = 'active' AND superseded_at IS NULL;

-- Cleanup support: locate staged rows by session for pre-flush + cleanup-on-failure.
CREATE INDEX IF NOT EXISTS idx_normalized_staged_session
  ON public.normalized_records (rebuild_session_id)
  WHERE staging_status = 'staged';

-- ---------------------------------------------------------------------
-- 4. Single-flight rebuild lock helpers
-- ---------------------------------------------------------------------

-- Acquire: atomic CAS — succeeds only if the batch has no active session OR
-- the existing session is older than 30 minutes (TTL auto-recovery).
-- Returns the session id on success; raises on contention.
CREATE OR REPLACE FUNCTION public.acquire_rebuild_lock(
  _batch_id uuid,
  _session_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  acquired_session uuid;
BEGIN
  UPDATE public.upload_batches
     SET current_rebuild_session_id = _session_id,
         rebuild_started_at = now()
   WHERE id = _batch_id
     AND (current_rebuild_session_id IS NULL
          OR rebuild_started_at < now() - interval '30 minutes')
  RETURNING current_rebuild_session_id INTO acquired_session;

  IF acquired_session IS NULL THEN
    RAISE EXCEPTION 'Another rebuild is already in progress for batch %', _batch_id
      USING ERRCODE = 'lock_not_available';
  END IF;

  RETURN acquired_session;
END;
$function$;

-- Release: only the session that owns the lock can release it.
CREATE OR REPLACE FUNCTION public.release_rebuild_lock(
  _batch_id uuid,
  _session_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  UPDATE public.upload_batches
     SET current_rebuild_session_id = NULL,
         rebuild_started_at = NULL
   WHERE id = _batch_id
     AND current_rebuild_session_id = _session_id;
END;
$function$;

-- ---------------------------------------------------------------------
-- 5. upload_replace_file RPC
-- ---------------------------------------------------------------------
-- Atomic: create new uploaded_files row -> insert normalized rows ->
-- verify count -> supersede prior file + prior rows. All in one TX.
-- A failure anywhere rolls everything back; old data stays active.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.upload_replace_file(
  _batch_id uuid,
  _file_label text,
  _file_name text,
  _source_type text,
  _pay_entity text,
  _aor_bucket text,
  _storage_path text,
  _snapshot_date date,
  _bo_snapshot_id uuid,
  _ede_snapshot_id uuid,
  _rows jsonb,
  _expected_count integer
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  new_file_id uuid;
  inserted_count integer := 0;
  chunk_size integer := 1000;
  start_idx integer;
  chunk jsonb;
  row_count integer;
BEGIN
  -- Defensive: row count must match the JSON payload size.
  row_count := COALESCE(jsonb_array_length(_rows), 0);
  IF row_count <> _expected_count THEN
    RAISE EXCEPTION 'upload_replace_file: payload count mismatch (got %, expected %)',
      row_count, _expected_count;
  END IF;

  -- 1. Insert the new uploaded_files row (staged).
  INSERT INTO public.uploaded_files (
    batch_id, file_label, file_name, source_type,
    pay_entity, aor_bucket, storage_path, snapshot_date,
    staging_status
  ) VALUES (
    _batch_id, _file_label, _file_name, _source_type,
    NULLIF(_pay_entity, ''), NULLIF(_aor_bucket, ''), _storage_path,
    COALESCE(_snapshot_date, CURRENT_DATE),
    'staged'
  )
  RETURNING id INTO new_file_id;

  -- 2. Insert normalized rows in chunks (staged, tied to new_file_id).
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
        _batch_id, new_file_id, _bo_snapshot_id, _ede_snapshot_id,
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

  -- 3. Verify staged row count for this file matches expected.
  SELECT COUNT(*) INTO inserted_count
    FROM public.normalized_records
   WHERE uploaded_file_id = new_file_id
     AND staging_status = 'staged';

  IF inserted_count <> _expected_count THEN
    RAISE EXCEPTION 'upload_replace_file: post-insert verify failed for % (expected %, found %)',
      _file_label, _expected_count, inserted_count;
  END IF;

  -- 4. Supersede prior active rows for the same (batch, file_label).
  --    Only after the new staged data is fully verified.
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

-- ---------------------------------------------------------------------
-- 6. replace_normalized_for_file_set RPC (batch-level rebuild promote)
-- ---------------------------------------------------------------------
-- Pre-conditions:
--   * Caller has acquired the rebuild lock with _session_id.
--   * Caller has staged all per-file rows with staging_status='staged'
--     and rebuild_session_id=_session_id.
--   * _expected_counts is jsonb: [{ file_id, expected }, ...]
--
-- The RPC verifies every file's staged count, then atomically:
--   1. Asserts the lock still belongs to _session_id (cross-check)
--   2. Supersedes all prior active rows for the file_ids in scope
--   3. Promotes staged session rows to active
-- All in one transaction; failure rolls everything back.
-- Returns the total promoted row count.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.replace_normalized_for_file_set(
  _batch_id uuid,
  _session_id uuid,
  _expected_counts jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  current_session uuid;
  expected_record record;
  staged_count integer;
  file_ids uuid[];
  total_promoted integer := 0;
BEGIN
  -- (1) Lock-ownership cross-check inside the TX.
  SELECT current_rebuild_session_id INTO current_session
    FROM public.upload_batches
   WHERE id = _batch_id
   FOR UPDATE;

  IF current_session IS NULL OR current_session <> _session_id THEN
    RAISE EXCEPTION 'replace_normalized_for_file_set: lock lost or stolen for batch % (expected session %, found %)',
      _batch_id, _session_id, current_session
      USING ERRCODE = 'lock_not_available';
  END IF;

  -- Collect file ids in scope.
  SELECT array_agg((rec->>'file_id')::uuid)
    INTO file_ids
    FROM jsonb_array_elements(_expected_counts) AS rec;

  IF file_ids IS NULL OR array_length(file_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'replace_normalized_for_file_set: empty file set';
  END IF;

  -- (2) Per-file staged-count verification.
  FOR expected_record IN
    SELECT
      (rec->>'file_id')::uuid AS file_id,
      (rec->>'expected')::integer AS expected
    FROM jsonb_array_elements(_expected_counts) AS rec
  LOOP
    SELECT COUNT(*) INTO staged_count
      FROM public.normalized_records
     WHERE batch_id = _batch_id
       AND uploaded_file_id = expected_record.file_id
       AND staging_status = 'staged'
       AND rebuild_session_id = _session_id;

    IF staged_count <> expected_record.expected THEN
      RAISE EXCEPTION 'replace_normalized_for_file_set: count mismatch for file % (expected %, staged %)',
        expected_record.file_id, expected_record.expected, staged_count;
    END IF;
  END LOOP;

  -- (3) Supersede prior active rows for every file in scope.
  UPDATE public.normalized_records
     SET superseded_at = now(),
         staging_status = 'superseded'
   WHERE batch_id = _batch_id
     AND uploaded_file_id = ANY(file_ids)
     AND staging_status = 'active'
     AND superseded_at IS NULL;

  -- (4) Promote staged session rows to active.
  UPDATE public.normalized_records
     SET staging_status = 'active'
   WHERE batch_id = _batch_id
     AND uploaded_file_id = ANY(file_ids)
     AND staging_status = 'staged'
     AND rebuild_session_id = _session_id;

  GET DIAGNOSTICS total_promoted = ROW_COUNT;
  RETURN total_promoted;
END;
$function$;

-- ---------------------------------------------------------------------
-- 7. Pre-flush helper for stale staged rows from prior crashed sessions
-- ---------------------------------------------------------------------
-- Called at the start of Phase 1 with the file_ids in scope. Safe because
-- staged rows are inert (excluded from canonical reads) and current-session
-- rows do not exist yet at Phase 1 start.

CREATE OR REPLACE FUNCTION public.preflush_stale_staged_rows(
  _batch_id uuid,
  _file_ids uuid[]
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  flushed integer;
BEGIN
  DELETE FROM public.normalized_records
   WHERE batch_id = _batch_id
     AND uploaded_file_id = ANY(_file_ids)
     AND staging_status = 'staged'
     AND rebuild_session_id IS NOT NULL;

  GET DIAGNOSTICS flushed = ROW_COUNT;
  RETURN flushed;
END;
$function$;
