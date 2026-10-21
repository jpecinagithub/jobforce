/**
 * @jobforce/backend — Integración Gmail (OAuth 2.0 de Google).
 *
 * - GET  /api/integraciones/gmail/estado     → estado de la integración
 *   (sesión; solo lectura; nunca devuelve el client_secret).
 * - POST /api/integraciones/gmail/config     → guarda client_id/secret
 *   CIFRADOS en `protected_settings` (sesión + CSRF; solo escritura).
 * - GET  /api/integraciones/gmail/autorizar  → URL de consentimiento de
 *   Google con `state` anti-CSRF de un solo uso (sesión; solo lectura).
 * - GET  /api/integraciones/gmail/callback   → callback OAuth público:
 *   valida state, intercambia code por tokens y guarda el refresh_token
 *   CIFRADO en `gmail_tokens`. Sin code/state → 400.
 * - POST /api/integraciones/gmail/revocar    → marca los tokens como
 *   revocados (sesión + CSRF).
 *
 * Reglas de seguridad: el client_secret y el refresh_token jamás salen en
 * claro en logs, respuestas ni auditoría. Las credenciales pueden venir del
 * panel (`protected_settings`, cifradas: tienen prioridad) o del entorno
 * (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`).
 */

import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '@jobforce/config';
import { query, withTransaction } from '@jobforce/database';
import { auditEvent } from '../audit.js';
import { requireCsrf, requireSession } from '../auth.js';
import {
  SecretCryptoError,
  decryptSecret,
  encryptSecret,
  resolveEncryptionKey,
} from '../secrets.js';
import { validateBody } from '../validation.js';

// Lectura (seguimiento) + envío (canal email del agente): el envío solo
// se activa cuando el ámbito GUARDADO incluye gmail.send, es decir, si
// Jon reconecta Gmail después de esta ampliación (2026-10-21).
const GMAIL_SCOPE =
  'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send';
const STATE_TTL_MS = 15 * 60 * 1000;
const GOOGLE_TIMEOUT_MS = 15_000;

const ConfigBody = z.object({
  clientId: z
    .string()
    .trim()
    .min(10, 'el client_id es demasiado corto')
    .max(200, 'el client_id es demasiado largo'),
  clientSecret: z
    .string()
    .trim()
    .min(10, 'el client_secret es demasiado corto')
    .max(200, 'el client_secret es demasiado largo'),
});

const CallbackQuery = z.object({
  code: z.string().min(1, 'falta el parámetro code'),
  state: z.string().min(1, 'falta el parámetro state'),
});

interface ProtectedSettingRow {
  clave: string;
  value_ciphertext: string;
  value_nonce: string;
}

interface GmailTokenRow {
  account_email: string | null;
  scope: string | null;
  obtained_at: Date;
  revoked_at: Date | null;
}

interface GoogleCreds {
  clientId: string;
  clientSecret: string;
  fromPanel: boolean;
}

/**
 * Lee las credenciales de Google: primero el panel (`protected_settings`,
 * cifradas), si no el entorno. null si no hay ninguna configurada.
 * Lanza SecretCryptoError si hay valores en el panel pero falta la clave.
 */
async function readGoogleCreds(config: AppConfig): Promise<GoogleCreds | null> {
  const rows = await query<ProtectedSettingRow>(
    `SELECT clave, value_ciphertext, value_nonce FROM protected_settings
      WHERE clave IN ('google_client_id', 'google_client_secret')`,
  );
  const byKey = new Map(rows.map((r) => [r.clave, r]));
  const panelId = byKey.get('google_client_id');
  const panelSecret = byKey.get('google_client_secret');
  if (panelId && panelSecret) {
    const key = resolveEncryptionKey(config.secretsEncryptionKey);
    return {
      clientId: decryptSecret(
        { ciphertext: panelId.value_ciphertext, nonce: panelId.value_nonce },
        key,
      ),
      clientSecret: decryptSecret(
        { ciphertext: panelSecret.value_ciphertext, nonce: panelSecret.value_nonce },
        key,
      ),
      fromPanel: true,
    };
  }
  if (config.googleClientId && config.googleClientSecret) {
    return {
      clientId: config.googleClientId,
      clientSecret: config.googleClientSecret,
      fromPanel: false,
    };
  }
  return null;
}

