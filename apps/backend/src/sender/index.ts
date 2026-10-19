/**
 * @jobforce/backend — Ejecutor de envíos: punto de entrada del módulo.
 *
 * - `procesarEnvio` / `reclamarSiguiente`: orquestación (executor.ts).
 * - `iniciarWorkerSends` / `procesarColaUnaVez`: bucle del worker (worker.ts).
 * - `PersonioDriver`, `crearDriver`, `camposPersonioEstandar`: driver real.
 * - Tipos y `AnomaliaEnvio`: types.ts.
 */

export { procesarEnvio, reclamarSiguiente } from './executor.js';
export type { ExecutorDeps } from './executor.js';
export { iniciarWorkerSends, procesarColaUnaVez } from './worker.js';
export type { WorkerOpts, WorkerHandle } from './worker.js';
export { PersonioDriver, crearDriver, camposPersonioEstandar } from './driver.js';
export { AnomaliaEnvio } from './types.js';
export type {
  AnomaliaKind,
  BrowserDriver,
  CampoFormulario,
  DriverJob,
  ResultadoDriver,
  ResultadoProceso,
} from './types.js';
