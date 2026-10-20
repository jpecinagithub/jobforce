/**
 * Tests de la Fase 7 (aprobación → envío encadenado y puerta del ejecutor).
 *
 * - En modo `preparar_para_revision`, aprobar encola el envío (misma lógica
 *   que request-send) y la respuesta lo dice: { send: 'encolado' }.
 * - Si la política lo bloquea (parada global, encaje por debajo del suelo
 *   de revisión de 70…), la aprobación queda registrada, NO se encola nada
 *   y se abre una intervención con el motivo. En la banda 70–75 la
 *   aprobación expresa de Jon SÍ basta para encolar (decisión 20-oct-2026:
 *   el umbral automático solo gobierna envíos sin aprobación humana).
 * - En los demás modos, approve NO encadena (comportamiento intacto).
 * - El ejecutor procesa envíos en modo revisión SOLO si la candidatura
 *   está `approved` (aprobación expresa de Jon); si no, falla cerrado sin
 *   abrir el navegador.
 */

import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
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
import { procesarEnvio } from '../src/sender/index.js';
import {
  type AperturaResultado,
  type BrowserDriver,
  type PreparacionResultado,
  type ResultadoDriver,
} from '../src/sender/types.js';

class FakeDriver implements BrowserDriver {
  readonly portal = 'personio';
  readonly llamadas: string[] = [];
  async verificarApertura(): Promise<AperturaResultado> {
    this.llamadas.push('verificarApertura');
    return { abierta: true, detalle: 'ok (fake)' };
  }
  async preparar(): Promise<PreparacionResultado> {
    this.llamadas.push('preparar');
    return { camposRellenados: 1, uploadsOk: true, capturas: [] };
  }
  async enviarYConfirmar(): Promise<ResultadoDriver> {
    this.llamadas.push('enviarYConfirmar');
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
  async cerrar(): Promise<void> {
    this.llamadas.push('cerrar');
  }
}

let docBase = '';

interface SeedOpts {
  score?: number;
  appStatus?: string;
  conFormConfig?: boolean;
}

/** Campaña + oferta personio + evaluación cumple + candidatura + documentos. */
async function seedCandidatura(opts: SeedOpts = {}): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const score = opts.score ?? 88;
  const c = await query<{ id: string }>(
    `INSERT INTO campaigns (name, criteria) VALUES ('camp-f7-chain', '{}'::jsonb) RETURNING id`,
  );
  const o = await query<{ id: string }>(
    `INSERT INTO offers (campaign_id, canonical_url, url, title, company)
     VALUES ($1, $2, $2, 'Finance Manager', 'Acme Corp') RETURNING id`,
    [c[0].id, `https://acme.jobs.personio.com/job/${suffix}`],
  );
  await query(
    `INSERT INTO evaluations (offer_id, campaign_id, mandatory_verdict, mandatory_details, score, breakdown)
     VALUES ($1, $2, 'cumple', '[]'::jsonb, $3, '[]'::jsonb)`,
    [o[0].id, c[0].id, score],
  );
  const snapshot =
    opts.conFormConfig === false
      ? {}
      : {
          formConfig: {
            applyUrl: `https://acme.jobs.personio.com/job/${suffix}/apply`,
            campos: [{ selector: '#nombre', tipo: 'fill', valor: 'Jon', etiqueta: 'nombre' }],
            submitButtonName: 'submit application',
          },
        };
  const a = await query<{ id: string }>(
    `INSERT INTO applications (campaign_id, offer_id, status, portal, offer_snapshot)
     VALUES ($1, $2, $3, 'personio', $4::jsonb) RETURNING id`,
    [c[0].id, o[0].id, opts.appStatus ?? 'ready_for_review', JSON.stringify(snapshot)],
  );
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
  return a[0].id;
}

