/**
 * Tests del rate limit del login: 10 intentos / 5 minutos por IP.
 * Fichero separado para que el contador por IP empiece limpio, y con los
 * valores estrictos de producción fijados explícitamente (el helper de tests
 * relaja el límite por defecto para no interferir con los demás ficheros).
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, closeTestApp, resetDb } from './helpers.js';

describe('rate limit de /api/auth/login', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await buildTestApp({
      LOGIN_RATE_LIMIT_MAX: '10',
      LOGIN_RATE_LIMIT_WINDOW_MS: String(5 * 60 * 1000),
    });
  });
  beforeEach(async () => {
    await resetDb();
  });
  after(async () => {
    await closeTestApp(app);
  });

  it('permite 10 intentos y rechaza el 11.º con 429', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'admin', password: 'contrasena-muy-segura-123' },
    });

    for (let i = 0; i < 10; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'admin', password: 'intento-equivocado-000' },
      });
      assert.equal(res.statusCode, 401, `el intento ${i + 1} debería pasar el rate limit`);
    }

    const bloqueado = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'intento-equivocado-000' },
    });
    assert.equal(bloqueado.statusCode, 429);
    assert.equal(bloqueado.json().error, 'demasiados_intentos');
  });
});
