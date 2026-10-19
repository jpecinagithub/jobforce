/**
 * @jobforce/backend — Propuestas de cambios de código (Fase 6.2).
 *
 * Modelo operativo: la implementación la ejecuta el agente (Muse) en una
 * rama `cambio/<id>-<slug>`; el panel es la capa de seguimiento,
 * autorización, auditoría y ejecución de la reversión. El panel NO escribe
 * código.
 *
 * - POST   /api/code-changes                 → crea una propuesta (borrador).
 * - GET    /api/code-changes                 → lista (filtros: estado, componente).
 * - GET    /api/code-changes/:id             → detalle + eventos de auditoría.
 * - PATCH  /api/code-changes/:id             → actualiza campos y avanza el
 *                                              estado UN paso hacia adelante.
 * - POST   /api/code-changes/:id/approve     → puerta de autorización: solo
 *                                              con declaración expresa de Jon.
 * - POST   /api/code-changes/:id/publish     → registra la publicación (solo
 *                                              desde `aprobada`; el merge y
 *                                              push a main los ejecuta el
 *                                              agente).
 * - POST   /api/code-changes/:id/revert      → reversión en un clic: responde
 *                                              202 al instante y trabaja en
 *                                              segundo plano.
 *
 * Ciclo de vida: borrador → en_desarrollo → en_revision → aprobada →
 * publicada → revertida. Solo transiciones hacia adelante de un paso; la
 * publicación exige aprobación previa (límite duro en código).
 *
 * REGLA DURA: la reversión NUNCA toca la base de datos (las migraciones
 * son solo hacia adelante). Si el commit objetivo es anterior a migraciones
 * ya aplicadas, se registra como aviso en el resultado, sin bloquear.
 *
 * Todas las rutas exigen sesión; las mutadoras además exigen cabecera CSRF.
 * Ningún secreto viaja en código, logs ni respuestas: VERCEL_TOKEN solo se
 * lee del entorno del proceso en el momento de la reversión.
 */

import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '@jobforce/database';
import { auditEvent } from '../audit.js';
import { requireCsrf, requireSession } from '../auth.js';
import { validateBody } from '../validation.js';

const execFileAsync = promisify(execFile);

const authOnly = { preHandler: [requireSession] };
const mutating = { preHandler: [requireSession, requireCsrf] };

// ---------------------------------------------------------------------------
// Tipos y máquina de estados.
// ---------------------------------------------------------------------------

export type ComponenteCambio = 'frontend' | 'backend' | 'ambos';
export type EstadoCambio =
  | 'borrador'
  | 'en_desarrollo'
  | 'en_revision'
  | 'aprobada'
  | 'publicada'
  | 'revertida';

const ComponenteSchema = z.enum(['frontend', 'backend', 'ambos']);
const EstadoSchema = z.enum([
  'borrador',
  'en_desarrollo',
  'en_revision',
  'aprobada',
  'publicada',
  'revertida',
]);
const TestEstadoSchema = z.enum(['pendiente', 'pasando', 'fallando']);

/**
 * Siguiente estado permitido por PATCH (un solo paso hacia adelante).
 * `aprobada`, `publicada` y `revertida` solo se alcanzan por sus endpoints
 * dedicados (puertas de autorización), nunca por PATCH.
 */
const SIGUIENTE_POR_PATCH: Partial<Record<EstadoCambio, EstadoCambio>> = {
  borrador: 'en_desarrollo',
  en_desarrollo: 'en_revision',
};

export interface CodeChangeRow {
  id: string;
  titulo: string;
  descripcion: string;
  rama: string | null;
  componente: ComponenteCambio;
  estado: EstadoCambio;
  preview_url: string | null;
  test_estado: 'pendiente' | 'pasando' | 'fallando';
  test_detalle: Record<string, unknown>;
  aprobada_por: string | null;
  aprobada_en: Date | null;
  declaracion_aprobacion: string | null;
  publicada_en: Date | null;
  commit_publicado: string | null;
  revertida_en: Date | null;
  commit_revertido: string | null;
  revert_estado: 'idle' | 'en_curso' | 'completada' | 'fallida';
  revert_resultado: Record<string, unknown>;
  revert_motivo: string | null;
  created_at: Date;
  updated_at: Date;
}

function toIso(d: Date): string {
  return new Date(d).toISOString();
}

