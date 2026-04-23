-- Phase 1c — reference-data tables for agent appointments and carrier canonicalization.
-- Structure only; ingestion UI arrives with Phase 3 (Commission Inquiry Form export).
-- The in-code constants drive today's AOR filter via src/lib/agents.ts.

-- 1. Agent appointments — one row per (agent NPN, carrier, state) appointment event.
-- Source file is the Agent_Appointments.csv that MessageFinancial provides.
-- Writing Agent Carrier ID is per (NPN, carrier, state) because some carriers
-- (notably BCBS) issue different producer numbers in different states.
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

-- 2. Carriers canonicalization — maps raw issuer/carrier strings to a canonical key.
-- Aliases live in an array so a single insert per carrier covers all the variant
-- names that show up across EDE, Back Office, and Commission statements.
CREATE TABLE IF NOT EXISTS public.carriers (
  canonical_key TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  aliases TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed Ambetter aliases — the carrier name shows up as "AMBETTER" in the agent
-- appointments file, "Ambetter Health" / "Ambetter from Sunshine Health" /
-- "Ambetter from Superior HealthPlan" / "Ambetter from Buckeye Health Plan"
-- across EDE, and "Ambetter" on commission statements.
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

-- 3. RLS policies (permissive, matching the internal-tool pattern)
ALTER TABLE public.agent_appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.carriers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all access to agent_appointments" ON public.agent_appointments
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Allow all access to carriers" ON public.carriers
  FOR ALL USING (true) WITH CHECK (true);
