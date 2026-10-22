/**
 * @jobforce/backend — Solicitudes de envío y checks pre-envío (Fase 4).
 *
 * - POST /api/applications/:id/presend-checks → ejecuta los 9 checks pre-envío.
 * - POST /api/applications/:id/request-send  → evalúa la política y, si el
 *   veredicto es `permitido`, deja la fila en `sends` (queued) + lock con
 *   vencimiento. Idempotente por cabecera `X-Idempotency-Key`.
 *
 * Todas exigen sesión; las dos son mutadoras (exigen cabecera CSRF).
 *
 * NOTA DE DISEÑO: la API no ejecuta el envío real (aún no existe ejecutor).
 * El estado queda en `queued` con la evidencia de la decisión para que el
 * motor lo recoja cuando exista.
 *
 * CONVERGENCIA (Fase 4): la decisión de política delega en `evaluarEnvio` de
 * `@jobforce/autonomy` (fuente única de verdad). Esta ruta solo compone:
 * pliegue de checks → suelo duro de encaje → modo investigar → motor →
 * promoción por aprobación explícita de Jon en modo revisión.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { DecisionEnvio, PoliticaAutonomia } from '@jobforce/domain';
import { evaluarEnvio, type ContextoEnvio } from '@jobforce/autonomy';
import { query, withTransaction } from '@jobforce/database';
import { checkUrlAlive } from '@jobforce/search';
import { auditEvent } from '../audit.js';
import { requireCsrf, requireSession } from '../auth.js';
import { getEffectivePolicy } from './autonomy.js';

const mutating = { preHandler: [requireSession, requireCsrf] };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Dependencias inyectables (solo tests).
// ---------------------------------------------------------------------------

export interface OfferProbeContext {
  applicationId: string;
  offerUrl: string | null;
  portal: string | null;
}

export interface OfferProbeResult {
  ok: boolean;
  detalle: string;
}

interface SendTestDeps {
  /** Sonda de vigencia de la oferta. Sin sonda, el check `oferta_vigente`
   *  falla de forma explícita (nada se simula como OK). */
  offerProbe?: (ctx: OfferProbeContext) => Promise<OfferProbeResult>;
}

let testDeps: SendTestDeps = {};

/** Solo para tests: inyecta la sonda de vigencia de ofertas. */
export function setSendTestDeps(deps: SendTestDeps): void {
  testDeps = deps;
}

/** Restaura las dependencias reales tras un test con dobles. */
export function resetSendTestDeps(): void {
  testDeps = {};
}

// ---------------------------------------------------------------------------
// Checks pre-envío.
// ---------------------------------------------------------------------------

export interface CheckResultado {
  check: string;
  ok: boolean;
  detalle: string;
}

interface ApplicationRow {
  id: string;
  campaign_id: string;
  offer_id: string;
  status: string;
  portal: string | null;
  /** URL operativa de aplicación: offers.apply_url si está resuelta; si no, la de la oferta. */
  offer_url: string | null;
  /** URL donde se encontró la oferta (la bolsa o el portal), sin resolver. */
  source_url?: string | null;
  offer_company: string | null;
  score: string | null;
  mandatory_verdict: string | null;
  offer_snapshot: Record<string, unknown>;
}

/** Exportada para el ejecutor de envíos (mismo shape que usa runPresendChecks). */
export type { ApplicationRow };

async function loadApplicationInternal(id: string): Promise<ApplicationRow | null> {
  const rows = await query<ApplicationRow>(
    `SELECT a.id, a.campaign_id, a.offer_id, a.status, a.portal,
            a.offer_snapshot,
            COALESCE(o.apply_url, o.url) AS offer_url, o.url AS source_url,
            o.company AS offer_company,
            e.score::text AS score, e.mandatory_verdict
       FROM applications a
       JOIN offers o ON o.id = a.offer_id
       LEFT JOIN LATERAL (
         SELECT score, mandatory_verdict FROM evaluations
          WHERE offer_id = a.offer_id
          ORDER BY created_at DESC LIMIT 1
       ) e ON true
      WHERE a.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * Carga una candidatura con su oferta y última evaluación.
 * Exportada para el ejecutor de envíos (`apps/backend/src/sender/`).
 */
export async function loadApplication(id: string): Promise<ApplicationRow | null> {
  return loadApplicationInternal(id);
}

async function countSendsSince(sqlInterval: string): Promise<number> {
  const rows = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM sends
      WHERE created_at >= now() - $1::interval
        AND status IN ('queued','sending','sent')`,
    [sqlInterval],
  );
  return Number(rows[0].n);
}

