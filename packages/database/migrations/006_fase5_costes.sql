-- 006_fase5_costes.sql — Fase 5: libro de costes, presupuestos y circuit breakers.
--
-- - cost_events: registro inmutable de cada gasto/uso (Exa, páginas
--   extraídas, tokens LLM, tiempo de navegador, Gmail). Fuente única de
--   verdad para los presupuestos; los agregados heredados
--   (campaigns.exa_spent_usd, searches.cost_usd) se siguen actualizando por
--   compatibilidad.
-- - budget_config: presupuestos globales diario y mensual (configurables).
-- - connector_breakers: estado del circuit breaker por conector.
-- - campaigns.total_budget_cap_usd: tope total por campaña (null = sin tope).

CREATE TABLE cost_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  application_id uuid REFERENCES applications(id) ON DELETE SET NULL,
  offer_id uuid REFERENCES offers(id) ON DELETE SET NULL,
  categoria text NOT NULL CHECK (categoria IN (
    'exa_search', 'page_extract', 'llm_tokens', 'browser_time', 'gmail', 'otro'
  )),
  cantidad_usd numeric(12,4) NOT NULL CHECK (cantidad_usd >= 0),
  detalles jsonb NOT NULL DEFAULT '{}',
  idempotency_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_cost_events_campaign ON cost_events (campaign_id, created_at DESC);
CREATE INDEX idx_cost_events_categoria ON cost_events (categoria, created_at DESC);
CREATE INDEX idx_cost_events_created ON cost_events (created_at DESC);

CREATE TABLE connector_breakers (
  connector text PRIMARY KEY,
  consecutive_failures int NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  total_failures bigint NOT NULL DEFAULT 0 CHECK (total_failures >= 0),
  opened_until timestamptz,
  last_failure_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE budget_config (
  clave text PRIMARY KEY CHECK (clave IN ('daily_usd', 'monthly_usd')),
  valor_usd numeric(12,4) NOT NULL CHECK (valor_usd >= 0),
  actualizado_en timestamptz NOT NULL DEFAULT now()
);
INSERT INTO budget_config (clave, valor_usd) VALUES
  ('daily_usd', 5.0000),
  ('monthly_usd', 50.0000)
ON CONFLICT (clave) DO NOTHING;

ALTER TABLE campaigns ADD COLUMN total_budget_cap_usd numeric(10,4);
