-- 002_fase2.sql — Fase 2: campañas, búsquedas, ofertas, evaluaciones e informes.
-- Ver CONTRATO Fase 2 §1 (~/workspace/jobforce/fase2/CONTRATO_API.md).

CREATE TABLE campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  criteria jsonb NOT NULL,
  exa_budget_cap_usd numeric(10,4) NOT NULL DEFAULT 3.0000,
  exa_spent_usd numeric(10,4) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived')),
  created_by uuid REFERENCES admin_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE searches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  query text NOT NULL,
  num_results int NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','error')),
  exa_request_id text,
  cost_usd numeric(10,4) NOT NULL DEFAULT 0,
  results_count int NOT NULL DEFAULT 0,
  duplicates_count int NOT NULL DEFAULT 0,
  error text,
  started_at timestamptz,
  finished_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  search_id uuid REFERENCES searches(id) ON DELETE SET NULL,
  canonical_url text NOT NULL,
  url text NOT NULL,
  title text,
  company text,
  published_date date,
  retrieved_at timestamptz NOT NULL DEFAULT now(),
  highlights jsonb,
  raw jsonb,
  UNIQUE (campaign_id, canonical_url)
);
CREATE INDEX idx_offers_campaign ON offers (campaign_id);

CREATE TABLE evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id uuid NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  profile_version_id uuid REFERENCES profile_versions(id),
  mandatory_verdict text NOT NULL CHECK (mandatory_verdict IN ('cumple','incumple','sin_evidencia')),
  mandatory_details jsonb NOT NULL,
  score numeric(5,2),
  breakdown jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (offer_id, campaign_id)
);

CREATE TABLE campaign_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  report jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
