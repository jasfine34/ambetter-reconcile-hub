-- Step 1: Supersede the two Feb-batch commission files (duplicates of Jan batch)
-- and their normalized rows.
UPDATE public.uploaded_files
SET superseded_at = now()
WHERE id IN (
  '8bc423a5-0765-4fee-a768-21e154298a72', -- Feb batch Coverall Commission Statement
  '9f7126e0-08a7-4380-9ac4-ec58372ac7fd'  -- Feb batch Vix Commission Statement
);

UPDATE public.normalized_records
SET superseded_at = now()
WHERE uploaded_file_id IN (
  '8bc423a5-0765-4fee-a768-21e154298a72',
  '9f7126e0-08a7-4380-9ac4-ec58372ac7fd'
)
AND superseded_at IS NULL;

-- Step 2a: Un-supersede the original Feb EDE files (BC3614-...2026-02-02) in the Feb batch
UPDATE public.uploaded_files
SET superseded_at = NULL
WHERE batch_id = '1569468f-8962-41c7-bd05-10bc509fa31b'
  AND source_type = 'EDE'
  AND file_name LIKE 'BC3614-%2026-02-02%';

-- Also un-supersede their normalized rows
UPDATE public.normalized_records
SET superseded_at = NULL
WHERE uploaded_file_id IN (
  SELECT id FROM public.uploaded_files
  WHERE batch_id = '1569468f-8962-41c7-bd05-10bc509fa31b'
    AND source_type = 'EDE'
    AND file_name LIKE 'BC3614-%2026-02-02%'
);

-- Step 2b: Supersede the incorrectly-uploaded Jan EDE files (JF3010-...2026-01-02) in the Feb batch
UPDATE public.uploaded_files
SET superseded_at = now()
WHERE batch_id = '1569468f-8962-41c7-bd05-10bc509fa31b'
  AND source_type = 'EDE'
  AND file_name LIKE 'JF3010-%2026-01-02%'
  AND superseded_at IS NULL;

UPDATE public.normalized_records
SET superseded_at = now()
WHERE uploaded_file_id IN (
  SELECT id FROM public.uploaded_files
  WHERE batch_id = '1569468f-8962-41c7-bd05-10bc509fa31b'
    AND source_type = 'EDE'
    AND file_name LIKE 'JF3010-%2026-01-02%'
)
AND superseded_at IS NULL;