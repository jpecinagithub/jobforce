-- 001_init.sql — Esquema inicial de JOBFORCE (Fase 1).
-- PostgreSQL es la fuente de verdad del negocio.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE admin_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE TABLE user_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  token_hash text UNIQUE NOT NULL,
  csrf_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  ip text,
  user_agent text
);

CREATE TABLE profile_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_no int GENERATED ALWAYS AS IDENTITY UNIQUE,
  status text NOT NULL DEFAULT 'draft',
  source text NOT NULL,
  notes text,
  created_by uuid REFERENCES admin_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE profile_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_version_id uuid NOT NULL REFERENCES profile_versions(id) ON DELETE CASCADE,
  category text NOT NULL,
  key text NOT NULL,
  value jsonb NOT NULL,
  source text NOT NULL,
  source_detail text,
  validation_status text NOT NULL DEFAULT 'unconfirmed',
  sensitivity text NOT NULL DEFAULT 'normal',
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (profile_version_id, category, key)
);

CREATE TABLE answer_memory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_original text NOT NULL,
  question_normalized text NOT NULL,
  answer text NOT NULL,
  language text NOT NULL DEFAULT 'es',
  source text NOT NULL,
  valid_from date,
  valid_until date,
  scope_type text NOT NULL DEFAULT 'general',
  scope_value text,
  reuse_rule text NOT NULL DEFAULT 'reuse',
  needs_context boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE configuration_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_no int GENERATED ALWAYS AS IDENTITY UNIQUE,
  config jsonb NOT NULL,
  note text,
  created_by uuid REFERENCES admin_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_id uuid REFERENCES admin_users(id),
  action text NOT NULL,
  entity_type text,
  entity_id text,
  details jsonb
);

CREATE INDEX idx_audit_events_occurred_at ON audit_events (occurred_at);
CREATE INDEX idx_profile_facts_version ON profile_facts (profile_version_id);
