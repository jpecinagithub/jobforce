/**
 * @jobforce/backend — Reintento de la configuración automática del
 * formulario (Fase 8.1).
 *
 * - POST /api/applications/:id/form-config/retry → vuelve a inspeccionar
 *   el formulario del portal y a intentar construir `formConfig` para la
 *   candidatura (mismo intento que hace la preparación). Pensada para que
 *   el panel la invoque cuando Jon complete los datos que faltaban.
 *
 * Exige sesión + cabecera CSRF (mutadora).
 */

import type { FastifyInstance } from 'fastify';
import { intentarConfigurarFormulario } from '../formconfig.js';
import { requireCsrf, requireSession } from '../auth.js';

const mutating = { preHandler: [requireSession, requireCsrf] };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function registerFormConfigRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/applications/:id/form-config/retry', mutating, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) {
      return reply.code(400).send({ error: 'candidatura_invalida' });
    }
    const res = await intentarConfigurarFormulario(id);
    if (res.estado === 'error' && res.motivo === 'candidatura_no_encontrada') {
      return reply.code(404).send({ error: 'candidatura_no_encontrada' });
    }
    return reply.send(res);
  });
}
