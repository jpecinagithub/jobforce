/**
 * @jobforce/backend — Rutas de perfiles por rol (fase «Perfiles por rol»).
 *
 * - GET    /api/role-profiles       → lista (el «por defecto» primero).
 * - POST   /api/role-profiles       → crea un perfil (201).
 * - GET    /api/role-profiles/:id   → detalle (404 si no existe).
 * - PUT    /api/role-profiles/:id   → actualización parcial.
 * - DELETE /api/role-profiles/:id   → borra (las campañas quedan a NULL).
 *
 * Un perfil por rol es la PRESENTACIÓN editable del perfil base para un
 * objetivo (Finance Manager, AI Engineer...). Estas rutas NUNCA tocan
 * profile_versions/profile_facts: los hechos verificados no se alteran.
 *
 * Todas exigen sesión; las mutadoras además exigen cabecera CSRF.
 * Como máximo hay un perfil con is_default = true (índice único parcial
 * en BD + limpieza en transacción al marcar otro).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { RoleProfile, RoleProfileFeaturedItem } from '@jobforce/domain';
import { query, withTransaction } from '@jobforce/database';
import { auditEvent } from '../audit.js';
import { requireCsrf, requireSession } from '../auth.js';
import { validateBody } from '../validation.js';

// Los ids son UUID v4; un id malformado nunca puede existir en BD, así que
// se rechaza con 400 antes de tocar la base de datos.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FeaturedItemSchema = z.object({
  title: z.string().trim().min(1, 'el título del bloque es obligatorio').max(200),
  subtitle: z.string().trim().max(200).default(''),
  description: z.string().trim().max(1500).default(''),
});

const SkillsSchema = z
  .array(z.string().trim().min(1, 'la habilidad no puede estar vacía').max(100))
  .max(50);

const CreateRoleProfileBody = z.object({
  name: z.string().trim().min(1, 'el nombre del rol es obligatorio').max(120),
  headline: z.string().trim().max(300).default(''),
  summary: z.string().trim().max(5000).default(''),
  featured: z.array(FeaturedItemSchema).max(20).default([]),
  skills: SkillsSchema.default([]),
  educationNote: z.string().trim().max(1500).nullable().optional(),
  isDefault: z.boolean().optional(),
});

const UpdateRoleProfileBody = z.object({
  name: z.string().trim().min(1, 'el nombre del rol no puede estar vacío').max(120).optional(),
  headline: z.string().trim().max(300).optional(),
  summary: z.string().trim().max(5000).optional(),
  featured: z.array(FeaturedItemSchema).max(20).optional(),
  skills: SkillsSchema.optional(),
  educationNote: z.string().trim().max(1500).nullable().optional(),
  isDefault: z.boolean().optional(),
});

const authOnly = { preHandler: [requireSession] };
const mutating = { preHandler: [requireSession, requireCsrf] };

interface RoleProfileRow {
  id: string;
  name: string;
  headline: string;
  summary: string;
  featured: unknown;
  skills: unknown;
  education_note: string | null;
  is_default: boolean;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `id, name, headline, summary, featured, skills, education_note,
                 is_default, created_at, updated_at`;

function toIso(d: Date): string {
  return new Date(d).toISOString();
}

function asFeatured(value: unknown): RoleProfileFeaturedItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null)
    .map((v) => ({
      title: typeof v.title === 'string' ? v.title : '',
      subtitle: typeof v.subtitle === 'string' ? v.subtitle : '',
      description: typeof v.description === 'string' ? v.description : '',
    }));
}

function asSkills(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];
}

function mapRoleProfile(row: RoleProfileRow): RoleProfile {
  return {
    id: row.id,
    name: row.name,
    headline: row.headline,
    summary: row.summary,
    featured: asFeatured(row.featured),
    skills: asSkills(row.skills),
    educationNote: row.education_note,
    isDefault: row.is_default,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as { code: string }).code === '23505';
}

export async function registerRoleProfileRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/role-profiles — lista (por defecto primero, luego por creación).
  app.get('/api/role-profiles', authOnly, async () => {
    const rows = await query<RoleProfileRow>(
      `SELECT ${COLUMNS} FROM role_profiles ORDER BY is_default DESC, created_at ASC`,
    );
    return rows.map(mapRoleProfile);
  });

  // POST /api/role-profiles — crea un perfil (borrador vacío si solo va el nombre).
  app.post('/api/role-profiles', mutating, async (req, reply) => {
    const valid = validateBody(CreateRoleProfileBody, req.body, reply);
    if (!valid) return;
    const d = valid.data;
    try {
      const created = await withTransaction(async (client) => {
        if (d.isDefault) {
          await client.query(`UPDATE role_profiles SET is_default = false WHERE is_default`);
        }
        const res = await client.query<RoleProfileRow>(
          `INSERT INTO role_profiles
             (name, headline, summary, featured, skills, education_note, is_default)
           VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)
           RETURNING ${COLUMNS}`,
          [
            d.name,
            d.headline,
            d.summary,
            JSON.stringify(d.featured),
            JSON.stringify(d.skills),
            d.educationNote ?? null,
            d.isDefault ?? false,
          ],
        );
        return res.rows[0];
      });
      await auditEvent({
        actorId: req.authSession?.userId ?? null,
        action: 'role_profile_created',
        entityType: 'role_profile',
        entityId: created.id,
        details: { name: created.name, isDefault: created.is_default },
      });
      return reply.code(201).send(mapRoleProfile(created));
    } catch (err) {
      if (isUniqueViolation(err)) {
        return reply.code(409).send({ error: 'perfil_rol_ya_existe' });
      }
      throw err;
    }
  });

  // GET /api/role-profiles/:id — detalle.
  app.get('/api/role-profiles/:id', authOnly, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id ?? '')) {
      return reply.code(400).send({ error: 'perfil_rol_invalido' });
    }
    const rows = await query<RoleProfileRow>(
      `SELECT ${COLUMNS} FROM role_profiles WHERE id = $1`,
      [id],
    );
    if (rows.length === 0) {
      return reply.code(404).send({ error: 'perfil_rol_no_encontrado' });
    }
    return mapRoleProfile(rows[0]);
  });

  // PUT /api/role-profiles/:id — actualización parcial.
  app.put('/api/role-profiles/:id', mutating, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id ?? '')) {
      return reply.code(400).send({ error: 'perfil_rol_invalido' });
    }
    const valid = validateBody(UpdateRoleProfileBody, req.body ?? {}, reply);
    if (!valid) return;
    const d = valid.data;

    const sets: string[] = [];
    const params: unknown[] = [];
    const changed: string[] = [];
    if (d.name !== undefined) {
      params.push(d.name);
      sets.push(`name = $${params.length}`);
      changed.push('name');
    }
    if (d.headline !== undefined) {
      params.push(d.headline);
      sets.push(`headline = $${params.length}`);
      changed.push('headline');
    }
    if (d.summary !== undefined) {
      params.push(d.summary);
      sets.push(`summary = $${params.length}`);
      changed.push('summary');
    }
    if (d.featured !== undefined) {
      params.push(JSON.stringify(d.featured));
      sets.push(`featured = $${params.length}::jsonb`);
      changed.push('featured');
    }
    if (d.skills !== undefined) {
      params.push(JSON.stringify(d.skills));
      sets.push(`skills = $${params.length}::jsonb`);
      changed.push('skills');
    }
    if (d.educationNote !== undefined) {
      params.push(d.educationNote);
      sets.push(`education_note = $${params.length}`);
      changed.push('educationNote');
    }
    if (d.isDefault !== undefined) {
      params.push(d.isDefault);
      sets.push(`is_default = $${params.length}`);
      changed.push('isDefault');
    }
    if (sets.length === 0) {
      return reply.code(400).send({ error: 'datos_invalidos', detalles: ['cuerpo: sin cambios'] });
    }
    sets.push('updated_at = now()');
    params.push(id);

    try {
      const updated = await withTransaction(async (client) => {
        if (d.isDefault === true) {
          await client.query(
            `UPDATE role_profiles SET is_default = false WHERE is_default AND id <> $1`,
            [id],
          );
        }
        const res = await client.query<{ id: string }>(
          `UPDATE role_profiles SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id`,
          params,
        );
        return res.rows[0] ?? null;
      });
      if (!updated) {
        return reply.code(404).send({ error: 'perfil_rol_no_encontrado' });
      }
    } catch (err) {
      if (isUniqueViolation(err)) {
        return reply.code(409).send({ error: 'perfil_rol_ya_existe' });
      }
      throw err;
    }
    await auditEvent({
      actorId: req.authSession?.userId ?? null,
      action: 'role_profile_updated',
      entityType: 'role_profile',
      entityId: id,
      details: { cambios: changed },
    });
    return reply.send({ ok: true });
  });

  // DELETE /api/role-profiles/:id — borra; las campañas que lo usaban quedan
  // con role_profile_id a NULL (ON DELETE SET NULL de la migración 012).
  app.delete('/api/role-profiles/:id', mutating, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id ?? '')) {
      return reply.code(400).send({ error: 'perfil_rol_invalido' });
    }
    const rows = await query<{ id: string; name: string }>(
      `DELETE FROM role_profiles WHERE id = $1 RETURNING id, name`,
      [id],
    );
    if (rows.length === 0) {
      return reply.code(404).send({ error: 'perfil_rol_no_encontrado' });
    }
    await auditEvent({
      actorId: req.authSession?.userId ?? null,
      action: 'role_profile_deleted',
      entityType: 'role_profile',
      entityId: id,
      details: { name: rows[0].name },
    });
    return reply.send({ ok: true });
  });
}