/** 503 si no hay clave de cifrado; el error nunca incluye el valor. */
function requireEncryptionKey(config: AppConfig, reply: FastifyReply): Buffer | null {
  try {
    return resolveEncryptionKey(config.secretsEncryptionKey);
  } catch (err) {
    const message =
      err instanceof SecretCryptoError ? err.message : 'cifrado no disponible';
    reply.code(503).send({ error: 'cifrado_no_configurado', detalle: message });
    return null;
  }
}

/** Intercambia el código de autorización por tokens en Google. */
async function exchangeCode(
  config: AppConfig,
  creds: GoogleCreds,
  code: string,
): Promise<{ refreshToken: string; accessToken: string; scope: string }> {
  const params = new URLSearchParams({
    code,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    redirect_uri: config.googleRedirectUri,
    grant_type: 'authorization_code',
  });
  let res: Response;
  try {
    res = await fetch(config.googleTokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
    });
  } catch {
    throw new Error('no se pudo contactar con Google (red o tiempo de espera)');
  }
  if (!res.ok) {
    throw new Error(`Google devolvió ${res.status} en el intercambio de tokens`);
  }
  const data = (await res.json()) as {
    refresh_token?: string;
    access_token?: string;
    scope?: string;
  };
  if (!data.refresh_token) {
    throw new Error(
      'Google no devolvió refresh_token (revoca el acceso anterior o usa prompt=consent)',
    );
  }
  return {
    refreshToken: data.refresh_token,
    accessToken: data.access_token ?? '',
    scope: data.scope ?? GMAIL_SCOPE,
  };
}

