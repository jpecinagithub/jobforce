/**
 * @jobforce/backend — Rutas de la política de autonomía (Fase 4).
 *
 * - GET    /api/autonomy/status            → estado operativo resumido.
 * - GET    /api/autonomy/policy            → borrador vigente + política activa.
 * - PUT    /api/autonomy/policy            → nueva versión (borrador). Solo admin.
 * - POST   /api/autonomy/policy/authorize  → autorización escrita de Jon.
 * - POST   /api/autonomy/policy/revoke     → revoca la autorización vigente.
 * - POST   /api/autonomy/stop              → parada global ON (+ evento outbox).
 * - POST   /api/autonomy/resume            → parada global OFF (solo con
 *                                            autorización vigente).
 *
 * Todas exigen sesión; las mutadoras además exigen cabecera CSRF.
 * La política efectiva es la fila de mayor `version` con `revoked_at IS NULL`.
 * Semántica de versiones: cada PUT crea una versión nueva e inmutable;
 * `authorize` anota la autorización escrita sobre la última versión.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ModoAutonomia, PoliticaAutonomia, ReglasAutonomia } from '@jobforce/domain';
import { query } from '@jobforce/database';
import { auditEvent } from '../audit.js';
import { requireCsrf, requireSession } from '../auth.js';
import { validateBody } from '../validation.js';

const authOnly = { preHandler: [requireSession] };
const mutating = { preHandler: [requireSession, requireCsrf] };

// ---------------------------------------------------------------------------
// Esquemas zod.
// ---------------------------------------------------------------------------

const ModoAutonomiaSchema = z.enum(['investigar', 'preparar_para_revision', 'ejecutar_automatico']);

const ReglasAutonomiaSchema: z.ZodType<ReglasAutonomia> = z.object({
  portalesPermitidos: z.array(z.string().min(1).max(60)),
  empresasExcluidas: z.array(z.string().min(1).max(200)),
  umbralEncajeRevision: z.number().min(0).max(100),
  umbralEncajeAutomatico: z.number().min(0).max(100),
  maxEnviosPorDia: z.number().int().min(0).max(1000),
  maxEnviosPorSemana: z.number().int().min(0).max(10000),
  presupuestoMensualUsd: z.number().min(0).max(100000),
  presupuestoExaMensualUsd: z.number().min(0).max(100000),
  tratamientoDesconocidos: z.enum(['revision', 'descartar']),
  crearCuentasPortales: z.boolean(),
});

const PutPolicyBody = z
  .object({
    modoActivo: ModoAutonomiaSchema.optional(),
    reglas: ReglasAutonomiaSchema.optional(),
    notes: z.string().max(2000).optional(),
  })
  .refine((b) => b.modoActivo !== undefined || b.reglas !== undefined, {
    message: 'se necesita modoActivo o reglas',
  });

const AuthorizeBody = z.object({
  autorizadoPor: z.string().trim().min(1, 'autorizadoPor es obligatorio').max(200),
  declaracion: z.string().trim().min(1, 'la declaración es obligatoria').max(5000),
});

// ---------------------------------------------------------------------------
// Filas de BD y valores por defecto.
// ---------------------------------------------------------------------------

export interface PolicyRow {
  id: string;
  version: number;
  policy: PoliticaAutonomia;
  created_at: Date;
  created_by: string | null;
  authorized_by: string | null;
  authorized_at: Date | null;
  revoked_at: Date | null;
  global_stop: boolean;
  notes: string | null;
}

/**
 * Reglas por defecto de la política (las mismas que siembra la migración 004).
 * Se usan como base cuando aún no hay ninguna versión efectiva.
 */
export function defaultReglasAutonomia(): ReglasAutonomia {
  return {
    portalesPermitidos: ['greenhouse', 'lever', 'personio'],
    empresasExcluidas: [],
    umbralEncajeRevision: 70,
    umbralEncajeAutomatico: 75,
    maxEnviosPorDia: 5,
    maxEnviosPorSemana: 20,
    presupuestoMensualUsd: 50,
    presupuestoExaMensualUsd: 3,
    tratamientoDesconocidos: 'revision',
    crearCuentasPortales: false,
  };
}

export function defaultPoliticaAutonomia(version: number): PoliticaAutonomia {
  return {
    version,
    modoActivo: 'preparar_para_revision',
    autorizacionEscrita: null,
    paradaGlobal: false,
    reglas: defaultReglasAutonomia(),
  };
}

function toIso(d: Date): string {
  return new Date(d).toISOString();
}