async function gastoMesUsd(): Promise<number> {
  const rows = await query<{ total: string | null }>(
    `SELECT SUM(COALESCE((evidence->>'cost_usd')::numeric, 0))::text AS total
       FROM sends
      WHERE created_at >= date_trunc('month', now())`,
  );
  return Number(rows[0].total ?? 0);
}

/**
 * Ejecuta los 9 checks pre-envío. Ningún check se simula como OK: donde no
 * hay una fuente real (sonda de vigencia), el check falla con su detalle.
 * Devuelve también las métricas de cuota/presupuesto para la decisión.
 *
 * La sonda de vigencia puede pasarse como segundo argumento (la usa el
 * ejecutor de envíos); si no se pasa, se usa la inyectada con
 * `setSendTestDeps` (tests); sin ninguna, el check `oferta_vigente` falla
 * de forma explícita.
 */
export async function runPresendChecks(
  app: ApplicationRow,
  offerProbe?: (ctx: OfferProbeContext) => Promise<OfferProbeResult>,
  opts: { excluirSendId?: string } = {},
): Promise<{
  checks: CheckResultado[];
  metricas: { enviosHoy: number; enviosSemana: number; gastoMesUsd: number };
}> {
  const checks: CheckResultado[] = [];

  // 1) Hay una política efectiva vigente.
  const policy = await getEffectivePolicy();
  checks.push({
    check: 'politica_vigente',
    ok: policy !== null,
    detalle: policy ? `versión ${policy.version}` : 'no hay política efectiva',
  });

  // 2) La parada global está desactivada.
  const paradaGlobal = policy?.global_stop === true;
  checks.push({
    check: 'parada_global_off',
    ok: !paradaGlobal,
    detalle: paradaGlobal ? 'parada global activa' : 'parada global desactivada',
  });

  // 3) La candidatura está aprobada por Jon — o la aprobación está cubierta
  //    por la autorización escrita en modo automático (la autorización escrita
  //    ES la aprobación en ese modo; exigir además un "approved" manual
  //    dejaría el modo automático inoperante, contra el diseño de
  //    `evaluarEnvio`, que no pide aprobación por candidatura en automático).
  const autoAutorizado =
    policy?.policy.modoActivo === 'ejecutar_automatico' && policy.authorized_by !== null;
  const aprobada = app.status === 'approved' || autoAutorizado;
  checks.push({
    check: 'oferta_aprobada',
    ok: aprobada,
    detalle: app.status === 'approved'
      ? 'estado de la candidatura: approved'
      : autoAutorizado
        ? 'aprobación cubierta por la autorización escrita (modo automático)'
        : `estado de la candidatura: ${app.status}`,
  });

  // 4) La oferta sigue vigente (sonda inyectable; sin sonda → fallo explícito).
  const probe = offerProbe ?? testDeps.offerProbe;
  if (probe) {
    try {
      const resultado = await probe({
        applicationId: app.id,
        offerUrl: app.offer_url,
        portal: app.portal,
      });
      checks.push({ check: 'oferta_vigente', ok: resultado.ok, detalle: resultado.detalle });
    } catch (err) {
      checks.push({
        check: 'oferta_vigente',
        ok: false,
        detalle: `la sonda falló: ${err instanceof Error ? err.message : 'error desconocido'}`,
      });
    }
  } else {
    checks.push({
      check: 'oferta_vigente',
      ok: false,
      detalle: 'sin_probe_de_vigencia: no hay sonda configurada para re-verificar la oferta',
    });
  }

  // 5) No hay otro envío no fallido para esta candidatura (excluyendo el
  //    propio envío cuando lo indica el ejecutor: ya está en `sending`).
  const duplicados = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM sends
      WHERE application_id = $1 AND status <> 'failed'
        AND ($2::uuid IS NULL OR id <> $2::uuid)`,
    [app.id, opts.excluirSendId ?? null],
  );
  checks.push({
    check: 'sin_duplicados',
    ok: Number(duplicados[0].n) === 0,
    detalle:
      Number(duplicados[0].n) === 0
        ? 'sin envíos previos no fallidos'
        : `${duplicados[0].n} envío(s) previo(s) no fallido(s)`,
  });

  // 6) No hay un bloqueo activo para esta candidatura.
  const locks = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM send_locks
      WHERE application_id = $1 AND locked_until > now()`,
    [app.id],
  );
  checks.push({
    check: 'sin_bloqueo_activo',
    ok: Number(locks[0].n) === 0,
    detalle: Number(locks[0].n) === 0 ? 'sin bloqueo activo' : 'bloqueo activo en vigor',
  });

  // 7-9) Cuotas y presupuesto de la política (si hay política efectiva).
  const reglas = policy?.policy?.reglas;
  const metricas = { enviosHoy: 0, enviosSemana: 0, gastoMesUsd: 0 };
  if (reglas) {
    metricas.enviosHoy = await countSendsSince('1 day');
    checks.push({
      check: 'cuota_diaria',
      ok: metricas.enviosHoy < reglas.maxEnviosPorDia,
      detalle: `${metricas.enviosHoy}/${reglas.maxEnviosPorDia} envíos en las últimas 24 h`,
    });
    metricas.enviosSemana = await countSendsSince('7 days');
    checks.push({
      check: 'cuota_semanal',
      ok: metricas.enviosSemana < reglas.maxEnviosPorSemana,
      detalle: `${metricas.enviosSemana}/${reglas.maxEnviosPorSemana} envíos en los últimos 7 días`,
    });
    metricas.gastoMesUsd = await gastoMesUsd();
    checks.push({
      check: 'presupuesto_mensual',
      ok: metricas.gastoMesUsd < reglas.presupuestoMensualUsd,
      detalle: `${metricas.gastoMesUsd.toFixed(2)}/${reglas.presupuestoMensualUsd} $ gastados este mes`,
    });
  } else {
    for (const check of ['cuota_diaria', 'cuota_semanal', 'presupuesto_mensual']) {
      checks.push({ check, ok: false, detalle: 'sin política efectiva para evaluar la cuota' });
    }
  }

  return { checks, metricas };
}

