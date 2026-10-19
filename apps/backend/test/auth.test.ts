/**
 * Tests de autenticación: health, setup, login, logout, me, sesiones y CSRF.
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
} from './helpers.js';

describe('auth', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await buildTestApp();
  });
  beforeEach(async () => {
    await resetDb();
  });
  after(async () => {
    await closeTestApp(app);
  });

  it('GET /api/health responde sin autenticación', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true, version: '0.1.0' });
  });

  it('POST /api/auth/setup crea el admin con hash argon2id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'admin', password: 'contrasena-muy-segura-123' },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json<{ id: string; username: string }>();
    assert.equal(body.username, 'admin');
    assert.ok(body.id);

    const rows = await query<{ password_hash: string }>(
      'SELECT password_hash FROM admin_users WHERE username = $1',
      ['admin'],
    );
    assert.ok(rows[0].password_hash.startsWith('$argon2id$'), 'el hash debe ser argon2id');
    assert.ok(!rows[0].password_hash.includes('contrasena'), 'el hash no contiene la contraseña');
  });

  it('POST /api/auth/setup rechaza un segundo admin (409)', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'admin', password: 'contrasena-muy-segura-123' },
    });
    assert.equal(first.statusCode, 201);

    const second = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'otro', password: 'otra-contrasena-segura' },
    });
    assert.equal(second.statusCode, 409);
    assert.deepEqual(second.json(), { error: 'admin_exists' });
  });

  it('POST /api/auth/setup valida username y password (400)', async () => {
    const shortPass = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'admin', password: 'corta' },
    });
    assert.equal(shortPass.statusCode, 400);

    const shortUser = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'ab', password: 'contrasena-muy-segura-123' },
    });
    assert.equal(shortUser.statusCode, 400);
  });

  it('POST /api/auth/login rechaza credenciales incorrectas (401)', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'admin', password: 'contrasena-muy-segura-123' },
    });

    const wrongPass = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'contrasena-equivocada-000' },
    });
    assert.equal(wrongPass.statusCode, 401);

    const unknownUser = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'nadie', password: 'contrasena-muy-segura-123' },
    });
    assert.equal(unknownUser.statusCode, 401);
    assert.deepEqual(wrongPass.json(), unknownUser.json(), 'no debe revelar qué falló');
  });

  it('POST /api/auth/login devuelve cookie de sesión y csrfToken', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'admin', password: 'contrasena-muy-segura-123' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'contrasena-muy-segura-123' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json<{ username: string; csrfToken: string }>();
    assert.equal(body.username, 'admin');
    assert.ok(body.csrfToken);

    const setCookie = String(res.headers['set-cookie']);
    assert.match(setCookie, /jobforce_session=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);

    // En BD solo se guarda el sha256 del token, nunca el token crudo.
    const tokenCrudo = setCookie.split(';')[0].split('=')[1];
    const sessions = await query<{ token_hash: string }>('SELECT token_hash FROM user_sessions');
    assert.equal(sessions.length, 1);
    assert.ok(!sessions[0].token_hash.includes(tokenCrudo));
    assert.equal(sessions[0].token_hash.length, 64);
  });

  it('GET /api/auth/me exige sesión', async () => {
    const anon = await app.inject({ method: 'GET', url: '/api/auth/me' });
    assert.equal(anon.statusCode, 401);

    const auth = await setupAndLogin(app);
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: authed(auth, false) });
    assert.equal(me.statusCode, 200);
    assert.deepEqual(me.json(), { username: 'admin', csrfToken: auth.csrfToken });
  });

  it('una cookie manipulada no autentica (401)', async () => {
    const auth = await setupAndLogin(app);
    const fake = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: 'jobforce_session=' + '00'.repeat(32) },
    });
    assert.equal(fake.statusCode, 401);
    void auth;
  });

  it('la sesión caducada deja de autenticar (401)', async () => {
    const auth = await setupAndLogin(app);
    await query(`UPDATE user_sessions SET expires_at = now() - interval '1 hour'`);
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: authed(auth, false) });
    assert.equal(me.statusCode, 401);
  });

  it('POST /api/auth/logout exige CSRF y cierra la sesión', async () => {
    const auth = await setupAndLogin(app);

    const sinCsrf = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: authed(auth, false),
    });
    assert.equal(sinCsrf.statusCode, 403);

    const csrfMal = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { ...authed(auth, false), 'x-csrf-token': 'invalido' },
    });
    assert.equal(csrfMal.statusCode, 403);

    const ok = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: authed(auth),
    });
    assert.equal(ok.statusCode, 200);

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: authed(auth, false) });
    assert.equal(me.statusCode, 401, 'tras el logout la sesión ya no vale');
  });

  it('la auditoría registra setup/login/logout sin secretos', async () => {
    const auth = await setupAndLogin(app);
    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: authed(auth) });

    const rows = await query<{ action: string; details: unknown }>(
      'SELECT action, details FROM audit_events ORDER BY occurred_at',
    );
    const actions = rows.map((r) => r.action);
    assert.deepEqual(actions, ['admin_created', 'auth_login', 'auth_logout']);

    const serialized = JSON.stringify(rows);
    assert.ok(!/password/i.test(serialized), 'la auditoría no guarda contraseñas');
    assert.ok(!/csrf/i.test(serialized), 'la auditoría no guarda tokens CSRF');
  });
});
