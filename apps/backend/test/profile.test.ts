/**
 * Tests del perfil: versiones, facts, activación, questionnaire e import-cv.
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import {
  authed,
  buildTestApp,
  closeTestApp,
  resetDb,
  setupAndLogin,
  type AuthContext,
} from './helpers.js';

describe('perfil', () => {
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

  it('GET /api/profile sin versión activa → 404 no_profile', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/profile',
      headers: authed(auth, false),
    });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.json(), { error: 'no_profile' });
  });

  it('GET /api/profile sin sesión → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/profile' });
    assert.equal(res.statusCode, 401);
  });

  it('POST /api/profile/versions exige CSRF', async () => {
    const sinCsrf = await app.inject({
      method: 'POST',
      url: '/api/profile/versions',
      headers: authed(auth, false),
      payload: { source: 'manual' },
    });
    assert.equal(sinCsrf.statusCode, 403);
    assert.deepEqual(sinCsrf.json(), { error: 'csrf_invalido' });
  });

  it('POST /api/profile/versions crea una versión en draft', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/profile/versions',
      headers: authed(auth),
      payload: { source: 'manual', notes: 'primera versión' },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json<{ id: string; versionNo: number; status: string }>();
    assert.equal(body.versionNo, 1);
    assert.equal(body.status, 'draft');
    assert.ok(body.id);
  });

  it('flujo completo: crear versión → añadir facts → activar → leer perfil', async () => {
    const v1 = await app.inject({
      method: 'POST',
      url: '/api/profile/versions',
      headers: authed(auth),
      payload: { source: 'manual' },
    });
    const v1Id = v1.json<{ id: string }>().id;

    const fact = await app.inject({
      method: 'POST',
      url: `/api/profile/versions/${v1Id}/facts`,
      headers: authed(auth),
      payload: {
        category: 'identidad',
        key: 'nombre_completo',
        value: 'Jon Peciña Iturbe',
        source: 'manual',
        validationStatus: 'confirmed',
      },
    });
    assert.equal(fact.statusCode, 201);

    const fact2 = await app.inject({
      method: 'POST',
      url: `/api/profile/versions/${v1Id}/facts`,
      headers: authed(auth),
      payload: {
        category: 'idiomas',
        key: 'ingles',
        value: { nivel: 'C1', certificado: false },
        source: 'manual',
      },
    });
    assert.equal(fact2.statusCode, 201);

    // Sin activar, el perfil sigue sin existir.
    const antes = await app.inject({
      method: 'GET',
      url: '/api/profile',
      headers: authed(auth, false),
    });
    assert.equal(antes.statusCode, 404);

    const activate = await app.inject({
      method: 'POST',
      url: `/api/profile/versions/${v1Id}/activate`,
      headers: authed(auth),
    });
    assert.equal(activate.statusCode, 200);
    assert.equal(activate.json().status, 'active');

    const perfil = await app.inject({
      method: 'GET',
      url: '/api/profile',
      headers: authed(auth, false),
    });
    assert.equal(perfil.statusCode, 200);
    const body = perfil.json<{
      version: { id: string; versionNo: number; status: string };
      facts: Array<{ category: string; key: string; value: unknown; validationStatus: string }>;
    }>();
    assert.equal(body.version.id, v1Id);
    assert.equal(body.version.status, 'active');
    assert.equal(body.facts.length, 2);
    const nombre = body.facts.find((f) => f.key === 'nombre_completo');
    assert.equal(nombre?.value, 'Jon Peciña Iturbe');
    assert.equal(nombre?.validationStatus, 'confirmed');
    const ingles = body.facts.find((f) => f.key === 'ingles');
    assert.deepEqual(ingles?.value, { nivel: 'C1', certificado: false });
  });

  it('activar una versión desactiva la anterior', async () => {
    const mk = async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/api/profile/versions',
        headers: authed(auth),
        payload: { source: 'manual' },
      });
      return r.json<{ id: string }>().id;
    };
    const v1 = await mk();
    const v2 = await mk();

    await app.inject({ method: 'POST', url: `/api/profile/versions/${v1}/activate`, headers: authed(auth) });
    await app.inject({ method: 'POST', url: `/api/profile/versions/${v2}/activate`, headers: authed(auth) });

    const perfil = await app.inject({
      method: 'GET',
      url: '/api/profile',
      headers: authed(auth, false),
    });
    assert.equal(perfil.json().version.id, v2);

    const lista = await app.inject({
      method: 'GET',
      url: '/api/profile/versions',
      headers: authed(auth, false),
    });
    const versions = lista.json<Array<{ id: string; status: string }>>();
    assert.equal(versions.find((v) => v.id === v1)?.status, 'draft');
    assert.equal(versions.find((v) => v.id === v2)?.status, 'active');
  });

  it('un fact duplicado (versión, categoría, clave) → 409', async () => {
    const v = await app.inject({
      method: 'POST',
      url: '/api/profile/versions',
      headers: authed(auth),
      payload: { source: 'manual' },
    });
    const vId = v.json<{ id: string }>().id;
    const payload = {
      category: 'identidad',
      key: 'nombre_completo',
      value: 'Jon',
      source: 'manual',
    };
    const first = await app.inject({
      method: 'POST',
      url: `/api/profile/versions/${vId}/facts`,
      headers: authed(auth),
      payload,
    });
    assert.equal(first.statusCode, 201);
    const dup = await app.inject({
      method: 'POST',
      url: `/api/profile/versions/${vId}/facts`,
      headers: authed(auth),
      payload,
    });
    assert.equal(dup.statusCode, 409);
  });

  it('añadir un fact a una versión inexistente → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/profile/versions/00000000-0000-0000-0000-000000000000/facts',
      headers: authed(auth),
      payload: { category: 'x', key: 'y', value: 1, source: 'manual' },
    });
    assert.equal(res.statusCode, 404);
  });

  it('POST /api/profile/import-cv → 501 not_implemented', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/profile/import-cv',
      headers: authed(auth),
      payload: {},
    });
    assert.equal(res.statusCode, 501);
    assert.deepEqual(res.json(), { error: 'not_implemented', reason: 'manual_seed' });
  });

  it('GET /api/profile/questionnaire devuelve los bloques esperados', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/profile/questionnaire',
      headers: authed(auth, false),
    });
    assert.equal(res.statusCode, 200);
    const blocks = res.json<
      Array<{
        id: string;
        titulo: string;
        preguntas: Array<{ id: string; texto: string; tipo: string; obligatoria: boolean }>;
      }>
    >();
    assert.deepEqual(
      blocks.map((b) => b.id),
      ['identidad_contacto', 'experiencia', 'educacion', 'competencias', 'idiomas', 'disponibilidad'],
    );
    for (const b of blocks) {
      assert.ok(b.titulo);
      assert.ok(b.preguntas.length > 0);
      for (const p of b.preguntas) {
        assert.ok(p.id && p.texto && p.tipo);
        assert.equal(typeof p.obligatoria, 'boolean');
      }
    }
  });
});
