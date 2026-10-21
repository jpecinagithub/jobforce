/**
 * Tests de la Fase 8 (automatización máxima).
 *
 * 8.1 formConfig automático (Personio):
 *  - Mapeo completo (perfil + respuestas) → formConfig persistido.
 *  - Requerido sin casar → sin formConfig, formConfigPendiente e
 *    intervención `datos_desconocidos` con los campos.
 *  - Portal sin driver → no se inspecciona; constancia sin intervención.
 *  - Fallo de inspección → la preparación sobrevive.
 *  - Endpoint de reintento.
 * 8.2 Scheduler diario:
 *  - Selección: solo activas sin búsqueda en 20 h; registro en auditoría.
 *  - Extremo a extremo con Exa falso: busca, evalúa y prepara.
 * 8.3 Modo automático:
 *  - ≥75 se solicita solo tras preparar; 70–74 espera en Revisión.
 *  - Sin autorización escrita de la política, nada se envía solo.
 *  - El ejecutor ejecuta el envío de una aprobada a 72 en modo automático.
 */

import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { loadConfig, type AppConfig } from '@jobforce/config';
import { query } from '@jobforce/database';
import {
  authed,
  buildTestApp,
  closeTestApp,
  resetDb,
  setupAndLogin,
  type AuthContext,
} from './helpers.js';
import { prepararCandidatura, prepararElegibles } from '../src/prepare.js';
import {
  resetFormConfigTestDeps,
  setFormConfigTestDeps,
  type InspeccionFormulario,
} from '../src/formconfig.js';
import {
  campanasParaBusquedaProgramada,
  ejecutarBusquedasProgramadas,
} from '../src/scheduler.js';
import {
  resetCampaignTestDeps,
  setCampaignTestDeps,
} from '../src/routes/campaigns.js';
import { resetSendTestDeps, setSendTestDeps } from '../src/routes/sends.js';
import { procesarEnvio } from '../src/sender/index.js';
import type {
  AperturaResultado,
  BrowserDriver,
  PreparacionResultado,
  ResultadoDriver,
} from '../src/sender/types.js';
import type { ExaClient } from '@jobforce/search';

let baseTmp = '';

class FakeDriver implements BrowserDriver {
  readonly portal = 'personio';
  async verificarApertura(): Promise<AperturaResultado> {
    return { abierta: true, detalle: 'ok (fake)' };
  }
  async preparar(): Promise<PreparacionResultado> {
    return { camposRellenados: 1, uploadsOk: true, capturas: [] };
  }
  async enviarYConfirmar(): Promise<ResultadoDriver> {
    return {
      confirmado: true,
      confirmacion: {
        mensaje: 'Thank you! (fake)',
        urlTrasEnvio: 'https://empleo.example/ok',
        referencia: null,
        capturas: [],
      },
      capturas: [],
      evidencia: {},
    };
  }
  async cerrar(): Promise<void> {}
}

const renderFalso = async (_html: string, pdfPath: string): Promise<void> => {
  writeFileSync(pdfPath, '%PDF-1.4 documento de test');
};

/** Siembra una versión de perfil ACTIVA con hechos mínimos pero completos. */
async function seedPerfilActivo(): Promise<void> {
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
    [
      'experience',
      'exp_surexport',
      { start: '2023-11', end: '2026-06', title: 'CFO', company: 'SurExport Peru Berries SAC', location: 'Lima, Perú' },
    ],
    ['skills', 'skills_core', ['IFRS']],
    ['languages', 'lang_es', { language: 'español', level: 'nativo' }],
  ];
  for (const [category, key, value] of facts) {
    await query(
      `INSERT INTO profile_facts (profile_version_id, category, key, value, source)
       VALUES ($1, $2, $3, $4::jsonb, 'test')`,
      [vid, category, key, JSON.stringify(value)],
    );
  }
}

async function seedRespuesta(pregunta: string, respuesta: string): Promise<void> {
  await query(
    `INSERT INTO answer_memory (question_original, question_normalized, answer, source, reuse_rule)
     VALUES ($1, $2, $3, 'test', 'reuse')`,
    [pregunta, pregunta, respuesta],
  );
}

