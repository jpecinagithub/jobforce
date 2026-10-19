/**
 * Tests de la integración Gmail (Fase 5).
 *
 * - Cifrado de secretos (AES-256-GCM): roundtrip, clave inválida, sin clave.
 * - POST /api/integraciones/gmail/config: auth, CSRF, cifrado, auditoría
 *   sin valores y el secret nunca en respuestas.
 * - GET /api/integraciones/gmail/autorizar: URL de consentimiento + state
 *   de un solo uso; 503 sin credenciales.
 * - GET /api/integraciones/gmail/callback: 400 sin code/state, 400 con
 *   state inválido, flujo completo contra un Google falso, refresh_token
 *   cifrado en BD, state de un solo uso.
 * - POST /api/integraciones/gmail/revocar.
 * - Cookie de sesión: SameSite=None; Secure cuando SESSION_COOKIE_SECURE=true.
 *
 * Requieren DATABASE_URL (PostgreSQL real).
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { query } from '@jobforce/database';
import {
  SecretCryptoError,
  decryptSecret,
  encryptSecret,
  resolveEncryptionKey,
} from '../src/secrets.js';
import {
  authed,
  buildTestApp,
  closeTestApp,
  resetDb,
  setupAndLogin,
  type AuthContext,
} from './helpers.js';

/** Google falso: solo los endpoints que usa el flujo OAuth. */
function startFakeGoogle() {
  const seen: { tokenBodies: string[] } = { tokenBodies: [] };
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/token') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.tokenBodies.push(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            access_token: 'fake-access-token',
            refresh_token: 'fake-refresh-token-abc123',
            expires_in: 3600,
            scope: 'https://www.googleapis.com/auth/gmail.readonly',
            token_type: 'Bearer',
          }),
        );
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/userinfo') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ email: 'jon@example.com' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise<{ base: string; seen: typeof seen; close: () => Promise<void> }>(
    (resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo;
        resolve({
          base: `http://127.0.0.1:${port}`,
          seen,
          close: () => new Promise((r) => server.close(() => r())),
        });
      });
    },
  );
}

const FAKE_CLIENT_ID = '1234567890-abcdef.apps.googleusercontent.com';
const FAKE_CLIENT_SECRET = 'GOCSPX-fake-secret-para-tests-0123456789';

describe('cifrado de secretos', () => {
  it('roundtrip: cifrar y descifrar recupera el valor original', () => {
    const key = resolveEncryptionKey(randomBytes(32).toString('base64'));
    const enc = encryptSecret('secreto-super-sensible', key);
    assert.equal(decryptSecret(enc, key), 'secreto-super-sensible');
    // El ciphertext no contiene el valor en claro.
    assert.ok(!enc.ciphertext.includes('secreto-super-sensible'));
    assert.ok(!Buffer.from(enc.ciphertext, 'base64').toString('utf8').includes('super-sensible'));
  });

  it('cada cifrado usa un nonce distinto', () => {
    const key = resolveEncryptionKey(randomBytes(32).toString('hex'));
    const a = encryptSecret('x', key);
    const b = encryptSecret('x', key);
    assert.notEqual(a.nonce, b.nonce);
    assert.notEqual(a.ciphertext, b.ciphertext);
  });

  it('sin SECRETS_ENCRYPTION_KEY lanza SecretCryptoError', () => {
    assert.throws(() => resolveEncryptionKey(null), SecretCryptoError);
    assert.throws(() => resolveEncryptionKey(''), SecretCryptoError);
    assert.throws(() => resolveEncryptionKey(undefined), SecretCryptoError);
  });

  it('clave de longitud inválida lanza SecretCryptoError', () => {
    assert.throws(() => resolveEncryptionKey('demasiado-corta'), SecretCryptoError);
    assert.throws(() => resolveEncryptionKey(randomBytes(16).toString('base64')), SecretCryptoError);
  });
});

