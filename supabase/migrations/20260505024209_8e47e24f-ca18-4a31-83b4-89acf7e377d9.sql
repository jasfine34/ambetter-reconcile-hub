ALTER FUNCTION public.upload_replace_file(uuid, text, text, text, text, text, text, date, text, text, text, jsonb, integer)
  SET statement_timeout = '120s';

ALTER FUNCTION public.replace_normalized_for_file_set(uuid, uuid, jsonb, text[])
  SET statement_timeout = '120s';