/** Campaña + oferta evaluada. Devuelve los ids. */
async function seedOferta(opts: {
  verdict?: string;
  score?: number;
  url?: string;
}): Promise<{ campaignId: string; offerId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const url = opts.url ?? `https://acme.jobs.personio.com/job/${suffix}`;
  const c = await query<{ id: string }>(
    `INSERT INTO campaigns (name, criteria) VALUES ('camp-f8', '{}'::jsonb) RETURNING id`,
  );
  const o = await query<{ id: string }>(
    `INSERT INTO offers (campaign_id, canonical_url, url, title, company)
     VALUES ($1, $2, $2, 'Finance Manager', 'Acme Corp') RETURNING id`,
    [c[0].id, url],
  );
  await query(
    `INSERT INTO evaluations (offer_id, campaign_id, mandatory_verdict, mandatory_details, score, breakdown)
     VALUES ($1, $2, $3, '[]'::jsonb, $4, '[]'::jsonb)`,
    [o[0].id, c[0].id, opts.verdict ?? 'cumple', opts.score ?? 85],
  );
  return { campaignId: c[0].id, offerId: o[0].id };
}

/** Política en el modo indicado, autorizada por Jon (vía API, como en producción). */
async function autorizarModo(
  app: FastifyInstance,
  auth: AuthContext,
  modoActivo: string,
  autorizar = true,
): Promise<void> {
  const put = await app.inject({
    method: 'PUT',
    url: '/api/autonomy/policy',
    headers: authed(auth),
    payload: { modoActivo },
  });
  assert.equal(put.statusCode, 201, `PUT policy: ${put.statusCode} ${put.body}`);
  if (!autorizar) return;
  const authorize = await app.inject({
    method: 'POST',
    url: '/api/autonomy/policy/authorize',
    headers: authed(auth),
    payload: {
      autorizadoPor: 'Jon Peciña Iturbe',
      declaracion: 'Autorizo la política según lo firmado (test).',
    },
  });
  assert.equal(authorize.statusCode, 200, `authorize: ${authorize.statusCode} ${authorize.body}`);
}

/** Inspección completa de un formulario Personio típico. */
function inspeccionCompleta(url: string): InspeccionFormulario {
  return {
    urlFinal: `${url.replace(/\/$/, '')}/apply`,
    submitButtonName: 'Submit application',
    campos: [
      { selector: '#doc-input-cv', idHtml: 'doc-input-cv', tipoHtml: 'file', etiqueta: 'CV', requerido: true },
      { selector: '#doc-input-cover-letter', idHtml: 'doc-input-cover-letter', tipoHtml: 'file', etiqueta: 'Cover letter', requerido: false },
      { selector: '#field-first_name', idHtml: 'field-first_name', tipoHtml: 'text', etiqueta: 'First name', requerido: true },
      { selector: '#field-last_name', idHtml: 'field-last_name', tipoHtml: 'text', etiqueta: 'Last name', requerido: true },
      { selector: '#field-email', idHtml: 'field-email', tipoHtml: 'email', etiqueta: 'Email', requerido: true },
      { selector: '#field-phone', idHtml: 'field-phone', tipoHtml: 'tel', etiqueta: 'Phone', requerido: false },
      { selector: '#custom-salary', idHtml: 'custom-salary', tipoHtml: 'text', etiqueta: 'Salary expectations', requerido: true },
      {
        selector: '#custom-notice',
        idHtml: 'custom-notice',
        tipoHtml: 'select',
        etiqueta: 'Notice period',
        requerido: true,
        opciones: ['Immediately', '1 month', '3 months'],
      },
    ],
  };
}

async function snapshotDe(applicationId: string): Promise<Record<string, unknown>> {
  const rows = await query<{ offer_snapshot: Record<string, unknown> }>(
    `SELECT offer_snapshot FROM applications WHERE id = $1`,
    [applicationId],
  );
  return rows[0].offer_snapshot;
}

