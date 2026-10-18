/**
 * @jobforce/backend — GET /api/health (sin autenticación).
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { FastifyInstance } from 'fastify';

function backendVersion(): string {
  try {
    const raw = readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && 'version' in parsed) {
      return String((parsed as { version: unknown }).version ?? '0.1.0');
    }
    return '0.1.0';
  } catch {
    return '0.1.0';
  }
}

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => ({ ok: true as const, version: backendVersion() }));
}