function mapPolicy(row: PolicyRow) {
  return {
    id: row.id,
    version: row.version,
    policy: row.policy,
    created_at: toIso(row.created_at),
    created_by: row.created_by,
    authorized_by: row.authorized_by,
    authorized_at: row.authorized_at ? toIso(row.authorized_at) : null,
    revoked_at: row.revoked_at ? toIso(row.revoked_at) : null,
    global_stop: row.global_stop,
    notes: row.notes,
  };
}

/** Política efectiva: la de mayor versión no revocada (o null si no hay). */
export async function getEffectivePolicy(): Promise<PolicyRow | null> {
  const rows = await query<PolicyRow>(
    `SELECT id, version, policy, created_at, created_by, authorized_by,
            authorized_at, revoked_at, global_stop, notes
       FROM autonomy_policies
      WHERE revoked_at IS NULL
      ORDER BY version DESC LIMIT 1`,
  );
  return rows[0] ?? null;
}

/** Última versión registrada (revocada o no). */
async function getLatestPolicy(): Promise<PolicyRow | null> {
  const rows = await query<PolicyRow>(
    `SELECT id, version, policy, created_at, created_by, authorized_by,
            authorized_at, revoked_at, global_stop, notes
       FROM autonomy_policies
      ORDER BY version DESC LIMIT 1`,
  );
  return rows[0] ?? null;
}

/** ¿Tiene la fila una autorización escrita vigente? */
export function isAuthorized(row: PolicyRow): boolean {
  return row.authorized_by !== null && row.revoked_at === null;
}

// ---------------------------------------------------------------------------
// Rutas.
// ---------------------------------------------------------------------------

