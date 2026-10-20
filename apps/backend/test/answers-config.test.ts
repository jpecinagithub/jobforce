/**
 * Tests de memoria de respuestas y de configuración.
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
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

describe('respuestas y configuración', () => {
  let app: FastifyInstance;
  let auth: AuthContext;

  before(async () => {
    app = await buildTestApp();
  });
  beforeEach(async () => {
    await resetDb();
    auth = await setupAndLogin(app);
  });
  after(async () => {
    await closeTestApp(app);
  });

  it('GET /api/answers empieza vacío', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/answers',
      headers: authed(auth, false),
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), []);
  });

  it('POST /api/answers guarda y GET la lista', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/answers',
      headers: authed(auth),
      payload: {
        questionOriginal: '¿Tienes permiso de trabajo en la UE?',
        questionNormalized: 'permiso trabajo ue',
        answer: 'Sí, ciudadano español.',
        source: 'manual',
        scopeType: 'general',
        reuseRule: 'reuse',
      },
    });
    assert.equal(created.statusCode, 201);
    assert.ok(created.json().id);

    const lista = await app.inject({
      method: 'GET',
      url: '/api/answers',
      headers: authed(auth, false),
    });
    assert.equal(lista.statusCode, 200);
    const answers = lista.json<Array<{ questionNormalized: string; language: string; reuseRule: string }>>();
    assert.equal(answers.length, 1);
    assert.equal(answers[0].questionNormalized, 'permiso trabajo ue');
    assert.equal(answers[0].language, 'es');
    assert.equal(answers[0].reuseRule, 'reuse');
  });

  it('POST /api/answers exige CSRF y valida el cuerpo', async () => {
    const sinCsrf = await app.inject({
      method: 'POST',
      url: '/api/answers',
      headers: authed(auth, false),
      payload: { questionOriginal: 'x', questionNormalized: 'x', answer: 'y', source: 'manual' },
    });
    assert.equal(sinCsrf.statusCode, 403);

    const incompleta = await app.inject({
      method: 'POST',
      url: '/api/answers',
      headers: authed(auth),
      payload: { questionOriginal: 'solo esto' },
    });
    assert.equal(incompleta.statusCode, 400);
  });

  it('la auditoría registra el alta de respuestas sin secretos', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/answers',
      headers: authed(auth),
      payload: {
        questionOriginal: '¿Pregunta?',
        questionNormalized: 'pregunta',
        answer: 'Respuesta.',
        source: 'manual',
      },
    });
    const rows = await query<{ action: string }>(
      `SELECT action FROM audit_events WHERE action = 'answer_created'`,
    );
    assert.equal(rows.length, 1);
  });

  it('PATCH /api/answers/:id actualiza la respuesta y audita', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/answers',
      headers: authed(auth),
      payload: {
        questionOriginal: '¿Pregunta?',
        questionNormalized: 'pregunta',
        answer: 'Respuesta vieja.',
        source: 'manual',
      },
    });
    assert.equal(created.statusCode, 201);
    const id = created.json().id as string;

    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/answers/${id}`,
      headers: authed(auth),
      payload: { answer: 'Respuesta nueva.', language: 'en' },
    });
    assert.equal(updated.statusCode, 200);
    assert.deepEqual(updated.json(), { ok: true });

    const lista = await app.inject({
      method: 'GET',
      url: '/api/answers',
      headers: authed(auth, false),
    });
    const [row] = lista.json<Array<{ answer: string; language: string; questionOriginal: string }>>();
    assert.equal(row.answer, 'Respuesta nueva.');
    assert.equal(row.language, 'en');
    assert.equal(row.questionOriginal, '¿Pregunta?');

    const audit = await query<{ action: string }>(
      `SELECT action FROM audit_events WHERE action = 'answer_updated'`,
    );
    assert.equal(audit.length, 1);
  });

  it('PATCH /api/answers/:id exige CSRF y valida id y cuerpo', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/answers',
      headers: authed(auth),
      payload: {
        questionOriginal: '¿Pregunta?',
        questionNormalized: 'pregunta',
        answer: 'Respuesta.',
        source: 'manual',
      },
    });
    const id = created.json().id as string;

    const sinCsrf = await app.inject({
      method: 'PATCH',
      url: `/api/answers/${id}`,
      headers: authed(auth, false),
      payload: { answer: 'x' },
    });
    assert.equal(sinCsrf.statusCode, 403);

    const vacio = await app.inject({
      method: 'PATCH',
      url: `/api/answers/${id}`,
      headers: authed(auth),
      payload: {},
    });
    assert.equal(vacio.statusCode, 400);

    const noUuid = await app.inject({
      method: 'PATCH',
      url: '/api/answers/no-es-uuid',
      headers: authed(auth),
      payload: { answer: 'x' },
    });
    assert.equal(noUuid.statusCode, 400);

    const inexistente = await app.inject({
      method: 'PATCH',
      url: '/api/answers/00000000-0000-4000-8000-000000000000',
      headers: authed(auth),
      payload: { answer: 'x' },
    });
    assert.equal(inexistente.statusCode, 404);
  });

  it('DELETE /api/answers/:id elimina la respuesta y audita', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/answers',
      headers: authed(auth),
      payload: {
        questionOriginal: '¿Pregunta?',
        questionNormalized: 'pregunta',
        answer: 'Respuesta.',
        source: 'manual',
      },
    });
    const id = created.json().id as string;

    const sinCsrf = await app.inject({
      method: 'DELETE',
      url: `/api/answers/${id}`,
      headers: authed(auth, false),
    });
    assert.equal(sinCsrf.statusCode, 403);

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/answers/${id}`,
      headers: authed(auth),
    });
    assert.equal(removed.statusCode, 200);
    assert.deepEqual(removed.json(), { ok: true });

    const lista = await app.inject({
      method: 'GET',
      url: '/api/answers',
      headers: authed(auth, false),
    });
    assert.deepEqual(lista.json(), []);

    const otra = await app.inject({
      method: 'DELETE',
      url: `/api/answers/${id}`,
      headers: authed(auth),
    });
    assert.equal(otra.statusCode, 404);

    const audit = await query<{ action: string }>(
      `SELECT action FROM audit_events WHERE action = 'answer_deleted'`,
    );
    assert.equal(audit.length, 1);
  });

  it('GET /api/config sin configuración → 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/config',
      headers: authed(auth, false),
    });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.json(), { error: 'sin_configuracion' });
  });

  it('GET /api/config devuelve la última versión no secreta', async () => {
    await query(
      `INSERT INTO configuration_versions (config, note) VALUES ($1, $2)`,
      [JSON.stringify({ idioma: 'es', zona_horaria: 'Europe/Madrid' }), 'configuración inicial'],
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/config',
      headers: authed(auth, false),
    });
    assert.equal(res.statusCode, 200);
    const body = res.json<{ versionNo: number; config: Record<string, unknown>; note: string }>();
    assert.equal(body.versionNo, 1);
    assert.deepEqual(body.config, { idioma: 'es', zona_horaria: 'Europe/Madrid' });
    assert.equal(body.note, 'configuración inicial');
  });

  it('GET /api/config exige sesión', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/config' });
    assert.equal(res.statusCode, 401);
  });
});
