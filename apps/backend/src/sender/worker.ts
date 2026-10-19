/**
 * @jobforce/backend — Bucle del ejecutor de envíos (Worker de autonomía).
 *
 * `iniciarWorkerSends` arranca un bucle que reclama envíos en `queued` y los
 * procesa de uno en uno con `reclamarSiguiente`. El reclamo es atómico
 * (`queued` → `sending` en un solo UPDATE), así que aunque hubiera dos
 * workers nunca procesarían el mismo envío; aun así, se recomienda una sola
 * instancia. Una excepción en un envío no detiene el bucle ni a los demás.
 *
 * El worker NO arranca solo: `apps/backend/src/index.ts` lo inicia únicamente
 * con `SENDER_WORKER_ENABLED=true`.
 */

import { reclamarSiguiente } from './executor.js';
import type { ExecutorDeps } from './executor.js';

export interface WorkerOpts {
  /** ms entre iteraciones cuando no hay nada en cola (default 60_000). */
  intervaloMs?: number;
  deps?: ExecutorDeps;
  onError?: (err: unknown) => void;
  onResultado?: (r: { procesado: boolean }) => void;
}

export interface WorkerHandle {
  detener(): void;
  readonly detenido: boolean;
}

export function iniciarWorkerSends(opts: WorkerOpts = {}): WorkerHandle {
  const intervaloMs = opts.intervaloMs ?? 60_000;
  let detenidoFlag = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let enCurso = false;

  const iterar = async (): Promise<void> => {
    if (detenidoFlag || enCurso) return;
    enCurso = true;
    try {
      const resultado = await reclamarSiguiente(opts.deps ?? {});
      if (resultado) {
        opts.onResultado?.(resultado);
      }
    } catch (err) {
      opts.onError?.(err);
    } finally {
      enCurso = false;
      if (!detenidoFlag) {
        timer = setTimeout(() => void iterar(), intervaloMs);
      }
    }
  };

  // Primera iteración inmediata al arrancar.
  timer = setTimeout(() => void iterar(), 0);

  return {
    detener() {
      detenidoFlag = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    get detenido() {
      return detenidoFlag;
    },
  };
}

/**
 * Procesa la cola una vez (hasta `max` envíos). Para ejecuciones manuales
 * o programadas externas (cron) sin mantener un bucle vivo.
 */
export async function procesarColaUnaVez(deps: ExecutorDeps = {}, max = 10): Promise<number> {
  let procesados = 0;
  for (let i = 0; i < max; i++) {
    const r = await reclamarSiguiente(deps);
    if (!r) break;
    procesados++;
  }
  return procesados;
}
