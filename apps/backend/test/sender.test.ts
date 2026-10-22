/**
 * Tests del ejecutor de envíos (modo `ejecutar_automatico`).
 *
 * Requieren `DATABASE_URL` en el entorno (PostgreSQL real, como el resto de
 * la suite). El navegador es un doble (`FakeDriver`); el driver real de
 * Playwright no se ejecuta aquí (su lógica es la del script de Fase 3,
 * probado en vivo).
 *
 * Casos: decisión según política, idempotencia, uncertain→conciliación,
 * stop→bloqueo, anomalía→bandeja, cuotas y presupuesto en el re-check,
 * documentos íntegros (sha256) y portal sin driver.
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { procesarEnvio, reclamarSiguiente, type ExecutorDeps } from '../src/sender/index.js';
import {
  AnomaliaEnvio,
  type AperturaResultado,
  type BrowserDriver,
  type DriverJob,
  type PreparacionResultado,
  type ResultadoDriver,
} from '../src/sender/types.js';

// ---------------------------------------------------------------------------
// Doble del driver.
// ---------------------------------------------------------------------------

interface Comportamiento {
  apertura?: AperturaResultado | AnomaliaEnvio;
  preparar?: PreparacionResultado | AnomaliaEnvio;
  enviar?: ResultadoDriver | AnomaliaEnvio;
}

class FakeDriver implements BrowserDriver {
  readonly portal = 'personio';
  readonly llamadas: string[] = [];
  constructor(private comp: Comportamiento = {}) {}

  async verificarApertura(): Promise<AperturaResultado> {
    this.llamadas.push('verificarApertura');
    const a = this.comp.apertura;
    if (a instanceof AnomaliaEnvio) throw a;
    return a ?? { abierta: true, detalle: 'ok (fake)' };
  }
  async preparar(): Promise<PreparacionResultado> {
    this.llamadas.push('preparar');
    const p = this.comp.preparar;
    if (p instanceof AnomaliaEnvio) throw p;
    return p ?? { camposRellenados: 1, uploadsOk: true, capturas: [] };
  }
  async enviarYConfirmar(): Promise<ResultadoDriver> {
    this.llamadas.push('enviarYConfirmar');
    const e = this.comp.enviar;
    if (e instanceof AnomaliaEnvio) throw e;
    return (
      e ?? {
        confirmado: true,
        confirmacion: {
          mensaje: 'Thank you! (fake)',
          urlTrasEnvio: 'https://empleo.example/ok',
          referencia: null,
          capturas: [],
        },
        capturas: [],
        evidencia: {},
      }
    );
  }
  async cerrar(): Promise<void> {
    this.llamadas.push('cerrar');
  }
}

const CONFIRMADO: ResultadoDriver = {
  confirmado: true,
  confirmacion: {
    mensaje: 'Thank you! We are very happy to receive your application.',
    urlTrasEnvio: 'https://empleo.example/gracias',
    referencia: 'REF-123',
    capturas: [],
  },
  capturas: [],
  evidencia: {},
};

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

let docBase = '';

interface CandidaturaOpts {
  portal?: string;
  score?: number | null;
  verdict?: string;
  appStatus?: string;
  conDocumentos?: boolean;
}

/** Crea campaña + oferta + evaluación + candidatura + documentos reales en disco. */
async function crearCandidatura(opts: CandidaturaOpts = {}): Promise<string> {
  const portal = opts.portal ?? 'personio';
  const score = opts.score === undefined ? 80 : opts.score;
  const verdict = opts.verdict ?? 'cumple';
  const appStatus = opts.appStatus ?? 'ready_for_review';
  const suffix = randomUUID().slice(0, 8);

  const c = await query<{ id: string }>(
    `INSERT INTO campaigns (name, criteria) VALUES ('camp-sender', '{}'::jsonb) RETURNING id`,
  );
  const o = await query<{ id: string }>(
    `INSERT INTO offers (campaign_id, canonical_url, url, title, company)
     VALUES ($1, $2, $3, 'Finance Manager', 'Acme Corp') RETURNING id`,
    [c[0].id, `https://empleo.example/oferta/${suffix}`, `https://empleo.example/oferta/${suffix}`],
  );
  if (score !== null) {
    await query(
      `INSERT INTO evaluations (offer_id, campaign_id, mandatory_verdict, mandatory_details, score, breakdown)
       VALUES ($1, $2, $3, '[]'::jsonb, $4, '[]'::jsonb)`,
      [o[0].id, c[0].id, verdict, score],
    );
  }
  const formConfig = {
    applyUrl: `https://empleo.example/oferta/${suffix}/apply`,
    campos: [{ selector: '#nombre', tipo: 'fill', valor: 'Jon', etiqueta: 'nombre' }],
    submitButtonName: 'submit application',
  };
  const a = await query<{ id: string }>(
    `INSERT INTO applications (campaign_id, offer_id, status, portal, offer_snapshot)
     VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id`,
    [c[0].id, o[0].id, appStatus, portal, JSON.stringify({ formConfig })],
  );
  if (opts.conDocumentos !== false) {
    for (const kind of ['cv', 'cover_letter']) {
      const nombre = `${a[0].id}-${kind}.pdf`;
      const contenido = `%PDF-1.4 fake ${kind} ${suffix}`;
      writeFileSync(join(docBase, nombre), contenido);
      const sha = createHash('sha256').update(contenido).digest('hex');
      await query(
        `INSERT INTO documents (application_id, kind, format, version, file_path, bytes, sha256, template_version, generator)
         VALUES ($1, $2, 'pdf', 1, $3, $4, $5, 'cv-template-v1', 'test')`,
        [a[0].id, kind, nombre, contenido.length, sha],
      );
    }
  }
  return a[0].id;
}

