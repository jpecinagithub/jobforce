/**
 * @jobforce/costs — Circuit breaker por conector (Fase 5).
 *
 * Tras N fallos SEGUIDOS de un conector (exa, ashby, smartrecruiters,
 * workday, gmail…), el conector se desactiva temporalmente con backoff
 * exponencial: el sistema deja de llamarlo hasta que vence `opened_until`.
 * Un éxito resetea el contador. El estado vive en `connector_breakers`, así
 * que sobrevive a reinicios del backend.
 *
 * Esto NO sustituye a la parada global de autonomía: es una protección
 * técnica por conector, no una decisión de envío.
 */

import { query } from '@jobforce/database';
import type { BreakerOptions, BreakerState } from './types.js';

export const DEFAULT_UMBRAL_FALLOS = 5;
export const DEFAULT_BACKOFF_BASE_MS = 5 * 60 * 1000; // 5 min
const MAX_BACKOFF_MS = 4 * 60 * 60 * 1000; // 4 h

interface BreakerRow {
  connector: string;
  consecutive_failures: number;
  total_failures: string;
  opened_until: string | null;
  last_failure_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
}

function mapRow(r: BreakerRow): BreakerState {
  return {
    connector: r.connector,
    consecutive_failures: r.consecutive_failures,
    total_failures: Number(r.total_failures),
    opened_until: r.opened_until,
    last_failure_at: r.last_failure_at,
    last_success_at: r.last_success_at,
    last_error: r.last_error,
  };
}

/** Estado actual de un conector (crea la fila si no existe). */
export async function estadoConector(connector: string): Promise<BreakerState> {
  const name = connector.trim().toLowerCase();
  if (!name) throw new Error('nombre de conector vacío');
  const rows = await query<BreakerRow>(
    `INSERT INTO connector_breakers (connector)
     VALUES ($1)
     ON CONFLICT (connector) DO NOTHING
     RETURNING connector, consecutive_failures, total_failures::text,
               opened_until, last_failure_at, last_success_at, last_error`,
    [name],
  );
  if (rows.length > 0) return mapRow(rows[0]);
  const prev = await query<BreakerRow>(
    `SELECT connector, consecutive_failures, total_failures::text,
            opened_until, last_failure_at, last_success_at, last_error
       FROM connector_breakers WHERE connector = $1`,
    [name],
  );
  return mapRow(prev[0]);
}

/** ¿Puede usarse el conector ahora mismo? */
export async function conectorDisponible(
  connector: string,
): Promise<{ disponible: true } | { disponible: false; reintentarEn: string; motivo: string }> {
  const st = await estadoConector(connector);
  if (st.opened_until && new Date(st.opened_until).getTime() > Date.now()) {
    return {
      disponible: false,
      reintentarEn: st.opened_until,
      motivo:
        `conector '${st.connector}' deshabilitado temporalmente tras ` +
        `${st.consecutive_failures} fallos seguidos` +
        (st.last_error ? `: ${st.last_error}` : ''),
    };
  }
  return { disponible: true };
}

/** Registra un éxito: resetea fallos seguidos y cierra el circuito. */
export async function registrarExito(connector: string): Promise<BreakerState> {
  const st = await estadoConector(connector);
  const rows = await query<BreakerRow>(
    `UPDATE connector_breakers
        SET consecutive_failures = 0,
            opened_until = NULL,
            last_success_at = now(),
            updated_at = now()
      WHERE connector = $1
     RETURNING connector, consecutive_failures, total_failures::text,
               opened_until, last_failure_at, last_success_at, last_error`,
    [st.connector],
  );
  return mapRow(rows[0]);
}

/**
 * Registra un fallo. Al alcanzar el umbral de fallos seguidos, abre el
 * circuito con backoff exponencial (base * 2^exceso, tope 4 h).
 */
export async function registrarFallo(
  connector: string,
  error?: string,
  opts: BreakerOptions = {},
): Promise<BreakerState> {
  const umbral = Math.max(1, Math.floor(opts.umbralFallos ?? DEFAULT_UMBRAL_FALLOS));
  const baseMs = Math.max(1000, Math.floor(opts.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS));
  const st = await estadoConector(connector);
  const seguidos = st.consecutive_failures + 1;
  let openedUntil: string | null = st.opened_until;
  if (seguidos >= umbral) {
    const exceso = seguidos - umbral;
    const backoffMs = Math.min(baseMs * 2 ** Math.min(exceso, 10), MAX_BACKOFF_MS);
    openedUntil = new Date(Date.now() + backoffMs).toISOString();
  }
  const rows = await query<BreakerRow>(
    `UPDATE connector_breakers
        SET consecutive_failures = $2,
            total_failures = total_failures + 1,
            opened_until = $3::timestamptz,
            last_failure_at = now(),
            last_error = $4,
            updated_at = now()
      WHERE connector = $1
     RETURNING connector, consecutive_failures, total_failures::text,
               opened_until, last_failure_at, last_success_at, last_error`,
    [st.connector, seguidos, openedUntil, (error ?? '').slice(0, 500) || null],
  );
  return mapRow(rows[0]);
}

/** Resetea manualmente un conector (panel / intervención). */
export async function resetearConector(connector: string): Promise<BreakerState> {
  const st = await estadoConector(connector);
  const rows = await query<BreakerRow>(
    `UPDATE connector_breakers
        SET consecutive_failures = 0, opened_until = NULL,
            last_error = NULL, updated_at = now()
      WHERE connector = $1
     RETURNING connector, consecutive_failures, total_failures::text,
               opened_until, last_failure_at, last_success_at, last_error`,
    [st.connector],
  );
  return mapRow(rows[0]);
}

/** Lista el estado de todos los conectores conocidos. */
export async function listarConectores(): Promise<BreakerState[]> {
  const rows = await query<BreakerRow>(
    `SELECT connector, consecutive_failures, total_failures::text,
            opened_until, last_failure_at, last_success_at, last_error
       FROM connector_breakers ORDER BY connector`,
  );
  return rows.map(mapRow);
}

/**
 * Ejecuta `fn` bajo el circuit breaker del conector: si está abierto,
 * lanza sin llamar; si falla, registra el fallo (y puede abrir el circuito).
 */
export async function conBreaker<T>(
  connector: string,
  fn: () => Promise<T>,
  opts: BreakerOptions = {},
): Promise<T> {
  const disp = await conectorDisponible(connector);
  if (!disp.disponible) {
    throw new Error(`${disp.motivo} (reintentar a partir de ${disp.reintentarEn})`);
  }
  try {
    const res = await fn();
    await registrarExito(connector);
    return res;
  } catch (err) {
    await registrarFallo(connector, err instanceof Error ? err.message : String(err), opts);
    throw err;
  }
}
