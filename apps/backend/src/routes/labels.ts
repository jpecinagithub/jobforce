/**
 * @jobforce/backend — Dataset etiquetado y métricas de precisión (Fase 6.4).
 *
 * - GET  /api/labels/offers? solo_sin_etiqueta=true → ofertas con su
 *   evaluación (score, predicción `encaja = score >= 70`) y etiqueta humana
 *   actual si existe. Orden: score DESC. (sesión)
 * - POST /api/labels/offers → upsert de etiqueta humana sobre una oferta:
 *   { offer_id (uuid), encaja_real (boolean), nota? }. (sesión + CSRF)
 * - GET  /api/labels/emails? solo_sin_etiqueta=true → mensajes del
 *   seguimiento de Gmail (`gmail_messages`) con la clasificación PREDICHA
 *   por el sistema (`classification`) y la etiqueta humana actual si
 *   existe. (sesión)
 * - POST /api/labels/emails → upsert de etiqueta humana sobre un mensaje:
 *   { mensaje_id, clasificacion_real, nota? }. (sesión + CSRF)
 * - GET  /api/metricas/precision → informe de precisión calculado SOLO con
 *   etiquetas humanas reales. (sesión)
 *
 * REGLA DURA: las métricas nunca usan la confianza declarada por el LLM
 * (`gmail_messages.confidence` ni ninguna otra): la realidad es siempre la
 * etiqueta humana y la predicción es la del sistema (score>=70 /
 * gmail_messages.classification).
 *
 * La clasificación predicha de correos vive en `gmail_messages.classification`
 * (vocabulario de la migración 003: 'confirmacion_envio','rechazo',
 * 'entrevista','solicitud_info','spam','otro'). La etiqueta humana usa el
 * vocabulario de la migración 010 ('confirmacion','rechazo','entrevista',
 * 'ambiguo','otro'). Para compararlas se normaliza 'confirmacion_envio' a
 * 'confirmacion'; el resto de valores se comparan tal cual.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '@jobforce/database';
import { auditEvent } from '../audit.js';
import { requireCsrf, requireSession } from '../auth.js';
import { validateBody } from '../validation.js';

/** Umbral de la política: score >= 70 ⇒ el sistema predice que encaja. */
const UMBRAL_ENCAJE = 70;

const authOnly = { preHandler: [requireSession] };
const mutating = { preHandler: [requireSession, requireCsrf] };

const CLASIFICACIONES_REALES = ['confirmacion', 'rechazo', 'entrevista', 'ambiguo', 'otro'] as const;

const LabelOfferBody = z.object({
  offer_id: z.string().uuid('offer_id debe ser un UUID'),
  encaja_real: z.boolean({ message: 'encaja_real debe ser true o false' }),
  nota: z.string().trim().max(2000).optional(),
});

const LabelEmailBody = z.object({
  mensaje_id: z.string().trim().min(1, 'mensaje_id es obligatorio').max(500),
  clasificacion_real: z.enum(CLASIFICACIONES_REALES, {
    message: `clasificacion_real debe ser una de: ${CLASIFICACIONES_REALES.join(', ')}`,
  }),
  nota: z.string().trim().max(2000).optional(),
});

interface OfferRow {
  offer_id: string;
  campaign_id: string;
  title: string | null;
  company: string | null;
  url: string;
  score: string | null;
  encaja_real: boolean | null;
  nota: string | null;
  etiqueta_fecha: Date | null;
}

interface EmailRow {
  mensaje_id: string;
  asunto: string | null;
  remitente: string | null;
  fecha: Date | null;
  predicha: string | null;
  etiqueta_actual: string | null;
  nota: string | null;
  etiqueta_fecha: Date | null;
}

function round3(n: number | null): number | null {
  if (n === null || !Number.isFinite(n)) return null;
  return Math.round(n * 1000) / 1000;
}

/**
 * Normaliza la clasificación predicha del seguimiento (vocabulario de
 * `gmail_messages.classification`) al vocabulario de la etiqueta humana.
 * 'confirmacion_envio' es lo mismo que la etiqueta 'confirmacion'.
 */
function normalizarPredicha(predicha: string | null): string | null {
  if (predicha === null) return null;
  if (predicha === 'confirmacion_envio') return 'confirmacion';
  return predicha;
}

