-- 015: Agente conversacional de aplicación directa.
-- El usuario pega la URL de una oferta en el chat del ítem «Agente» y el
-- sistema la ingiere en una campaña interna, genera CV + carta, aprueba
-- (la orden del chat es la aprobación expresa) y solicita el envío con
-- la maquinaria existente (checks + política + worker).

CREATE TABLE agent_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url text NOT NULL,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'done', 'blocked', 'failed')),
  step text,
  offer_id uuid REFERENCES offers(id) ON DELETE SET NULL,
  application_id uuid REFERENCES applications(id) ON DELETE SET NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES admin_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE TABLE agent_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid REFERENCES agent_jobs(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'agent')),
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_agent_messages_created ON agent_messages (created_at);
CREATE INDEX idx_agent_jobs_status ON agent_jobs (status);