// ---------------------------------------------------------------------------
// Decisión de envío: compone checks + motor de política (fuente única).
// ---------------------------------------------------------------------------

export interface DecisionResultado {
  decision: DecisionEnvio;
  motivos: string[];
  checks: CheckResultado[];
}

/**
 * Evalúa la política sobre una candidatura y sus checks, componiendo:
 *  1. Pliegue de checks: cualquier check fallido → `bloqueado`.
 *  2. Suelo duro de encaje: por debajo de `umbralEncajeRevision` → `bloqueado`.
 *  3. Modo `investigar` → `requiere_revision` (nunca encola solo).
 *  4. Núcleo de la política: `evaluarEnvio` de `@jobforce/autonomy`
 *     (fuente única de verdad; incluye el LÍMITE DURO: automático sin
 *     autorización escrita → `bloqueado`).
 *  5. Con aprobación HUMANA expresa (la candidatura está en `approved`),
 *     el requisito de revisión queda satisfecho y el encaje solo necesita
 *     alcanzar el umbral de revisión → `permitido` (encolar). Aplica en
 *     `preparar_para_revision` y en `ejecutar_automatico` (Fase 8): en
 *     automático, una candidatura en `ready_for_review` (sin aprobación
 *     humana) NUNCA se promueve por debajo del umbral automático.
 */