/** Política v2 en modo ejecutar_automatico con autorización escrita (vía API). */
async function autorizarAutomatico(app: FastifyInstance, auth: AuthContext): Promise<void> {
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
      declaracion: 'Autorizo los envíos automáticos según la política (test).',
    },
  });
  assert.equal(authorize.statusCode, 200, `authorize: ${authorize.statusCode} ${authorize.body}`);
}

/** Encola un envío por la API (con sonda de test que dice "abierta"). */
async function encolar(app: FastifyInstance, auth: AuthContext, applicationId: string): Promise<string> {
  setSendTestDeps({ offerProbe: async () => ({ ok: true, detalle: 'sonda de test: abierta' }) });
  try {
    const r = await app.inject({
      method: 'POST',
      url: `/api/applications/${applicationId}/request-send`,
      headers: { ...authed(auth), 'x-idempotency-key': randomUUID() },
    });
    assert.equal(r.statusCode, 201, `request-send: ${r.statusCode} ${r.body}`);
    return (r.json() as { id: string }).id;
  } finally {
    resetSendTestDeps();
  }
}

async function estadoSend(id: string): Promise<string> {
  const rows = await query<{ status: string }>(`SELECT status FROM sends WHERE id = $1`, [id]);
  return rows[0].status;
}

async function estadoApp(id: string): Promise<string> {
  const rows = await query<{ status: string }>(`SELECT status FROM applications WHERE id = $1`, [id]);
  return rows[0].status;
}

async function intervencionesAbiertas(applicationId: string): Promise<{ kind: string }[]> {
  return query<{ kind: string }>(
    `SELECT kind FROM interventions WHERE application_id = $1 AND status = 'abierta' ORDER BY created_at`,
    [applicationId],
  );
}

// ---------------------------------------------------------------------------
// Suite.
// ---------------------------------------------------------------------------

