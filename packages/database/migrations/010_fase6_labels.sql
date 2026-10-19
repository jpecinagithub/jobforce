-- 010_fase6_labels.sql — Fase 6.4: dataset etiquetado para medir precisión.
--
-- El dataset es la VERDAD HUMANA contra la que se mide el sistema. Las
-- métricas de precisión se calculan SOLO con estas etiquetas reales vs. la
-- predicción del sistema; NUNCA con la confianza declarada por el LLM.
--
-- `etiquetas_ofertas`: etiqueta humana (encaja_real) sobre una oferta
-- evaluada. Se compara con la predicción del sistema (score >= 70) para
-- medir precisión/recall del encaje. Una etiqueta por oferta (upsert por
-- PRIMARY KEY). ON DELETE CASCADE: si la oferta se borra, su etiqueta
-- desaparece con ella.
--
-- `etiquetas_correos`: etiqueta humana (clasificacion_real) sobre un mensaje
-- del seguimiento de Gmail (clave = gmail_messages.gmail_id, el ID de
-- mensaje que produce el seguimiento). La clasificación PREDICHA vive en
-- `gmail_messages.classification` (migración 003); esta tabla guarda solo
-- la clasificación REAL humana para la matriz de confusión.

CREATE TABLE etiquetas_ofertas (
  offer_id uuid PRIMARY KEY REFERENCES offers(id) ON DELETE CASCADE,
  encaja_real boolean NOT NULL,
  nota text,
  etiquetada_por uuid REFERENCES admin_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE etiquetas_correos (
  mensaje_id text PRIMARY KEY,
  clasificacion_real text NOT NULL CHECK (clasificacion_real IN (
    'confirmacion', 'rechazo', 'entrevista', 'ambiguo', 'otro'
  )),
  nota text,
  etiquetada_por uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
