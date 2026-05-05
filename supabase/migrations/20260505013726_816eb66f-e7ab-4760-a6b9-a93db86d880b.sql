-- =====================================================================
-- Add required-source-type aggregate guard to replace_normalized_for_file_set
-- =====================================================================
-- Closes the Feb 15:32 regression hole: per-file count verify alone
-- accepts a plan where every file's expected_count is 0 (or where one
-- whole source type silently produced 0 rows). Aggregate guard refuses
-- to promote unless every required source type has > 0 staged rows
-- across the entire rebuild plan.
--
-- Caller passes _required_source_types as an explicit text[] (e.g.
-- ARRAY['EDE','BACK_OFFICE','COMMISSION']). JS derives this from the
-- active uploaded_files set in scope, omitting any source type with
-- no files in the plan. Explicit array keeps the contract loud — no
-- implicit derivation from expected_counts metadata.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.replace_normalized_for_file_set(
  _batch_id uuid,
  _session_id uuid,
  _expected_counts jsonb,
  _required_source_types text[] DEFAULT NULL
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
  required_type text;
  type_staged_count integer;
BEGIN
  -- (1) Lock-ownership cross-check inside the TX (FOR UPDATE pin).
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

  -- (3) NEW: Required-source-type aggregate guard.
  --     For every source type the caller flagged as required for this
  --     rebuild plan, confirm staged_count > 0 across all files of that
  --     type in scope. Catches the Feb 15:32 silent-zero-EDE wipe.
  IF _required_source_types IS NOT NULL AND array_length(_required_source_types, 1) > 0 THEN
    FOREACH required_type IN ARRAY _required_source_types
    LOOP
      SELECT COUNT(*) INTO type_staged_count
        FROM public.normalized_records
       WHERE batch_id = _batch_id
         AND uploaded_file_id = ANY(file_ids)
         AND staging_status = 'staged'
         AND rebuild_session_id = _session_id
         AND source_type = required_type;

      IF type_staged_count = 0 THEN
        RAISE EXCEPTION 'replace_normalized_for_file_set: required source type % has 0 staged rows for batch % (refusing to promote — would wipe active % data)',
          required_type, _batch_id, required_type;
      END IF;
    END LOOP;
  END IF;

  -- (4) Supersede prior active rows for every file in scope.
  UPDATE public.normalized_records
     SET superseded_at = now(),
         staging_status = 'superseded'
   WHERE batch_id = _batch_id
     AND uploaded_file_id = ANY(file_ids)
     AND staging_status = 'active'
     AND superseded_at IS NULL;

  -- (5) Promote staged session rows to active.
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
