-- Partial composite index supporting Path B's keyset traversal:
-- (member_key IN (...) AND staging_status='active' AND superseded_at IS NULL ORDER BY id)
--
-- Without this, each keyset page in getNormalizedRecordsByMemberKeys degrades to
-- a heap scan + sort over every active normalized_records row (~27k+ today),
-- exceeding the 8s authenticated-role statement_timeout on Supabase.
--
-- The (member_key, id) order supports the IN-list lookup followed by stable
-- id ordering. The active partial predicate keeps the index size bounded since
-- superseded/staged rows are never queried by Path B.
CREATE INDEX IF NOT EXISTS normalized_records_active_member_key_id_idx
  ON public.normalized_records (member_key, id)
  WHERE staging_status = 'active' AND superseded_at IS NULL;