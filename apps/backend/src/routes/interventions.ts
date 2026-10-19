/**
 * @jobforce/backend — Bandeja de intervenciones manuales (Fase 4).
 *
 * - GET  /api/interventions                 → lista (filtros status/kind).
 * - POST /api/interventions/:id/resolve     → resuelve o descarta.
 *
 * Todas exigen sesión; la resolución además exige cabecera CSRF.
 * Una intervención abierta NO detiene a las demás candidaturas: no existen
 * locks globales, solo `send_locks` por candidatura con vencimiento.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '@jobforce/database';
import { auditEvent } from '../audit.js';
import { requireCsrf, requireSession } from '../auth.js';
import { validateBody } from '../validation.js';

const authOnly = { preHandler: [requireSession] };
const mutating = { preHandler: [requireSession, requireCsrf] };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ListQuery = z.object({
  status: z.enum(['abierta', 'resuelta', 'descartada']).optional(),
  kind: z
    .enum(['datos_desconocidos', 'pregunta_ambigua', 'captcha_mfa', 'fuera_de_politica', 'envio_incierto', 'error_tecnico'])
    .optional(),
});

const ResolveBody = z.object({
  resolution: z.enum(['resuelta', 'descartada']),
  // La nota es opcional en el frontal desde F6.1: si no llega, se guarda ''.
  note: z.string().trim().max(5000, 'la nota no puede superar 5000 caracteres').optional().default(''),
});

interface InterventionRow {
  id: string;
  kind: string;
  application_id: string | null;
  context: unknown;
  status: string;
  resolution: string | null;
  created_at: Date;
  resolved_at: Date | null;
}

function toIso(d: Date): string {
  return new Date(d).toISOString();
}

function mapIntervention(row: InterventionRow) {
  return {
    id: row.id,
    kind: row.kind,
    application_id: row.application_id,
    context: row.context,
    status: row.status,
    resolution: row.resolution,
    created_at: toIso(row.created_at),
    resolved_at: row.resolved_at ? toIso(row.resolved_at) : null,
  };
}

export async function registerInterventionRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/interventions — lista con filtros opcionales status/kind.
  app.get('/api/interventions', authOnly, async (req, reply) => {
    const valid = validateBody(ListQuery, req.query ?? {}, reply);
    if (!valid) return;
    const conds: string[] = [];
    const params: unknown[] = [];
    if (valid.data.status !== undefined) {
      params.push(valid.data.status);
      conds.push(`status = $${params.length}`);
    }
    if (valid.data.kind !== undefined) {
      params.push(valid.data.kind);
      conds.push(`kind = $${params.length}`);
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    const rows = await query<InterventionRow>(
      `SELECT id, kind, application_id, context, status, resolution,
              created_at, resolved_at
         FROM interventions ${where}
        ORDER BY created_at DESC`,
      params,
    );
    return { interventions: rows.map(mapIntervention) };
  });

  // POST /api/interventions/:id/resolve — resuelve o descarta.
  app.post('/api/interventions/:id/resolve', mutating, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) {
      return reply.code(400).send({ error: 'intervencion_invalida' });
    }
    const valid = validateBody(ResolveBody, req.body ?? {}, reply);
    if (!valid) return;

    const rows = await query<InterventionRow>(
      `SELECT id, kind, application_id, context, status, resolution,
              created_at, resolved_at
         FROM interventions WHERE id = $1`,
      [id],
    );
    const intervention = rows[0];
    if (!intervention) {
      return reply.code(404).send({ error: 'intervencion_no_encontrada' });
    }
    if (intervention.status !== 'abierta') {
      return reply.code(409).send({ error: 'intervencion_ya_cerrada', status: intervention.status });
    }
    const updated = await query<InterventionRow>(
      `UPDATE interventions
          SET status = $2, resolution = $3, resolved_at = now()
        WHERE id = $1
        RETURNING id, kind, application_id, context, status, resolution,
                  created_at, resolved_at`,
      [id, valid.data.resolution, valid.data.note],
    );
    await auditEvent({
      actorId: req.authSession?.userId ?? null,
      action: 'intervention_resolved',
      entityType: 'intervention',
      entityId: id,
      details: { resolution: valid.data.resolution, kind: intervention.kind },
    });
    return reply.send({ ok: true, intervention: mapIntervention(updated[0]) });
  });
}
