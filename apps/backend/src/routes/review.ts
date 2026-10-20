/**
 * @jobforce/backend — Revisión manual con mínima fricción (Fase 6).
 *
 * - GET  /api/review/queue                    → cola de candidaturas listas para revisión
 * - POST /api/applications/:id/approve        → ready_for_review → approved
 * - POST /api/applications/:id/reject         → ready_for_review → withdrawn
 * - POST /api/applications/review-batch       → aprueba/rechaza por lotes
 *
 * La cola solo lista; la lectura exige sesión, las mutaciones exigen sesión +
 * cabecera CSRF. Solo se puede aprobar/rechazar desde `ready_for_review`
 * (el estado que produce el modo `preparar_para_revision`); cualquier otro
 * estado responde 409.
 *
 * Fase 7: en modo `preparar_para_revision`, aprobar ENCADENA la solicitud
 * de envío (la misma lógica de request-send): si la política lo permite se
 * encola y el worker lo ejecuta; si lo bloquea, la aprobación queda
 * registrada, no se encola nada y se abre una intervención con el motivo.
 * En los demás modos estas rutas solo cambian el estado de revisión.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { query, withTransaction } from '@jobforce/database';
import { auditEvent } from '../audit.js';
import { requireCsrf, requireSession } from '../auth.js';
import { validateBody } from '../validation.js';
import { crearIntervencionSiNoAbierta } from '../intervention.js';
import { getEffectivePolicy } from './autonomy.js';
import { solicitarEnvio } from './sends.js';

const authOnly = { preHandler: [requireSession] };
const mutating = { preHandler: [requireSession, requireCsrf] };

// Ids UUID v4 (mismo patrón que en campaigns.ts): un id malformado nunca
// puede existir en BD, así que se rechaza con 400 antes de tocarla.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Único estado revisable: el paquete de aprobación está completo y pendiente de Jon. */
const REVIEWABLE_STATUS = 'ready_for_review';

const RejectBody = z.object({
  reason: z.string().trim().min(1, 'el motivo es obligatorio').max(500, 'el motivo no puede superar 500 caracteres'),
});

const BatchBody = z
  .object({
    ids: z
      .array(z.string().regex(UUID_RE, 'el id no es un UUID válido'))
      .min(1, 'se necesita al menos un id')
      .max(50, 'máximo 50 ids por lote'),
    action: z.enum(['approve', 'reject']),
    reason: z
      .string()
      .trim()
      .min(1, 'el motivo es obligatorio al rechazar')
      .max(500, 'el motivo no puede superar 500 caracteres')
      .optional(),
  })
  .refine((v) => v.action !== 'reject' || v.reason !== undefined, {
    message: 'el motivo es obligatorio al rechazar',
    path: ['reason'],
  });

// ---------------------------------------------------------------------------
// Filas de BD y mapeos.
// ---------------------------------------------------------------------------

interface QueueRow {
  id: string;
  campaign_id: string;
  offer_id: string;
  portal: string | null;
  created_at: Date;
  title: string | null;
  company: string | null;
  url: string;
  score: string | null;
  mandatory_verdict: string;
  breakdown: unknown;
}

interface ApplicationRow {
  id: string;
  campaign_id: string;
  offer_id: string;
  status: string;
  portal: string | null;
  reviewed_at: Date | null;
  reviewed_by: string | null;
  created_at: Date;
  updated_at: Date;
}

interface DimensionRaw {
  dimension: string;
  peso: number;
  puntos: number;
  explicacion: string;
  hechos: string[];
}

interface TopDimension {
  dimension: string;
  peso: number;
  puntos: number;
  explicacion: string;
  hechos: number;
}

/** Normaliza el breakdown: solo entran dimensiones con la forma esperada. */
function asDimensions(breakdown: unknown): DimensionRaw[] {
  if (!Array.isArray(breakdown)) return [];
  const dims: DimensionRaw[] = [];
  for (const raw of breakdown) {
    if (typeof raw !== 'object' || raw === null) continue;
    const d = raw as Record<string, unknown>;
    if (typeof d.dimension !== 'string') continue;
    dims.push({
      dimension: d.dimension,
      peso: typeof d.peso === 'number' && Number.isFinite(d.peso) ? d.peso : 0,
      puntos: typeof d.puntos === 'number' && Number.isFinite(d.puntos) ? d.puntos : 0,
      explicacion: typeof d.explicacion === 'string' ? d.explicacion : '',
      hechos: Array.isArray(d.hechos) ? d.hechos.filter((h): h is string => typeof h === 'string') : [],
    });
  }
  return dims;
}

function toIso(d: Date): string {
  return new Date(d).toISOString();
}