describe('rutas de Gmail', () => {
  let app: FastifyInstance;
  let auth: AuthContext;
  let fakeGoogle: { base: string; seen: { tokenBodies: string[] }; close: () => Promise<void> };
  const encKey = randomBytes(32).toString('base64');

  before(async () => {
    fakeGoogle = await startFakeGoogle();
    app = await buildTestApp({
      SECRETS_ENCRYPTION_KEY: encKey,
      GOOGLE_AUTH_URL: `${fakeGoogle.base}/auth`,
      GOOGLE_TOKEN_URL: `${fakeGoogle.base}/token`,
      GOOGLE_USERINFO_URL: `${fakeGoogle.base}/userinfo`,
      GOOGLE_REDIRECT_URI: 'https://panel.example.com/api/integraciones/gmail/callback',
    });
  });

  after(async () => {
    await closeTestApp(app);
    await fakeGoogle.close();
  });

  beforeEach(async () => {
    await resetDb();
    auth = await setupAndLogin(app);
  });

  it('callback sin code ni state → 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/integraciones/gmail/callback' });
    assert.equal(res.statusCode, 400);
  });

  it('callback con state inexistente → 400 estado_invalido', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/integraciones/gmail/callback?code=x&state=no-existe',
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'estado_invalido');
  });

  it('estado exige sesión', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/integraciones/gmail/estado' });
    assert.equal(res.statusCode, 401);
  });

  it('config: 401 sin sesión, 403 con sesión pero sin CSRF', async () => {
    const sinSesion = await app.inject({
      method: 'POST',
      url: '/api/integraciones/gmail/config',
      payload: { clientId: FAKE_CLIENT_ID, clientSecret: FAKE_CLIENT_SECRET },
    });
    assert.equal(sinSesion.statusCode, 401);

    const sinCsrf = await app.inject({
      method: 'POST',
      url: '/api/integraciones/gmail/config',
      headers: authed(auth, false),
      payload: { clientId: FAKE_CLIENT_ID, clientSecret: FAKE_CLIENT_SECRET },
    });
    assert.equal(sinCsrf.statusCode, 403);
  });

  it('config rechaza cuerpos inválidos sin exponer valores', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/integraciones/gmail/config',
      headers: authed(auth),
      payload: { clientId: 'x', clientSecret: 'y' },
    });
    assert.equal(res.statusCode, 400);
    assert.ok(!res.body.includes('x'));
  });

  it('autorizar sin credenciales → 503 oauth_no_configurado', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/integraciones/gmail/autorizar',
      headers: authed(auth, false),
    });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error, 'oauth_no_configurado');
  });

  it('flujo completo: config → autorizar → callback → estado → revocar', async () => {
    // 1. Guardar credenciales en el campo protegido.
    const cfg = await app.inject({
      method: 'POST',
      url: '/api/integraciones/gmail/config',
      headers: authed(auth),
      payload: { clientId: FAKE_CLIENT_ID, clientSecret: FAKE_CLIENT_SECRET },
    });
    assert.equal(cfg.statusCode, 200);
    assert.ok(!cfg.body.includes(FAKE_CLIENT_SECRET), 'el secret no sale en la respuesta');

    // La BD guarda ciphertext, nunca el valor en claro.
    const settings = await query<{ clave: string; value_ciphertext: string }>(
      'SELECT clave, value_ciphertext FROM protected_settings',
    );
    assert.equal(settings.length, 2);
    for (const s of settings) {
      assert.ok(!s.value_ciphertext.includes(FAKE_CLIENT_SECRET));
      assert.ok(!s.value_ciphertext.includes(FAKE_CLIENT_ID.replace('.apps.googleusercontent.com', '')));
    }

    // 2. Auditoría sin valores.
    const audit = await query<{ action: string; details: { campos: string[] } }>(
      `SELECT action, details FROM audit_events WHERE action = 'gmail_oauth_config_actualizada'`,
    );
    assert.equal(audit.length, 1);
    assert.deepEqual(audit[0].details.campos, ['google_client_id', 'google_client_secret']);
    assert.ok(!JSON.stringify(audit[0].details).includes(FAKE_CLIENT_SECRET));

    // 3. Estado: configurado, sin secret en la respuesta.
    const estado1 = await app.inject({
      method: 'GET',
      url: '/api/integraciones/gmail/estado',
      headers: authed(auth, false),
    });
    assert.equal(estado1.statusCode, 200);
    const e1 = estado1.json();
    assert.equal(e1.client.configured, true);
    assert.equal(e1.client.clientId, FAKE_CLIENT_ID);
    assert.equal(e1.secretConfigured, true);
    assert.equal(e1.oauth.connected, false);
    assert.equal(e1.redirectUri, 'https://panel.example.com/api/integraciones/gmail/callback');
    assert.ok(!estado1.body.includes(FAKE_CLIENT_SECRET));

    // 4. Autorizar: URL de consentimiento con el state de un solo uso.
    const aut = await app.inject({
      method: 'GET',
      url: '/api/integraciones/gmail/autorizar',
      headers: authed(auth, false),
    });
    assert.equal(aut.statusCode, 200);
    const { url } = aut.json<{ url: string }>();
    assert.ok(url.startsWith(`${fakeGoogle.base}/auth?`));
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('client_id'), FAKE_CLIENT_ID);
    assert.equal(
      parsed.searchParams.get('redirect_uri'),
      'https://panel.example.com/api/integraciones/gmail/callback',
    );
    assert.equal(parsed.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.readonly');
    assert.equal(parsed.searchParams.get('access_type'), 'offline');
    assert.equal(parsed.searchParams.get('prompt'), 'consent');
    const state = parsed.searchParams.get('state');
    assert.ok(state && state.length >= 32);

    // 5. Callback: intercambio contra el Google falso.
    const cb = await app.inject({
      method: 'GET',
      url: `/api/integraciones/gmail/callback?code=codigo-falso&state=${state}`,
    });
    assert.equal(cb.statusCode, 200, `callback inesperado: ${cb.statusCode} ${cb.body}`);
    assert.deepEqual(cb.json(), { ok: true, accountEmail: 'jon@example.com' });

    // El intercambio usó el secret del panel (no el del entorno).
    const tokenBody = fakeGoogle.seen.tokenBodies.at(-1) ?? '';
    assert.ok(tokenBody.includes(encodeURIComponent(FAKE_CLIENT_SECRET)));

    // 6. El refresh_token queda cifrado en BD.
    const tokens = await query<{
      refresh_token_ciphertext: string;
      account_email: string | null;
      revoked_at: Date | null;
    }>('SELECT refresh_token_ciphertext, account_email, revoked_at FROM gmail_tokens');
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].account_email, 'jon@example.com');
    assert.equal(tokens[0].revoked_at, null);
    assert.ok(!tokens[0].refresh_token_ciphertext.includes('fake-refresh-token-abc123'));

    // 7. El state ya se consumió: segundo uso → 400.
    const reuse = await app.inject({
      method: 'GET',
      url: `/api/integraciones/gmail/callback?code=otro&state=${state}`,
    });
    assert.equal(reuse.statusCode, 400);

    // 8. Estado: conectado.
    const estado2 = await app.inject({
      method: 'GET',
      url: '/api/integraciones/gmail/estado',
      headers: authed(auth, false),
    });
    const e2 = estado2.json();
    assert.equal(e2.oauth.connected, true);
    assert.equal(e2.oauth.accountEmail, 'jon@example.com');

    // 9. Revocar.
    const rev = await app.inject({
      method: 'POST',
      url: '/api/integraciones/gmail/revocar',
      headers: authed(auth),
    });
    assert.equal(rev.statusCode, 200);
    assert.equal(rev.json().revocado, true);
    const estado3 = await app.inject({
      method: 'GET',
      url: '/api/integraciones/gmail/estado',
      headers: authed(auth, false),
    });
    assert.equal(estado3.json().oauth.connected, false);
  });

  it('callback con state caducado → 400', async () => {
    await query(
      `INSERT INTO gmail_oauth_states (state, expires_at)
       VALUES ('caducado-123', now() - interval '1 minute')`,
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/integraciones/gmail/callback?code=x&state=caducado-123',
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'estado_invalido');
  });

  it('sin SECRETS_ENCRYPTION_KEY, guardar config → 503', async () => {
    const appSinClave = await buildTestApp({
      SECRETS_ENCRYPTION_KEY: '',
      GOOGLE_REDIRECT_URI: 'https://panel.example.com/api/integraciones/gmail/callback',
    });
    try {
      const res = await appSinClave.inject({
        method: 'POST',
        url: '/api/integraciones/gmail/config',
        headers: authed(auth),
        payload: { clientId: FAKE_CLIENT_ID, clientSecret: FAKE_CLIENT_SECRET },
      });
      assert.equal(res.statusCode, 503);
      assert.equal(res.json().error, 'cifrado_no_configurado');
    } finally {
      await appSinClave.close();
    }
  });
});