/** ¿La candidatura nace de una orden directa de Jon en el chat del Agente?
 * El agente lo sella en el offer_snapshot al aprobar (`ordenDirecta: true`). */
export function ordenDirectaDeJon(app: ApplicationRow): boolean {
  const snap = app.offer_snapshot as { ordenDirecta?: unknown } | null;
  return !!snap && typeof snap === 'object' && snap.ordenDirecta === true;
}

export function decidirEnvio(
  app: ApplicationRow,
  politica: PoliticaAutonomia,
  checks: CheckResultado[],
  metricas: { enviosHoy: number; enviosSemana: number; gastoMesUsd: number },
): { decision: DecisionEnvio; motivos: string[] } {
  const fallidos = checks.filter((c) => !c.ok);
  if (fallidos.length > 0) {
    return {
      decision: 'bloqueado',
      motivos: fallidos.map((c) => `check_${c.check}_fallido: ${c.detalle}`),
    };
  }

  const score = app.score === null ? null : Number(app.score);
  if (score !== null && !Number.isNaN(score) && score < politica.reglas.umbralEncajeRevision) {
    return {
      decision: 'bloqueado',
      motivos: [`encaje_insuficiente: ${score} < ${politica.reglas.umbralEncajeRevision}`],
    };
  }

  if (politica.modoActivo === 'investigar') {
    return { decision: 'requiere_revision', motivos: ['modo_investigar_no_envia_solo'] };
  }

  const checkOk = (nombre: string): boolean => checks.some((c) => c.check === nombre && c.ok);
  const ctx: ContextoEnvio = {
    encaje: score === null || Number.isNaN(score) ? null : score,
    // Conservador: sin veredicto de evaluación no se afirma cumplimiento.
    obligatorios:
      app.mandatory_verdict === 'cumple'
        ? 'cumple'
        : app.mandatory_verdict === 'incumple'
          ? 'incumple'
          : 'sin_evidencia',
    portal: app.portal ?? '',
    empresa: app.offer_company ?? '',
    enviosHoy: metricas.enviosHoy,
    enviosSemana: metricas.enviosSemana,
    gastoMesUsd: metricas.gastoMesUsd,
    duplicado: !checkOk('sin_duplicados'),
    ofertaVigente: checkOk('oferta_vigente'),
  };
  const ev = evaluarEnvio(politica, ctx);

  if (ev.decision === 'requiere_revision' && app.status === 'approved' && ordenDirectaDeJon(app)) {
    // Orden directa de Jon en el chat del Agente (2026-10-21): él ha
    // visto la evaluación informativa de ESA oferta y ha ordenado
    // aplicar expresamente. Su revisión favorable sustituye a la
    // automática SOLO para los motivos blandos que producen
    // `requiere_revision` (sin evidencia / encaje desconocido). Los
    // bloqueos duros (decisión `bloqueado`: parada global, duplicado,
    // oferta no vigente, empresa excluida, portal no permitido,
    // límites, presupuesto, incumple) NO se ven afectados.
    return {
      decision: 'permitido',
      motivos: [
        ...ev.motivos,
        'orden_directa_de_jon: encargo expreso en el chat del Agente tras ver la evaluación',
      ],
    };
  }

  if (ev.decision === 'requiere_revision' && app.status === 'approved') {
    // Decisión expresa de Jon (20-oct-2026): su aprobación explícita basta
    // desde el umbral de revisión; el umbral automático solo gobierna los
    // envíos SIN aprobación humana por candidatura. La condición es el
    // estado `approved` (aprobación humana real), no el modo: en
    // `ejecutar_automatico` una candidatura aún en `ready_for_review` no
    // entra aquí y sigue necesitando el umbral automático. El suelo duro
    // de `umbralEncajeRevision` ya se aplicó arriba (por debajo →
    // bloqueado); sin encaje medido no se promueve.
    const encajeSuficiente = ctx.encaje !== null && ctx.encaje >= politica.reglas.umbralEncajeRevision;
    if (encajeSuficiente) {
      return {
        decision: 'permitido',
        motivos: [...ev.motivos, 'aprobacion_explicita_de_jon: candidatura en estado approved'],
      };
    }
  }
  return { decision: ev.decision, motivos: ev.motivos };
}