/** Política v2 autorizada en el modo indicado (vía API, como en producción). */
async function autorizarModo(
  app: FastifyInstance,
  auth: AuthContext,
  modoActivo: string,
): Promise<void> {
  const put = await app.inject({
    method: 'PUT',
    url: '/api/autonomy/policy',
    headers: authed(auth),
    payload: { modoActivo },
  });
  assert.equal(put.statusCode, 201, `PUT policy: ${put.statusCode} ${put.body}`);
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

async function sendsDe(applicationId: string): Promise<Array<{ status: string }>> {
  return query<{ status: string }>(
    `SELECT status FROM sends WHERE application_id = $1`,
    [applicationId],
  );
}

async function intervencionesDe(applicationId: string): Promise<Array<{ kind: string; status: string }>> {
  return query<{ kind: string; status: string }>(
    `SELECT kind, status FROM interventions WHERE application_id = $1`,
    [applicationId],
  );
}

describe('aprobación → envío encadenado (Fase 7)', () => {
  let app: FastifyInstance;
  let auth: AuthContext;

  before(async () => {
    docBase = mkdtempSync(join(tmpdir(), 'jf7-chain-docs-'));
    app = await buildTestApp();
  });

  after(async () => {
    await closeTestApp(app);
  });

  beforeEach(async () => {
    await resetDb();
    auth = await setupAndLogin(app);
    setSendTestDeps({
      offerProbe: async () => ({ ok: true, detalle: 'sonda de test: oferta abierta' }),
    });
  });

  afterEach(() => {
    resetSendTestDeps();
  });

  it('aprobar en preparar_para_revision (score 88) encola el envío', async () => {
    await autorizarModo(app, auth, 'preparar_para_revision');
    const appId = await seedCandidatura({ score: 88 });

    const res = await app.inject({
      method: 'POST',
      url: `/api/applications/${appId}/approve`,
      headers: authed(auth),
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json<{
      ok: boolean;
      application: { status: string };
      send?: { send: string; motivo?: string };
    }>();
    assert.equal(body.ok, true);
    assert.equal(body.application.status, 'approved');
    assert.equal(body.send?.send, 'encolado');

    const sends = await sendsDe(appId);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].status, 'queued');
  });

  it('parada global: aprueba pero NO encola y abre intervención', async () => {
    await autorizarModo(app, auth, 'preparar_para_revision');
    const appId = await seedCandidatura({ score: 88 });
    const stop = await app.inject({
      method: 'POST',
      url: '/api/autonomy/stop',
      headers: authed(auth),
    });
    assert.equal(stop.statusCode, 200, stop.body);

    const res = await app.inject({
      method: 'POST',
      url: `/api/applications/${appId}/approve`,
      headers: authed(auth),
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json<{
      application: { status: string };
      send?: { send: string; motivo?: string };
    }>();
    assert.equal(body.application.status, 'approved', 'la aprobación queda registrada');
    assert.equal(body.send?.send, 'bloqueado');
    assert.match(body.send?.motivo ?? '', /parada_global/);

    assert.equal((await sendsDe(appId)).length, 0, 'no debe encolarse nada');
    const ivs = await intervencionesDe(appId);
    assert.equal(ivs.length, 1);
    assert.equal(ivs[0].kind, 'fuera_de_politica');
    assert.equal(ivs[0].status, 'abierta');
  });

  it('banda 70–75: la aprobación expresa de Jon basta para encolar desde 70 (decisión 20-oct-2026)', async () => {
    await autorizarModo(app, auth, 'preparar_para_revision');
    const appId = await seedCandidatura({ score: 72 });

    const res = await app.inject({
      method: 'POST',
      url: `/api/applications/${appId}/approve`,
      headers: authed(auth),
    });
    const body = res.json<{ send?: { send: string; motivo?: string } }>();
    assert.equal(body.send?.send, 'encolado');
    assert.equal((await sendsDe(appId)).length, 1);
    const ivs = await intervencionesDe(appId);
    assert.equal(ivs.length, 0);
  });

  it('en ejecutar_automatico, approve NO encadena (comportamiento intacto)', async () => {
    await autorizarModo(app, auth, 'ejecutar_automatico');
    const appId = await seedCandidatura({ score: 88 });

    const res = await app.inject({
      method: 'POST',
      url: `/api/applications/${appId}/approve`,
      headers: authed(auth),
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json<{ ok: boolean; send?: unknown }>();
    assert.equal(body.ok, true);
    assert.equal(body.send, undefined, 'sin campo send fuera del modo revisión');
    assert.equal((await sendsDe(appId)).length, 0);
  });

  it('el lote encadena por item: una encola y otra queda bloqueada con intervención', async () => {
    await autorizarModo(app, auth, 'preparar_para_revision');
    const buena = await seedCandidatura({ score: 90 });
    const baja = await seedCandidatura({ score: 60 });

    const res = await app.inject({
      method: 'POST',
      url: '/api/applications/review-batch',
      headers: authed(auth),
      payload: { ids: [buena, baja], action: 'approve' },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json<{
      items: Array<{ id: string; ok: boolean; send?: { send: string } }>;
    }>();
    const porId = new Map(body.items.map((i) => [i.id, i]));
    assert.equal(porId.get(buena)?.send?.send, 'encolado');
    assert.equal(porId.get(baja)?.send?.send, 'bloqueado');
    assert.equal((await sendsDe(buena)).length, 1);
    assert.equal((await sendsDe(baja)).length, 0);
    assert.equal((await intervencionesDe(baja)).length, 1);
  });

  it('el ejecutor SÍ procesa en modo revisión si la candidatura está approved', async () => {
    await autorizarModo(app, auth, 'preparar_para_revision');
    const appId = await seedCandidatura({ score: 88, appStatus: 'approved' });
    const s = await query<{ id: string }>(
      `INSERT INTO sends (application_id, idempotency_key, policy_version, status, evidence)
       VALUES ($1, $2, 2, 'queued', '{}'::jsonb) RETURNING id`,
      [appId, randomUUID()],
    );
    const fake = new FakeDriver();
    const r = await procesarEnvio(s[0].id, {
      workspaceBase: docBase,
      driverFactory: () => fake,
    });
    assert.equal(r.procesado, true);
    const send = await query<{ status: string }>(`SELECT status FROM sends WHERE id = $1`, [s[0].id]);
    assert.equal(send[0].status, 'sent');
    const appRow = await query<{ status: string }>(
      `SELECT status FROM applications WHERE id = $1`,
      [appId],
    );
    assert.equal(appRow[0].status, 'submitted');
    assert.ok(fake.llamadas.includes('enviarYConfirmar'));
  });

  it('el ejecutor NO procesa en modo revisión sin aprobación expresa (falla cerrado)', async () => {
    await autorizarModo(app, auth, 'preparar_para_revision');
    const appId = await seedCandidatura({ score: 88, appStatus: 'ready_for_review' });
    const s = await query<{ id: string }>(
      `INSERT INTO sends (application_id, idempotency_key, policy_version, status, evidence)
       VALUES ($1, $2, 2, 'queued', '{}'::jsonb) RETURNING id`,
      [appId, randomUUID()],
    );
    let factoryLlamada = false;
    const r = await procesarEnvio(s[0].id, {
      workspaceBase: docBase,
      driverFactory: () => {
        factoryLlamada = true;
        return new FakeDriver();
      },
    });
    assert.equal(r.procesado, true);
    const send = await query<{ status: string }>(`SELECT status FROM sends WHERE id = $1`, [s[0].id]);
    assert.equal(send[0].status, 'failed');
    assert.equal(factoryLlamada, false, 'la puerta actúa antes de crear el driver');
    const ivs = await intervencionesDe(appId);
    assert.ok(ivs.some((i) => i.kind === 'fuera_de_politica' && i.status === 'abierta'));
  });
});
