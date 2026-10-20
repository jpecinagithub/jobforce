/**
 * Tests de autonomía (Fase 4): migración 004, política, parada global,
 * intervenciones, checks pre-envío, request-send idempotente y conciliación.
 *
 * Requieren `DATABASE_URL` en el entorno. La sonda de vigencia de ofertas se
 * inyecta con `setSendTestDeps` (sin sonda, el check falla explícitamente:
 * nada se simula como OK).
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { query } from '@jobforce/database';
import {
  authed,
  buildTestApp,
  closeTestApp,
  resetDb,
  setupAndLogin,
  type AuthContext,
} from './helpers.js';
import { resetSendTestDeps, setSendTestDeps } from '../src/routes/sends.js';
import { marcarEnvioIncierto } from '../src/reconcile.js';

interface CandidaturaOpts {
  portal?: string;
  company?: string;
  /** null = sin evaluación (encaje desconocido). */
  score?: number | null;
  verdict?: string;
  appStatus?: string;
}

/** Crea campaña + oferta + evaluación + candidatura directamente en BD. */
async function crearCandidatura(opts: CandidaturaOpts = {}): Promise<string> {
  const portal = opts.portal ?? 'greenhouse';
  const company = opts.company ?? 'Acme Corp';
  const score = opts.score === undefined ? 80 : opts.score;
  const verdict = opts.verdict ?? 'cumple';
  const appStatus = opts.appStatus ?? 'approved';
  const suffix = randomUUID().slice(0, 8);

  const c = await query<{ id: string }>(
    `INSERT INTO campaigns (name, criteria) VALUES ('camp-test', '{}'::jsonb) RETURNING id`,
  );
  const o = await query<{ id: string }>(
    `INSERT INTO offers (campaign_id, canonical_url, url, title, company)
     VALUES ($1, $2, $3, 'Finance Manager', $4) RETURNING id`,
    [c[0].id, `https://empleo.example/oferta/${suffix}`, `https://empleo.example/oferta/${suffix}`, company],
  );
  if (score !== null) {
    await query(
      `INSERT INTO evaluations (offer_id, campaign_id, mandatory_verdict, mandatory_details, score, breakdown)
       VALUES ($1, $2, $3, '[]'::jsonb, $4, '[]'::jsonb)`,
      [o[0].id, c[0].id, verdict, score],
    );
  }
  const a = await query<{ id: string }>(
    `INSERT INTO applications (campaign_id, offer_id, status, portal)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [c[0].id, o[0].id, appStatus, portal],
  );
  return a[0].id;
}

/** Autoriza la política actual en modo ejecutar_automatico (para tests). */
async function autorizarEjecucion(app: FastifyInstance, auth: AuthContext): Promise<void> {
  const put = await app.inject({
    method: 'PUT',
    url: '/api/autonomy/policy',
    headers: authed(auth),
    payload: { modoActivo: 'ejecutar_automatico' },
  });
  assert.equal(put.statusCode, 201, `PUT policy: ${put.statusCode} ${put.body}`);
  const authorize = await app.inject({
    method: 'POST',
    url: '/api/autonomy/policy/authorize',
    headers: authed(auth),
    payload: {
      autorizadoPor: 'Jon Peciña Iturbe',
      declaracion: 'Autorizo los envíos automáticos según la política v2 (test).',
    },
  });
  assert.equal(authorize.statusCode, 200, `authorize: ${authorize.statusCode} ${authorize.body}`);
}

describe('autonomía (Fase 4)', () => {
  let app: FastifyInstance;
  let auth: AuthContext;

  before(async () => {
    app = await buildTestApp();
  });

  after(async () => {
    await closeTestApp(app);
  });

  beforeEach(async () => {
    await resetDb();
    resetSendTestDeps();
    auth = await setupAndLogin(app);
  });

  it('la migración 004 aplica y siembra la política v1 como borrador', async () => {
    const tablas = await query<{ t: string }>(
      `SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public'
         AND tablename IN ('autonomy_policies','sends','send_locks','outbox',
                           'interventions','portal_accounts','application_outcomes')`,
    );
    assert.equal(tablas.length, 7, `tablas creadas: ${tablas.map((t) => t.t).join(',')}`);

    const rows = await query<{
      version: number;
      policy: {
        modoActivo: string;
        autorizacionEscrita: null;
        reglas: Record<string, unknown>;
      };
      authorized_by: string | null;
      global_stop: boolean;
    }>(`SELECT version, policy, authorized_by, global_stop FROM autonomy_policies`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].version, 1);
    assert.equal(rows[0].authorized_by, null);
    assert.equal(rows[0].global_stop, false);
    assert.equal(rows[0].policy.modoActivo, 'preparar_para_revision');
    assert.equal(rows[0].policy.autorizacionEscrita, null);
    const r = rows[0].policy.reglas;
    assert.deepEqual(r.portalesPermitidos, ['greenhouse', 'lever', 'personio']);
    assert.equal(r.umbralEncajeRevision, 70);
    assert.equal(r.umbralEncajeAutomatico, 75);
    assert.equal(r.maxEnviosPorDia, 5);
    assert.equal(r.maxEnviosPorSemana, 20);
    assert.equal(r.presupuestoMensualUsd, 50);
    assert.equal(r.presupuestoExaMensualUsd, 3);
    assert.equal(r.tratamientoDesconocidos, 'revision');
    assert.equal(r.crearCuentasPortales, false);
  });

  it('las rutas exigen sesión', async () => {
    for (const url of ['/api/autonomy/status', '/api/autonomy/policy', '/api/interventions']) {
      const res = await app.inject({ method: 'GET', url });
      assert.equal(res.statusCode, 401, url);
    }
    const res = await app.inject({ method: 'POST', url: '/api/autonomy/stop' });
    assert.equal(res.statusCode, 401);
  });

  it('status refleja la política semilla', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/autonomy/status', headers: authed(auth, false) });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      modo: 'preparar_para_revision',
      paradaGlobal: false,
      autorizada: false,
      versionPolitica: 1,
      enviosHoy: 0,
      gastoMesUsd: 0,
    });
  });

  it('autorizar → estado: borrador, activa y segunda autorización en 409', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/autonomy/policy',
      headers: authed(auth),
      payload: { modoActivo: 'ejecutar_automatico', notes: 'nota de test' },
    });
    assert.equal(put.statusCode, 201);
    assert.equal(put.json<{ version: number }>().version, 2);

    const policy = await app.inject({
      method: 'GET',
      url: '/api/autonomy/policy',
      headers: authed(auth, false),
    });
    const body = policy.json<{ borrador: { version: number } | null; activa: unknown }>();
    assert.equal(body.borrador?.version, 2);
    assert.equal(body.activa, null);

    const authorize = await app.inject({
      method: 'POST',
      url: '/api/autonomy/policy/authorize',
      headers: authed(auth),
      payload: { autorizadoPor: 'Jon Peciña Iturbe', declaracion: 'Autorizo (test).' },
    });
    assert.equal(authorize.statusCode, 200);

    const again = await app.inject({
      method: 'POST',
      url: '/api/autonomy/policy/authorize',
      headers: authed(auth),
      payload: { autorizadoPor: 'Jon Peciña Iturbe', declaracion: 'Otra vez.' },
    });
    assert.equal(again.statusCode, 409);

    const status = await app.inject({
      method: 'GET',
      url: '/api/autonomy/status',
      headers: authed(auth, false),
    });
    assert.deepEqual(status.json(), {
      modo: 'ejecutar_automatico',
      paradaGlobal: false,
      autorizada: true,
      versionPolitica: 2,
      enviosHoy: 0,
      gastoMesUsd: 0,
    });
  });

  it('presend-checks: sin sonda la vigencia falla explícitamente (nada simulado)', async () => {
    const appId = await crearCandidatura();
    const res = await app.inject({
      method: 'POST',
      url: `/api/applications/${appId}/presend-checks`,
      headers: authed(auth),
    });
    assert.equal(res.statusCode, 200);
    const checks = res.json<{ checks: Array<{ check: string; ok: boolean; detalle: string }> }>().checks;
    assert.equal(checks.length, 9);
    const porNombre = Object.fromEntries(checks.map((c) => [c.check, c]));
    assert.equal(porNombre['oferta_vigente'].ok, false);
    assert.match(porNombre['oferta_vigente'].detalle, /sin_probe_de_vigencia/);
    assert.equal(porNombre['oferta_aprobada'].ok, true);
    assert.equal(porNombre['politica_vigente'].ok, true);
    assert.equal(porNombre['parada_global_off'].ok, true);
  });

  it('stop bloquea request-send y resume lo desbloquea (con autorización)', async () => {
    await autorizarEjecucion(app, auth);
    setSendTestDeps({
      offerProbe: async () => ({ ok: true, detalle: 'sonda de test: oferta abierta' }),
    });

    const appA = await crearCandidatura({ score: 80 });
    const ok = await app.inject({
      method: 'POST',
      url: `/api/applications/${appA}/request-send`,
      headers: { ...authed(auth), 'x-idempotency-key': 'clave-a' },
    });
    assert.equal(ok.statusCode, 201, ok.body);
    const sendA = ok.json<{ decision: string; id: string; idempotency_key: string }>();
    assert.equal(sendA.decision, 'permitido');
    assert.equal(sendA.idempotency_key, 'clave-a');

    const stop = await app.inject({ method: 'POST', url: '/api/autonomy/stop', headers: authed(auth) });
    assert.equal(stop.statusCode, 200);
    assert.equal(stop.json<{ paradaGlobal: boolean }>().paradaGlobal, true);

    const outbox = await query<{ event: { type: string } }>(
      `SELECT event FROM outbox WHERE aggregate = 'autonomy' ORDER BY created_at DESC LIMIT 1`,
    );
    assert.equal(outbox[0].event.type, 'parada_global_activada');

    const appB = await crearCandidatura({ score: 80 });
    const bloqueado = await app.inject({
      method: 'POST',
      url: `/api/applications/${appB}/request-send`,
      headers: authed(auth),
    });
    assert.equal(bloqueado.statusCode, 200);
    const bodyB = bloqueado.json<{ decision: string; motivos: string[] }>();
    assert.equal(bodyB.decision, 'bloqueado');
    assert.ok(bodyB.motivos.some((m) => m.includes('parada_global')), bodyB.motivos.join('|'));

    const resume = await app.inject({ method: 'POST', url: '/api/autonomy/resume', headers: authed(auth) });
    assert.equal(resume.statusCode, 200);

    const okB = await app.inject({
      method: 'POST',
      url: `/api/applications/${appB}/request-send`,
      headers: authed(auth),
    });
    assert.equal(okB.statusCode, 201);
    assert.equal(okB.json<{ decision: string }>().decision, 'permitido');
  });

  it('idempotencia: la misma key devuelve el mismo send sin duplicar', async () => {
    await autorizarEjecucion(app, auth);
    setSendTestDeps({
      offerProbe: async () => ({ ok: true, detalle: 'sonda de test: oferta abierta' }),
    });
    const appId = await crearCandidatura({ score: 80 });

    const primera = await app.inject({
      method: 'POST',
      url: `/api/applications/${appId}/request-send`,
      headers: { ...authed(auth), 'x-idempotency-key': 'clave-unica-1' },
    });
    assert.equal(primera.statusCode, 201);
    const id1 = primera.json<{ id: string }>().id;

    const segunda = await app.inject({
      method: 'POST',
      url: `/api/applications/${appId}/request-send`,
      headers: { ...authed(auth), 'x-idempotency-key': 'clave-unica-1' },
    });
    assert.equal(segunda.statusCode, 200);
    const body2 = segunda.json<{ id: string; duplicado: boolean }>();
    assert.equal(body2.id, id1);
    assert.equal(body2.duplicado, true);

    const total = await query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM sends`);
    assert.equal(total[0].n, '1');

    // El lock con vencimiento quedó creado.
    const locks = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM send_locks WHERE application_id = $1 AND locked_until > now()`,
      [appId],
    );
    assert.equal(locks[0].n, '1');
  });

  it('una intervención abierta no bloquea otras candidaturas', async () => {
    await autorizarEjecucion(app, auth);
    setSendTestDeps({
      offerProbe: async () => ({ ok: true, detalle: 'sonda de test: oferta abierta' }),
    });
    const appA = await crearCandidatura({ score: 80 });
    await query(
      `INSERT INTO interventions (kind, application_id, context)
       VALUES ('datos_desconocidos', $1, '{"campo":"salario"}'::jsonb)`,
      [appA],
    );
    const appB = await crearCandidatura({ score: 80 });
    const res = await app.inject({
      method: 'POST',
      url: `/api/applications/${appB}/request-send`,
      headers: authed(auth),
    });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(res.json<{ decision: string }>().decision, 'permitido');
  });

  it('decisiones: encaje bajo bloquea, encaje medio con aprobación permite desde 70, investigar requiere revisión', async () => {
    setSendTestDeps({
      offerProbe: async () => ({ ok: true, detalle: 'sonda de test: oferta abierta' }),
    });

    const bajo = await crearCandidatura({ score: 60 });
    const r1 = await app.inject({
      method: 'POST',
      url: `/api/applications/${bajo}/request-send`,
      headers: authed(auth),
    });
    const b1 = r1.json<{ decision: string; motivos: string[] }>();
    assert.equal(b1.decision, 'bloqueado');
    assert.ok(b1.motivos.some((m) => m.includes('encaje_insuficiente')));

    // Banda 70–75 con aprobación expresa de Jon: permitido (decisión de Jon
    // 20-oct-2026: su aprobación basta desde el umbral de revisión, 70).
    const medio = await crearCandidatura({ score: 72 });
    const r2 = await app.inject({
      method: 'POST',
      url: `/api/applications/${medio}/request-send`,
      headers: authed(auth),
    });
    const b2 = r2.json<{ decision: string }>();
    assert.equal(b2.decision, 'permitido');

    // En modo preparar_para_revision (semilla v1) con aprobación de Jon: permitido.
    const alto = await crearCandidatura({ score: 80 });
    const r3 = await app.inject({
      method: 'POST',
      url: `/api/applications/${alto}/request-send`,
      headers: authed(auth),
    });
    assert.equal(r3.statusCode, 201, r3.body);
    assert.equal(r3.json<{ decision: string }>().decision, 'permitido');

    // Modo investigar nunca permite encolar solo.
    await app.inject({
      method: 'PUT',
      url: '/api/autonomy/policy',
      headers: authed(auth),
      payload: { modoActivo: 'investigar' },
    });
    const inv = await crearCandidatura({ score: 95 });
    const r4 = await app.inject({
      method: 'POST',
      url: `/api/applications/${inv}/request-send`,
      headers: authed(auth),
    });
    const b4 = r4.json<{ decision: string; motivos: string[] }>();
    assert.equal(b4.decision, 'requiere_revision');
    assert.ok(b4.motivos.some((m) => m.includes('modo_investigar')));

    // Sin aprobación de Jon: bloqueado por el check oferta_aprobada.
    const sinAprobar = await crearCandidatura({ score: 95, appStatus: 'documents_ready' });
    const r5 = await app.inject({
      method: 'POST',
      url: `/api/applications/${sinAprobar}/request-send`,
      headers: authed(auth),
    });
    const b5 = r5.json<{ decision: string; motivos: string[] }>();
    assert.equal(b5.decision, 'bloqueado');
    assert.ok(b5.motivos.some((m) => m.includes('oferta_aprobada')));
  });

  it('intervenciones: filtros, resolución y 409 al re-resolver', async () => {
    const appId = await crearCandidatura();
    const ins = await query<{ id: string }>(
      `INSERT INTO interventions (kind, application_id, context)
       VALUES ('datos_desconocidos', $1, '{}'::jsonb),
              ('captcha_mfa', $1, '{}'::jsonb)
       RETURNING id`,
      [appId],
    );

    const todas = await app.inject({
      method: 'GET',
      url: '/api/interventions?status=abierta',
      headers: authed(auth, false),
    });
    assert.equal(todas.json<{ interventions: unknown[] }>().interventions.length, 2);

    const filtradas = await app.inject({
      method: 'GET',
      url: '/api/interventions?kind=captcha_mfa',
      headers: authed(auth, false),
    });
    const lista = filtradas.json<{ interventions: Array<{ kind: string }> }>().interventions;
    assert.equal(lista.length, 1);
    assert.equal(lista[0].kind, 'captcha_mfa');

    const resolve = await app.inject({
      method: 'POST',
      url: `/api/interventions/${ins[0].id}/resolve`,
      headers: authed(auth),
      payload: { resolution: 'resuelta', note: 'Dato confirmado con Jon.' },
    });
    assert.equal(resolve.statusCode, 200);
    assert.equal(resolve.json<{ intervention: { status: string } }>().intervention.status, 'resuelta');

    const otraVez = await app.inject({
      method: 'POST',
      url: `/api/interventions/${ins[0].id}/resolve`,
      headers: authed(auth),
      payload: { resolution: 'descartada', note: 'x' },
    });
    assert.equal(otraVez.statusCode, 409);
  });

  it('marcarEnvioIncierto: uncertain + intervención envio_incierto (idempotente)', async () => {
    await autorizarEjecucion(app, auth);
    setSendTestDeps({
      offerProbe: async () => ({ ok: true, detalle: 'sonda de test: oferta abierta' }),
    });
    const appId = await crearCandidatura({ score: 80 });
    const req = await app.inject({
      method: 'POST',
      url: `/api/applications/${appId}/request-send`,
      headers: authed(auth),
    });
    const sendId = req.json<{ id: string }>().id;

    const r1 = await marcarEnvioIncierto({
      sendId,
      applicationId: appId,
      causa: 'sin confirmación tras pulsar Submit',
      actorId: null,
    });
    const send = await query<{ status: string }>(`SELECT status FROM sends WHERE id = $1`, [sendId]);
    assert.equal(send[0].status, 'uncertain');
    const iv = await query<{ id: string; kind: string; status: string }>(
      `SELECT id, kind, status FROM interventions WHERE id = $1`,
      [r1.interventionId],
    );
    assert.equal(iv[0].kind, 'envio_incierto');
    assert.equal(iv[0].status, 'abierta');

    // Segunda llamada: reutiliza la intervención abierta (no duplica).
    const r2 = await marcarEnvioIncierto({
      sendId,
      applicationId: appId,
      causa: 'sin confirmación tras pulsar Submit',
      actorId: null,
    });
    assert.equal(r2.interventionId, r1.interventionId);
  });

  it('revoke retira la autorización y resume falla sin autorización vigente', async () => {
    await autorizarEjecucion(app, auth);
    const revoke = await app.inject({
      method: 'POST',
      url: '/api/autonomy/policy/revoke',
      headers: authed(auth),
    });
    assert.equal(revoke.statusCode, 200);

    const status = await app.inject({
      method: 'GET',
      url: '/api/autonomy/status',
      headers: authed(auth, false),
    });
    assert.equal(status.json<{ autorizada: boolean }>().autorizada, false);

    const resume = await app.inject({
      method: 'POST',
      url: '/api/autonomy/resume',
      headers: authed(auth),
    });
    assert.equal(resume.statusCode, 409);
    assert.equal(resume.json<{ error: string }>().error, 'sin_autorizacion_vigente');
  });
});