/** Resumen de encaje: las 3 dimensiones con más peso + nº de hechos referenciados. */
function mapQueueRow(row: QueueRow) {
  const top: TopDimension[] = asDimensions(row.breakdown)
    .sort((a, b) => b.peso - a.peso)
    .slice(0, 3)
    .map((d) => ({
      dimension: d.dimension,
      peso: d.peso,
      puntos: d.puntos,
      explicacion: d.explicacion,
      hechos: d.hechos.length,
    }));
  const hechosVerificados = top.reduce((n, d) => n + d.hechos, 0);
  return {
    id: row.id,
    portal: row.portal,
    offer: {
      id: row.offer_id,
      title: row.title,
      company: row.company,
      url: row.url,
    },
    score: row.score === null ? null : Number(row.score),
    mandatoryVerdict: row.mandatory_verdict,
    resumenEncaje: {
      topDimensiones: top,
      hechosVerificados,
    },
    createdAt: toIso(row.created_at),
  };
}

function mapApplication(row: ApplicationRow) {
  return {
    id: row.id,
    status: row.status,
    portal: row.portal,
    reviewedAt: row.reviewed_at ? toIso(row.reviewed_at) : null,
    reviewedBy: row.reviewed_by,
    updatedAt: toIso(row.updated_at),
  };
}

// ---------------------------------------------------------------------------
// Lógica compartida de aprobación / rechazo (usa transacciones).
// ---------------------------------------------------------------------------

type Decision = 'approve' | 'reject';

const DECISION_TO_STATUS: Record<Decision, 'approved' | 'withdrawn'> = {
  approve: 'approved',
  reject: 'withdrawn',
};

const DECISION_TO_AUDIT: Record<Decision, string> = {
  approve: 'application_approved',
  reject: 'application_rejected',
};

class ReviewError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    public status?: string,
  ) {
    super(code);
  }
}

function requireUuid(id: string): void {
  if (!UUID_RE.test(id)) {
    throw new ReviewError(400, 'candidatura_invalida');
  }
}

/**
 * Aplica una decisión de revisión. Solo desde `ready_for_review`: cualquier
 * otro estado lanza 409. La transición y la auditoría van en una transacción.
 */
