/**
 * @jobforce/backend — Búsquedas diarias automáticas (Fase 8.2).
 *
 * Mecanismo elegido: **timer interno del backend**. Motivos: no depende de
 * cron del host ni de secretos nuevos; sobrevive a reinicios del contenedor
 * (se reprograma al arrancar); y ejecuta EXACTAMENTE la misma lógica que el
 * botón «Buscar» del panel (`ejecutarBusquedaCampana`: presupuesto de la
 * campaña y global, circuit breaker, evaluación, preparación automática y
 * —en modo automático autorizado— solicitud de envíos).
 *
 * Reglas:
 *   - Una vez al día a las 08:00 (Europe/Madrid, con DST correcto).
 *   - Solo campañas en estado `active` (borrador/archivada nunca buscan).
 *   - Si una campaña ya buscó en las últimas 20 h, se salta (idempotencia
 *     ante reinicios o ejecuciones solapadas).
 *   - Cada ejecución queda registrada en `audit_events`
 *     (`scheduled_search_run`) y cada búsqueda en la tabla `searches`,
 *     igual que si la hubiera lanzado Jon desde el panel.
 *   - Sin catch-up al arrancar: si el backend estaba caído a las 08:00, la
 *     campaña espera al día siguiente (la ventana de 20 h evita dobles,
 *     no crea deuda de búsquedas atrasadas con coste sorpresa).
 */

import type { AppConfig } from '@jobforce/config';
import { query } from '@jobforce/database';
import { auditEvent } from './audit.js';
import {
  ejecutarBusquedaCampana,
  type ResultadoBusqueda,
} from './routes/campaigns.js';

const VENTANA_SALTO_MS = 20 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Selección de campañas.
// ---------------------------------------------------------------------------

/** Campañas activas a las que les toca buscar (sin búsqueda en 20 h). */
export async function campanasParaBusquedaProgramada(
  ahora: Date = new Date(),
): Promise<string[]> {
  const limite = new Date(ahora.getTime() - VENTANA_SALTO_MS);
  const rows = await query<{ id: string }>(
    `SELECT c.id FROM campaigns c
      WHERE c.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM searches s
           WHERE s.campaign_id = c.id
             AND COALESCE(s.started_at, s.finished_at) >= $1
        )
      ORDER BY c.created_at ASC`,
    [limite],
  );
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Ejecución del barrido.
// ---------------------------------------------------------------------------

export interface SchedulerDeps {
  /** Lanzador de la búsqueda de una campaña. Por defecto, el real. */
  lanzarBusqueda?: (campaignId: string) => Promise<ResultadoBusqueda>;
}

export interface BarridoProgramadoResultado {
  ejecutadas: number;
  detalle: Array<{ campaign_id: string; ok: boolean; error?: string }>;
}

export async function ejecutarBusquedasProgramadas(
  config: AppConfig,
  deps: SchedulerDeps = {},
): Promise<BarridoProgramadoResultado> {
  const lanzar =
    deps.lanzarBusqueda ??
    ((campaignId: string) =>
      ejecutarBusquedaCampana(config, campaignId, { actorId: null }));
  const ids = await campanasParaBusquedaProgramada();
  const detalle: BarridoProgramadoResultado['detalle'] = [];
  for (const campaignId of ids) {
    try {
      const res = await lanzar(campaignId);
      await auditEvent({
        actorId: null,
        action: 'scheduled_search_run',
        entityType: 'campaign',
        entityId: campaignId,
        details: res.ok
          ? {
              ok: true,
              busquedas: res.searches.length,
              resultados: res.searches.reduce((n, s) => n + s.results_count, 0),
              total_cost_usd: res.total_cost_usd,
            }
          : { ok: false, status: res.status, error: res.error },
      });
      detalle.push({ campaign_id: campaignId, ok: res.ok, ...(res.ok ? {} : { error: res.error }) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'error desconocido';
      await auditEvent({
        actorId: null,
        action: 'scheduled_search_run',
        entityType: 'campaign',
        entityId: campaignId,
        details: { ok: false, error: `excepcion: ${msg}`.slice(0, 500) },
      }).catch(() => undefined);
      detalle.push({ campaign_id: campaignId, ok: false, error: msg });
    }
  }
  return { ejecutadas: ids.length, detalle };
}

// ---------------------------------------------------------------------------
// Timer: próximo 08:00 en Europe/Madrid (DST incluido, vía Intl).
// ---------------------------------------------------------------------------

interface PartesMadrid {
  y: number;
  m: number;
  d: number;
  h: number;
  min: number;
  s: number;
}

function partesEnMadrid(fecha: Date): PartesMadrid {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(fecha)) parts[p.type] = p.value;
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    h: Number(parts.hour) % 24,
    min: Number(parts.minute),
    s: Number(parts.second),
  };
}

/** Instante UTC que corresponde a las `hora`:00 de un día civil de Madrid. */
function instanteMadrid(y: number, m: number, d: number, hora: number): Date {
  let guess = Date.UTC(y, m - 1, d, hora, 0, 0);
  for (let i = 0; i < 3; i++) {
    const p = partesEnMadrid(new Date(guess));
    const comoSiUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s);
    const offset = comoSiUtc - guess;
    const corregido = Date.UTC(y, m - 1, d, hora, 0, 0) - offset;
    if (corregido === guess) break;
    guess = corregido;
  }
  return new Date(guess);
}

/** Próxima ejecución: hoy a las 08:00 de Madrid si aún no pasó; si no, mañana. */
export function proximaEjecucionMadrid(ahora: Date = new Date()): Date {
  const p = partesEnMadrid(ahora);
  const hoy8 = instanteMadrid(p.y, p.m, p.d, 8);
  if (ahora.getTime() < hoy8.getTime()) return hoy8;
  const manana = new Date(Date.UTC(p.y, p.m - 1, p.d) + 24 * 60 * 60 * 1000);
  return instanteMadrid(
    manana.getUTCFullYear(),
    manana.getUTCMonth() + 1,
    manana.getUTCDate(),
    8,
  );
}

export interface SchedulerHandle {
  detener(): void;
  readonly detenido: boolean;
}

export interface SchedulerOpts {
  onError?: (err: unknown) => void;
  onRun?: (r: BarridoProgramadoResultado) => void;
}

export function iniciarSchedulerBusquedas(
  config: AppConfig,
  opts: SchedulerOpts = {},
): SchedulerHandle {
  let detenidoFlag = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const programar = (): void => {
    if (detenidoFlag) return;
    const proxima = proximaEjecucionMadrid();
    const delta = Math.max(1000, proxima.getTime() - Date.now());
    timer = setTimeout(() => {
      void (async () => {
        try {
          const r = await ejecutarBusquedasProgramadas(config);
          opts.onRun?.(r);
        } catch (err) {
          opts.onError?.(err);
        } finally {
          programar();
        }
      })();
    }, delta);
  };
  programar();

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