export async function registerLabelRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/labels/offers — ofertas con evaluación, predicción y etiqueta.
  app.get('/api/labels/offers', authOnly, async (req) => {
    const q = req.query as { solo_sin_etiqueta?: string };
    const soloSin = q.solo_sin_etiqueta === 'true';
    const rows = await query<OfferRow>(
      `SELECT o.id AS offer_id, o.campaign_id, o.title, o.company, o.url,
              e.score::text AS score, l.encaja_real, l.nota,
              l.created_at AS etiqueta_fecha
         FROM offers o
         LEFT JOIN evaluations e ON e.offer_id = o.id
         LEFT JOIN etiquetas_ofertas l ON l.offer_id = o.id
        ${soloSin ? 'WHERE l.offer_id IS NULL' : ''}
        ORDER BY e.score DESC NULLS LAST, o.title NULLS LAST, o.id`,
    );
    const ofertas = rows.map((r) => {
      const score = r.score === null ? null : Number(r.score);
      return {
        offer_id: r.offer_id,
        campaign_id: r.campaign_id,
        title: r.title,
        company: r.company,
        url: r.url,
        score,
        // Predicción del sistema (umbral de la política): null sin evaluación.
        encaja: score === null ? null : score >= UMBRAL_ENCAJE,
        encaja_real: r.encaja_real,
        nota: r.nota,
        etiqueta_fecha: r.etiqueta_fecha ? new Date(r.etiqueta_fecha).toISOString() : null,
      };
    });
    return {
      ofertas,
      total: ofertas.length,
      etiquetadas: ofertas.filter((o) => o.encaja_real !== null).length,
    };
  });

  // POST /api/labels/offers — upsert de etiqueta humana sobre una oferta.
  app.post('/api/labels/offers', mutating, async (req, reply) => {
    const valid = validateBody(LabelOfferBody, req.body ?? {}, reply);
    if (!valid) return;
    const actorId = req.authSession?.userId ?? null;
    const { offer_id, encaja_real, nota } = valid.data;

    const existentes = await query<{ id: string }>(
      'SELECT id FROM offers WHERE id = $1',
      [offer_id],
    );
    if (existentes.length === 0) {
      return reply.code(404).send({
        error: 'oferta_no_encontrada',
        detalle: 'No existe ninguna oferta con ese offer_id.',
      });
    }

    await query(
      `INSERT INTO etiquetas_ofertas (offer_id, encaja_real, nota, etiquetada_por)
         VALUES ($1, $2, $3, $4)
       ON CONFLICT (offer_id) DO UPDATE SET
         encaja_real = EXCLUDED.encaja_real,
         nota = EXCLUDED.nota,
         etiquetada_por = EXCLUDED.etiquetada_por,
         created_at = now()`,
      [offer_id, encaja_real, nota ?? null, actorId],
    );
    await auditEvent({
      actorId,
      action: 'etiqueta_oferta_guardada',
      entityType: 'etiqueta_oferta',
      entityId: offer_id,
      details: { encaja_real },
    });
    return reply.send({ ok: true, offer_id, encaja_real });
  });

  // GET /api/labels/emails — mensajes del seguimiento con clasificación
  // predicha por el sistema y etiqueta humana actual.
  app.get('/api/labels/emails', authOnly, async (req) => {
    const q = req.query as { solo_sin_etiqueta?: string };
    const soloSin = q.solo_sin_etiqueta === 'true';
    const rows = await query<EmailRow>(
      `SELECT g.gmail_id AS mensaje_id, g.subject AS asunto,
              g.from_addr AS remitente, g.received_at AS fecha,
              g.classification AS predicha, l.clasificacion_real AS etiqueta_actual,
              l.nota, l.created_at AS etiqueta_fecha
         FROM gmail_messages g
         LEFT JOIN etiquetas_correos l ON l.mensaje_id = g.gmail_id
        ${soloSin ? 'WHERE l.mensaje_id IS NULL' : ''}
        ORDER BY g.received_at DESC NULLS LAST, g.gmail_id`,
    );
    const correos = rows.map((r) => ({
      mensaje_id: r.mensaje_id,
      asunto: r.asunto,
      remitente: r.remitente,
      fecha: r.fecha ? new Date(r.fecha).toISOString() : null,
      // Clasificación predicha por el sistema (puede cambiar si el
      // seguimiento la actualiza); la confianza del LLM NO se expone ni se
      // usa en métricas.
      predicha: r.predicha,
      clasificacion_real: r.etiqueta_actual,
      nota: r.nota,
      etiqueta_fecha: r.etiqueta_fecha ? new Date(r.etiqueta_fecha).toISOString() : null,
    }));
    return {
      correos,
      total: correos.length,
      etiquetados: correos.filter((c) => c.clasificacion_real !== null).length,
    };
  });

  // POST /api/labels/emails — upsert de etiqueta humana sobre un mensaje.
  app.post('/api/labels/emails', mutating, async (req, reply) => {
    const valid = validateBody(LabelEmailBody, req.body ?? {}, reply);
    if (!valid) return;
    const actorId = req.authSession?.userId ?? null;
    const { mensaje_id, clasificacion_real, nota } = valid.data;

    await query(
      `INSERT INTO etiquetas_correos (mensaje_id, clasificacion_real, nota, etiquetada_por)
         VALUES ($1, $2, $3, $4)
       ON CONFLICT (mensaje_id) DO UPDATE SET
         clasificacion_real = EXCLUDED.clasificacion_real,
         nota = EXCLUDED.nota,
         etiquetada_por = EXCLUDED.etiquetada_por,
         created_at = now()`,
      [mensaje_id, clasificacion_real, nota ?? null, actorId],
    );
    await auditEvent({
      actorId,
      action: 'etiqueta_correo_guardada',
      entityType: 'etiqueta_correo',
      entityId: mensaje_id,
      details: { clasificacion_real },
    });
    return reply.send({ ok: true, mensaje_id, clasificacion_real });
  });

  // GET /api/metricas/precision — informe calculado SOLO con etiquetas
  // humanas reales vs. predicción del sistema.
  app.get('/api/metricas/precision', authOnly, async () => {
    // --- Encaje: predicción = score >= 70, realidad = etiqueta humana. ---
    const etiquetadas = await query<{
      score: string | null;
      encaja_real: boolean;
    }>(
      `SELECT e.score::text AS score, l.encaja_real
         FROM etiquetas_ofertas l
         LEFT JOIN evaluations e ON e.offer_id = l.offer_id`,
    );
    let vp = 0;
    let fp = 0;
    let fn = 0;
    let vn = 0;
    let sinEvaluacion = 0;
    for (const r of etiquetadas) {
      const score = r.score === null ? null : Number(r.score);
      if (score === null) {
        // Etiqueta sin evaluación: no hay predicción que evaluar.
        sinEvaluacion += 1;
        continue;
      }
      const predice = score >= UMBRAL_ENCAJE;
      if (predice && r.encaja_real) vp += 1;
      else if (predice && !r.encaja_real) fp += 1;
      else if (!predice && r.encaja_real) fn += 1;
      else vn += 1;
    }
    const nEncaje = vp + fp + fn + vn;
    const encaje =
      nEncaje === 0
        ? {
            n: 0,
            mensaje: 'Sin etiquetas todavía: etiqueta ofertas en /etiquetas para medir.',
            sin_evaluacion: sinEvaluacion,
          }
        : {
            n: nEncaje,
            vp,
            fp,
            fn,
            vn,
            sin_evaluacion: sinEvaluacion,
            precision: round3(vp + fp === 0 ? null : vp / (vp + fp)),
            recall: round3(vp + fn === 0 ? null : vp / (vp + fn)),
          };

    // --- Correos: predicción = gmail_messages.classification (normalizada),
    //     realidad = etiqueta humana. La confianza del LLM no interviene. ---
    const correos = await query<{
      predicha: string | null;
      clasificacion_real: string;
    }>(
      `SELECT g.classification AS predicha, l.clasificacion_real
         FROM etiquetas_correos l
         LEFT JOIN gmail_messages g ON g.gmail_id = l.mensaje_id`,
    );
    const matriz: Record<string, number> = {};
    let correctas = 0;
    let conPrediccion = 0;
    for (const r of correos) {
      const pred = normalizarPredicha(r.predicha);
      const clavePred = pred ?? 'sin_prediccion';
      const clave = `${clavePred}__${r.clasificacion_real}`;
      matriz[clave] = (matriz[clave] ?? 0) + 1;
      if (pred !== null) {
        conPrediccion += 1;
        if (pred === r.clasificacion_real) correctas += 1;
      }
    }
    const nCorreos = correos.length;
    const errores = conPrediccion - correctas;
    const correosMetrics =
      nCorreos === 0
        ? {
            n: 0,
            mensaje: 'Sin etiquetas todavía: etiqueta correos en /etiquetas para medir.',
          }
        : {
            n: nCorreos,
            con_prediccion: conPrediccion,
            correctas,
            errores,
            exactitud: round3(conPrediccion === 0 ? null : correctas / conPrediccion),
            matriz,
          };

    return {
      encaje,
      correos: correosMetrics,
      umbral_encaje: UMBRAL_ENCAJE,
      calculada_en: new Date().toISOString(),
    };
  });
}
