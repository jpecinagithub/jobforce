/**
 * @jobforce/backend — Ejecutor de envíos.
 *
 * Procesa las filas de `sends` en estado `queued`:
 *
 *   1. Reclama el envío atómicamente (`queued` → `sending`; si ya no está en
 *      `queued`, otro proceso lo tomó: no se reprocesa — idempotencia).
 *   2. Carga la candidatura, la oferta y los documentos versionados; verifica
 *      que los PDF existen en disco y que su SHA-256 coincide con la
 *      biblioteca `documents` (integridad de lo enviado).
 *   3. Puerta de política (LÍMITE DURO): autorización escrita vigente + sin
 *      parada global + una de dos vías: modo `ejecutar_automatico`, o modo
 *      `preparar_para_revision` con la candidatura en `approved` (la
 *      aprobación expresa de Jon por candidatura, Fase 7). Si no, no se
 *      abre el navegador: `failed` + intervención `fuera_de_politica`.
 *   4. Re-ejecuta `runPresendChecks` (con sonda real de vigencia vía el
 *      driver) y `decidirEnvio` justo antes del envío. Si la decisión no es
 *      `permitido` → `failed` + intervención `fuera_de_politica`.
 *   5. Ejecuta el flujo del driver (verificar → rellenar → subir →
 *      re-verificar → UN clic en Submit → confirmar).
 *   6. Re-verifica la parada global inmediatamente antes del clic.
 *   7. Registra: `sent` con evidencias, `uncertain` (conciliación obligatoria
 *      antes de cualquier reintento, jamás reintento a ciegas) o `failed`.
 *
 * Ante cualquier anomalía: NO se fuerza ni se reintenta a ciegas. Se crea
 * una intervención con contexto y el envío queda en `uncertain` (si se pulsó
 * Submit) o `failed` (si no). Una excepción no detiene las demás: no hay
 * locks globales, solo `send_locks` por candidatura con vencimiento.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { query, withTransaction } from '@jobforce/database';
import { auditEvent } from '../audit.js';
import { getEffectivePolicy, isAuthorized } from '../routes/autonomy.js';
import {
  decidirEnvio,
  loadApplication,
  runPresendChecks,
  type ApplicationRow,
  type OfferProbeResult,
} from '../routes/sends.js';
import { marcarEnvioIncierto } from '../reconcile.js';
import { crearDriver } from './driver.js';
import { presupuestoDisponible, registrarTiempoNavegador } from '@jobforce/costs';
import {
  AnomaliaEnvio,
  type BrowserDriver,
  type CampoFormulario,
  type DriverJob,
  type ResultadoProceso,
} from './types.js';

// ---------------------------------------------------------------------------
// Tipos y dependencias inyectables.
// ---------------------------------------------------------------------------

export interface ExecutorDeps {
  /** Factoría del driver. Por defecto, `crearDriver` (solo personio real). */
  driverFactory?: (job: DriverJob) => BrowserDriver;
  /**
   * Base para resolver `documents.file_path` (relativo al workspace) y para
   * guardar las evidencias. Por defecto `~/workspace`.
   */
  workspaceBase?: string;
  /** actorId para la auditoría (null = sistema). */
  actorId?: string | null;
}

type InterventionKind =
  | 'datos_desconocidos'
  | 'pregunta_ambigua'
  | 'captcha_mfa'
  | 'fuera_de_politica'
  | 'envio_incierto'
  | 'error_tecnico';

interface SendRow {
  id: string;
  application_id: string;
  idempotency_key: string;
  policy_version: number;
  status: string;
}

interface DocumentRow {
  kind: string;
  format: string;
  version: number;
  file_path: string;
  bytes: number;
  sha256: string;
}

interface FormConfig {
  applyUrl?: string;
  campos: CampoFormulario[];
  docCvSelector?: string;
  docCartaSelector?: string;
  submitButtonName?: string;
}

