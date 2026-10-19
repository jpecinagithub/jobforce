/**
 * @jobforce/backend — Punto de entrada.
 *
 * 1. Carga y valida la configuración (`@jobforce/config`).
 * 2. Ejecuta las migraciones pendientes (`@jobforce/database`).
 * 3. Arranca el servidor HTTP en el puerto configurado.
 */

import { loadConfig } from '@jobforce/config';
import { closePool, runMigrations } from '@jobforce/database';
import { buildServer } from './server.js';
import { iniciarWorkerSends, type WorkerHandle } from './sender/index.js';

async function main(): Promise<void> {
  const config = loadConfig();
  // El pool de @jobforce/database lee DATABASE_URL del entorno.
  process.env.DATABASE_URL = config.databaseUrl;

  await runMigrations(config.databaseUrl);

  const app = buildServer(config);

  // Worker del ejecutor de envíos: solo con SENDER_WORKER_ENABLED=true.
  // Procesa los `sends` en `queued` dentro de la política autorizada.
  let worker: WorkerHandle | null = null;
  if (config.senderWorkerEnabled) {
    worker = iniciarWorkerSends({
      onError: (err) => app.log.error({ err }, 'worker de envíos: error en iteración'),
      onResultado: (r) => app.log.info({ resultado: r }, 'worker de envíos: envío procesado'),
    });
    app.log.info('worker de envíos iniciado (SENDER_WORKER_ENABLED=true)');
  }

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'apagando servidor');
    worker?.detener();
    await app.close();
    await closePool();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: config.port, host: '0.0.0.0' });
  app.log.info(`backend escuchando en el puerto ${config.port} (${config.nodeEnv})`);
}

main().catch((err: unknown) => {
  console.error('[backend] ERROR al arrancar:', err instanceof Error ? err.message : err);
  process.exit(1);
});
