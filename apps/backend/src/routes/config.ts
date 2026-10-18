/**
 * @jobforce/backend — GET /api/config.
 *
 * Devuelve la configuración no secreta vigente (última versión de
 * `configuration_versions`). 404 si aún no existe ninguna.
 * Exige sesión; es solo lectura (sin CSRF).
 */

import type { FastifyInstance } from 'fastify';
import { query } from '@jobforce/database';
import { requireSession } from '../auth.js';

interface ConfigRow {
  id: string;
  version_no: number;
  config: Record<string, unknown>;
  note: string | null;
  created_by: string | null;
  created_at: Date;
}

export async function registerConfigRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/config', { preHandler: [requireSession] }, async (_req, reply) => {
    const rows = await query<ConfigRow>(
      `SELECT id, version_no, config, note, created_by, created_at
         FROM configuration_versions ORDER BY version_no DESC LIMIT 1`,
    );
    const row = rows[0];
    if (!row) {
      return reply.code(404).send({ error: 'sin_configuracion' });
    }
    return reply.send({
      id: row.id,
      versionNo: Number(row.version_no),
      config: row.config,
      note: row.note,
      createdBy: row.created_by,
      createdAt: new Date(row.created_at).toISOString(),
    });
  });
}
