/**
 * @jobforce/backend — Sesiones y protección CSRF.
 *
 * - `requireSession`: preHandler que exige una cookie de sesión válida.
 *   El token crudo nunca se guarda: en `user_sessions.token_hash` solo vive
 *   el sha256 hexadecimal del token. Sesión expirada o inexistente → 401.
 * - `requireCsrf`: preHandler para rutas mutadoras (POST/PUT/PATCH/DELETE).
 *   Exige la cabecera `x-csrf-token` (nombre desde la constante del dominio)
 *   igual al `csrf_token` de la sesión, con comparación timing-safe → 403.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { SESSION_COOKIE_NAME, CSRF_HEADER_NAME } from '@jobforce/domain';
import { query } from '@jobforce/database';

declare module 'fastify' {
  interface FastifyRequest {
    authSession?: {
      id: string;
      userId: string;
      username: string;
      csrfToken: string;
    };
  }
}

/** sha256 hexadecimal del token de sesión (lo que se guarda en la BD). */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Comparación de cadenas en tiempo constante (evita ataques de timing). */
function timingSafeEqualStrings(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

interface SessionRow {
  id: string;
  user_id: string;
  username: string;
  csrf_token: string;
}

/** Exige sesión válida. 401 si la cookie falta, es desconocida o ha caducado. */
export async function requireSession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = req.cookies[SESSION_COOKIE_NAME];
  if (!token) {
    return reply.code(401).send({ error: 'sesion_requerida' });
  }
  const tokenHash = hashSessionToken(token);
  const rows = await query<SessionRow>(
    `SELECT s.id, s.user_id, u.username, s.csrf_token
       FROM user_sessions s
       JOIN admin_users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [tokenHash],
  );
  if (rows.length === 0) {
    // Limpieza perezosa: la sesión desconocida o caducada se elimina.
    await query('DELETE FROM user_sessions WHERE token_hash = $1', [tokenHash]).catch(() => undefined);
    return reply.code(401).send({ error: 'sesion_invalida_o_expirada' });
  }
  const row = rows[0];
  req.authSession = {
    id: row.id,
    userId: row.user_id,
    username: row.username,
    csrfToken: row.csrf_token,
  };
}

/**
 * Exige que la cabecera CSRF coincida con el token CSRF de la sesión.
 * Debe usarse DESPUÉS de `requireSession`. 403 si falta o no coincide.
 */
export async function requireCsrf(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const session = req.authSession;
  if (!session) {
    return reply.code(401).send({ error: 'sesion_requerida' });
  }
  const raw = req.headers[CSRF_HEADER_NAME];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!header || !timingSafeEqualStrings(header, session.csrfToken)) {
    return reply.code(403).send({ error: 'csrf_invalido' });
  }
}

/** Alias para el nombre de la constante en el código de tests (uso interno). */
export { CSRF_HEADER_NAME, SESSION_COOKIE_NAME };