export async function registerAutonomyRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/autonomy/status — estado operativo resumido.
  app.get('/api/autonomy/status', authOnly, async (req, reply) => {
    const policy = await getEffectivePolicy();
    if (!policy) {
      return reply.code(404).send({ error: 'sin_politica' });
    }
    const polit = policy.policy as PoliticaAutonomia;
    const enviadas = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM sends
        WHERE created_at >= date_trunc('day', now())
          AND status IN ('queued','sending','sent')`,
    );
    // Gasto del mes: suma del libro de costes (Fase 5), todas las categorías.
    const gasto = await query<{ total: string | null }>(
      `SELECT SUM(cantidad_usd)::text AS total
         FROM cost_events
        WHERE created_at >= date_trunc('month', now())`,
    );
    return {
      modo: polit.modoActivo as ModoAutonomia,
      paradaGlobal: policy.global_stop,
      autorizada: isAuthorized(policy),
      versionPolitica: policy.version,
      enviosHoy: Number(enviadas[0].n),
      gastoMesUsd: Number(gasto[0].total ?? 0),
    };
  });

  // GET /api/autonomy/policy — borrador vigente + política activa.
  app.get('/api/autonomy/policy', authOnly, async () => {
    const latest = await getLatestPolicy();
    const efectiva = await getEffectivePolicy();
    const activa =
      efectiva && isAuthorized(efectiva) ? mapPolicy(efectiva) : null;
    // Borrador = la última versión si aún no está autorizada.
    const borrador = latest && !isAuthorized(latest) ? mapPolicy(latest) : null;
    return { borrador, activa };
  });

  // PUT /api/autonomy/policy — crea una NUEVA versión (borrador).
  app.put('/api/autonomy/policy', mutating, async (req, reply) => {
    const valid = validateBody(PutPolicyBody, req.body ?? {}, reply);
    if (!valid) return;

    const base = await getEffectivePolicy();
    const basePolicy = base ? (base.policy as PoliticaAutonomia) : defaultPoliticaAutonomia(0);
    const nextVersion = (base ? base.version : 0) + 1;
    // OJO: si la última versión está revocada, la nueva parte de la efectiva
    // anterior; el número de versión siempre avanza (nunca se reutiliza).
    const latest = await getLatestPolicy();
    const version = Math.max(nextVersion, (latest?.version ?? 0) + 1);

    const nueva: PoliticaAutonomia = {
      version,
      modoActivo: (valid.data.modoActivo ?? basePolicy.modoActivo) as ModoAutonomia,
      autorizacionEscrita: null,
      paradaGlobal: false,
      reglas: valid.data.reglas ?? basePolicy.reglas,
    };
    const rows = await query<{ id: string }>(
      `INSERT INTO autonomy_policies (version, policy, created_by, notes)
       VALUES ($1, $2::jsonb, $3, $4) RETURNING id`,
      [version, JSON.stringify(nueva), req.authSession?.userId ?? null, valid.data.notes ?? null],
    );
    await auditEvent({
      actorId: req.authSession?.userId ?? null,
      action: 'autonomy_policy_created',
      entityType: 'autonomy_policy',
      entityId: rows[0].id,
      details: { version, modo: nueva.modoActivo },
    });
    return reply.code(201).send({ version });
  });

  // POST /api/autonomy/policy/authorize — autorización escrita de Jon.
  app.post('/api/autonomy/policy/authorize', mutating, async (req, reply) => {
    const valid = validateBody(AuthorizeBody, req.body ?? {}, reply);
    if (!valid) return;

    const latest = await getLatestPolicy();
    if (!latest) {
      return reply.code(404).send({ error: 'sin_politica' });
    }
    if (isAuthorized(latest)) {
      return reply.code(409).send({ error: 'politica_ya_autorizada', version: latest.version });
    }
    if (latest.revoked_at !== null) {
      return reply.code(409).send({ error: 'politica_revocada', version: latest.version });
    }
    const autorizadoEn = new Date().toISOString();
    const updated = await query<PolicyRow>(
      `UPDATE autonomy_policies
          SET authorized_by = $2,
              authorized_at = now(),
              policy = jsonb_set(
                policy,
                '{autorizacionEscrita}',
                $3::jsonb
              )
        WHERE id = $1
        RETURNING id, version, policy, created_at, created_by, authorized_by,
                  authorized_at, revoked_at, global_stop, notes`,
      [
        latest.id,
        valid.data.autorizadoPor,
        JSON.stringify({
          autorizadoPor: valid.data.autorizadoPor,
          autorizadoEn,
          declaracion: valid.data.declaracion,
        }),
      ],
    );
    await auditEvent({
      actorId: req.authSession?.userId ?? null,
      action: 'autonomy_policy_authorized',
      entityType: 'autonomy_policy',
      entityId: latest.id,
      details: { version: latest.version, autorizadoPor: valid.data.autorizadoPor },
    });
    return reply.send({ ok: true, version: latest.version, politica: mapPolicy(updated[0]) });
  });

  // POST /api/autonomy/policy/revoke — revoca la autorización vigente.
  app.post('/api/autonomy/policy/revoke', mutating, async (req, reply) => {
    const efectiva = await getEffectivePolicy();
    if (!efectiva || !isAuthorized(efectiva)) {
      return reply.code(409).send({ error: 'sin_autorizacion_que_revocar' });
    }
    await query(`UPDATE autonomy_policies SET revoked_at = now() WHERE id = $1`, [efectiva.id]);
    await auditEvent({
      actorId: req.authSession?.userId ?? null,
      action: 'autonomy_policy_revoked',
      entityType: 'autonomy_policy',
      entityId: efectiva.id,
      details: { version: efectiva.version },
    });
    return reply.send({ ok: true, version: efectiva.version });
  });

  // POST /api/autonomy/stop — parada global ON (+ evento en outbox).
  app.post('/api/autonomy/stop', mutating, async (req, reply) => {
    const efectiva = await getEffectivePolicy();
    if (!efectiva) {
      return reply.code(404).send({ error: 'sin_politica' });
    }
    await query(`UPDATE autonomy_policies SET global_stop = true WHERE id = $1`, [efectiva.id]);
    await query(
      `INSERT INTO outbox (aggregate, event) VALUES ('autonomy', $1::jsonb)`,
      [
        JSON.stringify({
          type: 'parada_global_activada',
          policy_version: efectiva.version,
          at: new Date().toISOString(),
          by: req.authSession?.username ?? null,
        }),
      ],
    );
    await auditEvent({
      actorId: req.authSession?.userId ?? null,
      action: 'autonomy_global_stop',
      entityType: 'autonomy_policy',
      entityId: efectiva.id,
      details: { version: efectiva.version },
    });
    return reply.send({ paradaGlobal: true, version: efectiva.version });
  });

  // POST /api/autonomy/resume — parada global OFF (solo con autorización vigente).
  app.post('/api/autonomy/resume', mutating, async (req, reply) => {
    const efectiva = await getEffectivePolicy();
    if (!efectiva) {
      return reply.code(404).send({ error: 'sin_politica' });
    }
    if (!isAuthorized(efectiva)) {
      return reply.code(409).send({ error: 'sin_autorizacion_vigente' });
    }
    await query(`UPDATE autonomy_policies SET global_stop = false WHERE id = $1`, [efectiva.id]);
    await query(
      `INSERT INTO outbox (aggregate, event) VALUES ('autonomy', $1::jsonb)`,
      [
        JSON.stringify({
          type: 'parada_global_desactivada',
          policy_version: efectiva.version,
          at: new Date().toISOString(),
          by: req.authSession?.username ?? null,
        }),
      ],
    );
    await auditEvent({
      actorId: req.authSession?.userId ?? null,
      action: 'autonomy_global_resume',
      entityType: 'autonomy_policy',
      entityId: efectiva.id,
      details: { version: efectiva.version },
    });
    return reply.send({ paradaGlobal: false, version: efectiva.version });
  });
}