const ANOMALIA_A_INTERVENCION: Record<AnomaliaEnvio['kind'], InterventionKind> = {
  captcha_mfa: 'captcha_mfa',
  oferta_cerrada: 'fuera_de_politica',
  formulario_cambiado: 'pregunta_ambigua',
  datos_ausentes: 'datos_desconocidos',
  portal_no_soportado: 'fuera_de_politica',
  error_ambiguo: 'error_tecnico',
};

// ---------------------------------------------------------------------------
// Carga y verificación del trabajo.
// ---------------------------------------------------------------------------

function parseFormConfig(snap: Record<string, unknown> | null | undefined): FormConfig | null {
  if (!snap || typeof snap !== 'object') return null;
  const fc = (snap as { formConfig?: unknown }).formConfig;
  if (!fc || typeof fc !== 'object') return null;
  const campos = (fc as { campos?: unknown }).campos;
  if (!Array.isArray(campos) || campos.length === 0) return null;
  for (const c of campos) {
    if (!c || typeof c !== 'object') return null;
    const cc = c as Record<string, unknown>;
    if (
      typeof cc.selector !== 'string' ||
      typeof cc.valor !== 'string' ||
      typeof cc.etiqueta !== 'string' ||
      (cc.tipo !== 'fill' && cc.tipo !== 'select')
    ) {
      return null;
    }
  }
  return fc as FormConfig;
}

function sha256De(ruta: string): string {
  return createHash('sha256').update(readFileSync(ruta)).digest('hex');
}

interface TrabajoCargado {
  send: SendRow;
  app: ApplicationRow;
  job: DriverJob;
}

async function cargarTrabajo(send: SendRow, deps: ExecutorDeps): Promise<TrabajoCargado> {
  const base = deps.workspaceBase ?? join(homedir(), 'workspace');

  const app = await loadApplication(send.application_id);
  if (!app) {
    throw new AnomaliaEnvio('datos_ausentes', `candidatura ${send.application_id} no encontrada`);
  }

  const docs = await query<DocumentRow>(
    `SELECT kind, format, version, file_path, bytes, sha256
       FROM documents
      WHERE application_id = $1 AND format = 'pdf'
        AND kind IN ('cv', 'cover_letter')
      ORDER BY kind, version DESC`,
    [send.application_id],
  );
  const porKind = new Map<string, DocumentRow>();
  for (const d of docs) {
    if (!porKind.has(d.kind)) porKind.set(d.kind, d);
  }
  const cv = porKind.get('cv');
  const carta = porKind.get('cover_letter');
  if (!cv || !carta) {
    throw new AnomaliaEnvio('datos_ausentes', 'faltan documentos PDF versionados (cv y/o cover_letter)', {
      contexto: { tieneCv: !!cv, tieneCarta: !!carta },
    });
  }
  const cvPath = join(base, cv.file_path);
  const cartaPath = join(base, carta.file_path);
  for (const [ruta, fila, etiqueta] of [
    [cvPath, cv, 'cv'],
    [cartaPath, carta, 'carta'],
  ] as const) {
    if (!existsSync(ruta)) {
      throw new AnomaliaEnvio('datos_ausentes', `documento ${etiqueta} no existe en disco: ${ruta}`, {
        contexto: { documento: etiqueta, file_path: fila.file_path },
      });
    }
    const real = sha256De(ruta);
    if (real !== fila.sha256) {
      throw new AnomaliaEnvio(
        'datos_ausentes',
        `el SHA-256 de ${etiqueta} no coincide con la biblioteca versionada: no se envía un documento distinto del generado`,
        { contexto: { documento: etiqueta, file_path: fila.file_path } },
      );
    }
  }

  const formConfig = parseFormConfig(app.offer_snapshot);
  if (!formConfig) {
    throw new AnomaliaEnvio(
      'datos_ausentes',
      'la candidatura no tiene configuración de formulario (offer_snapshot.formConfig): no se puede rellenar con seguridad',
      { contexto: { applicationId: app.id } },
    );
  }
  const applyUrl = formConfig.applyUrl ?? app.offer_url;
  if (!applyUrl) {
    throw new AnomaliaEnvio('datos_ausentes', 'sin URL de solicitud (ni en formConfig ni en la oferta)', {
      contexto: { applicationId: app.id },
    });
  }

  const shotsDir = join(base, 'jobforce', 'sends', send.id, 'capturas');
  mkdirSync(shotsDir, { recursive: true });

  const job: DriverJob = {
    sendId: send.id,
    applicationId: app.id,
    portal: (app.portal ?? '').trim().toLowerCase(),
    applyUrl,
    campos: formConfig.campos,
    cvPath,
    cartaPath,
    docCvSelector: formConfig.docCvSelector ?? '#doc-input-cv',
    docCartaSelector: formConfig.docCartaSelector ?? '#doc-input-cover-letter',
    shotsDir,
    submitButtonName: formConfig.submitButtonName ?? 'submit application',
  };
  return { send, app, job };
}

