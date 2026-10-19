-- 004_fase4.sql — Fase 4: persistencia de la autonomía.
--
-- `autonomy_policies`: historial de versiones de la política de autonomía.
--   Cada PUT crea una NUEVA versión (inmutable); la autorización escrita
--   (authorized_by/at) se anota sobre la versión vigente. La versión efectiva
--   es la de mayor `version` con `revoked_at IS NULL`.
--   Semilla: versión 1 como BORRADOR (sin autorización), modo por defecto
--   `preparar_para_revision` (sin ella, ningún envío automático).
--
-- `sends`: cada intento de envío. Deduplicación por `idempotency_key`
--   (UNIQUE): la misma clave nunca crea dos filas. `policy_version` fija con
--   qué versión de la política se decidió. El envío real lo ejecutará el motor
--   (Worker 1); la API solo deja la fila en `queued` con la evidencia de la
--   decisión. `uncertain` = enviado pero sin confirmación (ver reconcile.ts).
--
-- `send_locks`: bloqueo con vencimiento por candidatura. Un solo envío en
--   vuelo por candidatura; el bloqueo caduca solo (sin locks globales).
--
-- `outbox`: eventos de dominio pendientes de despacho (p. ej. parada global).
--
-- `interventions`: bandeja de intervención manual. Una intervención abierta
--   NO detiene a las demás candidaturas: no hay locks globales.
--
-- `portal_accounts`: credenciales de portales. SIEMPRE cifradas
--   (`password_ciphertext` + `key_ref`); jamás plaintext en la base de datos.
--
-- `application_outcomes`: estado del PROCESO DE SELECCIÓN (pendiente →
--   en_proceso → entrevista → rechazado | contratado | sin_respuesta),
--   separado del estado técnico del recorrido (`applications.status`).

CREATE TABLE autonomy_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version int NOT NULL UNIQUE,
  policy jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES admin_users(id),
  authorized_by text,
  authorized_at timestamptz,
  revoked_at timestamptz,
  global_stop boolean NOT NULL DEFAULT false,
  notes text
);

CREATE TABLE sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL UNIQUE,
  policy_version int NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued','sending','sent','uncertain','failed'
  )),
  evidence jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_sends_application ON sends (application_id);
CREATE INDEX idx_sends_status ON sends (status);
CREATE INDEX idx_sends_created ON sends (created_at);

CREATE TABLE send_locks (
  application_id uuid PRIMARY KEY REFERENCES applications(id) ON DELETE CASCADE,
  locked_until timestamptz NOT NULL,
  locked_by text NOT NULL
);

CREATE TABLE outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate text NOT NULL,
  event jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending','dispatched','failed'
  )),
  attempts int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_outbox_status ON outbox (status);

CREATE TABLE interventions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN (
    'datos_desconocidos','pregunta_ambigua','captcha_mfa',
    'fuera_de_politica','envio_incierto'
  )),
  application_id uuid REFERENCES applications(id) ON DELETE SET NULL,
  context jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'abierta' CHECK (status IN (
    'abierta','resuelta','descartada'
  )),
  resolution text,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX idx_interventions_status ON interventions (status);
CREATE INDEX idx_interventions_kind ON interventions (kind);
CREATE INDEX idx_interventions_application ON interventions (application_id);

CREATE TABLE portal_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portal text NOT NULL,
  username text NOT NULL,
  password_ciphertext text NOT NULL,
  key_ref text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  UNIQUE (portal, username)
);

CREATE TABLE application_outcomes (
  application_id uuid PRIMARY KEY REFERENCES applications(id) ON DELETE CASCADE,
  selection_status text NOT NULL DEFAULT 'pendiente' CHECK (selection_status IN (
    'pendiente','en_proceso','entrevista','rechazado','contratado','sin_respuesta'
  )),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Semilla: política v1 como BORRADOR. Sin autorización escrita no hay envío
-- automático; el modo por defecto prepara las candidaturas para revisión de Jon.
INSERT INTO autonomy_policies (version, policy, authorized_by, authorized_at, global_stop, notes)
VALUES (
  1,
  '{
    "version": 1,
    "modoActivo": "preparar_para_revision",
    "autorizacionEscrita": null,
    "paradaGlobal": false,
    "reglas": {
      "portalesPermitidos": ["greenhouse", "lever", "personio"],
      "empresasExcluidas": [],
      "umbralEncajeRevision": 70,
      "umbralEncajeAutomatico": 75,
      "maxEnviosPorDia": 5,
      "maxEnviosPorSemana": 20,
      "presupuestoMensualUsd": 50,
      "presupuestoExaMensualUsd": 3,
      "tratamientoDesconocidos": "revision",
      "crearCuentasPortales": false
    }
  }'::jsonb,
  NULL,
  NULL,
  false,
  'Borrador inicial de la política de autonomía (Fase 4). Requiere autorización escrita de Jon antes de cualquier envío automático.'
);
