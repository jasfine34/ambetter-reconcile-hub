ALTER FUNCTION public.insert_clearing_rows(uuid, jsonb) SET statement_timeout = '120s';
ALTER FUNCTION public.supersede_active_clearings_batch(integer) SET statement_timeout = '120s';