interface SendRow {
  id: string;
  application_id: string;
  idempotency_key: string;
  policy_version: number;
  status: string;
  evidence: { decision?: DecisionEnvio; motivos?: string[] } & Record<string, unknown>;
  created_at: Date;
}

function mapSend(row: SendRow) {
  return {
    id: row.id,
    application_id: row.application_id,
    idempotency_key: row.idempotency_key,
    policy_version: row.policy_version,
    status: row.status,
    decision: row.evidence.decision ?? null,
    motivos: row.evidence.motivos ?? [],
    created_at: row.created_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Solicitud de envío (Fase 7): lógica de request-send extraída de la ruta
// para reutilizarla en el encadenado aprobación → envío de /revision.
// ---------------------------------------------------------------------------

/**
 * Sonda de vigencia por HTTP (producción): la URL de la oferta debe
 * responder. Es una comprobación REAL, no simulada: si el portal bloquea
 * la sonda o la oferta caducó, el check falla y el envío no se encola.
 * El ejecutor re-verifica después con la sonda del navegador (driver).
 */
const sondaVigenciaHttp = async (ctx: OfferProbeContext): Promise<OfferProbeResult> => {
  if (!ctx.offerUrl) {
    return { ok: false, detalle: 'sin_url_de_oferta: no se puede re-verificar la vigencia' };
  }
  const viva = await checkUrlAlive(ctx.offerUrl);
  return viva
    ? { ok: true, detalle: 'sonda http: la URL de la oferta responde' }
    : { ok: false, detalle: 'sonda http: la URL de la oferta no responde (posible caducidad)' };
};

export type SolicitarEnvioResultado =
  | { outcome: 'no_encontrada' }
  | { outcome: 'repetido'; send: ReturnType<typeof mapSend> & { duplicado: boolean } }
  | { outcome: 'ya_existe'; sendId: string }
  | { outcome: 'conflicto' }
  | {
      outcome: 'bloqueado';
      decision: DecisionEnvio;
      motivos: string[];
      checks: CheckResultado[];
    }
  | { outcome: 'encolado'; send: ReturnType<typeof mapSend> & { duplicado: boolean } };

/**
 * Decide y, si la política lo permite, encola el envío de una candidatura
 * (send `queued` + lock de 15 min, transaccional). Idempotente por clave y
 * sin duplicados por candidatura. La sonda de vigencia es la inyectada en
 * tests si la hay; en producción, la sonda HTTP real.
 */
export async function solicitarEnvio(
  applicationId: string,
  opts: { actorId?: string | null; idempotencyKey?: string } = {},
): Promise<SolicitarEnvioResultado> {
  const application = await loadApplication(applicationId);
  if (!application) return { outcome: 'no_encontrada' };
  const id = applicationId;
  const idempotencyKey = opts.idempotencyKey;

  // 1) Idempotencia estricta: la misma clave devuelve el mismo envío.
  if (idempotencyKey) {
    const previas = await query<SendRow>(
      `SELECT id, application_id, idempotency_key, policy_version, status,
              evidence, created_at
         FROM sends WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    if (previas.length > 0) {
      return { outcome: 'repetido', send: { ...mapSend(previas[0]), duplicado: true } };
    }
  }

  // 2) Sin duplicados por candidatura (aunque la clave sea distinta).
  const existentes = await query<{ id: string }>(
    `SELECT id FROM sends WHERE application_id = $1 AND status <> 'failed'`,
    [id],
  );
  if (existentes.length > 0) {
    return { outcome: 'ya_existe', sendId: existentes[0].id };
  }

  // 3) Checks + decisión de política.
  const policy = await getEffectivePolicy();
  const probe = testDeps.offerProbe ?? sondaVigenciaHttp;
  const { checks, metricas } = await runPresendChecks(application, probe);
  if (!policy) {
    return {
      outcome: 'bloqueado',
      decision: 'bloqueado',
      motivos: ['sin_politica_vigente'],
      checks,
    };
  }
  const { decision, motivos } = decidirEnvio(application, policy.policy, checks, metricas);
  if (decision !== 'permitido') {
    return { outcome: 'bloqueado', decision, motivos, checks };
  }

  // 4) Permitido: encola el envío + lock con vencimiento (transaccional).
  const key = idempotencyKey ?? randomUUID();
  const evidence = {
    decision: 'permitido' as DecisionEnvio,
    motivos,
    checks,
    policy_version: policy.version,
    decided_at: new Date().toISOString(),
    cost_usd: 0,
  };
  try {
    const created = await withTransaction(async (client) => {
      const sendRows = await client.query<SendRow>(
        `INSERT INTO sends (application_id, idempotency_key, policy_version, status, evidence)
         VALUES ($1, $2, $3, 'queued', $4::jsonb)
         RETURNING id, application_id, idempotency_key, policy_version,
                   status, evidence, created_at`,
        [id, key, policy.version, JSON.stringify(evidence)],
      );
      await client.query(
        `INSERT INTO send_locks (application_id, locked_until, locked_by)
         VALUES ($1, now() + interval '15 minutes', 'request-send')`,
        [id],
      );
      return sendRows.rows[0] as SendRow;
    });
    await auditEvent({
      actorId: opts.actorId ?? null,
      action: 'send_queued',
      entityType: 'send',
      entityId: created.id,
      details: { application_id: id, policy_version: policy.version, idempotency_key: key },
    });
    return { outcome: 'encolado', send: { ...mapSend(created), duplicado: false } };
  } catch (err) {
    // Carrera: otro proceso encoló o bloqueó entre el check y el INSERT.
    if (err instanceof Error && 'code' in err && (err as { code: string }).code === '23505') {
      const deNuevo = await query<{ id: string }>(
        `SELECT id FROM sends WHERE application_id = $1 AND status <> 'failed'`,
        [id],
      );
      if (deNuevo.length > 0) return { outcome: 'ya_existe', sendId: deNuevo[0].id };
      return { outcome: 'conflicto' };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Rutas.
// ---------------------------------------------------------------------------

export async function registerSendRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/applications/:id/presend-checks — ejecuta los 9 checks.
  app.post('/api/applications/:id/presend-checks', mutating, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) {
      return reply.code(400).send({ error: 'candidatura_invalida' });
    }
    const application = await loadApplication(id);
    if (!application) {
      return reply.code(404).send({ error: 'candidatura_no_encontrada' });
    }
    const { checks } = await runPresendChecks(application);
    return reply.send({ application_id: id, checks });
  });

  // POST /api/applications/:id/request-send — decide y, si procede, encola.
  app.post('/api/applications/:id/request-send', mutating, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) {
      return reply.code(400).send({ error: 'candidatura_invalida' });
    }
    const rawKey = req.headers['x-idempotency-key'];
    const idempotencyKey = Array.isArray(rawKey) ? rawKey[0] : rawKey;
    const res = await solicitarEnvio(id, {
      actorId: req.authSession?.userId ?? null,
      idempotencyKey,
    });
    switch (res.outcome) {
      case 'no_encontrada':
        return reply.code(404).send({ error: 'candidatura_no_encontrada' });
      case 'repetido':
        return reply.send(res.send);
      case 'ya_existe':
        return reply.code(409).send({ error: 'envio_ya_existe', send_id: res.sendId });
      case 'conflicto':
        return reply.code(409).send({ error: 'envio_ya_existe' });
      case 'bloqueado':
        return reply.send({
          application_id: id,
          decision: res.decision,
          motivos: res.motivos,
          checks: res.checks,
        });
      case 'encolado':
        return reply.code(201).send(res.send);
    }
  });
}