describe('cookie de sesión cross-site', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('con SESSION_COOKIE_SECURE=true la cookie es SameSite=None; Secure', async () => {
    const app = await buildTestApp({
      SESSION_COOKIE_SECURE: 'true',
      SECRETS_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    });
    try {
      const auth = await setupAndLogin(app, 'admin', 'CookieTest-123-segura');
      // Segundo login para inspeccionar la cabecera Set-Cookie.
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: auth.username, password: 'CookieTest-123-segura' },
      });
      assert.equal(login.statusCode, 200);
      const setCookie = String(login.headers['set-cookie'] ?? '');
      assert.ok(setCookie.includes('SameSite=None'), `falta SameSite=None: ${setCookie}`);
      assert.ok(setCookie.includes('Secure'), `falta Secure: ${setCookie}`);
      assert.ok(setCookie.includes('HttpOnly'), `falta HttpOnly: ${setCookie}`);
    } finally {
      await closeTestApp(app);
    }
  });

  it('sin secure (desarrollo) la cookie sigue siendo SameSite=Lax', async () => {
    const app = await buildTestApp({
      SESSION_COOKIE_SECURE: 'false',
      SECRETS_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    });
    try {
      const auth = await setupAndLogin(app, 'admin', 'CookieTest-123-segura');
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: auth.username, password: 'CookieTest-123-segura' },
      });
      const setCookie = String(login.headers['set-cookie'] ?? '');
      assert.ok(setCookie.includes('SameSite=Lax'), `se esperaba Lax: ${setCookie}`);
      assert.ok(!setCookie.includes('SameSite=None'));
    } finally {
      await closeTestApp(app);
    }
  });
});