// ---------------------------------------------------------------------------
// Intervenciones y registro de resultados.
// ---------------------------------------------------------------------------

async function crearIntervencion(
  kind: InterventionKind,
  applicationId: string | null,
  contexto: Record<string, unknown>,
): Promise<string> {
  const abiertas = await query<{ id: string }>(
    `SELECT id FROM interventions
      WHERE kind = $1
        AND application_id IS NOT DISTINCT FROM $2::uuid
        AND status = 'abierta'
      ORDER BY created_at DESC LIMIT 1`,
    [kind, applicationId],
  );
  if (abiertas.length > 0) return abiertas[0].id;
  const creadas = await query<{ id: string }>(
    `INSERT INTO interventions (kind, application_id, context)
     VALUES ($1, $2::uuid, $3::jsonb) RETURNING id`,
    [kind, applicationId, JSON.stringify(contexto)],
  );
  return creadas[0].id;
}

async function fallar(
  send: SendRow,
  applicationId: string,
  motivo: string,
  kind: InterventionKind,
  contexto: Record<string, unknown>,
  actorId: string | null,
): Promise<ResultadoProceso> {
  const en = new Date().toISOString();
  await query(
    `UPDATE sends
        SET status = 'failed',
            evidence = evidence || $2::jsonb,
            updated_at = now()
      WHERE id = $1`,
    [send.id, JSON.stringify({ fallo: { motivo, en } })],
  );
  await query(
    `UPDATE applications
        SET status = 'submission_failed', failure_reason = $2, updated_at = now()
      WHERE id = $1`,
    [applicationId, motivo.slice(0, 500)],
  );
  const interventionId = await crearIntervencion(kind, applicationId, {
    send_id: send.id,
    motivo,
    marcado_en: en,
    ...contexto,
  });
  await auditEvent({
    actorId,
    action: 'send_failed',
    entityType: 'send',
    entityId: send.id,
    details: { application_id: applicationId, motivo, intervention_kind: kind, interventionId },
  });
  return { procesado: true, estado: 'failed', sendId: send.id, detalle: motivo, interventionId };
}

