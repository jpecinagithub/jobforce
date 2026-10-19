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
 * TODO(convergencia Worker 1): la lógica de decisión (`decidirEnvio`) vive
 * aquí de forma local porque el paquete @jobforce/autonomy del motor aún no
 * existe. Cuando esté listo, esta ruta debe delegar en él (o compartir el
 * módulo) para que la API y el motor decidan con los mismos criterios.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { DecisionEnvio, PoliticaAutonomia } from '@jobforce/domain';
import { query, withTransaction } from '@jobforce/database';
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
  offer_url: string | null;
  offer_company: string | null;
  score: string | null;
  mandatory_verdict: string | null;
}

async function loadApplication(id: string): Promise<ApplicationRow | null> {
  const rows = await query<ApplicationRow>(
    `SELECT a.id, a.campaign_id, a.offer_id, a.status, a.portal,
            o.url AS offer_url, o.company AS offer_company,
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
 */
export async function runPresendChecks(app: ApplicationRow): Promise<CheckResultado[]> {
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

  // 3) La candidatura está aprobada por Jon.
  checks.push({
    check: 'oferta_aprobada',
    ok: app.status === 'approved',
    detalle: `estado de la candidatura: ${app.status}`,
  });

  // 4) La oferta sigue vigente (sonda inyectable; sin sonda → fallo explícito).
  if (testDeps.offerProbe) {
    try {
      const probe = await testDeps.offerProbe({
        applicationId: app.id,
        offerUrl: app.offer_url,
        portal: app.portal,
      });
      checks.push({ check: 'oferta_vigente', ok: probe.ok, detalle: probe.detalle });
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

  // 5) No hay otro envío no fallido para esta candidatura.
  const duplicados = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM sends
      WHERE application_id = $1 AND status <> 'failed'`,
    [app.id],
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
  if (reglas) {
    const hoy = await countSendsSince('1 day');
    checks.push({
      check: 'cuota_diaria',
      ok: hoy < reglas.maxEnviosPorDia,
      detalle: `${hoy}/${reglas.maxEnviosPorDia} envíos en las últimas 24 h`,
    });
    const semana = await countSendsSince('7 days');
    checks.push({
      check: 'cuota_semanal',
      ok: semana < reglas.maxEnviosPorSemana,
      detalle: `${semana}/${reglas.maxEnviosPorSemana} envíos en los últimos 7 días`,
    });
    const gasto = await gastoMesUsd();
    checks.push({
      check: 'presupuesto_mensual',
      ok: gasto < reglas.presupuestoMensualUsd,
      detalle: `${gasto.toFixed(2)}/${reglas.presupuestoMensualUsd} $ gastados este mes`,
    });
  } else {
    for (const check of ['cuota_diaria', 'cuota_semanal', 'presupuesto_mensual']) {
      checks.push({ check, ok: false, detalle: 'sin política efectiva para evaluar la cuota' });
    }
  }

  return checks;
}

// ---------------------------------------------------------------------------
// Decisión de envío (lógica local; ver TODO del encabezado).
// ---------------------------------------------------------------------------

export interface DecisionResultado {
  decision: DecisionEnvio;
  motivos: string[];
  checks: CheckResultado[];
}

/**
 * Evalúa la política sobre una candidatura y sus checks.
 * Criterios (mismos del contrato de tipos):
 *  - cualquier check fallido → `bloqueado`;
 *  - portal no permitido o empresa excluida → `bloqueado`;
 *  - encaje desconocido → según `tratamientoDesconocidos`;
 *  - encaje < umbralEncajeRevision → `bloqueado`;
 *  - encaje < umbralEncajeAutomatico → `requiere_revision`;
 *  - modo `investigar` → `requiere_revision` (nunca envía solo);
 *  - modo `preparar_para_revision` → `permitido` solo con aprobación de Jon
 *    (estado `approved`, ya exigido por el check `oferta_aprobada`);
 *  - modo `ejecutar_automatico` → `permitido` solo con autorización escrita
 *    vigente; sin ella, `requiere_revision`.
 */
export function decidirEnvio(
  app: ApplicationRow,
  politica: PoliticaAutonomia,
  checks: CheckResultado[],
): { decision: DecisionEnvio; motivos: string[] } {
  const motivos: string[] = [];

  const fallidos = checks.filter((c) => !c.ok);
  if (fallidos.length > 0) {
    return {
      decision: 'bloqueado',
      motivos: fallidos.map((c) => `check_${c.check}_fallido: ${c.detalle}`),
    };
  }

  const reglas = politica.reglas;

  const portal = (app.portal ?? '').toLowerCase();
  if (!reglas.portalesPermitidos.map((p) => p.toLowerCase()).includes(portal)) {
    return {
      decision: 'bloqueado',
      motivos: [`portal_no_permitido: ${app.portal ?? '(sin portal)'}`],
    };
  }

  const empresa = (app.offer_company ?? '').toLowerCase();
  if (empresa && reglas.empresasExcluidas.map((e) => e.toLowerCase()).includes(empresa)) {
    return { decision: 'bloqueado', motivos: [`empresa_excluida: ${app.offer_company}`] };
  }

  if (app.mandatory_verdict === 'incumple') {
    return { decision: 'bloqueado', motivos: ['requisitos_obligatorios_no_cumplidos'] };
  }

  const score = app.score === null ? null : Number(app.score);
  if (score === null || Number.isNaN(score)) {
    if (reglas.tratamientoDesconocidos === 'descartar') {
      return { decision: 'bloqueado', motivos: ['encaje_desconocido_descartado_por_politica'] };
    }
    return { decision: 'requiere_revision', motivos: ['encaje_desconocido'] };
  }

  if (score < reglas.umbralEncajeRevision) {
    return {
      decision: 'bloqueado',
      motivos: [`encaje_insuficiente: ${score} < ${reglas.umbralEncajeRevision}`],
    };
  }
  if (score < reglas.umbralEncajeAutomatico) {
    return {
      decision: 'requiere_revision',
      motivos: [`encaje_bajo_umbral_automatico: ${score} < ${reglas.umbralEncajeAutomatico}`],
    };
  }

  switch (politica.modoActivo) {
    case 'investigar':
      motivos.push('modo_investigar_no_envia_solo');
      return { decision: 'requiere_revision', motivos };
    case 'preparar_para_revision':
      // El check `oferta_aprobada` ya garantizó el estado `approved` (= Jon
      // aprobó explícitamente); con encaje suficiente, se permite encolar.
      motivos.push('aprobacion_explicita_de_jon');
      return { decision: 'permitido', motivos };
    case 'ejecutar_automatico':
      if (politica.autorizacionEscrita === null) {
        return { decision: 'requiere_revision', motivos: ['sin_autorizacion_escrita'] };
      }
      motivos.push('autorizacion_escrita_vigente');
      return { decision: 'permitido', motivos };
  }
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
    const checks = await runPresendChecks(application);
    return reply.send({ application_id: id, checks });
  });

  // POST /api/applications/:id/request-send — decide y, si procede, encola.
  app.post('/api/applications/:id/request-send', mutating, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) {
      return reply.code(400).send({ error: 'candidatura_invalida' });
    }
    const application = await loadApplication(id);
    if (!application) {
      return reply.code(404).send({ error: 'candidatura_no_encontrada' });
    }

    const rawKey = req.headers['x-idempotency-key'];
    const idempotencyKey = Array.isArray(rawKey) ? rawKey[0] : rawKey;

    // 1) Idempotencia estricta: la misma clave devuelve el mismo envío.
    if (idempotencyKey) {
      const previas = await query<SendRow>(
        `SELECT id, application_id, idempotency_key, policy_version, status,
                evidence, created_at
           FROM sends WHERE idempotency_key = $1`,
        [idempotencyKey],
      );
      if (previas.length > 0) {
        return reply.send({ ...mapSend(previas[0]), duplicado: true });
      }
    }

    // 2) Sin duplicados por candidatura (aunque la clave sea distinta).
    const existentes = await query<{ id: string }>(
      `SELECT id FROM sends WHERE application_id = $1 AND status <> 'failed'`,
      [id],
    );
    if (existentes.length > 0) {
      return reply
        .code(409)
        .send({ error: 'envio_ya_existe', send_id: existentes[0].id });
    }

    // 3) Checks + decisión de política.
    const policy = await getEffectivePolicy();
    const checks = await runPresendChecks(application);
    if (!policy) {
      return reply.send({
        application_id: id,
        decision: 'bloqueado' satisfies DecisionEnvio,
        motivos: ['sin_politica_vigente'],
        checks,
      });
    }
    const { decision, motivos } = decidirEnvio(application, policy.policy, checks);
    if (decision !== 'permitido') {
      return reply.send({ application_id: id, decision, motivos, checks });
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
        actorId: req.authSession?.userId ?? null,
        action: 'send_queued',
        entityType: 'send',
        entityId: created.id,
        details: { application_id: id, policy_version: policy.version, idempotency_key: key },
      });
      return reply.code(201).send({ ...mapSend(created), duplicado: false });
    } catch (err) {
      // Carrera: otro proceso encoló o bloqueó entre el check y el INSERT.
      if (err instanceof Error && 'code' in err && (err as { code: string }).code === '23505') {
        return reply.code(409).send({ error: 'envio_ya_existe' });
      }
      throw err;
    }
  });
}
