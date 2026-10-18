/**
 * @jobforce/backend — Utilidades de validación de entrada.
 *
 * Los errores de validación devuelven 400 con mensajes en español y sin
 * detalles internos. Las contraseñas y otros secretos nunca aparecen en
 * los mensajes de error.
 */

import type { FastifyReply } from 'fastify';
import type { ZodType } from 'zod';

export interface Validated<T> {
  ok: true;
  data: T;
}

/**
 * Valida `body` contra `schema`. Si falla, responde 400 y devuelve null
 * (la ruta debe cortar ahí con `return`).
 */
export function validateBody<T>(
  schema: ZodType<T>,
  body: unknown,
  reply: FastifyReply,
): Validated<T> | null {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const detalles = parsed.error.issues.map((i) => {
      const campo = i.path.length > 0 ? i.path.join('.') : 'cuerpo';
      return `${campo}: ${i.message}`;
    });
    reply.code(400).send({ error: 'datos_invalidos', detalles });
    return null;
  }
  return { ok: true, data: parsed.data };
}