async function applyDecision(
  id: string,
  decision: Decision,
  reason: string | undefined,
  req: FastifyRequest,
): Promise<ApplicationRow> {
  requireUuid(id);
  return withTransaction(async (client) => {
    const rows = await client.query<ApplicationRow>(
      `SELECT id, campaign_id, offer_id, status, portal,
              reviewed_at, reviewed_by, created_at, updated_at
         FROM applications WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const app = rows.rows[0];
    if (!app) {
      throw new ReviewError(404, 'candidatura_no_encontrada');
    }
    if (app.status !== REVIEWABLE_STATUS) {
      throw new ReviewError(409, 'candidatura_no_en_revision', app.status);
    }
    const updated = await client.query<ApplicationRow>(
      `UPDATE applications
          SET status = $2,
              reviewed_at = now(),
              reviewed_by = $3,
              failure_reason = $4,
              updated_at = now()
        WHERE id = $1
        RETURNING id, campaign_id, offer_id, status, portal,
                  reviewed_at, reviewed_by, created_at, updated_at`,
      [id, DECISION_TO_STATUS[decision], req.authSession?.userId ?? null, decision === 'reject' ? (reason ?? '') : null],
    );
    const row = updated.rows[0];
    await auditEvent(
      {
        actorId: req.authSession?.userId ?? null,
        action: DECISION_TO_AUDIT[decision],
        entityType: 'application',
        entityId: id,
        details:
          decision === 'reject'
            ? { reason: reason ?? '', from: REVIEWABLE_STATUS }
            : { from: REVIEWABLE_STATUS },
      },
      client,
    );
    return row;
  });
}

function replyReviewError(reply: FastifyReply, err: unknown) {
  if (err instanceof ReviewError) {
    const payload: { error: string; status?: string } = { error: err.code };
    if (err.status !== undefined) payload.status = err.status;
    return reply.code(err.statusCode).send(payload);
  }
  throw err;
}

// ---------------------------------------------------------------------------
// Encadenado aprobación → envío (Fase 7).
// ---------------------------------------------------------------------------

export interface SendChainResult {
  send: 'encolado' | 'bloqueado';
  motivo?: string;
}

/**
 * Tras una aprobación, en modo `preparar_para_revision` se encadena la
 * solicitud de envío reutilizando `solicitarEnvio` (la lógica de
 * request-send): re-evalúa la política completa (checks, cuotas,
 * presupuesto, parada global) y encola si procede.
 *
 * - Fuera de ese modo devuelve null: la respuesta no cambia (comportamiento
 *   histórico intacto).
 * - Si la política lo bloquea, la aprobación YA registrada se mantiene,
 *   no se encola nada y se abre una intervención con el motivo.
 */
async function encadenarEnvioTrasAprobacion(
  applicationId: string,
  actorId: string | null,
): Promise<SendChainResult | null> {
  const policy = await getEffectivePolicy();
  if (!policy || policy.policy.modoActivo !== 'preparar_para_revision') return null;
  try {
    const res = await solicitarEnvio(applicationId, { actorId });
    if (res.outcome === 'encolado' || res.outcome === 'repetido') {
      return { send: 'encolado' };
    }
    if (res.outcome === 'ya_existe') {
      return { send: 'encolado', motivo: 'ya_existia_un_envio_para_esta_candidatura' };
    }
    if (res.outcome === 'no_encontrada') {
      return { send: 'bloqueado', motivo: 'candidatura_no_encontrada' };
    }
    if (res.outcome === 'conflicto') {
      return { send: 'bloqueado', motivo: 'conflicto_al_encolar_el_envio' };
    }
    const motivo = res.motivos.join(' | ') || res.decision;
    await crearIntervencionSiNoAbierta('fuera_de_politica', applicationId, {
      origen: 'aprobacion_revision',
      decision: res.decision,
      motivos: res.motivos,
    });
    return { send: 'bloqueado', motivo };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'error desconocido';
    await crearIntervencionSiNoAbierta('error_tecnico', applicationId, {
      origen: 'aprobacion_revision',
      error: msg.slice(0, 500),
    }).catch(() => undefined);
    return { send: 'bloqueado', motivo: `error_tecnico: ${msg}` };
  }
}

// ---------------------------------------------------------------------------
// Rutas.
// ---------------------------------------------------------------------------

export async function registerReviewRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/review/queue — cola de revisión: candidaturas en
  // `ready_for_review` con resumen de encaje. Orden: score descendente
  // (las sin puntuación, al final).
  app.get('/api/review/queue', authOnly, async () => {
    const rows = await query<QueueRow>(
      `SELECT a.id, a.campaign_id, a.offer_id, a.portal, a.created_at,
              o.title, o.company, o.url,
              e.score, e.mandatory_verdict, e.breakdown
         FROM applications a
         JOIN offers o ON o.id = a.offer_id
         LEFT JOIN evaluations e
           ON e.offer_id = a.offer_id AND e.campaign_id = a.campaign_id
        WHERE a.status = $1
        ORDER BY e.score DESC NULLS LAST, a.created_at ASC`,
      [REVIEWABLE_STATUS],
    );
    return { queue: rows.map(mapQueueRow) };
  });

  // POST /api/applications/:id/approve — Jon aprueba: ready_for_review → approved.
  // En modo preparar_para_revision encadena la solicitud de envío y la
  // respuesta lo indica: { send: 'encolado' | 'bloqueado', motivo? }.
  app.post('/api/applications/:id/approve', mutating, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const row = await applyDecision(id, 'approve', undefined, req);
      const chain = await encadenarEnvioTrasAprobacion(id, req.authSession?.userId ?? null);
      return reply.send({
        ok: true,
        application: mapApplication(row),
        ...(chain ? { send: chain } : {}),
      });
    } catch (err) {
      return replyReviewError(reply, err);
    }
  });

  // POST /api/applications/:id/reject — Jon retira: ready_for_review → withdrawn.
  app.post('/api/applications/:id/reject', mutating, async (req, reply) => {
    const { id } = req.params as { id: string };
    const valid = validateBody(RejectBody, req.body ?? {}, reply);
    if (!valid) return;
    try {
      const row = await applyDecision(id, 'reject', valid.data.reason, req);
      return reply.send({ ok: true, application: mapApplication(row) });
    } catch (err) {
      return replyReviewError(reply, err);
    }
  });

  // POST /api/applications/review-batch — aprueba/rechaza en lote. Devuelve
  // resultado por item: los fallos no abortan el resto del lote.
  app.post('/api/applications/review-batch', mutating, async (req, reply) => {
    const valid = validateBody(BatchBody, req.body ?? {}, reply);
    if (!valid) return;
    const { ids, action, reason } = valid.data;
    const items: Array<{
      id: string;
      ok: boolean;
      error?: string;
      status?: string;
      send?: SendChainResult;
    }> = [];
    for (const id of ids) {
      try {
        await applyDecision(id, action, reason, req);
        if (action === 'approve') {
          const chain = await encadenarEnvioTrasAprobacion(
            id,
            req.authSession?.userId ?? null,
          );
          items.push(chain ? { id, ok: true, send: chain } : { id, ok: true });
        } else {
          items.push({ id, ok: true });
        }
      } catch (err) {
        if (err instanceof ReviewError) {
          items.push(err.status !== undefined ? { id, ok: false, error: err.code, status: err.status } : { id, ok: false, error: err.code });
        } else {
          throw err;
        }
      }
    }
    const okCount = items.filter((i) => i.ok).length;
    return reply.send({ ok: okCount === items.length, items });
  });
}