describe('ejecutor de envíos', () => {
  let app: FastifyInstance;
  let auth: AuthContext;
  let driver: FakeDriver;
  let factoryLlamada: boolean;

  const deps = (): ExecutorDeps => ({
    workspaceBase: docBase,
    driverFactory: () => {
      factoryLlamada = true;
      return driver;
    },
  });

  before(async () => {
    app = await buildTestApp();
    docBase = mkdtempSync(join(tmpdir(), 'sender-test-'));
  });

  after(async () => {
    await closeTestApp(app);
  });

  beforeEach(async () => {
    await resetDb();
    resetSendTestDeps();
    auth = await setupAndLogin(app);
    driver = new FakeDriver({ enviar: CONFIRMADO });
    factoryLlamada = false;
  });

  it('modo automático autorizado + driver OK → sent con evidencias', async () => {
    await autorizarAutomatico(app, auth);
    const applicationId = await crearCandidatura();
    const sendId = await encolar(app, auth, applicationId);

    const r = await procesarEnvio(sendId, deps());
    assert.equal(r.procesado, true);
    assert.equal((r as { estado: string }).estado, 'sent');
    assert.equal(await estadoSend(sendId), 'sent');
    assert.equal(await estadoApp(applicationId), 'submitted');
    assert.deepEqual(driver.llamadas, ['verificarApertura', 'preparar', 'enviarYConfirmar', 'cerrar']);

    const ev = await query<{ evidence: { confirmacion: { referencia: string } } }>(
      `SELECT evidence FROM sends WHERE id = $1`,
      [sendId],
    );
    assert.equal(ev[0].evidence.confirmacion.referencia, 'REF-123');
  });

  it('sin autorización escrita → bloqueado sin abrir el navegador', async () => {
    // resetDb siembra la v1 como borrador (preparar_para_revision, sin auth).
    // Para encolar en ese modo hace falta aprobación manual:
    const applicationId = await crearCandidatura({ appStatus: 'approved' });
    const sendId = await encolar(app, auth, applicationId);

    const r = await procesarEnvio(sendId, deps());
    assert.equal((r as { estado: string }).estado, 'failed');
    assert.equal(await estadoSend(sendId), 'failed');
    assert.equal(factoryLlamada, false, 'no se debe crear el driver sin autorización');
    const iv = await intervencionesAbiertas(applicationId);
    assert.deepEqual(iv.map((i) => i.kind), ['fuera_de_politica']);
  });

  it('parada global → bloqueado sin abrir el navegador', async () => {
    await autorizarAutomatico(app, auth);
    const applicationId = await crearCandidatura();
    const sendId = await encolar(app, auth, applicationId);
    const stop = await app.inject({ method: 'POST', url: '/api/autonomy/stop', headers: authed(auth) });
    assert.equal(stop.statusCode, 200);

    const r = await procesarEnvio(sendId, deps());
    assert.equal((r as { estado: string }).estado, 'failed');
    assert.equal(factoryLlamada, false);
    assert.ok((r as { detalle: string }).detalle.includes('parada global'));
  });

  it('idempotencia: procesar dos veces el mismo envío no duplica nada', async () => {
    await autorizarAutomatico(app, auth);
    const applicationId = await crearCandidatura();
    const sendId = await encolar(app, auth, applicationId);

    const r1 = await procesarEnvio(sendId, deps());
    assert.equal((r1 as { estado: string }).estado, 'sent');
    const llamadasTrasPrimero = driver.llamadas.length;

    const r2 = await procesarEnvio(sendId, deps());
    assert.equal(r2.procesado, false);
    assert.equal((r2 as { motivo: string }).motivo, 'no_en_queued');
    assert.equal(driver.llamadas.length, llamadasTrasPrimero, 'el driver no se toca dos veces');
    const n = await query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM sends WHERE id = $1`, [sendId]);
    assert.equal(n[0].n, '1');
  });

  it('sin confirmación → uncertain + intervención envio_incierto, sin reintento', async () => {
    await autorizarAutomatico(app, auth);
    const applicationId = await crearCandidatura();
    const sendId = await encolar(app, auth, applicationId);
    driver = new FakeDriver({
      enviar: { confirmado: false, capturas: [], evidencia: { motivo: 'timeout tras Submit' } },
    });

    const r = await procesarEnvio(sendId, deps());
    assert.equal((r as { estado: string }).estado, 'uncertain');
    assert.equal(await estadoSend(sendId), 'uncertain');
    const iv = await intervencionesAbiertas(applicationId);
    assert.deepEqual(iv.map((i) => i.kind), ['envio_incierto']);

    // Segundo procesado: no reintenta a ciegas.
    const llamadas = driver.llamadas.length;
    const r2 = await procesarEnvio(sendId, deps());
    assert.equal(r2.procesado, false);
    assert.equal(driver.llamadas.length, llamadas);
  });

  it('CAPTCHA real antes del envío → captcha_mfa, failed, sin reintento ciego', async () => {
    await autorizarAutomatico(app, auth);
    const applicationId = await crearCandidatura();
    const sendId = await encolar(app, auth, applicationId);
    driver = new FakeDriver({
      preparar: new AnomaliaEnvio('captcha_mfa', 'Turnstile visible antes de enviar'),
    });

    const r = await procesarEnvio(sendId, deps());
    assert.equal((r as { estado: string }).estado, 'failed');
    assert.equal(await estadoSend(sendId), 'failed');
    assert.equal(await estadoApp(applicationId), 'submission_failed');
    assert.ok(!driver.llamadas.includes('enviarYConfirmar'), 'no se pulsa Submit con CAPTCHA');
    const iv = await intervencionesAbiertas(applicationId);
    assert.deepEqual(iv.map((i) => i.kind), ['captcha_mfa']);
  });

  it('anomalía tras pulsar Submit → uncertain para conciliación', async () => {
    await autorizarAutomatico(app, auth);
    const applicationId = await crearCandidatura();
    const sendId = await encolar(app, auth, applicationId);
    driver = new FakeDriver({
      enviar: new AnomaliaEnvio('captcha_mfa', 'desafío tras el clic, sin confirmación', { trasClick: true }),
    });

    const r = await procesarEnvio(sendId, deps());
    assert.equal((r as { estado: string }).estado, 'uncertain');
    const iv = await intervencionesAbiertas(applicationId);
    assert.deepEqual(iv.map((i) => i.kind), ['envio_incierto']);
  });

  it('una excepción no detiene los demás envíos', async () => {
    await autorizarAutomatico(app, auth);
    const app1 = await crearCandidatura();
    const app2 = await crearCandidatura();
    const send1 = await encolar(app, auth, app1);
    const send2 = await encolar(app, auth, app2);

    // El driver falla solo para el primer envío (por sendId).
    const d1 = new FakeDriver({ preparar: new AnomaliaEnvio('error_ambiguo', 'red caída al rellenar') });
    const d2 = new FakeDriver({ enviar: CONFIRMADO });
    const r1 = await procesarEnvio(send1, {
      workspaceBase: docBase,
      driverFactory: (job) => (job.sendId === send1 ? d1 : d2),
    });
    const r2 = await procesarEnvio(send2, {
      workspaceBase: docBase,
      driverFactory: (job) => (job.sendId === send1 ? d1 : d2),
    });
    assert.equal((r1 as { estado: string }).estado, 'failed');
    assert.equal((r2 as { estado: string }).estado, 'sent');
    assert.equal(await estadoSend(send2), 'sent');
  });

  it('oferta cerrada en el re-check → failed + intervención, sin rellenar', async () => {
    await autorizarAutomatico(app, auth);
    const applicationId = await crearCandidatura();
    const sendId = await encolar(app, auth, applicationId);
    driver = new FakeDriver({ apertura: { abierta: false, detalle: 'HTTP 404: oferta retirada' } });

    const r = await procesarEnvio(sendId, deps());
    assert.equal((r as { estado: string }).estado, 'failed');
    assert.ok(!driver.llamadas.includes('preparar'), 'no se rellena una oferta cerrada');
    const iv = await intervencionesAbiertas(applicationId);
    assert.deepEqual(iv.map((i) => i.kind), ['fuera_de_politica']);
  });

  it('documento con sha distinto al versionado → datos_desconocidos, sin navegador', async () => {
    await autorizarAutomatico(app, auth);
    const applicationId = await crearCandidatura();
    const sendId = await encolar(app, auth, applicationId);
    // Corrompe el fichero tras registrar su hash: lo enviado no sería lo generado.
    const rows = await query<{ file_path: string }>(
      `SELECT file_path FROM documents WHERE application_id = $1 AND kind = 'cv'`,
      [applicationId],
    );
    writeFileSync(join(docBase, rows[0].file_path), '%PDF-1.4 CONTENIDO DISTINTO');

    const r = await procesarEnvio(sendId, deps());
    assert.equal((r as { estado: string }).estado, 'failed');
    assert.equal(factoryLlamada, false);
    const iv = await intervencionesAbiertas(applicationId);
    assert.deepEqual(iv.map((i) => i.kind), ['datos_desconocidos']);
  });

  it('cuota diaria alcanzada → bloqueado en el re-check', async () => {
    await autorizarAutomatico(app, auth);
    // 5 envíos ya cuentan hoy (límite de la política v1).
    for (let i = 0; i < 5; i++) {
      const appId = await crearCandidatura();
      await query(
        `INSERT INTO sends (application_id, idempotency_key, policy_version, status, evidence)
         VALUES ($1, $2, 2, 'sent', '{}'::jsonb)`,
        [appId, `cuota-${i}-${randomUUID()}`],
      );
    }
    const applicationId = await crearCandidatura();
    // Se inserta directamente en queued (request-send lo habría bloqueado).
    const s = await query<{ id: string }>(
      `INSERT INTO sends (application_id, idempotency_key, policy_version, status, evidence)
       VALUES ($1, $2, 2, 'queued', '{}'::jsonb) RETURNING id`,
      [applicationId, `cuota-extra-${randomUUID()}`],
    );

    const r = await procesarEnvio(s[0].id, deps());
    assert.equal((r as { estado: string }).estado, 'failed');
    assert.ok(!driver.llamadas.includes('preparar'));
    assert.ok((r as { detalle: string }).detalle.includes('cuota_diaria'));
  });

  it('portal sin driver probado → fuera_de_politica, sin simular', async () => {
    await autorizarAutomatico(app, auth);
    const applicationId = await crearCandidatura({ portal: 'smartrecruiters' });
    // request-send rechazaría smartrecruiters (no está en
    // portalesPermitidos ni tiene driver); se inserta directo para
    // probar la puerta del ejecutor. (Antes el fixture era ashby;
    // desde 2026-10-22 Ashby SÍ tiene driver y está permitido.)
    const s = await query<{ id: string }>(
      `INSERT INTO sends (application_id, idempotency_key, policy_version, status, evidence)
       VALUES ($1, $2, 2, 'queued', '{}'::jsonb) RETURNING id`,
      [applicationId, `portal-${randomUUID()}`],
    );
    const { crearDriver } = await import('../src/sender/driver.js');
    const r = await procesarEnvio(s[0].id, { workspaceBase: docBase, driverFactory: (job) => crearDriver(job.portal) });
    assert.equal((r as { estado: string }).estado, 'failed');
    const iv = await intervencionesAbiertas(applicationId);
    assert.deepEqual(iv.map((i) => i.kind), ['fuera_de_politica']);
  });

  it('request-send encola en automático autorizado sin aprobación manual', async () => {
    // Coherencia del check 3: la autorización escrita ES la aprobación.
    await autorizarAutomatico(app, auth);
    const applicationId = await crearCandidatura({ appStatus: 'ready_for_review' });
    setSendTestDeps({ offerProbe: async () => ({ ok: true, detalle: 'abierta' }) });
    try {
      const r = await app.inject({
        method: 'POST',
        url: `/api/applications/${applicationId}/request-send`,
        headers: { ...authed(auth), 'x-idempotency-key': randomUUID() },
      });
      assert.equal(r.statusCode, 201, `request-send en automático: ${r.statusCode} ${r.body}`);
      assert.equal((r.json() as { status: string }).status, 'queued');
    } finally {
      resetSendTestDeps();
    }
  });

  it('reclamarSiguiente procesa el más antiguo y devuelve null sin cola', async () => {
    await autorizarAutomatico(app, auth);
    const applicationId = await crearCandidatura();
    await encolar(app, auth, applicationId);

    const r = await reclamarSiguiente(deps());
    assert.ok(r && r.procesado && (r as { estado: string }).estado === 'sent');
    const vacio = await reclamarSiguiente(deps());
    assert.equal(vacio, null);
  });
});

// ---------------------------------------------------------------------------
// iCIMS: el ejecutor carga el trabajo SIN formConfig de selectores,
// obtiene la cuenta del portal y pasa los datos al driver.
// ---------------------------------------------------------------------------

describe('ejecutor de envíos — iCIMS', () => {
  let app: FastifyInstance;
  let auth: AuthContext;

  class CapturingDriver implements BrowserDriver {
    readonly portal = 'icims';
    job: DriverJob | null = null;
    async verificarApertura(job: DriverJob): Promise<AperturaResultado> {
      this.job = job;
      return { abierta: true, detalle: 'ok (fake icims)' };
    }
    async preparar(job: DriverJob): Promise<PreparacionResultado> {
      this.job = job;
      return { camposRellenados: 5, uploadsOk: true, capturas: [] };
    }
    async enviarYConfirmar(): Promise<ResultadoDriver> {
      return {
        confirmado: true,
        confirmacion: {
          mensaje: 'Thank you, your application has been submitted (fake).',
          urlTrasEnvio: 'https://careers-sightsavers.icims.com/ok',
          referencia: 'ICIMS-1',
          capturas: [],
        },
        capturas: [],
        evidencia: {},
      };
    }
    async cerrar(): Promise<void> {}
  }

  async function seedPerfil(): Promise<void> {
    const v = await query<{ id: string }>(
      `INSERT INTO profile_versions (status, source) VALUES ('active', 'test') RETURNING id`,
    );
    const vid = v[0].id;
    const facts: Array<[string, string, unknown]> = [
      ['identity', 'full_name', 'Jon Peciña Iturbe'],
      ['identity', 'email', 'jpecina@gmail.com'],
      ['identity', 'linkedin', 'linkedin.com/in/jpecina'],
      ['identity', 'location', { city: 'Logroño', country: 'España' }],
      ['identity', 'phone', '+34 600000000'],
      ['experience', 'experience_summary_claim', { text: 'over 15 years of experience', note: 'literal' }],
      ['experience', 'exp_x', { start: '2023-11', end: '2026-06', title: 'CFO', company: 'Acme', location: 'Lima' }],
      ['education', 'edu_x', { start: '1997', end: '2003', degree: 'Ingeniero Industrial', institution: 'UNAV', official: true, issued: 'Pamplona' }],
      ['skills', 'skills_core', ['IFRS']],
      ['languages', 'lang_en', { language: 'inglés', level: 'avanzado' }],
    ];
    for (const [category, key, value] of facts) {
      await query(
        `INSERT INTO profile_facts (profile_version_id, category, key, value, source)
         VALUES ($1, $2, $3, $4::jsonb, 'test')`,
        [vid, category, key, JSON.stringify(value)],
      );
    }
  }

  before(async () => {
    app = await buildTestApp();
    if (!docBase) docBase = mkdtempSync(join(tmpdir(), 'sender-icims-'));
  });

  after(async () => {
    await closeTestApp(app);
  });

  beforeEach(async () => {
    await resetDb();
    resetSendTestDeps();
    auth = await setupAndLogin(app);
    await seedPerfil();
  });

  it('portal icims sin formConfig: cuenta + datos al driver → sent', async () => {
    // Política automática con icims permitido y cuentas autorizadas.
    const { defaultReglasAutonomia } = await import('../src/routes/autonomy.js');
    const reglas = {
      ...defaultReglasAutonomia(),
      portalesPermitidos: ['personio', 'icims'],
      crearCuentasPortales: true,
    };
    const put = await app.inject({
      method: 'PUT',
      url: '/api/autonomy/policy',
      headers: authed(auth),
      payload: { modoActivo: 'ejecutar_automatico', reglas },
    });
    assert.equal(put.statusCode, 201, `PUT policy: ${put.statusCode} ${put.body}`);
    const authorize = await app.inject({
      method: 'POST',
      url: '/api/autonomy/policy/authorize',
      headers: authed(auth),
      payload: { autorizadoPor: 'Jon Peciña Iturbe', declaracion: 'Autorizo (test iCIMS).' },
    });
    assert.equal(authorize.statusCode, 200);

    const applicationId = await crearCandidatura({
      portal: 'icims',
      score: 80,
      verdict: 'cumple',
      appStatus: 'approved',
    });
    // Sin formConfig: iCIMS rellena por etiquetas, no por selectores.
    await query(`UPDATE applications SET offer_snapshot = '{}'::jsonb WHERE id = $1`, [applicationId]);
    const pol = await query<{ version: number }>(
      `SELECT version FROM autonomy_policies WHERE revoked_at IS NULL ORDER BY version DESC LIMIT 1`,
    );
    const send = await query<{ id: string }>(
      `INSERT INTO sends (application_id, idempotency_key, policy_version, status)
       VALUES ($1, $2, $3, 'queued') RETURNING id`,
      [applicationId, randomUUID(), pol[0].version],
    );

    const driver = new CapturingDriver();
    const cuentaLlamada: { host?: string; email?: string } = {};
    const r = await procesarEnvio(send[0].id, {
      workspaceBase: docBase,
      driverFactory: () => driver,
      cuentaPortal: async (host: string, email: string) => {
        cuentaLlamada.host = host;
        cuentaLlamada.email = email;
        return { email, password: 'Pw-generada-9!x' };
      },
    });
    assert.equal(r.procesado, true);
    assert.equal((r as { estado: string }).estado, 'sent');
    assert.equal(await estadoApp(applicationId), 'submitted');
    assert.equal(cuentaLlamada.email, 'jpecina@gmail.com');
    assert.ok(driver.job, 'el driver recibió el trabajo');
    assert.equal(driver.job!.portal, 'icims');
    assert.equal(driver.job!.campos.length, 0);
    assert.equal(driver.job!.icims?.cuentaPassword, 'Pw-generada-9!x');
    assert.equal(driver.job!.icims?.nombre, 'Jon');
    assert.equal(driver.job!.icims?.paisResidencia, 'España');
  });
});

// ---------------------------------------------------------------------------
// Workable: el ejecutor carga el trabajo por etiquetas (sin formConfig
// ni cuenta de portal) y el driver recibe los datos del candidato.
// ---------------------------------------------------------------------------

describe('ejecutor de envíos — Workable', () => {
  let app: FastifyInstance;
  let auth: AuthContext;

  class CapturingDriverW implements BrowserDriver {
    readonly portal = 'workable';
    job: DriverJob | null = null;
    async verificarApertura(job: DriverJob): Promise<AperturaResultado> {
      this.job = job;
      return { abierta: true, detalle: 'ok (fake workable)' };
    }
    async preparar(job: DriverJob): Promise<PreparacionResultado> {
      this.job = job;
      return { camposRellenados: 4, uploadsOk: true, capturas: [] };
    }
    async enviarYConfirmar(): Promise<ResultadoDriver> {
      return {
        confirmado: true,
        confirmacion: {
          mensaje: 'Your application has been sent (fake).',
          urlTrasEnvio: 'https://apply.workable.com/ok',
          referencia: null,
          capturas: [],
        },
        capturas: [],
        evidencia: {},
      };
    }
    async cerrar(): Promise<void> {}
  }

  before(async () => {
    app = await buildTestApp();
    if (!docBase) docBase = mkdtempSync(join(tmpdir(), 'sender-workable-'));
  });

  after(async () => {
    await closeTestApp(app);
  });

  beforeEach(async () => {
    await resetDb();
    resetSendTestDeps();
    auth = await setupAndLogin(app);
    // Perfil activo mínimo (mismo sembrado que el bloque iCIMS).
    const v = await query<{ id: string }>(
      `INSERT INTO profile_versions (status, source) VALUES ('active', 'test') RETURNING id`,
    );
    const facts: Array<[string, string, unknown]> = [
      ['identity', 'full_name', 'Jon Peciña Iturbe'],
      ['identity', 'email', 'jpecina@gmail.com'],
      ['identity', 'linkedin', 'linkedin.com/in/jpecina'],
      ['identity', 'location', { city: 'Logroño', country: 'España' }],
      ['identity', 'phone', '+34 600000000'],
      ['compensation', 'salary_expectation', { text: 'USD 70,000 per year' }],
      ['experience', 'experience_summary_claim', { text: 'over 15 years of experience', note: 'literal' }],
      ['experience', 'exp_x', { start: '2023-11', end: '2026-06', title: 'CFO', company: 'Acme', location: 'Lima' }],
      ['education', 'edu_x', { start: '1997', end: '2003', degree: 'Ingeniero Industrial', institution: 'UNAV', official: true, issued: 'Pamplona' }],
      ['skills', 'skills_core', ['IFRS']],
      ['languages', 'lang_en', { language: 'inglés', level: 'avanzado' }],
    ];
    for (const [category, key, value] of facts) {
      await query(
        `INSERT INTO profile_facts (profile_version_id, category, key, value, source)
         VALUES ($1, $2, $3, $4::jsonb, 'test')`,
        [v[0].id, category, key, JSON.stringify(value)],
      );
    }
  });

  it('portal workable sin formConfig ni cuenta: datos por etiquetas → sent', async () => {
    const { defaultReglasAutonomia } = await import('../src/routes/autonomy.js');
    const reglas = {
      ...defaultReglasAutonomia(),
      portalesPermitidos: ['personio', 'workable'],
      crearCuentasPortales: true,
    };
    const put = await app.inject({
      method: 'PUT',
      url: '/api/autonomy/policy',
      headers: authed(auth),
      payload: { modoActivo: 'ejecutar_automatico', reglas },
    });
    assert.equal(put.statusCode, 201, `PUT policy: ${put.statusCode} ${put.body}`);
    const authorize = await app.inject({
      method: 'POST',
      url: '/api/autonomy/policy/authorize',
      headers: authed(auth),
      payload: { autorizadoPor: 'Jon Peciña Iturbe', declaracion: 'Autorizo (test Workable).' },
    });
    assert.equal(authorize.statusCode, 200);

    const applicationId = await crearCandidatura({
      portal: 'workable',
      score: 82,
      verdict: 'cumple',
      appStatus: 'approved',
    });
    await query(`UPDATE applications SET offer_snapshot = '{}'::jsonb WHERE id = $1`, [applicationId]);
    const pol = await query<{ version: number }>(
      `SELECT version FROM autonomy_policies WHERE revoked_at IS NULL ORDER BY version DESC LIMIT 1`,
    );
    const send = await query<{ id: string }>(
      `INSERT INTO sends (application_id, idempotency_key, policy_version, status)
       VALUES ($1, $2, $3, 'queued') RETURNING id`,
      [applicationId, randomUUID(), pol[0].version],
    );
    const driver = new CapturingDriverW();
    const r = await procesarEnvio(send[0].id, {
      workspaceBase: docBase,
      driverFactory: () => driver,
    });
    assert.equal(r.procesado, true);
    assert.equal((r as { estado: string }).estado, 'sent');
    assert.ok(driver.job);
    assert.equal(driver.job!.portal, 'workable');
    assert.equal(driver.job!.etiquetas?.nombre, 'Jon');
    assert.equal(driver.job!.etiquetas?.salarioEsperado, 'USD 70,000 per year');
    assert.equal(driver.job!.etiquetas?.cuentaPassword, '');
  });
});
