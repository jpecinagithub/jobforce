/**
 * Tests de etiquetas y métricas de precisión (Fase 6.4).
 *
 * - Upsert de etiqueta de oferta (+ 404 si la oferta no existe).
 * - GET /api/labels/offers con predicción score>=70 y filtro solo_sin_etiqueta.
 * - Métricas con 0 etiquetas → mensaje de "sin etiquetas".
 * - Métricas con un juego conocido: 4 ofertas (VP=1, FP=1, FN=1, VN=1)
 *   → precisión 0.5 y recall 0.5.
 * - Upsert de etiqueta de correo y matriz de confusión de /api/metricas/precision.
 *
 * Requieren `DATABASE_URL` en el entorno.
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

let app: FastifyInstance;
let auth: AuthContext;

async function crearOfertaEvaluada(
  score: number,
  company = 'Acme Corp',
): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const c = await query<{ id: string }>(
    `INSERT INTO campaigns (name, criteria) VALUES ('camp-labels', '{}'::jsonb) RETURNING id`,
  );
  const o = await query<{ id: string }>(
    `INSERT INTO offers (campaign_id, canonical_url, url, title, company)
     VALUES ($1, $2, $3, 'Finance Manager', $4) RETURNING id`,
    [
      c[0].id,
      `https://empleo.example/oferta/${suffix}`,
      `https://empleo.example/oferta/${suffix}`,
      company,
    ],
  );
  await query(
    `INSERT INTO evaluations (offer_id, campaign_id, mandatory_verdict, mandatory_details, score, breakdown)
     VALUES ($1, $2, 'cumple', '[]'::jsonb, $3, '[]'::jsonb)`,
    [o[0].id, c[0].id, score],
  );
  return o[0].id;
}

async function crearCorreoSeguimiento(
  classification: string,
  gmailId?: string,
): Promise<string> {
  const id = gmailId ?? `msg-${randomUUID().slice(0, 8)}`;
  await query(
    `INSERT INTO gmail_messages (gmail_id, classification, subject, from_addr, received_at)
     VALUES ($1, $2, 'Asunto de prueba', 'rrhh@example.com', now())`,
    [id, classification],
  );
  return id;
}

describe('etiquetas de ofertas', () => {
  before(async () => {
    app = await buildTestApp();
  });
  after(async () => closeTestApp(app));
  beforeEach(async () => {
    await resetDb();
    auth = await setupAndLogin(app);
  });

  it('upsert de etiqueta: crea y actualiza la etiqueta de la oferta', async () => {
    const offerId = await crearOfertaEvaluada(82);

    const crear = await app.inject({
      method: 'POST',
      url: '/api/labels/offers',
      headers: authed(auth),
      payload: { offer_id: offerId, encaja_real: true, nota: 'Buen encaje' },
    });
    assert.equal(crear.statusCode, 200, crear.body);
    assert.deepEqual(JSON.parse(crear.body), { ok: true, offer_id: offerId, encaja_real: true });

    const actualizar = await app.inject({
      method: 'POST',
      url: '/api/labels/offers',
      headers: authed(auth),
      payload: { offer_id: offerId, encaja_real: false },
    });
    assert.equal(actualizar.statusCode, 200, actualizar.body);

    const filas = await query<{ encaja_real: boolean; nota: string | null }>(
      'SELECT encaja_real, nota FROM etiquetas_ofertas WHERE offer_id = $1',
      [offerId],
    );
    assert.equal(filas.length, 1, 'el upsert no debe duplicar la fila');
    assert.equal(filas[0].encaja_real, false);
    assert.equal(filas[0].nota, null);
  });

  it('404 cuando la oferta no existe', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/labels/offers',
      headers: authed(auth),
      payload: { offer_id: randomUUID(), encaja_real: true },
    });
    assert.equal(res.statusCode, 404);
    assert.equal(JSON.parse(res.body).error, 'oferta_no_encontrada');
  });

  it('valida el cuerpo: oferta sin UUID o sin booleano → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/labels/offers',
      headers: authed(auth),
      payload: { offer_id: 'no-es-uuid', encaja_real: 'si' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('exige CSRF en el POST', async () => {
    const offerId = await crearOfertaEvaluada(82);
    const res = await app.inject({
      method: 'POST',
      url: '/api/labels/offers',
      headers: authed(auth, false),
      payload: { offer_id: offerId, encaja_real: true },
    });
    assert.equal(res.statusCode, 403, res.body);
  });

  it('GET lista con score, predicción y etiqueta; ordena por score DESC', async () => {
    const alta = await crearOfertaEvaluada(85, 'Globex');
    const baja = await crearOfertaEvaluada(55, 'Initech');
    await app.inject({
      method: 'POST',
      url: '/api/labels/offers',
      headers: authed(auth),
      payload: { offer_id: baja, encaja_real: false },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/labels/offers',
      headers: authed(auth, false),
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as {
      total: number;
      etiquetadas: number;
      ofertas: Array<{
        offer_id: string;
        company: string;
        score: number;
        encaja: boolean;
        encaja_real: boolean | null;
      }>;
    };
    assert.equal(body.total, 2);
    assert.equal(body.etiquetadas, 1);
    assert.equal(body.ofertas[0].offer_id, alta, 'primero el score más alto');
    assert.equal(body.ofertas[0].score, 85);
    assert.equal(body.ofertas[0].encaja, true, 'score>=70 ⇒ predice que encaja');
    assert.equal(body.ofertas[0].encaja_real, null);
    assert.equal(body.ofertas[1].score, 55);
    assert.equal(body.ofertas[1].encaja, false);
    assert.equal(body.ofertas[1].encaja_real, false);
  });

  it('?solo_sin_etiqueta=true oculta las ya etiquetadas', async () => {
    const una = await crearOfertaEvaluada(85);
    await crearOfertaEvaluada(55);
    await app.inject({
      method: 'POST',
      url: '/api/labels/offers',
      headers: authed(auth),
      payload: { offer_id: una, encaja_real: true },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/labels/offers?solo_sin_etiqueta=true',
      headers: authed(auth, false),
    });
    const body = JSON.parse(res.body) as { total: number };
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(body.total, 1);
  });
});

describe('etiquetas de correos', () => {
  before(async () => {
    app = await buildTestApp();
  });
  after(async () => closeTestApp(app));
  beforeEach(async () => {
    await resetDb();
    auth = await setupAndLogin(app);
  });

  it('upsert de etiqueta de correo sobre un mensaje del seguimiento', async () => {
    const gmailId = await crearCorreoSeguimiento('rechazo');
    const res = await app.inject({
      method: 'POST',
      url: '/api/labels/emails',
      headers: authed(auth),
      payload: { mensaje_id: gmailId, clasificacion_real: 'rechazo' },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(JSON.parse(res.body), {
      ok: true,
      mensaje_id: gmailId,
      clasificacion_real: 'rechazo',
    });

    const filas = await query<{ clasificacion_real: string }>(
      'SELECT clasificacion_real FROM etiquetas_correos WHERE mensaje_id = $1',
      [gmailId],
    );
    assert.equal(filas.length, 1);
    assert.equal(filas[0].clasificacion_real, 'rechazo');
  });

  it('rechaza clasificaciones fuera del vocabulario', async () => {
    const gmailId = await crearCorreoSeguimiento('rechazo');
    const res = await app.inject({
      method: 'POST',
      url: '/api/labels/emails',
      headers: authed(auth),
      payload: { mensaje_id: gmailId, clasificacion_real: 'confirmacion_envio' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('GET expone la clasificación predicha del sistema y la etiqueta actual', async () => {
    const gmailId = await crearCorreoSeguimiento('entrevista');
    await app.inject({
      method: 'POST',
      url: '/api/labels/emails',
      headers: authed(auth),
      payload: { mensaje_id: gmailId, clasificacion_real: 'ambiguo', nota: 'dudoso' },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/labels/emails',
      headers: authed(auth, false),
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as {
      total: number;
      etiquetados: number;
      correos: Array<{
        mensaje_id: string;
        asunto: string;
        predicha: string;
        clasificacion_real: string | null;
        nota: string | null;
      }>;
    };
    assert.equal(body.total, 1);
    assert.equal(body.etiquetados, 1);
    assert.equal(body.correos[0].predicha, 'entrevista');
    assert.equal(body.correos[0].clasificacion_real, 'ambiguo');
    assert.equal(body.correos[0].nota, 'dudoso');
  });
});

describe('métricas de precisión', () => {
  before(async () => {
    app = await buildTestApp();
  });
  after(async () => closeTestApp(app));
  beforeEach(async () => {
    await resetDb();
    auth = await setupAndLogin(app);
  });

  async function etiquetarOferta(offerId: string, encajaReal: boolean): Promise<void> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/labels/offers',
      headers: authed(auth),
      payload: { offer_id: offerId, encaja_real: encajaReal },
    });
    assert.equal(res.statusCode, 200, res.body);
  }

  async function etiquetarCorreo(mensajeId: string, real: string): Promise<void> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/labels/emails',
      headers: authed(auth),
      payload: { mensaje_id: mensajeId, clasificacion_real: real },
    });
    assert.equal(res.statusCode, 200, res.body);
  }

  it('con 0 etiquetas devuelve el mensaje de "sin etiquetas todavía"', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/metricas/precision',
      headers: authed(auth, false),
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as {
      encaje: { n: number; mensaje: string };
      correos: { n: number; mensaje: string };
    };
    assert.equal(body.encaje.n, 0);
    assert.ok(body.encaje.mensaje.includes('Sin etiquetas todavía'));
    assert.equal(body.correos.n, 0);
    assert.ok(body.correos.mensaje.includes('Sin etiquetas todavía'));
  });

  it('juego conocido: VP=1, FP=1, FN=1, VN=1 → precisión 0.5 y recall 0.5', async () => {
    // Predicción del sistema: score >= 70 ⇒ encaja.
    const vp = await crearOfertaEvaluada(80); // predice sí, real sí
    const fp = await crearOfertaEvaluada(75); // predice sí, real no
    const fn = await crearOfertaEvaluada(60); // predice no, real sí
    const vn = await crearOfertaEvaluada(40); // predice no, real no
    await etiquetarOferta(vp, true);
    await etiquetarOferta(fp, false);
    await etiquetarOferta(fn, true);
    await etiquetarOferta(vn, false);

    const res = await app.inject({
      method: 'GET',
      url: '/api/metricas/precision',
      headers: authed(auth, false),
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as {
      encaje: {
        n: number;
        vp: number;
        fp: number;
        fn: number;
        vn: number;
        precision: number;
        recall: number;
      };
    };
    assert.deepEqual(
      { vp: body.encaje.vp, fp: body.encaje.fp, fn: body.encaje.fn, vn: body.encaje.vn },
      { vp: 1, fp: 1, fn: 1, vn: 1 },
    );
    assert.equal(body.encaje.n, 4);
    assert.equal(body.encaje.precision, 0.5, '1/(1+1)');
    assert.equal(body.encaje.recall, 0.5, '1/(1+1)');
  });

  it('la matriz de confusión de correos compara predicha vs. etiqueta real', async () => {
    // 'confirmacion_envio' del sistema se normaliza a 'confirmacion'.
    const a = await crearCorreoSeguimiento('confirmacion_envio');
    const b = await crearCorreoSeguimiento('rechazo');
    const c = await crearCorreoSeguimiento('rechazo');
    await etiquetarCorreo(a, 'confirmacion'); // acierto
    await etiquetarCorreo(b, 'entrevista'); // fallo: predijo rechazo, real entrevista
    await etiquetarCorreo(c, 'rechazo'); // acierto

    const res = await app.inject({
      method: 'GET',
      url: '/api/metricas/precision',
      headers: authed(auth, false),
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as {
      correos: {
        n: number;
        con_prediccion: number;
        correctas: number;
        errores: number;
        exactitud: number;
        matriz: Record<string, number>;
      };
    };
    assert.equal(body.correos.n, 3);
    assert.equal(body.correos.con_prediccion, 3);
    assert.equal(body.correos.correctas, 2);
    assert.equal(body.correos.errores, 1);
    assert.equal(body.correos.exactitud, 0.667, '2/3 redondeado a 3 decimales');
    assert.deepEqual(body.correos.matriz, {
      confirmacion__confirmacion: 1,
      rechazo__entrevista: 1,
      rechazo__rechazo: 1,
    });
  });

  it('las etiquetas cambian el informe: añadir etiquetas actualiza n', async () => {
    const primera = await app.inject({
      method: 'GET',
      url: '/api/metricas/precision',
      headers: authed(auth, false),
    });
    assert.equal(JSON.parse(primera.body).encaje.n, 0);

    const offerId = await crearOfertaEvaluada(90);
    await etiquetarOferta(offerId, true);

    const segunda = await app.inject({
      method: 'GET',
      url: '/api/metricas/precision',
      headers: authed(auth, false),
    });
    const body = JSON.parse(segunda.body) as {
      encaje: { n: number; vp: number; precision: number };
    };
    assert.equal(body.encaje.n, 1);
    assert.equal(body.encaje.vp, 1);
    assert.equal(body.encaje.precision, 1);
  });
});
