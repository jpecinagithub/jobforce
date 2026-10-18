/**
 * @jobforce/backend — Rutas del perfil.
 *
 * - GET  /api/profile                    → versión activa con sus facts (404 si no hay).
 * - GET  /api/profile/versions           → lista de versiones.
 * - GET  /api/profile/questionnaire      → cuestionario estático de la Fase 1.
 * - POST /api/profile/versions           → crea una versión (nace en draft).
 * - POST /api/profile/versions/:id/facts → añade un fact a la versión.
 * - POST /api/profile/versions/:id/activate → activa la versión (transacción).
 * - POST /api/profile/import-cv         → 501 (la importación v1 va por semilla SQL).
 *
 * Todas exigen sesión; las mutadoras además exigen cabecera CSRF.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ProfileFact, ProfileVersion, ProfileVersionStatus } from '@jobforce/domain';
import { query, withTransaction } from '@jobforce/database';
import { auditEvent } from '../audit.js';
import { requireCsrf, requireSession } from '../auth.js';
import { validateBody } from '../validation.js';
import { QUESTIONNAIRE } from '../questionnaire.js';

const CreateVersionBody = z.object({
  source: z.string().trim().min(1, 'el origen es obligatorio').max(200),
  notes: z.string().max(2000).optional(),
});

const VALIDATION_STATUSES = ['confirmed', 'unconfirmed', 'preference', 'unknown'] as const;
const SENSITIVITIES = ['normal', 'sensitive', 'highly_sensitive'] as const;

const CreateFactBody = z.object({
  category: z.string().trim().min(1, 'la categoría es obligatoria').max(100),
  key: z.string().trim().min(1, 'la clave es obligatoria').max(200),
  value: z.unknown(),
  source: z.string().trim().min(1, 'el origen es obligatorio').max(200),
  sourceDetail: z.string().max(1000).optional(),
  validationStatus: z.enum(VALIDATION_STATUSES).default('unconfirmed'),
  sensitivity: z.enum(SENSITIVITIES).default('normal'),
});

const authOnly = { preHandler: [requireSession] };
const mutating = { preHandler: [requireSession, requireCsrf] };

interface VersionRow {
  id: string;
  version_no: number;
  status: string;
  source: string;
  notes: string | null;
  created_by: string | null;
  created_at: Date;
}

interface FactRow {
  category: string;
  key: string;
  value: unknown;
  source: string;
  source_detail: string | null;
  validation_status: string;
  sensitivity: string;
}

function toIso(d: Date): string {
  return new Date(d).toISOString();
}

function mapVersion(row: VersionRow): ProfileVersion {
  return {
    id: row.id,
    versionNo: Number(row.version_no),
    status: row.status as ProfileVersionStatus,
    source: row.source,
    notes: row.notes,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
  };
}

function mapFact(row: FactRow): ProfileFact {
  return {
    category: row.category,
    key: row.key,
    value: row.value,
    source: row.source,
    sourceDetail: row.source_detail ?? undefined,
    validationStatus: row.validation_status as ProfileFact['validationStatus'],
    sensitivity: row.sensitivity as ProfileFact['sensitivity'],
  };
}

export async function registerProfileRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/profile — versión activa con sus facts.
  app.get('/api/profile', authOnly, async (req, reply) => {
    const versions = await query<VersionRow>(
      `SELECT id, version_no, status, source, notes, created_by, created_at
         FROM profile_versions WHERE status = 'active' ORDER BY version_no DESC LIMIT 1`,
    );
    const version = versions[0];
    if (!version) {
      return reply.code(404).send({ error: 'no_profile' });
    }
    const facts = await query<FactRow>(
      `SELECT category, key, value, source, source_detail, validation_status, sensitivity
         FROM profile_facts WHERE profile_version_id = $1 ORDER BY category, key`,
      [version.id],
    );
    return reply.send({ version: mapVersion(version), facts: facts.map(mapFact) });
  });

  // GET /api/profile/versions — lista de versiones (más reciente primero).
  app.get('/api/profile/versions', authOnly, async () => {
    const rows = await query<VersionRow>(
      `SELECT id, version_no, status, source, notes, created_by, created_at
         FROM profile_versions ORDER BY version_no DESC`,
    );
    return rows.map(mapVersion);
  });

  // GET /api/profile/questionnaire — cuestionario estático de la Fase 1.
  app.get('/api/profile/questionnaire', authOnly, async () => QUESTIONNAIRE);

  // POST /api/profile/versions — crea una versión (nace en draft).
  app.post('/api/profile/versions', mutating, async (req, reply) => {
    const valid = validateBody(CreateVersionBody, req.body, reply);
    if (!valid) return;
    const rows = await query<VersionRow>(
      `INSERT INTO profile_versions (status, source, notes, created_by)
       VALUES ('draft', $1, $2, $3)
       RETURNING id, version_no, status, source, notes, created_by, created_at`,
      [valid.data.source, valid.data.notes ?? null, req.authSession?.userId ?? null],
    );
    const version = rows[0];
    await auditEvent({
      actorId: req.authSession?.userId ?? null,
      action: 'profile_version_created',
      entityType: 'profile_version',
      entityId: version.id,
      details: { versionNo: version.version_no, source: version.source },
    });
    return reply.code(201).send({
      id: version.id,
      versionNo: Number(version.version_no),
      status: version.status,
    });
  });

  // POST /api/profile/versions/:id/facts — añade un fact a la versión.
  app.post('/api/profile/versions/:id/facts', mutating, async (req, reply) => {
    const valid = validateBody(CreateFactBody, req.body, reply);
    if (!valid) return;
    const { id } = req.params as { id: string };

    const versions = await query<{ id: string }>('SELECT id FROM profile_versions WHERE id = $1', [id]);
    if (versions.length === 0) {
      return reply.code(404).send({ error: 'version_no_encontrada' });
    }
    try {
      const rows = await query<{ id: string }>(
        `INSERT INTO profile_facts
           (profile_version_id, category, key, value, source, source_detail, validation_status, sensitivity)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8) RETURNING id`,
        [
          id,
          valid.data.category,
          valid.data.key,
          JSON.stringify(valid.data.value ?? null),
          valid.data.source,
          valid.data.sourceDetail ?? null,
          valid.data.validationStatus,
          valid.data.sensitivity,
        ],
      );
      const factId = rows[0].id;
      await auditEvent({
        actorId: req.authSession?.userId ?? null,
        action: 'profile_fact_created',
        entityType: 'profile_fact',
        entityId: factId,
        details: {
          versionId: id,
          category: valid.data.category,
          key: valid.data.key,
          sensitivity: valid.data.sensitivity,
        },
      });
      return reply.code(201).send({ id: factId });
    } catch (err) {
      // (version, category, key) duplicado.
      if (err instanceof Error && 'code' in err && (err as { code: string }).code === '23505') {
        return reply.code(409).send({ error: 'fact_ya_existe' });
      }
      throw err;
    }
  });

  // POST /api/profile/versions/:id/activate — activa la versión (transacción).
  app.post('/api/profile/versions/:id/activate', mutating, async (req, reply) => {
    const { id } = req.params as { id: string };
    const activated = await withTransaction(async (client) => {
      const found = await client.query<VersionRow>(
        `SELECT id, version_no, status, source, notes, created_by, created_at
           FROM profile_versions WHERE id = $1`,
        [id],
      );
      if (found.rows.length === 0) return null;
      await client.query(`UPDATE profile_versions SET status = 'draft' WHERE status = 'active'`);
      const updated = await client.query<VersionRow>(
        `UPDATE profile_versions SET status = 'active' WHERE id = $1
         RETURNING id, version_no, status, source, notes, created_by, created_at`,
        [id],
      );
      const row = updated.rows[0];
      await auditEvent({
        actorId: req.authSession?.userId ?? null,
        action: 'profile_version_activated',
        entityType: 'profile_version',
        entityId: row.id,
        details: { versionNo: row.version_no },
      }, client);
      return row;
    });
    if (!activated) {
      return reply.code(404).send({ error: 'version_no_encontrada' });
    }
    return reply.send({
      id: activated.id,
      versionNo: Number(activated.version_no),
      status: activated.status,
    });
  });

  // POST /api/profile/import-cv — no implementado en la Fase 1 (semilla SQL manual).
  app.post('/api/profile/import-cv', mutating, async (_req, reply) => {
    return reply.code(501).send({ error: 'not_implemented', reason: 'manual_seed' });
  });
}
