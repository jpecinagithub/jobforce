/**
 * @jobforce/backend — Factoría de la aplicación Fastify.
 *
 * `buildServer(config)` devuelve la instancia lista para escuchar (o para
 * `app.inject()` en los tests). Separa la construcción del arranque para que
 * los tests puedan reutilizarla sin abrir puertos.
 */

import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { AppConfig } from '@jobforce/config';
import { registerHealthRoutes } from './routes/health.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerProfileRoutes } from './routes/profile.js';
import { registerAnswerRoutes } from './routes/answers.js';
import { registerConfigRoutes } from './routes/config.js';

export function buildServer(config: AppConfig): FastifyInstance {
  const app = Fastify({ logger: config.nodeEnv !== 'test' });

  app.register(helmet);
  app.register(cookie);
  // Rate limit desactivado por defecto: cada ruta opta con `config.rateLimit`.
  app.register(rateLimit, { global: false });

  // Errores de validación de Fastify → 400 en español; resto → 500 genérico
  // sin filtrar detalles internos (los secretos nunca llegan aquí).
  app.setErrorHandler((rawErr, req, reply) => {
    if (reply.sent) return;
    const err = rawErr as FastifyError;
    if (err.validation) {
      return reply.code(400).send({ error: 'datos_invalidos' });
    }
    // Cuerpo personalizado del error (p. ej. el 429 del rate limit con su reintento).
    const customPayload = (err as FastifyError & { payload?: unknown }).payload;
    if (err.statusCode === 429 && customPayload !== undefined) {
      return reply.code(429).send(customPayload);
    }
    req.log.error({ msg: 'error interno', code: err.code });
    const statusCode = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    return reply.code(statusCode).send({
      error: statusCode < 500 ? 'peticion_invalida' : 'error_interno',
    });
  });

  app.register(registerHealthRoutes);
  app.register(async (instance) => registerAuthRoutes(instance, config));
  app.register(registerProfileRoutes);
  app.register(registerAnswerRoutes);
  app.register(registerConfigRoutes);

  return app;
}
