-- 003_fase3.sql — Fase 3: candidaturas, biblioteca de documentos versionados y seguimiento Gmail.
--
-- `applications`: una candidatura = una oferta objetivo + estado del recorrido.
--   Estados técnicos del recorrido (separados del estado del proceso de selección,
--   que vive en el seguimiento Gmail):
--     draft            → creada, sin documentos aún
--     documents_ready  → CV y carta generados y validados
--     form_prepared    → formulario rellenado con Playwright, listo para revisión
--     ready_for_review → paquete de aprobación completo pendiente de Jon
--     approved         → Jon aprobó explícitamente (envío autorizado)
--     submitting       → envío en curso (bloqueo con vencimiento)
--     submitted        → confirmación de envío capturada
--     submission_failed→ envío fallido (ver failure_reason)
--     withdrawn        → retirada por Jon (stop)
--
-- `documents`: biblioteca versionada. Cada fila = bytes exactos de un documento
--   en un formato, con su hash SHA-256, plantilla usada y generador. Los bytes
--   viven en el sistema de archivos (file_path relativo al workspace) y el hash
--   en BD garantiza que lo enviado es exactamente lo generado.
--
-- `gmail_sync_state` / `gmail_messages`: seguimiento de correo. Sincronización
--   inicial acotada + incremental con historyId; clasificación de cada mensaje
--   y vinculación a la candidatura con confianza; los ambiguos quedan
--   pendientes de revisión manual (reviewed=false).

CREATE TABLE applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  offer_id uuid NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft','documents_ready','form_prepared','ready_for_review',
    'approved','submitting','submitted','submission_failed','withdrawn'
  )),
  offer_snapshot jsonb NOT NULL DEFAULT '{}',
  portal text,
  submitted_at timestamptz,
  submission_evidence jsonb,
  failure_reason text,
  created_by uuid REFERENCES admin_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, offer_id)
);
CREATE INDEX idx_applications_status ON applications (status);

CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('cv','cover_letter')),
  format text NOT NULL CHECK (format IN ('docx','pdf')),
  version int NOT NULL DEFAULT 1,
  file_path text NOT NULL,
  bytes int NOT NULL,
  sha256 text NOT NULL,
  template_version text NOT NULL,
  generator text NOT NULL,
  model_used text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (application_id, kind, format, version)
);
CREATE INDEX idx_documents_application ON documents (application_id);

CREATE TABLE gmail_sync_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox text NOT NULL DEFAULT 'primary',
  history_id text,
  last_sync_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mailbox)
);

CREATE TABLE gmail_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gmail_id text NOT NULL UNIQUE,
  thread_id text,
  application_id uuid REFERENCES applications(id) ON DELETE SET NULL,
  classification text NOT NULL DEFAULT 'otro' CHECK (classification IN (
    'confirmacion_envio','rechazo','entrevista','solicitud_info','spam','otro'
  )),
  confidence numeric(4,3),
  link_reason text,
  subject text,
  from_addr text,
  received_at timestamptz,
  reviewed boolean NOT NULL DEFAULT false,
  raw jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_gmail_messages_application ON gmail_messages (application_id);
CREATE INDEX idx_gmail_messages_classification ON gmail_messages (classification);