/** Intento no crítico de obtener el email de la cuenta autorizada. */
async function fetchAccountEmail(config: AppConfig, accessToken: string): Promise<string | null> {
  if (!accessToken) return null;
  try {
    const res = await fetch(config.googleUserinfoUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { email?: string };
    return typeof data.email === 'string' && data.email.includes('@') ? data.email : null;
  } catch {
    return null;
  }
}

export async function registerGmailRoutes(
  app: FastifyInstance,
  config: AppConfig,
): Promise<void> {
  // GET /api/integraciones/gmail/estado — estado sin secretos.
  app.get('/api/integraciones/gmail/estado', { preHandler: [requireSession] }, async (req, reply) => {
    const creds = await readGoogleCreds(config).catch((err) => {
      if (err instanceof SecretCryptoError) return 'crypto' as const;
      throw err;
    });
    if (creds === 'crypto') {
      return reply.code(503).send({ error: 'cifrado_no_configurado' });
    }
    const tokens = await query<GmailTokenRow>(
      `SELECT account_email, scope, obtained_at, revoked_at
         FROM gmail_tokens WHERE provider = 'google'`,
    );
    const token = tokens[0];
    return reply.send({
      redirectUri: config.googleRedirectUri,
      encryptionConfigured: config.secretsEncryptionKey !== null,
      client: creds
        ? {
            configured: true,
            // El client_id es un identificador público por diseño de Google.
            clientId: creds.clientId,
            fromPanel: creds.fromPanel,
          }
        : { configured: false, clientId: null, fromPanel: false },
      // El secret jamás se devuelve: solo se informa de si está guardado.
      secretConfigured: creds !== null,
      oauth: token
        ? {
            connected: token.revoked_at === null,
            accountEmail: token.account_email,
            scope: token.scope,
            obtainedAt: new Date(token.obtained_at).toISOString(),
            revokedAt: token.revoked_at ? new Date(token.revoked_at).toISOString() : null,
          }
        : { connected: false, accountEmail: null, scope: null, obtainedAt: null, revokedAt: null },
    });
  });

  // POST /api/integraciones/gmail/config — guarda client_id/secret cifrados.
  app.post(
    '/api/integraciones/gmail/config',
    { preHandler: [requireSession, requireCsrf] },
    async (req, reply) => {
      const valid = validateBody(ConfigBody, req.body, reply);
      if (!valid) return;
      const key = requireEncryptionKey(config, reply);
      if (!key) return;
      const { clientId, clientSecret } = valid.data;

      const encId = encryptSecret(clientId, key);
      const encSecret = encryptSecret(clientSecret, key);
      const actorId = req.authSession?.userId ?? null;

      await withTransaction(async (client) => {
        await client.query(
          `INSERT INTO protected_settings (clave, value_ciphertext, value_nonce, key_ref, updated_by)
             VALUES ('google_client_id', $1, $2, $3, $4)
           ON CONFLICT (clave) DO UPDATE SET
             value_ciphertext = EXCLUDED.value_ciphertext,
             value_nonce = EXCLUDED.value_nonce,
             key_ref = EXCLUDED.key_ref,
             updated_by = EXCLUDED.updated_by,
             updated_at = now()`,
          [encId.ciphertext, encId.nonce, encId.keyRef, actorId],
        );
        await client.query(
          `INSERT INTO protected_settings (clave, value_ciphertext, value_nonce, key_ref, updated_by)
             VALUES ('google_client_secret', $1, $2, $3, $4)
           ON CONFLICT (clave) DO UPDATE SET
             value_ciphertext = EXCLUDED.value_ciphertext,
             value_nonce = EXCLUDED.value_nonce,
             key_ref = EXCLUDED.key_ref,
             updated_by = EXCLUDED.updated_by,
             updated_at = now()`,
          [encSecret.ciphertext, encSecret.nonce, encSecret.keyRef, actorId],
        );
        // Auditoría SIN valores: solo quién, cuándo y qué campos.
        await auditEvent(
          {
            actorId,
            action: 'gmail_oauth_config_actualizada',
            entityType: 'protected_setting',
            entityId: 'google_oauth',
            details: { campos: ['google_client_id', 'google_client_secret'] },
          },
          client,
        );
      });
      return reply.send({ ok: true });
    },
  );

  // GET /api/integraciones/gmail/autorizar — URL de consentimiento + state.
  app.get('/api/integraciones/gmail/autorizar', { preHandler: [requireSession] }, async (req, reply) => {
    const creds = await readGoogleCreds(config).catch((err) => {
      if (err instanceof SecretCryptoError) return 'crypto' as const;
      throw err;
    });
    if (creds === 'crypto') {
      return reply.code(503).send({ error: 'cifrado_no_configurado' });
    }
    if (!creds) {
      return reply.code(503).send({
        error: 'oauth_no_configurado',
        detalle: 'Falta el client_id/secret de Google: pégalos en el campo protegido de /configuracion.',
      });
    }
    const state = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + STATE_TTL_MS);
    await query('DELETE FROM gmail_oauth_states WHERE expires_at <= now()');
    await query('INSERT INTO gmail_oauth_states (state, expires_at) VALUES ($1, $2)', [
      state,
      expiresAt.toISOString(),
    ]);
    const params = new URLSearchParams({
      client_id: creds.clientId,
      redirect_uri: config.googleRedirectUri,
      response_type: 'code',
      scope: GMAIL_SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    });
    await auditEvent({
      actorId: req.authSession?.userId ?? null,
      action: 'gmail_oauth_autorizacion_iniciada',
      entityType: 'gmail_oauth',
      entityId: 'google',
    });
    return reply.send({
      url: `${config.googleAuthUrl}?${params.toString()}`,
      expiraEnSegundos: Math.floor(STATE_TTL_MS / 1000),
    });
  });

  // GET /api/integraciones/gmail/callback — callback OAuth (público: lo llama
  // el navegador tras el consentimiento en Google). Rate limit por IP.
  app.get(
    '/api/integraciones/gmail/callback',
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: 5 * 60 * 1000,
          keyGenerator: (req) => req.ip,
          errorResponseBuilder: (_req, context) => {
            const err = new Error('demasiados_intentos') as Error & {
              statusCode?: number;
              payload?: unknown;
            };
            err.statusCode = 429;
            err.payload = { error: 'demasiados_intentos', reintentar_en_ms: context.ttl };
            return err;
          },
        },
      },
    },
    async (req, reply) => {
      const parsed = CallbackQuery.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'datos_invalidos' });
      }
      const { code, state } = parsed.data;

      // El state es de un solo uso: se consume aquí.
      const consumed = await withTransaction(async (client) => {
        const rows = await client.query<{ state: string }>(
          `DELETE FROM gmail_oauth_states
            WHERE state = $1 AND expires_at > now()
            RETURNING state`,
          [state],
        );
        await client.query('DELETE FROM gmail_oauth_states WHERE expires_at <= now()');
        return rows.rows.length > 0;
      });
      if (!consumed) {
        return reply.code(400).send({
          error: 'estado_invalido',
          detalle: 'El state no existe, ha caducado o ya se usó: inicia de nuevo la autorización.',
        });
      }

      const key = requireEncryptionKey(config, reply);
      if (!key) return;
      let creds: GoogleCreds | null = null;
      try {
        creds = await readGoogleCreds(config);
      } catch (err) {
        if (err instanceof SecretCryptoError) {
          return reply.code(503).send({ error: 'cifrado_no_configurado' });
        }
        throw err;
      }
      if (!creds) {
        return reply.code(503).send({ error: 'oauth_no_configurado' });
      }

      let tokens: { refreshToken: string; accessToken: string; scope: string };
      try {
        tokens = await exchangeCode(config, creds, code);
      } catch (err) {
        req.log.error({ msg: 'intercambio de tokens con Google fallido' });
        const detalle = err instanceof Error ? err.message : 'error desconocido';
        const noRefresh = detalle.includes('refresh_token');
        return reply.code(502).send({
          error: noRefresh ? 'refresh_token_no_devuelto' : 'intercambio_token_fallido',
          detalle,
        });
      }

      const accountEmail = await fetchAccountEmail(config, tokens.accessToken);
      const enc = encryptSecret(tokens.refreshToken, key);
      await query(
        `INSERT INTO gmail_tokens
           (provider, refresh_token_ciphertext, refresh_token_nonce, key_ref,
            account_email, scope, obtained_at, revoked_at, updated_at)
         VALUES ('google', $1, $2, $3, $4, $5, now(), NULL, now())
         ON CONFLICT (provider) DO UPDATE SET
           refresh_token_ciphertext = EXCLUDED.refresh_token_ciphertext,
           refresh_token_nonce = EXCLUDED.refresh_token_nonce,
           key_ref = EXCLUDED.key_ref,
           account_email = EXCLUDED.account_email,
           scope = EXCLUDED.scope,
           obtained_at = EXCLUDED.obtained_at,
           revoked_at = NULL,
           updated_at = now()`,
        [enc.ciphertext, enc.nonce, enc.keyRef, accountEmail, tokens.scope],
      );
      // Auditoría sin tokens: solo la cuenta conectada.
      await auditEvent({
        actorId: null,
        action: 'gmail_oauth_conectado',
        entityType: 'gmail_oauth',
        entityId: 'google',
        details: { account_email: accountEmail },
      });
      return reply.send({ ok: true, accountEmail });
    },
  );

  // POST /api/integraciones/gmail/revocar — marca los tokens como revocados.
  app.post(
    '/api/integraciones/gmail/revocar',
    { preHandler: [requireSession, requireCsrf] },
    async (req, reply) => {
      const result = await query<{ uno: number }>(
        `UPDATE gmail_tokens SET revoked_at = now(), updated_at = now()
          WHERE provider = 'google' AND revoked_at IS NULL
          RETURNING 1 AS uno`,
      );
      await auditEvent({
        actorId: req.authSession?.userId ?? null,
        action: 'gmail_oauth_revocado',
        entityType: 'gmail_oauth',
        entityId: 'google',
        details: { filas: result.length },
      });
      return reply.send({ ok: true, revocado: result.length > 0 });
    },
  );
}
