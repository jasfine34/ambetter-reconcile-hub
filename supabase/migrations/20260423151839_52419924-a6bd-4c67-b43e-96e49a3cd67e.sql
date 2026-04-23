CREATE TABLE IF NOT EXISTS public.agent_appointments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name TEXT,
  agent_npn TEXT NOT NULL,
  carrier_raw TEXT,
  carrier_normalized TEXT,
  status TEXT,
  state TEXT,
  last_activity_date TIMESTAMPTZ,
  writing_number TEXT,
  is_coverall_aor BOOLEAN NOT NULL DEFAULT false,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_appointments_npn ON public.agent_appointments (agent_npn);
CREATE INDEX IF NOT EXISTS idx_agent_appointments_carrier ON public.agent_appointments (carrier_normalized);
CREATE INDEX IF NOT EXISTS idx_agent_appointments_coverall_aor
  ON public.agent_appointments (is_coverall_aor) WHERE is_coverall_aor = true;
CREATE INDEX IF NOT EXISTS idx_agent_appointments_lookup
  ON public.agent_appointments (agent_npn, carrier_normalized, state);

CREATE TABLE IF NOT EXISTS public.carriers (
  canonical_key TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  aliases TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.carriers (canonical_key, display_name, aliases) VALUES
  ('ambetter', 'Ambetter', ARRAY[
    'Ambetter',
    'AMBETTER',
    'Ambetter Health',
    'Ambetter from Sunshine Health',
    'Ambetter from Superior HealthPlan',
    'Ambetter from Buckeye Health Plan',
    'Ambetter from Absolute Total Care',
    'Ambetter from MHS',
    'Ambetter from Peach State Health Plan'
  ])
ON CONFLICT (canonical_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  aliases = EXCLUDED.aliases;

ALTER TABLE public.agent_appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.carriers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all access to agent_appointments" ON public.agent_appointments
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Allow all access to carriers" ON public.carriers
  FOR ALL USING (true) WITH CHECK (true);