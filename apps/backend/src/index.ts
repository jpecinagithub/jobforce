/**
 * @jobforce/backend — Punto de entrada.
 *
 * 1. Carga y valida la configuración (`@jobforce/config`).
 * 2. Ejecuta las migraciones pendientes (`@jobforce/database`).
 * 3. Arranca el servidor HTTP en el puerto configurado.
 */

import { loadConfig } from '@jobforce/config';
import { closePool, runMigrations } from '@jobforce/database';
import { fijarPresupuesto } from '@jobforce/costs';
import { buildServer } from './server.js';
import { iniciarWorkerSends, type WorkerHandle } from './sender/index.js';
import {
  iniciarSchedulerBusquedas,
  proximaEjecucionMadrid,
  type SchedulerHandle,
} from './scheduler.js';
import { workspaceBase } from './workspace.js';

async function main(): Promise<void> {
  const config = loadConfig();
  // El pool de @jobforce/database lee DATABASE_URL del entorno.
  process.env.DATABASE_URL = config.databaseUrl;

  await runMigrations(config.databaseUrl);

  // Presupuestos de costes (Fase 5): si las variables están definidas, tienen
  // prioridad sobre lo guardado en `budget_config` y se siembran al arrancar.
  if (config.costDailyBudgetUsd !== null) {
    await fijarPresupuesto('daily_usd', config.costDailyBudgetUsd);
  }
  if (config.costMonthlyBudgetUsd !== null) {
    await fijarPresupuesto('monthly_usd', config.costMonthlyBudgetUsd);
  }

  const app = buildServer(config);

  // Worker del ejecutor de envíos: solo con SENDER_WORKER_ENABLED=true.
  // Procesa los `sends` en `queued` dentro de la política autorizada.
  let worker: WorkerHandle | null = null;
  if (config.senderWorkerEnabled) {
    worker = iniciarWorkerSends({
      // La base de documentos debe coincidir con la de quien los genera
      // (prepare.ts usa la misma función): en el contenedor es
      // /home/app/workspace, con el volumen de documentos montado.
      deps: { workspaceBase: workspaceBase() },
      onError: (err) => app.log.error({ err }, 'worker de envíos: error en iteración'),
      onResultado: (r) => app.log.info({ resultado: r }, 'worker de envíos: envío procesado'),
    });
    app.log.info('worker de envíos iniciado (SENDER_WORKER_ENABLED=true)');
  }

  // Scheduler de búsquedas diarias (Fase 8.2): a las 08:00 (Europe/Madrid)
  // busca solo en las campañas activas que no hayan buscado en 20 h.
  const scheduler: SchedulerHandle = iniciarSchedulerBusquedas(config, {
    onError: (err) => app.log.error({ err }, 'scheduler de búsquedas: error en el barrido'),
    onRun: (r) =>
      app.log.info({ barrido: r }, 'scheduler de búsquedas: barrido diario completado'),
  });
  app.log.info(
    { proxima: proximaEjecucionMadrid().toISOString() },
    'scheduler de búsquedas iniciado (diario 08:00 Europe/Madrid)',
  );

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'apagando servidor');
    worker?.detener();
    scheduler.detener();
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
