/**
 * @jobforce/backend — Rutas de autenticación.
 *
 * - POST /api/auth/setup  → crea el usuario administrador (solo si no existe).
 * - POST /api/auth/login  → inicia sesión (rate limit: 10 intentos / 5 min por IP).
 * - POST /api/auth/logout → cierra la sesión actual.
 * - GET  /api/auth/me     → devuelve el usuario de la sesión.
 *
 * Ninguna ruta de aquí exige cabecera CSRF (setup y login están exentas
 * por contrato; logout la exige como cualquier otra ruta mutadora).
 */

import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import argon2 from 'argon2';
import { SESSION_COOKIE_NAME } from '@jobforce/domain';
import { query, withTransaction } from '@jobforce/database';
import type { AppConfig } from '@jobforce/config';
import { auditEvent } from '../audit.js';
import { hashSessionToken, requireCsrf, requireSession } from '../auth.js';
import { validateBody } from '../validation.js';

const SetupBody = z.object({
  username: z
    .string()
    .trim()
    .min(3, 'el nombre de usuario debe tener al menos 3 caracteres')
    .max(64, 'el nombre de usuario no puede superar 64 caracteres')
    .regex(/^[a-zA-Z0-9._-]+$/, 'el nombre de usuario solo admite letras, números y . _ -'),
  password: z.string().min(12, 'la contraseña debe tener al menos 12 caracteres'),
});

const LoginBody = z.object({
  username: z.string(),
  password: z.string(),
});

interface AdminRow {
  id: string;
  username: string;
  password_hash: string;
}

function cookieOptions(config: AppConfig) {
  return {
    path: '/',
    httpOnly: true,
    secure: config.sessionCookieSecure,
    sameSite: 'lax' as const,
    maxAge: Math.floor(config.sessionTtlHours * 3600),
  };
}

export async function registerAuthRoutes(app: FastifyInstance, config: AppConfig): Promise<void> {
  // POST /api/auth/setup — alta del administrador (solo si no existe ninguno).
  app.post('/api/auth/setup', async (req, reply) => {
    const valid = validateBody(SetupBody, req.body, reply);
    if (!valid) return;
    const { username, password } = valid.data;

    try {
      const created = await withTransaction(async (client) => {
        const countRows = await client.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM admin_users',
        );
        if ((countRows.rows[0]?.n ?? 0) > 0) {
          const err = new Error('ya existe un administrador') as Error & { code?: string };
          err.code = 'ADMIN_EXISTS';
          throw err;
        }
        const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
        const insertRows = await client.query<{ id: string; username: string }>(
          'INSERT INTO admin_users (username, password_hash) VALUES ($1, $2) RETURNING id, username',
          [username, passwordHash],
        );
        const row = insertRows.rows[0];
        await auditEvent({
          actorId: row.id,
          action: 'admin_created',
          entityType: 'admin_user',
          entityId: row.id,
          details: { username: row.username },
        }, client);
        return row;
      });
      return reply.code(201).send({ id: created.id, username: created.username });
    } catch (err) {
      if (err instanceof Error && (err as Error & { code?: string }).code === 'ADMIN_EXISTS') {
        return reply.code(409).send({ error: 'admin_exists' });
      }
      // Carrera entre dos setups simultáneos: la restricción UNIQUE lo impide.
      if (err instanceof Error && 'code' in err && (err as { code: string }).code === '23505') {
        return reply.code(409).send({ error: 'admin_exists' });
      }
      throw err;
    }
  });

  // POST /api/auth/login — inicio de sesión con rate limit por IP.
  app.post(
    '/api/auth/login',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '5 minutes',
          keyGenerator: (req) => req.ip,
          errorResponseBuilder: (_req, context) => ({
            error: 'demasiados_intentos',
            reintentar_en_ms: context.ttl,
          }),
        },
      },
    },
    async (req, reply) => {
      const valid = validateBody(LoginBody, req.body, reply);
      if (!valid) return;
      const { username, password } = valid.data;

      const rows = await query<AdminRow>(
        'SELECT id, username, password_hash FROM admin_users WHERE username = $1',
        [username],
      );
      const user = rows[0];
      // Respuesta idéntica exista o no el usuario (no revela qué falló).
      const passwordOk = user ? await argon2.verify(user.password_hash, password).catch(() => false) : false;
      if (!user || !passwordOk) {
        return reply.code(401).send({ error: 'credenciales_invalidas' });
      }

      const token = randomBytes(32).toString('hex');
      const tokenHash = hashSessionToken(token);
      const csrfToken = randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + config.sessionTtlHours * 3600_000);

      await withTransaction(async (client) => {
        const sRows = await client.query<{ id: string }>(
          `INSERT INTO user_sessions (user_id, token_hash, csrf_token, expires_at, ip, user_agent)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [user.id, tokenHash, csrfToken, expiresAt.toISOString(), req.ip ?? null, (req.headers['user-agent'] as string | undefined) ?? null],
        );
        await auditEvent({
          actorId: user.id,
          action: 'auth_login',
          entityType: 'user_session',
          entityId: sRows.rows[0].id,
          details: { ip: req.ip ?? null },
        }, client);
      });
      await query('UPDATE admin_users SET last_login_at = now() WHERE id = $1', [user.id]);

      reply.setCookie(SESSION_COOKIE_NAME, token, cookieOptions(config));
      return reply.send({ username: user.username, csrfToken });
    },
  );

  // POST /api/auth/logout — cierra la sesión actual (exige sesión + CSRF).
  app.post(
    '/api/auth/logout',
    { preHandler: [requireSession, requireCsrf] },
    async (req, reply) => {
      const token = req.cookies[SESSION_COOKIE_NAME];
      const actorId = req.authSession?.userId ?? null;
      if (token) {
        await query('DELETE FROM user_sessions WHERE token_hash = $1', [hashSessionToken(token)]);
      }
      await auditEvent({
        actorId,
        action: 'auth_logout',
        entityType: 'user_session',
        entityId: req.authSession?.id ?? null,
      });
      reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
      return reply.send({ ok: true });
    },
  );

  // GET /api/auth/me — usuario de la sesión actual.
  app.get('/api/auth/me', { preHandler: [requireSession] }, async (req) => ({
    username: req.authSession?.username ?? '',
  }));
}
