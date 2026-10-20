/**
 * @jobforce/backend — Rutas de memoria de respuestas.
 *
 * - GET    /api/answers      → lista de respuestas guardadas.
 * - POST   /api/answers      → guarda una respuesta (201).
 * - PATCH  /api/answers/:id  → actualiza los campos enviados de una respuesta.
 * - DELETE /api/answers/:id  → elimina una respuesta.
 *
 * Todas exigen sesión; las mutaciones además exigen cabecera CSRF.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '@jobforce/database';
import { auditEvent } from '../audit.js';
import { requireCsrf, requireSession } from '../auth.js';
import { validateBody } from '../validation.js';

const CreateAnswerBody = z.object({
  questionOriginal: z.string().trim().min(1, 'la pregunta original es obligatoria'),
  questionNormalized: z.string().trim().min(1, 'la pregunta normalizada es obligatoria'),
  answer: z.string().trim().min(1, 'la respuesta es obligatoria'),
  language: z.string().trim().max(10).default('es'),
  source: z.string().trim().min(1, 'el origen es obligatorio').max(200),
  scopeType: z.enum(['general', 'country', 'company', 'position', 'application']).default('general'),
  scopeValue: z.string().max(200).optional(),
  reuseRule: z.enum(['reuse', 'ask_first', 'never']).default('reuse'),
});

const UpdateAnswerBody = z.object({
  questionOriginal: z.string().trim().min(1, 'la pregunta original es obligatoria').optional(),
  questionNormalized: z.string().trim().min(1, 'la pregunta normalizada es obligatoria').optional(),
  answer: z.string().trim().min(1, 'la respuesta es obligatoria').optional(),
  language: z.string().trim().max(10).optional(),
  source: z.string().trim().min(1, 'el origen es obligatorio').max(200).optional(),
  scopeType: z.enum(['general', 'country', 'company', 'position', 'application']).optional(),
  scopeValue: z.string().max(200).nullable().optional(),
  reuseRule: z.enum(['reuse', 'ask_first', 'never']).optional(),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const authOnly = { preHandler: [requireSession] };
const mutating = { preHandler: [requireSession, requireCsrf] };

interface AnswerRow {
  id: string;
  question_original: string;
  question_normalized: string;
  answer: string;
  language: string;
  source: string;
  valid_from: string | null;
  valid_until: string | null;
  scope_type: string;
  scope_value: string | null;
  reuse_rule: string;
  needs_context: boolean;
  created_at: Date;
  updated_at: Date;
}

function mapAnswer(row: AnswerRow) {
  return {
    id: row.id,
    questionOriginal: row.question_original,
    questionNormalized: row.question_normalized,
    answer: row.answer,
    language: row.language,
    source: row.source,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    scopeType: row.scope_type,
    scopeValue: row.scope_value,
    reuseRule: row.reuse_rule,
    needsContext: row.needs_context,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function registerAnswerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/answers', authOnly, async () => {
    const rows = await query<AnswerRow>(
      `SELECT id, question_original, question_normalized, answer, language, source,
              valid_from, valid_until, scope_type, scope_value, reuse_rule,
              needs_context, created_at, updated_at
         FROM answer_memory ORDER BY created_at DESC`,
    );
    return rows.map(mapAnswer);
  });

  app.post('/api/answers', mutating, async (req, reply) => {
    const valid = validateBody(CreateAnswerBody, req.body, reply);
    if (!valid) return;
    const d = valid.data;
    const rows = await query<{ id: string }>(
      `INSERT INTO answer_memory
         (question_original, question_normalized, answer, language, source,
          scope_type, scope_value, reuse_rule)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        d.questionOriginal,
        d.questionNormalized,
        d.answer,
        d.language,
        d.source,
        d.scopeType,
        d.scopeValue ?? null,
        d.reuseRule,
      ],
    );
    const answerId = rows[0].id;
    await auditEvent({
      actorId: req.authSession?.userId ?? null,
      action: 'answer_created',
      entityType: 'answer_memory',
      entityId: answerId,
      details: {
        scopeType: d.scopeType,
        scopeValue: d.scopeValue ?? null,
        reuseRule: d.reuseRule,
      },
    });
    return reply.code(201).send({ id: answerId });
  });

  // PATCH /api/answers/:id — actualiza solo los campos enviados (mismo
  // patrón que PATCH /api/role-profiles/:id).
  app.patch('/api/answers/:id', mutating, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id ?? '')) {
      return reply.code(400).send({ error: 'respuesta_invalida' });
    }
    const valid = validateBody(UpdateAnswerBody, req.body, reply);
    if (!valid) return;
    const d = valid.data;

    const sets: string[] = [];
    const params: unknown[] = [];
    const changed: string[] = [];
    const setField = (column: string, key: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
      changed.push(key);
    };
    if (d.questionOriginal !== undefined) setField('question_original', 'questionOriginal', d.questionOriginal);
    if (d.questionNormalized !== undefined) setField('question_normalized', 'questionNormalized', d.questionNormalized);
    if (d.answer !== undefined) setField('answer', 'answer', d.answer);
    if (d.language !== undefined) setField('language', 'language', d.language);
    if (d.source !== undefined) setField('source', 'source', d.source);
    if (d.scopeType !== undefined) setField('scope_type', 'scopeType', d.scopeType);
    if (d.scopeValue !== undefined) setField('scope_value', 'scopeValue', d.scopeValue);
    if (d.reuseRule !== undefined) setField('reuse_rule', 'reuseRule', d.reuseRule);
    if (sets.length === 0) {
      return reply.code(400).send({ error: 'datos_invalidos', detalles: ['cuerpo: sin cambios'] });
    }
    sets.push('updated_at = now()');
    params.push(id);

    const rows = await query<{ id: string }>(
      `UPDATE answer_memory SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id`,
      params,
    );
    if (rows.length === 0) {
      return reply.code(404).send({ error: 'respuesta_no_encontrada' });
    }
    await auditEvent({
      actorId: req.authSession?.userId ?? null,
      action: 'answer_updated',
      entityType: 'answer_memory',
      entityId: id,
      details: { cambios: changed },
    });
    return reply.send({ ok: true });
  });

  // DELETE /api/answers/:id — elimina la respuesta.
  app.delete('/api/answers/:id', mutating, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id ?? '')) {
      return reply.code(400).send({ error: 'respuesta_invalida' });
    }
    const rows = await query<{ id: string }>(
      `DELETE FROM answer_memory WHERE id = $1 RETURNING id`,
      [id],
    );
    if (rows.length === 0) {
      return reply.code(404).send({ error: 'respuesta_no_encontrada' });
    }
    await auditEvent({
      actorId: req.authSession?.userId ?? null,
      action: 'answer_deleted',
      entityType: 'answer_memory',
      entityId: id,
      details: {},
    });
    return reply.send({ ok: true });
  });
}