async function registrarEnviado(
  send: SendRow,
  applicationId: string,
  confirmacion: { mensaje: string; urlTrasEnvio: string; referencia: string | null; capturas: string[] },
  actorId: string | null,
): Promise<ResultadoProceso> {
  const en = new Date().toISOString();
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE sends
          SET status = 'sent',
              evidence = evidence || $2::jsonb,
              updated_at = now()
        WHERE id = $1`,
      [
        send.id,
        JSON.stringify({
          confirmacion: {
            mensaje: confirmacion.mensaje.slice(0, 2000),
            url_tras_envio: confirmacion.urlTrasEnvio,
            referencia: confirmacion.referencia,
            capturas: confirmacion.capturas,
          },
          enviado_en: en,
        }),
      ],
    );
    await client.query(
      `UPDATE applications
          SET status = 'submitted', submitted_at = now(),
              submission_evidence = $2::jsonb, updated_at = now()
        WHERE id = $1`,
      [
        applicationId,
        JSON.stringify({
          mensaje: confirmacion.mensaje.slice(0, 2000),
          url_tras_envio: confirmacion.urlTrasEnvio,
          referencia: confirmacion.referencia,
          capturas: confirmacion.capturas,
          enviado_en: en,
        }),
      ],
    );
    await client.query(
      `INSERT INTO application_outcomes (application_id, selection_status)
       VALUES ($1, 'en_proceso')
       ON CONFLICT (application_id) DO UPDATE
          SET selection_status = 'en_proceso', updated_at = now()
        WHERE application_outcomes.selection_status = 'pendiente'`,
      [applicationId],
    );
  });
  await auditEvent({
    actorId,
    action: 'send_executed',
    entityType: 'send',
    entityId: send.id,
    details: {
      application_id: applicationId,
      referencia: confirmacion.referencia,
      url_tras_envio: confirmacion.urlTrasEnvio,
    },
  });
  return {
    procesado: true,
    estado: 'sent',
    sendId: send.id,
    detalle: `enviado y confirmado: ${confirmacion.mensaje.slice(0, 120)}`,
  };
}

// ---------------------------------------------------------------------------
// Orquestación principal.
// ---------------------------------------------------------------------------

/**
 * Procesa un envío en estado `queued`. Idempotente: si ya no está en
 * `queued` (otro proceso lo tomó o ya se procesó), no hace nada.
 */
export async function procesarEnvio(sendId: string, deps: ExecutorDeps = {}): Promise<ResultadoProceso> {
  const actorId = deps.actorId ?? null;

  // 1) Reclamo atómico: solo un proceso puede pasar de queued → sending.
  const reclamados = await query<SendRow>(
    `UPDATE sends
        SET status = 'sending', updated_at = now()
      WHERE id = $1 AND status = 'queued'
      RETURNING id, application_id, idempotency_key, policy_version, status`,
    [sendId],
  );
  if (reclamados.length === 0) {
    return { procesado: false, motivo: 'no_en_queued', sendId };
  }
  const send = reclamados[0];

  const liberar = async () => {
    await query(`DELETE FROM send_locks WHERE application_id = $1`, [send.application_id]).catch(() => {});
  };

  let driver: BrowserDriver | null = null;
  let navegadorIniciado = false;
  let tNavegador0 = 0;
  try {
    // 2) Toma de propiedad: se elimina el bloqueo que dejó request-send (el
    //    reclamo atómico queued→sending ya es el mutex real). El ejecutor
    //    crea su propio bloqueo más abajo, antes de la fase del navegador.
    await query(`DELETE FROM send_locks WHERE application_id = $1`, [send.application_id]);

    // 3) Carga + verificación de documentos (puede lanzar AnomaliaEnvio).
    let trabajo;
    try {
      trabajo = await cargarTrabajo(send, deps);
    } catch (e) {
      if (e instanceof AnomaliaEnvio) {
        return await fallar(send, send.application_id, e.message, ANOMALIA_A_INTERVENCION[e.kind], e.contexto, actorId);
      }
      throw e;
    }
    const { app, job } = trabajo;

    // 4) Puerta de política — LÍMITE DURO. Sin esto no se abre el navegador.
    //    Vías legítimas: (a) `ejecutar_automatico` con autorización escrita;
    //    (b) `preparar_para_revision` con la candidatura en `approved`: en
    //    este modo la aprobación expresa de Jon por candidatura ES la
    //    autorización operativa (Fase 7). Todo lo demás falla cerrado.
    const policyRow = await getEffectivePolicy();
    const polit = policyRow?.policy ?? null;
    const viaAutomatica = polit?.modoActivo === 'ejecutar_automatico';
    const viaRevisionAprobada =
      polit?.modoActivo === 'preparar_para_revision' && app.status === 'approved';
    if (
      !policyRow ||
      !polit ||
      !(viaAutomatica || viaRevisionAprobada) ||
      !isAuthorized(policyRow) ||
      policyRow.global_stop ||
      polit.paradaGlobal
    ) {
      const razones: string[] = [];
      if (!policyRow || !polit) razones.push('sin política efectiva');
      else {
        if (!(viaAutomatica || viaRevisionAprobada)) {
          razones.push(
            polit.modoActivo === 'preparar_para_revision'
              ? `modo=preparar_para_revision sin aprobación expresa de Jon (estado=${app.status})`
              : `modo=${polit.modoActivo}`,
          );
        }
        if (!isAuthorized(policyRow)) razones.push('sin autorización escrita vigente');
        if (policyRow.global_stop || polit.paradaGlobal) razones.push('parada global activa');
      }
      return await fallar(
        send,
        app.id,
        `la política no autoriza el envío (${razones.join(', ')})`,
        'fuera_de_politica',
        { modo: polit?.modoActivo ?? null },
        actorId,
      );
    }

    // 5) Driver (puede lanzar portal_no_soportado).
    try {
      const factory = deps.driverFactory ?? ((j: DriverJob) => crearDriver(j.portal));
      driver = factory(job);
    } catch (e) {
      if (e instanceof AnomaliaEnvio) {
        return await fallar(send, app.id, e.message, ANOMALIA_A_INTERVENCION[e.kind], e.contexto, actorId);
      }
      throw e;
    }

    // 6) Sonda de vigencia real vía el driver + checks + decisión.
    //    La sonda propaga AnomaliaEnvio (p. ej. CAPTCHA en la verificación);
    //    otros errores se convierten en check fallido explícito.
    const sondaVigencia = async (): Promise<OfferProbeResult> => {
      try {
        const r = await driver!.verificarApertura(job);
        return { ok: r.abierta, detalle: r.detalle };
      } catch (e) {
        if (e instanceof AnomaliaEnvio) throw e;
        return { ok: false, detalle: `la sonda falló: ${e instanceof Error ? e.message : 'error desconocido'}` };
      }
    };
    try {
      const { checks, metricas } = await runPresendChecks(app, sondaVigencia, { excluirSendId: send.id });
      const { decision, motivos } = decidirEnvio(app, polit, checks, metricas);
      if (decision !== 'permitido') {
        return await fallar(
          send,
          app.id,
          `checks pre-envío no permiten el envío: ${motivos.join(' | ').slice(0, 400)}`,
          'fuera_de_politica',
          { decision, motivos, checks: checks.map((c) => ({ check: c.check, ok: c.ok, detalle: c.detalle })) },
          actorId,
        );
      }
    } catch (e) {
      if (e instanceof AnomaliaEnvio) {
        return await manejarAnomalia(e, send, app.id, actorId);
      }
      throw e;
    }

    // 6b) Presupuesto mensual global (Fase 5): sin presupuesto no se abre el
    //     navegador. El gasto real lo mide el libro de costes.
    const disp = await presupuestoDisponible();
    if (!disp.ok) {
      return await fallar(
        send,
        app.id,
        `presupuesto agotado: no se abre el navegador (${disp.motivo})`,
        'fuera_de_politica',
        { presupuesto: disp.codigo },
        actorId,
      );
    }

    // 6c) Bloqueo con vencimiento (15 min) por candidatura para la fase del
    //     navegador. Un solo envío en vuelo por candidatura.
    await query(
      `INSERT INTO send_locks (application_id, locked_until, locked_by)
       VALUES ($1, now() + interval '15 minutes', 'sender-executor')
       ON CONFLICT (application_id) DO UPDATE
          SET locked_until = now() + interval '15 minutes', locked_by = 'sender-executor'`,
      [send.application_id],
    );

    // 7) Rellenar + subir + re-verificar (puede lanzar AnomaliaEnvio).
    //    Se mide el tiempo de navegador para el libro de costes (Fase 5).
    try {
      navegadorIniciado = true;
      tNavegador0 = Date.now();
      await driver.preparar(job);
    } catch (e) {
      if (e instanceof AnomaliaEnvio) {
        return await manejarAnomalia(e, send, app.id, actorId);
      }
      throw e;
    }

    // 8) Parada global inmediata: re-verificar justo antes del clic.
    const policyPre = await getEffectivePolicy();
    if (!policyPre || policyPre.global_stop || policyPre.policy.paradaGlobal) {
      return await fallar(
        send,
        app.id,
        'parada global activada justo antes del envío: no se pulsa Submit',
        'fuera_de_politica',
        {},
        actorId,
      );
    }

    // 9) Un clic en Submit + captura de confirmación.
    try {
      const res = await driver.enviarYConfirmar(job);
      if (res.confirmado && res.confirmacion) {
        return await registrarEnviado(send, app.id, res.confirmacion, actorId);
      }
      // Sin confirmación: INCIERTO. Conciliación obligatoria; sin reintento.
      const { interventionId } = await marcarEnvioIncierto({
        sendId: send.id,
        applicationId: app.id,
        causa: `sin confirmación tras pulsar Submit (${JSON.stringify(res.evidencia).slice(0, 300)})`,
        actorId,
      });
      return {
        procesado: true,
        estado: 'uncertain',
        sendId: send.id,
        detalle: 'sin confirmación tras Submit: marcado incierto para conciliación',
        interventionId,
      };
    } catch (e) {
      if (e instanceof AnomaliaEnvio) {
        return await manejarAnomalia(e, send, app.id, actorId);
      }
      throw e;
    }
  } catch (e) {
    // Error inesperado: failed + intervención técnica. Nunca reintento ciego.
    const msg = e instanceof Error ? e.message : 'error desconocido';
    return await fallar(
      send,
      send.application_id,
      `error inesperado del ejecutor: ${msg}`.slice(0, 500),
      'error_tecnico',
      { error: msg.slice(0, 1000) },
      actorId,
    );
  } finally {
    if (driver) {
      await driver.cerrar().catch(() => {});
    }
    // Libro de costes (Fase 5): tiempo de navegador por candidatura, con
    // idempotencia por envío. No debe tumbar el resultado del envío si falla.
    if (navegadorIniciado) {
      await registrarTiempoNavegador({
        applicationId: send.application_id,
        sendId: send.id,
        duracionMs: Date.now() - tNavegador0,
      }).catch(() => {});
    }
    await liberar();
  }
}

/**
 * Convierte una anomalía del driver en intervención. Si ocurrió tras pulsar
 * Submit → `uncertain` + conciliación (contrato de reconcile.ts). Si no,
 * nada se envió → `failed` + intervención con contexto.
 */
async function manejarAnomalia(
  e: AnomaliaEnvio,
  send: SendRow,
  applicationId: string,
  actorId: string | null,
): Promise<ResultadoProceso> {
  const en = new Date().toISOString();
  if (e.trasClick) {
    const { interventionId } = await marcarEnvioIncierto({
      sendId: send.id,
      applicationId,
      causa: `${e.kind}: ${e.message}`,
      actorId,
    });
    // Se enriquece el contexto de la intervención con la anomalía concreta.
    await query(`UPDATE interventions SET context = context || $2::jsonb WHERE id = $1`, [
      interventionId,
      JSON.stringify({ anomalia: e.kind, detalle_anomalia: e.contexto, marcado_en: en }),
    ]);
    return {
      procesado: true,
      estado: 'uncertain',
      sendId: send.id,
      detalle: `anomalía tras Submit (${e.kind}): marcado incierto para conciliación`,
      interventionId,
    };
  }
  return await fallar(
    send,
    applicationId,
    `anomalía antes del envío (${e.kind}): ${e.message}`,
    ANOMALIA_A_INTERVENCION[e.kind],
    { ...e.contexto, marcado_en: en },
    actorId,
  );
}

/**
 * Reclama el siguiente envío en `queued` (el más antiguo) y lo procesa.
 * Devuelve null si no hay nada en cola.
 */
export async function reclamarSiguiente(deps: ExecutorDeps = {}): Promise<ResultadoProceso | null> {
  const filas = await query<{ id: string }>(
    `SELECT id FROM sends WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`,
  );
  if (filas.length === 0) return null;
  return procesarEnvio(filas[0].id, deps);
}