describe('Fase 8.1 — formConfig automático (Personio)', () => {
  let app: FastifyInstance;
  let auth: AuthContext;

  before(async () => {
    baseTmp = mkdtempSync(join(tmpdir(), 'jf8-docs-'));
    process.env.JOBFORCE_WORKSPACE_BASE = baseTmp;
    app = await buildTestApp();
  });

  after(async () => {
    delete process.env.JOBFORCE_WORKSPACE_BASE;
    await closeTestApp(app);
  });

  beforeEach(async () => {
    await resetDb();
    auth = await setupAndLogin(app);
    await seedPerfilActivo();
  });

  afterEach(() => {
    resetFormConfigTestDeps();
  });

  it('mapeo completo: perfil + respuestas → formConfig persistido', async () => {
    await seedRespuesta('salary expectations', '120000 EUR');
    await seedRespuesta('notice period', 'Immediately');
    const { campaignId, offerId } = await seedOferta({ score: 85 });

    const res = await prepararCandidatura(campaignId, offerId, {
      deps: { render: renderFalso, formConfigInspector: async (url) => inspeccionCompleta(url) },
    });
    assert.equal(res.status, 'ready_for_review');
    assert.ok(res.applicationId);
    const snap = await snapshotDe(res.applicationId);
    const fc = snap.formConfig as {
      campos: Array<{ selector: string; tipo: string; valor: string }>;
      docCvSelector: string;
      docCartaSelector: string;
      submitButtonName: string;
      applyUrl: string;
    };
    assert.ok(fc, 'debe existir formConfig');
    assert.equal(snap.formConfigPendiente, undefined);
    const porSelector = new Map(fc.campos.map((c) => [c.selector, c]));
    assert.equal(porSelector.get('#field-first_name')?.valor, 'Jon');
    assert.equal(porSelector.get('#field-last_name')?.valor, 'Peciña Iturbe');
    assert.equal(porSelector.get('#field-email')?.valor, 'jpecina@gmail.com');
    assert.equal(porSelector.get('#field-phone')?.valor, '+34 600000000');
    assert.equal(porSelector.get('#custom-salary')?.valor, '120000 EUR');
    assert.equal(porSelector.get('#custom-notice')?.tipo, 'select');
    assert.equal(porSelector.get('#custom-notice')?.valor, 'Immediately');
    assert.equal(fc.docCvSelector, '#doc-input-cv');
    assert.equal(fc.docCartaSelector, '#doc-input-cover-letter');
    assert.equal(fc.submitButtonName, 'Submit application');
    assert.match(fc.applyUrl, /\/apply$/);
    const ivs = await query(`SELECT id FROM interventions WHERE application_id = $1`, [
      res.applicationId,
    ]);
    assert.equal(ivs.length, 0, 'sin intervenciones cuando todo casa');
  });

  it('requerido sin casar → sin formConfig, pendiente registrado e intervención', async () => {
    await seedRespuesta('notice period', 'Immediately');
    // Sin respuesta para "Salary expectations": requerido sin casar.
    const { campaignId, offerId } = await seedOferta({ score: 85 });

    const res = await prepararCandidatura(campaignId, offerId, {
      deps: { render: renderFalso, formConfigInspector: async (url) => inspeccionCompleta(url) },
    });
    assert.equal(res.status, 'ready_for_review', 'la candidatura se prepara igual');
    const snap = await snapshotDe(res.applicationId!);
    assert.equal(snap.formConfig, undefined, 'NO debe escribirse formConfig');
    const pend = snap.formConfigPendiente as { motivo: string; camposSinMapear: string[] };
    assert.equal(pend.motivo, 'campos_requeridos_sin_mapear');
    assert.ok(pend.camposSinMapear.some((e) => /salary/i.test(e)));
    const ivs = await query<{ kind: string; status: string; context: { camposSinMapear?: string[] } }>(
      `SELECT kind, status, context FROM interventions WHERE application_id = $1`,
      [res.applicationId],
    );
    assert.equal(ivs.length, 1);
    assert.equal(ivs[0].kind, 'datos_desconocidos');
    assert.equal(ivs[0].status, 'abierta');
    assert.ok(ivs[0].context.camposSinMapear?.some((e) => /salary/i.test(e)));
  });

  it('portal sin driver (greenhouse): no inspecciona, constancia sin intervención', async () => {
    let llamadas = 0;
    const { campaignId, offerId } = await seedOferta({
      score: 85,
      url: 'https://boards.greenhouse.io/acme/jobs/123',
    });
    const res = await prepararCandidatura(campaignId, offerId, {
      deps: {
        render: renderFalso,
        formConfigInspector: async (url) => {
          llamadas += 1;
          return inspeccionCompleta(url);
        },
      },
    });
    assert.equal(res.status, 'ready_for_review');
    assert.equal(llamadas, 0, 'no debe ni intentarse la inspección');
    const snap = await snapshotDe(res.applicationId!);
    assert.equal(snap.formConfig, undefined);
    assert.equal(
      (snap.formConfigPendiente as { motivo: string }).motivo,
      'portal_sin_driver',
    );
    const ivs = await query(`SELECT id FROM interventions WHERE application_id = $1`, [
      res.applicationId,
    ]);
    assert.equal(ivs.length, 0, 'sin intervención ruidosa por portales sin driver');
  });

  it('fallo de inspección → la preparación sobrevive con el motivo registrado', async () => {
    const { campaignId, offerId } = await seedOferta({ score: 85 });
    const res = await prepararCandidatura(campaignId, offerId, {
      deps: {
        render: renderFalso,
        formConfigInspector: async () => {
          throw new Error('timeout de red simulado');
        },
      },
    });
    assert.equal(res.status, 'ready_for_review');
    const snap = await snapshotDe(res.applicationId!);
    assert.equal(snap.formConfig, undefined);
    const pend = snap.formConfigPendiente as { motivo: string };
    assert.match(pend.motivo, /^inspeccion_fallida/);
  });

  it('endpoint de reintento: configura una candidatura ya preparada', async () => {
    await seedRespuesta('salary expectations', '120000 EUR');
    await seedRespuesta('notice period', 'Immediately');
    const { campaignId, offerId } = await seedOferta({ score: 85 });
    const prep = await prepararCandidatura(campaignId, offerId, {
      deps: { render: renderFalso },
    });
    assert.equal(prep.status, 'ready_for_review');
    // Sin inspector inyectado en la preparación (NODE_ENV=test): sin formConfig.
    assert.equal((await snapshotDe(prep.applicationId!)).formConfig, undefined);

    setFormConfigTestDeps({
      inspector: async (url) => inspeccionCompleta(url),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/applications/${prep.applicationId}/form-config/retry`,
      headers: authed(auth),
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json<{ estado: string }>();
    assert.equal(body.estado, 'ok');
    const snap = await snapshotDe(prep.applicationId!);
    assert.ok(snap.formConfig, 'el reintento debe dejar el formConfig escrito');
  });
});

describe('Fase 8.2 — scheduler de búsquedas diarias', () => {
  let app: FastifyInstance;
  let auth: AuthContext;
  let config: AppConfig;

  before(async () => {
    baseTmp = mkdtempSync(join(tmpdir(), 'jf8-sched-'));
    process.env.JOBFORCE_WORKSPACE_BASE = baseTmp;
    app = await buildTestApp({ EXA_API_KEY: ['clave', 'falsa'].join('-') });
    config = loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      SESSION_COOKIE_SECURE: 'false',
      EXA_API_KEY: ['clave', 'falsa'].join('-'),
    });
  });

  after(async () => {
    delete process.env.JOBFORCE_WORKSPACE_BASE;
    resetCampaignTestDeps();
    await closeTestApp(app);
  });

  beforeEach(async () => {
    await resetDb();
    resetCampaignTestDeps();
    auth = await setupAndLogin(app);
  });

  async function seedCampana(
    status: string,
    ultimaBusquedaHaceHoras: number | null,
  ): Promise<string> {
    const c = await query<{ id: string }>(
      `INSERT INTO campaigns (name, criteria, status) VALUES ('camp-sched', '{}'::jsonb, $1) RETURNING id`,
      [status],
    );
    if (ultimaBusquedaHaceHoras !== null) {
      await query(
        `INSERT INTO searches (campaign_id, query, num_results, status, started_at, finished_at)
         VALUES ($1, 'q', 5, 'done', now() - ($2 || ' hours')::interval, now() - ($2 || ' hours')::interval)`,
        [c[0].id, String(ultimaBusquedaHaceHoras)],
      );
    }
    return c[0].id;
  }

  it('selección: solo activas y sin búsqueda en las últimas 20 h', async () => {
    const activaSin = await seedCampana('active', null);
    await seedCampana('active', 2);
    const activaVieja = await seedCampana('active', 30);
    await seedCampana('draft', null);
    await seedCampana('archived', 30);

    const ids = await campanasParaBusquedaProgramada();
    assert.deepEqual(new Set(ids), new Set([activaSin, activaVieja]));
  });

  it('el barrido registra cada ejecución en auditoría', async () => {
    const a = await seedCampana('active', null);
    const b = await seedCampana('active', null);
    const lanzadas: string[] = [];
    const r = await ejecutarBusquedasProgramadas(config, {
      lanzarBusqueda: async (id) => {
        lanzadas.push(id);
        return { ok: true, searches: [], total_cost_usd: 0 };
      },
    });
    assert.equal(r.ejecutadas, 2);
    assert.deepEqual(new Set(lanzadas), new Set([a, b]));
    const audits = await query<{ entity_id: string }>(
      `SELECT entity_id FROM audit_events WHERE action = 'scheduled_search_run'`,
    );
    assert.equal(audits.length, 2);
  });

  it('extremo a extremo: busca con Exa falso, evalúa y prepara la elegible', async () => {
    await seedPerfilActivo();
    setCampaignTestDeps({
      checkUrlStatus: async () => 'alive',
      createExaClient: (): ExaClient => ({
        async getContents() {
          return { texts: new Map<string, string>(), costDollars: 0 };
        },
        async search() {
          return {
            requestId: 'req-f8',
            costDollars: 0.007,
            results: [
              {
                id: 'r1',
                title: 'CFO — Acme',
                url: 'https://empleo.example/oferta/1',
                author: 'Acme',
                highlights: ['Se busca CFO con experiencia en IFRS'],
              },
              {
                id: 'r2',
                title: 'Junior Accountant — Beta',
                url: 'https://jobs.example/junior',
                author: 'Beta',
                highlights: [],
              },
            ],
          };
        },
      }),
      evaluateOffer: (offer) =>
        /junior/i.test(offer.title)
          ? {
              mandatory_verdict: 'sin_evidencia' as const,
              mandatory_details: [],
              score: null,
              breakdown: [],
            }
          : {
              mandatory_verdict: 'cumple' as const,
              mandatory_details: [],
              score: 85.5,
              breakdown: [],
            },
    });

    // Campaña creada por la API y activada (como haría Jon en el panel).
    const creada = await app.inject({
      method: 'POST',
      url: '/api/campaigns',
      headers: authed(auth),
      payload: { name: 'Scheduler E2E' },
    });
    assert.equal(creada.statusCode, 201, creada.body);
    const campaignId = creada.json<{ id: string }>().id;
    const activada = await app.inject({
      method: 'PUT',
      url: `/api/campaigns/${campaignId}`,
      headers: authed(auth),
      payload: { status: 'active' },
    });
    assert.equal(activada.statusCode, 200, activada.body);

    const r = await ejecutarBusquedasProgramadas(config);
    assert.equal(r.ejecutadas, 1);
    assert.equal(r.detalle[0].ok, true);

    const searches = await query<{ status: string }>(
      `SELECT status FROM searches WHERE campaign_id = $1`,
      [campaignId],
    );
    assert.ok(searches.length >= 1);
    assert.ok(searches.every((s) => s.status === 'done'));
    const apps = await query<{ status: string }>(
      `SELECT status FROM applications WHERE campaign_id = $1`,
      [campaignId],
    );
    assert.equal(apps.length, 1, 'solo la oferta que cumple se prepara');
    assert.equal(apps[0].status, 'ready_for_review');
    const audits = await query(
      `SELECT id FROM audit_events WHERE action = 'scheduled_search_run' AND entity_id = $1`,
      [campaignId],
    );
    assert.equal(audits.length, 1);

    // Segunda pasada inmediata: la ventana de 20 h la salta.
    const r2 = await ejecutarBusquedasProgramadas(config);
    assert.equal(r2.ejecutadas, 0);
  });
});

describe('Fase 8.3 — modo automático (ejecutar_automatico)', () => {
  let app: FastifyInstance;
  let auth: AuthContext;

  before(async () => {
    baseTmp = mkdtempSync(join(tmpdir(), 'jf8-auto-'));
    process.env.JOBFORCE_WORKSPACE_BASE = baseTmp;
    app = await buildTestApp();
  });

  after(async () => {
    delete process.env.JOBFORCE_WORKSPACE_BASE;
    await closeTestApp(app);
  });

  beforeEach(async () => {
    await resetDb();
    auth = await setupAndLogin(app);
    await seedPerfilActivo();
    await seedRespuesta('salary expectations', '120000 EUR');
    await seedRespuesta('notice period', 'Immediately');
    setSendTestDeps({
      offerProbe: async () => ({ ok: true, detalle: 'sonda de test: oferta abierta' }),
    });
    // Como en producción: la preparación deja el formConfig configurado.
    setFormConfigTestDeps({
      inspector: async (url) => inspeccionCompleta(url),
    });
  });

  afterEach(() => {
    resetSendTestDeps();
    resetFormConfigTestDeps();
  });

  async function sendsDe(applicationId: string): Promise<Array<{ id: string; status: string }>> {
    return query<{ id: string; status: string }>(
      `SELECT id, status FROM sends WHERE application_id = $1`,
      [applicationId],
    );
  }

  it('score 85: tras preparar, el envío se solicita solo y queda encolado', async () => {
    await autorizarModo(app, auth, 'ejecutar_automatico');
    const { campaignId } = await seedOferta({ score: 85 });

    // La generación de documentos en los tests usa el render real sobre la
    // base temporal (JOBFORCE_WORKSPACE_BASE): igual que en producción.
    const r = await prepararElegibles(campaignId, null);
    assert.equal(r.preparadas, 1);
    assert.equal(r.enviosSolicitados, 1);

    const apps = await query<{ id: string; status: string }>(
      `SELECT id, status FROM applications WHERE campaign_id = $1`,
      [campaignId],
    );
    assert.equal(apps.length, 1);
    const sends = await sendsDe(apps[0].id);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].status, 'queued');
    const audits = await query(
      `SELECT id FROM audit_events WHERE action = 'autosend_sweep' AND entity_id = $1`,
      [campaignId],
    );
    assert.equal(audits.length, 1);
  });

  it('score 72: se prepara y espera en Revisión sin enviarse sola', async () => {
    await autorizarModo(app, auth, 'ejecutar_automatico');
    const { campaignId } = await seedOferta({ score: 72 });

    const r = await prepararElegibles(campaignId, null);
    assert.equal(r.preparadas, 1);
    assert.equal(r.enviosSolicitados, 0);

    const apps = await query<{ id: string; status: string }>(
      `SELECT id, status FROM applications WHERE campaign_id = $1`,
      [campaignId],
    );
    assert.equal(apps[0].status, 'ready_for_review');
    assert.equal((await sendsDe(apps[0].id)).length, 0);
  });

  it('sin autorización escrita de la política, nada se envía solo', async () => {
    // Modo automático creado como borrador SIN autorizar.
    await autorizarModo(app, auth, 'ejecutar_automatico', false);
    const { campaignId } = await seedOferta({ score: 90 });

    const r = await prepararElegibles(campaignId, null);
    assert.equal(r.preparadas, 1);
    assert.equal(r.enviosSolicitados, 0);
    const apps = await query<{ id: string }>(
      `SELECT id FROM applications WHERE campaign_id = $1`,
      [campaignId],
    );
    assert.equal((await sendsDe(apps[0].id)).length, 0);
  });

  it('el ejecutor ejecuta el envío de una aprobada a 72 en modo automático', async () => {
    await autorizarModo(app, auth, 'ejecutar_automatico');
    const { campaignId, offerId } = await seedOferta({ score: 72 });

    const prep = await prepararCandidatura(campaignId, offerId, {});
    assert.equal(prep.status, 'ready_for_review');
    // Jon aprueba en Revisión: encadena y encola (banda 70–74).
    const approve = await app.inject({
      method: 'POST',
      url: `/api/applications/${prep.applicationId}/approve`,
      headers: authed(auth),
    });
    assert.equal(approve.statusCode, 200, approve.body);
    const sends = await sendsDe(prep.applicationId!);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].status, 'queued');

    const fake = new FakeDriver();
    const r = await procesarEnvio(sends[0].id, {
      workspaceBase: baseTmp,
      driverFactory: () => fake,
    });
    assert.equal(r.procesado, true);
    const send = await query<{ status: string }>(`SELECT status FROM sends WHERE id = $1`, [
      sends[0].id,
    ]);
    assert.equal(send[0].status, 'sent');
    const appRow = await query<{ status: string }>(
      `SELECT status FROM applications WHERE id = $1`,
      [prep.applicationId],
    );
    assert.equal(appRow[0].status, 'submitted');
  });

  it('el ejecutor ejecuta un envío automático ≥75 sin aprobación por candidatura', async () => {
    await autorizarModo(app, auth, 'ejecutar_automatico');
    const { campaignId } = await seedOferta({ score: 85 });

    const r = await prepararElegibles(campaignId, null);
    assert.equal(r.enviosSolicitados, 1);
    const apps = await query<{ id: string; status: string }>(
      `SELECT id, status FROM applications WHERE campaign_id = $1`,
      [campaignId],
    );
    assert.equal(apps[0].status, 'ready_for_review', 'sin aprobación humana previa');
    const sends = await sendsDe(apps[0].id);
    const fake = new FakeDriver();
    const pr = await procesarEnvio(sends[0].id, {
      workspaceBase: baseTmp,
      driverFactory: () => fake,
    });
    assert.equal(pr.procesado, true);
    const send = await query<{ status: string }>(`SELECT status FROM sends WHERE id = $1`, [
      sends[0].id,
    ]);
    assert.equal(send[0].status, 'sent');
  });
});
