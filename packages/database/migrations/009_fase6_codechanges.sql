-- 009_fase6_codechanges.sql — Fase 6.2: cambios de código desde el panel.
--
-- - code_changes: propuestas de cambios de código con su ciclo de vida
--   (borrador → en_desarrollo → en_revision → aprobada → publicada →
--   revertida). El agente implementa en una rama `cambio/<id>-<slug>`; el
--   panel es la capa de seguimiento, autorización expresa de publicación
--   (puerta dura: sin aprobación no hay publicación), registro de
--   publicación y ejecución de la reversión en un clic.
-- - deployments: histórico inmutable de despliegues (frontend/backend).
--   La reversión del backend busca aquí el último despliegue `exito` con
--   commit distinto al publicado; la del frontend usa el despliegue de
--   producción anterior de Vercel (o el fallback manual documentado).
--
-- Regla dura: la reversión NUNCA toca la base de datos (las migraciones
-- son solo hacia adelante). Si el commit objetivo es anterior a
-- migraciones ya aplicadas, se registra como aviso en el resultado.

CREATE TABLE code_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  titulo text NOT NULL,
  descripcion text NOT NULL,
  rama text,
  componente text NOT NULL CHECK (componente IN ('frontend', 'backend', 'ambos')),
  estado text NOT NULL DEFAULT 'borrador'
    CHECK (estado IN ('borrador', 'en_desarrollo', 'en_revision', 'aprobada', 'publicada', 'revertida')),
  preview_url text,
  test_estado text NOT NULL DEFAULT 'pendiente'
    CHECK (test_estado IN ('pendiente', 'pasando', 'fallando')),
  test_detalle jsonb NOT NULL DEFAULT '{}'::jsonb,
  aprobada_por uuid REFERENCES admin_users(id),
  aprobada_en timestamptz,
  declaracion_aprobacion text,
  publicada_en timestamptz,
  commit_publicado text,
  revertida_en timestamptz,
  commit_revertido text,
  -- Reversión en segundo plano: la petición responde 202 al instante y el
  -- progreso se consulta con GET /api/code-changes/:id.
  revert_estado text NOT NULL DEFAULT 'idle'
    CHECK (revert_estado IN ('idle', 'en_curso', 'completada', 'fallida')),
  revert_resultado jsonb NOT NULL DEFAULT '{}'::jsonb,
  revert_motivo text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_code_changes_estado ON code_changes (estado);
CREATE INDEX idx_code_changes_updated ON code_changes (updated_at DESC);

CREATE TABLE deployments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  componente text CHECK (componente IN ('frontend', 'backend')),
  commit text NOT NULL,
  vercel_deployment_id text,
  vercel_url text,
  desplegado_en timestamptz NOT NULL DEFAULT now(),
  desplegado_por text,
  estado text NOT NULL DEFAULT 'exito'
    CHECK (estado IN ('exito', 'fallo'))
);

CREATE INDEX idx_deployments_componente_fecha ON deployments (componente, desplegado_en DESC);