function mapChange(row: CodeChangeRow) {
  return {
    id: row.id,
    titulo: row.titulo,
    descripcion: row.descripcion,
    rama: row.rama,
    componente: row.componente,
    estado: row.estado,
    preview_url: row.preview_url,
    test_estado: row.test_estado,
    test_detalle: row.test_detalle ?? {},
    aprobada_por: row.aprobada_por,
    aprobada_en: row.aprobada_en ? toIso(row.aprobada_en) : null,
    declaracion_aprobacion: row.declaracion_aprobacion,
    publicada_en: row.publicada_en ? toIso(row.publicada_en) : null,
    commit_publicado: row.commit_publicado,
    revertida_en: row.revertida_en ? toIso(row.revertida_en) : null,
    commit_revertido: row.commit_revertido,
    revert_estado: row.revert_estado,
    revert_resultado: row.revert_resultado ?? {},
    revert_motivo: row.revert_motivo,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

const SELECT_CAMBIOS = `SELECT id, titulo, descripcion, rama, componente, estado,
    preview_url, test_estado, test_detalle, aprobada_por, aprobada_en,
    declaracion_aprobacion, publicada_en, commit_publicado, revertida_en,
    commit_revertido, revert_estado, revert_resultado, revert_motivo,
    created_at, updated_at
  FROM code_changes`;

async function getChange(id: string): Promise<CodeChangeRow | null> {
  const rows = await query<CodeChangeRow>(`${SELECT_CAMBIOS} WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Esquemas zod.
// ---------------------------------------------------------------------------

const CreateBody = z.object({
  titulo: z.string().trim().min(1, 'el título es obligatorio').max(120),
  descripcion: z.string().trim().min(1, 'la descripción es obligatoria').max(5000),
  componente: ComponenteSchema,
});

const UpdateBody = z
  .object({
    rama: z.string().trim().min(1).max(200).nullable().optional(),
    preview_url: z.string().trim().min(1).max(2000).url('preview_url debe ser una URL válida').nullable().optional(),
    test_estado: TestEstadoSchema.optional(),
    test_detalle: z.record(z.string(), z.unknown()).optional(),
    estado: z.enum(['en_desarrollo', 'en_revision']).optional(),
  })
  .refine(
    (b) =>
      b.rama !== undefined ||
      b.preview_url !== undefined ||
      b.test_estado !== undefined ||
      b.test_detalle !== undefined ||
      b.estado !== undefined,
    { message: 'no hay campos que actualizar' },
  );

const ApproveBody = z.object({
  declaracion: z
    .string()
    .trim()
    .min(1, 'la declaración de autorización es obligatoria')
    .max(500),
});

const PublishBody = z.object({
  commit: z.string().trim().min(1, 'el commit es obligatorio').max(100),
  vercel_deployment_id: z.string().trim().max(200).optional(),
  vercel_url: z.string().trim().max(2000).url().optional(),
});

const RevertBody = z.object({
  motivo: z.string().trim().min(1, 'el motivo es obligatorio').max(500),
});

const IdParams = z.object({ id: z.string().uuid('id no es un UUID válido') });

function validateParams(
  params: unknown,
  reply: Parameters<typeof validateBody>[2],
): { id: string } | null {
  const parsed = IdParams.safeParse(params);
  if (!parsed.success) {
    reply.code(400).send({ error: 'datos_invalidos', detalles: ['id: no es un UUID válido'] });
    return null;
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Reversión del backend: ejecutable real + doble inyectable para tests.
// ---------------------------------------------------------------------------

export interface BackendRevertResult {
  ok: boolean;
  commitObjetivo: string;
  commitActual?: string;
  /** Avisos no bloqueantes (p. ej. migraciones posteriores al objetivo). */
  avisos: string[];
  error?: string;
}

export type BackendRevertFn = (
  commitObjetivo: string,
  opts?: { dryRun?: boolean },
) => Promise<BackendRevertResult>;

function repoDir(): string {
  return process.env.JOBFORCE_REPO_DIR ?? `${homedir()}/jobforce-verify`;
}
function infraDir(): string {
  return process.env.JOBFORCE_INFRA_DIR ?? `${repoDir()}/infra`;
}

/**
 * Ejecutor real de reversión del backend:
 * 1. Averigua el HEAD actual del repo en Oracle.
 * 2. Comprueba si entre el commit objetivo y el actual se añadieron
 *    migraciones (aviso, no bloquea: la BD nunca se revierte).
 * 3. `git checkout <commitObjetivo>`.
 * 4. Reconstruye y redespliega el backend con docker compose.
 */
async function defaultBackendRevert(
  commitObjetivo: string,
  opts?: { dryRun?: boolean },
): Promise<BackendRevertResult> {
  if (opts?.dryRun || process.env.JOBFORCE_REVERT_DRY_RUN === '1') {
    return {
      ok: true,
      commitObjetivo,
      commitActual: 'simulado',
      avisos: ['dry-run: no se ejecutó git ni docker'],
    };
  }
  const dir = repoDir();
  const avisos: string[] = [];
  let commitActual = 'desconocido';
  try {
    const { stdout } = await execFileAsync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
      timeout: 60_000,
    });
    commitActual = stdout.trim();
  } catch (err) {
    return { ok: false, commitObjetivo, avisos, error: `no se pudo leer el HEAD del repo: ${msg(err)}` };
  }
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', dir, 'diff', '--name-only', commitObjetivo, commitActual, '--', 'packages/database/migrations/'],
      { timeout: 60_000 },
    );
    const migraciones = stdout.trim().split('\n').filter(Boolean);
    if (migraciones.length > 0) {
      avisos.push(
        `El commit objetivo es anterior a migraciones ya aplicadas (${migraciones.length}): ` +
          `${migraciones.join(', ')}. La base de datos NO se revierte (solo hacia adelante); ` +
          `verifica que el código antiguo sea compatible con el esquema actual.`,
      );
    }
  } catch (err) {
    avisos.push(`No se pudo comparar migraciones entre commits: ${msg(err)} (se continúa sin bloquear).`);
  }
  try {
    await execFileAsync('git', ['-C', dir, 'checkout', commitObjetivo], { timeout: 120_000 });
  } catch (err) {
    return { ok: false, commitObjetivo, commitActual, avisos, error: `git checkout falló: ${msg(err)}` };
  }
  try {
    await execFileAsync(
      'docker',
      ['compose', '--env-file', '../.env', 'up', '-d', '--build', 'backend'],
      { cwd: infraDir(), timeout: 15 * 60_000, maxBuffer: 32 * 1024 * 1024 },
    );
  } catch (err) {
    return {
      ok: false,
      commitObjetivo,
      commitActual,
      avisos,
      error: `docker compose falló (el repo quedó en ${commitObjetivo}): ${msg(err)}`,
    };
  }
  return { ok: true, commitObjetivo, commitActual, avisos };
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message.split('\n')[0] : String(err);
}

// ---------------------------------------------------------------------------
// Reversión del frontend (Vercel): API REST + fallback manual documentado.
// ---------------------------------------------------------------------------

export interface VercelRevertResult {
  /** 'automatico' solo si el opt-in experimental tuvo éxito; si no, 'manual'. */
  modo: 'automatico' | 'manual';
  deploymentId?: string;
  deploymentUrl?: string;
  dashboardUrl?: string;
  instrucciones?: string;
  nota?: string;
}

export interface VercelRevertContext {
  /** Commit git registrado en la publicación (informativo). */
  commitPublicado: string | null;
  /** Deployment id registrado en nuestro histórico (objetivo preferido). */
  deploymentObjetivo?: string | null;
}

export type VercelRevertFn = (ctx: VercelRevertContext) => Promise<VercelRevertResult>;

const VERCEL_API = 'https://api.vercel.com';

async function vercelGet<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${VERCEL_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Vercel API respondió ${res.status}`);
  }
  return (await res.json()) as T;
}

interface VercelDeployment {
  uid: string;
  url: string;
  state: string;
  target?: string;
  createdAt: number;
}

/** URL del dashboard del proyecto (mejor esfuerzo; nunca lanza). */
async function vercelDashboardUrl(
  token: string,
  projectId: string,
  teamId: string | undefined,
): Promise<string> {
  try {
    const teamParam = teamId ? `?teamId=${encodeURIComponent(teamId)}` : '';
    const proj = await vercelGet<{ name: string; accountId: string }>(
      `/v9/projects/${encodeURIComponent(projectId)}${teamParam}`,
      token,
    );
    const team = await vercelGet<{ slug: string }>(`/v2/teams/${proj.accountId}`, token).catch(
      () => null,
    );
    const scope = team?.slug ?? proj.accountId;
    return `https://vercel.com/${scope}/${proj.name}/deployments`;
  } catch {
    return 'https://vercel.com/dashboard';
  }
}

/**
 * Estrategia para el frontend:
 * - Si nuestro histórico de deployments conoce el deployment id anterior,
 *   se usa como objetivo (verificado contra la API).
 * - Si no, se localiza con GET /v6/deployments?projectId=…&target=production
 *   &state=READY: el más reciente es (normalmente) el actual y el segundo
 *   es el candidato de reversión.
 * - Vercel NO expone un endpoint REST documentado para "promote to
 *   production" / instant rollback (solo existe un endpoint interno no
 *   documentado). Por defecto se devuelve el fallback MANUAL con
 *   instrucciones paso a paso (nunca se falla en silencio).
 * - Opt-in experimental: si VERCEL_AUTO_ROLLBACK=true, se intenta el
 *   endpoint no documentado POST /v9/projects/{id}/rollback/{deploymentId};
 *   si falla, se devuelve el fallback manual con el error anotado.
 */
async function defaultVercelRevert(ctx: VercelRevertContext): Promise<VercelRevertResult> {
  const token = process.env.VERCEL_TOKEN;
  const projectId = process.env.VERCEL_PROJECT_ID;
  const teamId = process.env.VERCEL_TEAM_ID;

  const instruccionesManual = (deploymentId?: string, deploymentUrl?: string): string =>
    'Reversión manual del frontal en el panel de Vercel:\n' +
    '1. Abre el proyecto en el dashboard de Vercel → pestaña Deployments.\n' +
    '2. Localiza el último despliegue de producción anterior al cambio' +
    (deploymentId ? ` (id ${deploymentId}${deploymentUrl ? `, ${deploymentUrl}` : ''})` : '') +
    '.\n' +
    '3. Abre su menú (⋯) → "Promote to Production" y confirma.\n' +
    '4. Verifica la URL de producción. El cambio es instantáneo (sin rebuild).';

  const manual = async (
    nota: string,
    deploymentId?: string,
    deploymentUrl?: string,
  ): Promise<VercelRevertResult> => ({
    modo: 'manual',
    deploymentId,
    deploymentUrl,
    dashboardUrl: token && projectId ? await vercelDashboardUrl(token, projectId, teamId) : undefined,
    instrucciones: instruccionesManual(deploymentId, deploymentUrl),
    nota,
  });

  if (!token || !projectId) {
    return manual(
      !token
        ? 'Sin VERCEL_TOKEN en el entorno del backend: no se puede consultar la API de Vercel.'
        : 'Sin VERCEL_PROJECT_ID en el entorno del backend: no se sabe qué proyecto consultar.',
    );
  }

  const teamParam = teamId ? `&teamId=${encodeURIComponent(teamId)}` : '';
  let anterior: VercelDeployment | undefined;

  // 1) Objetivo preferido: el registrado en nuestro histórico.
  if (ctx.deploymentObjetivo) {
    try {
      const d = await vercelGet<VercelDeployment>(
        `/v13/deployments/${encodeURIComponent(ctx.deploymentObjetivo)}`,
        token,
      );
      if (d.state === 'READY') anterior = d;
    } catch {
      /* se sigue con la lista de producción */
    }
  }

  // 2) Si no, el segundo despliegue de producción READY más reciente.
  if (!anterior) {
    try {
      const lista = await vercelGet<{ deployments: VercelDeployment[] }>(
        `/v6/deployments?projectId=${encodeURIComponent(projectId)}${teamParam}` +
          `&target=production&state=READY&limit=5`,
        token,
      );
      const ordenados = [...(lista.deployments ?? [])].sort((a, b) => b.createdAt - a.createdAt);
      anterior = ordenados[1] ?? ordenados[0];
    } catch (err) {
      return manual(`No se pudo listar los despliegues de Vercel: ${msg(err)}.`);
    }
  }

  if (!anterior) {
    return manual('La API de Vercel no devolvió ningún despliegue de producción en estado READY.');
  }

  const info = { deploymentId: anterior.uid, deploymentUrl: `https://${anterior.url}` };

  if (process.env.VERCEL_AUTO_ROLLBACK === 'true') {
    try {
      const res = await fetch(
        `${VERCEL_API}/v9/projects/${encodeURIComponent(projectId)}/rollback/${encodeURIComponent(anterior.uid)}${teamParam ? `?${teamParam.slice(1)}` : ''}`,
        { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      );
      if (res.ok) {
        return {
          modo: 'automatico',
          ...info,
          dashboardUrl: await vercelDashboardUrl(token, projectId, teamId),
          nota: 'Rollback ejecutado vía endpoint no documentado de Vercel (opt-in VERCEL_AUTO_ROLLBACK).',
        };
      }
      return manual(
        `El endpoint experimental de rollback respondió ${res.status}; se devuelve el procedimiento manual.`,
        info.deploymentId,
        info.deploymentUrl,
      );
    } catch (err) {
      return manual(
        `El rollback automático falló (${msg(err)}); se devuelve el procedimiento manual.`,
        info.deploymentId,
        info.deploymentUrl,
      );
    }
  }

  return manual(
    'Vercel no expone un endpoint REST documentado para republicar un despliegue anterior; ' +
      'la reversión del frontal es un paso manual de un clic en el dashboard.',
    info.deploymentId,
    info.deploymentUrl,
  );
}

// ---------------------------------------------------------------------------
// Dobles inyectables para tests (patrón setSendTestDeps de sends.ts).
// ---------------------------------------------------------------------------

interface RevertTestDeps {
  backendRevert?: BackendRevertFn;
  vercelRevert?: VercelRevertFn;
}

let testDeps: RevertTestDeps = {};

/** Solo para tests: inyecta los ejecutores de reversión. */
export function setRevertTestDeps(deps: RevertTestDeps): void {
  testDeps = deps;
}

/** Restaura los ejecutores reales tras un test con dobles. */
export function resetRevertTestDeps(): void {
  testDeps = {};
}

// ---------------------------------------------------------------------------
// Orquestador de la reversión (segundo plano).
// ---------------------------------------------------------------------------

interface JobOutcome {
  revertida: boolean;
  resultado: Record<string, unknown>;
}

/** Ejecuta la reversión y deja el resultado en la BD. Nunca lanza. */
async function runRevertJob(changeId: string, runId: string): Promise<void> {
  const resultado: Record<string, unknown> = { revert_id: runId, inicio: new Date().toISOString() };
  try {
    const change = await getChange(changeId);
    if (!change) {
      resultado.error = 'cambio_no_encontrado';
      await finishRevert(changeId, runId, false, resultado, null);
      return;
    }
    if (change.estado !== 'publicada') {
      resultado.error = `estado_invalido_para_revertir: ${change.estado}`;
      await finishRevert(changeId, runId, false, resultado, null);
      return;
    }

    const tocaBackend = change.componente === 'backend' || change.componente === 'ambos';
    const tocaFrontend = change.componente === 'frontend' || change.componente === 'ambos';
    let todoOk = true;
    let commitRevertido: string | null = null;

    if (tocaBackend) {
      const prev = await query<{ commit: string }>(
        `SELECT commit FROM deployments
          WHERE componente = 'backend' AND estado = 'exito'
            AND commit <> $1
          ORDER BY desplegado_en DESC LIMIT 1`,
        [change.commit_publicado ?? ''],
      );
      if (prev.length === 0) {
        todoOk = false;
        resultado.backend = { ok: false, error: 'sin_despliegue_backend_previo' };
      } else {
        const objetivo = prev[0].commit;
        const ejecutar = testDeps.backendRevert ?? defaultBackendRevert;
        const r = await ejecutar(objetivo, {});
        resultado.backend = r;
        if (r.ok) {
          commitRevertido = objetivo;
          await query(
            `INSERT INTO deployments (componente, commit, desplegado_por, estado)
             VALUES ('backend', $1, 'jon (revert)', 'exito')`,
            [objetivo],
          );
        } else {
          todoOk = false;
          await query(
            `INSERT INTO deployments (componente, commit, desplegado_por, estado)
             VALUES ('backend', $1, 'jon (revert)', 'fallo')`,
            [objetivo],
          );
        }
      }
    }

    if (tocaFrontend) {
      // Objetivo preferido: el último despliegue de frontend con deployment
      // id conocido y commit distinto al publicado.
      const prevFront = await query<{ vercel_deployment_id: string | null }>(
        `SELECT vercel_deployment_id FROM deployments
          WHERE componente = 'frontend' AND estado = 'exito'
            AND commit <> $1
          ORDER BY desplegado_en DESC LIMIT 1`,
        [change.commit_publicado ?? ''],
      );
      const ejecutar = testDeps.vercelRevert ?? defaultVercelRevert;
      const r = await ejecutar({
        commitPublicado: change.commit_publicado,
        deploymentObjetivo: prevFront[0]?.vercel_deployment_id ?? null,
      });
      resultado.frontend = r;
      // El fallback manual no es un fallo: el panel entrega las
      // instrucciones y el clic final lo hace Jon en el dashboard.
      if (r.deploymentId) {
        commitRevertido = commitRevertido ?? `vercel:${r.deploymentId}`;
      }
      await query(
        `INSERT INTO deployments (componente, commit, vercel_deployment_id, vercel_url, desplegado_por, estado)
         VALUES ('frontend', $1, $2, $3, 'jon (revert)', 'exito')`,
        [change.commit_publicado ?? 'desconocido', r.deploymentId ?? null, r.deploymentUrl ?? null],
      );
    }

    resultado.fin = new Date().toISOString();
    await finishRevert(changeId, runId, todoOk, resultado, commitRevertido);
  } catch (err) {
    resultado.error = msg(err);
    resultado.fin = new Date().toISOString();
    await finishRevert(changeId, runId, false, resultado, null).catch(() => undefined);
  }
}

async function finishRevert(
  changeId: string,
  runId: string,
  ok: boolean,
  resultado: Record<string, unknown>,
  commitRevertido: string | null,
): Promise<void> {
  if (ok) {
    await query(
      `UPDATE code_changes
          SET estado = 'revertida',
              revert_estado = 'completada',
              revert_resultado = $2::jsonb,
              revertida_en = now(),
              commit_revertido = $3,
              updated_at = now()
        WHERE id = $1`,
      [changeId, JSON.stringify(resultado), commitRevertido],
    );
  } else {
    await query(
      `UPDATE code_changes
          SET revert_estado = 'fallida',
              revert_resultado = $2::jsonb,
              updated_at = now()
        WHERE id = $1`,
      [changeId, JSON.stringify(resultado)],
    );
  }
  await auditEvent({
    actorId: null,
    action: ok ? 'code_change_revert_finished' : 'code_change_revert_failed',
    entityType: 'code_change',
    entityId: changeId,
    details: { revert_id: runId, ok, resultado },
  });
}

// ---------------------------------------------------------------------------
// Rutas.
// ---------------------------------------------------------------------------

export async function registerCodeChangeRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/code-changes — crea una propuesta en borrador.
  app.post('/api/code-changes', mutating, async (req, reply) => {
    const valid = validateBody(CreateBody, req.body ?? {}, reply);
    if (!valid) return;

    const rows = await query<{ id: string }>(
      `INSERT INTO code_changes (titulo, descripcion, componente)
       VALUES ($1, $2, $3) RETURNING id`,
      [valid.data.titulo, valid.data.descripcion, valid.data.componente],
    );
    const id = rows[0].id;
    await auditEvent({
      actorId: req.authSession?.userId ?? null,
      action: 'code_change_created',
      entityType: 'code_change',
      entityId: id,
      details: { titulo: valid.data.titulo, componente: valid.data.componente },
    });
    const change = await getChange(id);
    return reply.code(201).send(mapChange(change!));
  });

  // GET /api/code-changes — lista con filtros opcionales.
  app.get('/api/code-changes', authOnly, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const conds: string[] = [];
    const params: unknown[] = [];
    if (q.estado !== undefined) {
      const p = EstadoSchema.safeParse(q.estado);
      if (!p.success) return reply.code(400).send({ error: 'datos_invalidos', detalles: ['estado: valor no válido'] });
      conds.push(`estado = $${params.length + 1}`);
      params.push(p.data);
    }
    if (q.componente !== undefined) {
      const p = ComponenteSchema.safeParse(q.componente);
      if (!p.success) {
        return reply.code(400).send({ error: 'datos_invalidos', detalles: ['componente: valor no válido'] });
      }
      conds.push(`componente = $${params.length + 1}`);
      params.push(p.data);
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    const rows = await query<CodeChangeRow>(
      `${SELECT_CAMBIOS} ${where} ORDER BY updated_at DESC`,
      params,
    );
    return { cambios: rows.map(mapChange) };
  });

  // GET /api/code-changes/:id — detalle + últimos eventos de auditoría.
  app.get('/api/code-changes/:id', authOnly, async (req, reply) => {
    const params = validateParams(req.params, reply);
    if (!params) return;

    const change = await getChange(params.id);
    if (!change) {
      return reply.code(404).send({ error: 'cambio_no_encontrado' });
    }
    const eventos = await query<{
      id: string;
      action: string;
      details: Record<string, unknown> | null;
      actor: string | null;
      occurred_at: Date;
    }>(
      `SELECT a.id, a.action, a.details, u.username AS actor, a.occurred_at
         FROM audit_events a
         LEFT JOIN admin_users u ON u.id = a.actor_id
        WHERE a.entity_type = 'code_change' AND a.entity_id = $1
        ORDER BY a.occurred_at DESC LIMIT 20`,
      [params.id],
    );
    return {
      ...mapChange(change),
      auditoria: eventos.map((e) => ({
        id: e.id,
        accion: e.action,
        detalles: e.details ?? {},
        actor: e.actor,
        creada_en: toIso(e.occurred_at),
      })),
    };
  });

  // PATCH /api/code-changes/:id — actualiza campos y/o avanza un paso.
  app.patch('/api/code-changes/:id', mutating, async (req, reply) => {
    const params = validateParams(req.params, reply);
    if (!params) return;
    const valid = validateBody(UpdateBody, req.body ?? {}, reply);
    if (!valid) return;

    const change = await getChange(params.id);
    if (!change) {
      return reply.code(404).send({ error: 'cambio_no_encontrado' });
    }
    if (change.estado === 'revertida') {
      return reply.code(409).send({ error: 'cambio_revertido', mensaje: 'Un cambio revertido es inmutable.' });
    }

    const d = valid.data;
    if (d.estado !== undefined) {
      const esperado = SIGUIENTE_POR_PATCH[change.estado];
      if (esperado !== d.estado) {
        return reply.code(409).send({
          error: 'transicion_no_permitida',
          mensaje: `Desde '${change.estado}' solo se puede avanzar a '${esperado ?? 'ningún estado (usa approve/publish/revert)'}'.`,
        });
      }
    }

    const sets: string[] = ['updated_at = now()'];
    const args: unknown[] = [];
    if (d.rama !== undefined) {
      sets.push(`rama = $${args.length + 1}`);
      args.push(d.rama);
    }
    if (d.preview_url !== undefined) {
      sets.push(`preview_url = $${args.length + 1}`);
      args.push(d.preview_url);
    }
    if (d.test_estado !== undefined) {
      sets.push(`test_estado = $${args.length + 1}`);
      args.push(d.test_estado);
    }
    if (d.test_detalle !== undefined) {
      sets.push(`test_detalle = $${args.length + 1}::jsonb`);
      args.push(JSON.stringify(d.test_detalle));
    }
    if (d.estado !== undefined) {
      sets.push(`estado = $${args.length + 1}`);
      args.push(d.estado);
    }
    await query(`UPDATE code_changes SET ${sets.join(', ')} WHERE id = $${args.length + 1}`, [
      ...args,
      params.id,
    ]);
    await auditEvent({
      actorId: req.authSession?.userId ?? null,
      action: 'code_change_updated',
      entityType: 'code_change',
      entityId: params.id,
      details: { campos: Object.keys(d) },
    });
    const updated = await getChange(params.id);
    return mapChange(updated!);
  });

  // POST /api/code-changes/:id/approve — puerta de autorización.
  app.post('/api/code-changes/:id/approve', mutating, async (req, reply) => {
    const params = validateParams(req.params, reply);
    if (!params) return;
    const valid = validateBody(ApproveBody, req.body ?? {}, reply);
    if (!valid) return;

    const change = await getChange(params.id);
    if (!change) {
      return reply.code(404).send({ error: 'cambio_no_encontrado' });
    }
    if (change.estado !== 'en_revision') {
      return reply.code(409).send({
        error: 'estado_invalido_para_aprobar',
        mensaje: `Solo se puede aprobar desde 'en_revision' (estado actual: '${change.estado}').`,
      });
    }

    await query(
      `UPDATE code_changes
          SET estado = 'aprobada',
              aprobada_por = $2,
              aprobada_en = now(),
              declaracion_aprobacion = $3,
              updated_at = now()
        WHERE id = $1`,
      [params.id, req.authSession?.userId ?? null, valid.data.declaracion],
    );
    // La declaración de Jon queda en la auditoría: es la prueba de la
    // autorización expresa. Nunca contiene secretos (es texto libre de Jon).
    await auditEvent({
      actorId: req.authSession?.userId ?? null,
      action: 'code_change_approved',
      entityType: 'code_change',
      entityId: params.id,
      details: {
        aprobada_por: req.authSession?.username ?? null,
        declaracion: valid.data.declaracion,
      },
    });
    const updated = await getChange(params.id);
    return mapChange(updated!);
  });

  // POST /api/code-changes/:id/publish — registra la publicación.
  app.post('/api/code-changes/:id/publish', mutating, async (req, reply) => {
    const params = validateParams(req.params, reply);
    if (!params) return;
    const valid = validateBody(PublishBody, req.body ?? {}, reply);
    if (!valid) return;

    const change = await getChange(params.id);
    if (!change) {
      return reply.code(404).send({ error: 'cambio_no_encontrado' });
    }
    // LÍMITE DURO: sin aprobación expresa previa no hay publicación.
    if (change.estado !== 'aprobada') {
      return reply.code(409).send({
        error: 'publicacion_sin_aprobacion',
        mensaje: `Solo se puede publicar desde 'aprobada' (estado actual: '${change.estado}'). Aprueba primero el cambio.`,
      });
    }

    await query(
      `UPDATE code_changes
          SET estado = 'publicada',
              commit_publicado = $2,
              publicada_en = now(),
              updated_at = now()
        WHERE id = $1`,
      [params.id, valid.data.commit],
    );
    // Una fila por componente: la reversión busca el último despliegue
    // `exito` de cada componente con commit distinto al publicado.
    const componentesPub: string[] =
      change.componente === 'ambos' ? ['frontend', 'backend'] : [change.componente];
    for (const c of componentesPub) {
      await query(
        `INSERT INTO deployments (componente, commit, vercel_deployment_id, vercel_url, desplegado_por, estado)
         VALUES ($1, $2, $3, $4, 'jon', 'exito')`,
        [
          c,
          valid.data.commit,
          c === 'frontend' ? (valid.data.vercel_deployment_id ?? null) : null,
          c === 'frontend' ? (valid.data.vercel_url ?? null) : null,
        ],
      );
    }
    await auditEvent({
      actorId: req.authSession?.userId ?? null,
      action: 'code_change_published',
      entityType: 'code_change',
      entityId: params.id,
      details: {
        commit: valid.data.commit,
        componente: change.componente,
        aprobada_por: change.aprobada_por,
        aprobada_en: change.aprobada_en ? toIso(change.aprobada_en) : null,
      },
    });
    const updated = await getChange(params.id);
    return mapChange(updated!);
  });

  // POST /api/code-changes/:id/revert — reversión en un clic (202 + fondo).
  app.post('/api/code-changes/:id/revert', mutating, async (req, reply) => {
    const params = validateParams(req.params, reply);
    if (!params) return;
    const valid = validateBody(RevertBody, req.body ?? {}, reply);
    if (!valid) return;

    const change = await getChange(params.id);
    if (!change) {
      return reply.code(404).send({ error: 'cambio_no_encontrado' });
    }
    if (change.estado !== 'publicada') {
      return reply.code(409).send({
        error: 'estado_invalido_para_revertir',
        mensaje: `Solo se puede revertir desde 'publicada' (estado actual: '${change.estado}').`,
      });
    }
    if (change.revert_estado === 'en_curso') {
      return reply.code(409).send({ error: 'revert_en_curso', mensaje: 'Ya hay una reversión en curso para este cambio.' });
    }
    const total = await query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM deployments`);
    if (Number(total[0].n) === 0) {
      return reply.code(409).send({
        error: 'sin_despliegues_previos',
        mensaje: 'No hay despliegues previos registrados: no hay a qué revertir.',
      });
    }

    const runId = randomUUID();
    const resultadoInicial = { revert_id: runId, inicio: new Date().toISOString(), motivo: valid.data.motivo };
    await query(
      `UPDATE code_changes
          SET revert_estado = 'en_curso',
              revert_motivo = $2,
              revert_resultado = $3::jsonb,
              updated_at = now()
        WHERE id = $1`,
      [params.id, valid.data.motivo, JSON.stringify(resultadoInicial)],
    );
    await auditEvent({
      actorId: req.authSession?.userId ?? null,
      action: 'code_change_revert_started',
      entityType: 'code_change',
      entityId: params.id,
      details: { revert_id: runId, motivo: valid.data.motivo, componente: change.componente },
    });

    // Segundo plano: la petición responde 202 al instante; el progreso se
    // consulta con GET /api/code-changes/:id (revert_estado/revert_resultado).
    void runRevertJob(params.id, runId);

    return reply.code(202).send({ ok: true, revert_id: runId, estado: 'en_curso' });
  });
}
