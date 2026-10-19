/**
 * @jobforce/costs — Libro de costes (Fase 5).
 *
 * `cost_events` es un registro inmutable y con idempotencia opcional:
 * cada gasto real o uso medible del sistema deja aquí una fila. Los
 * presupuestos (`budgets.ts`) y el panel leen de esta tabla.
 */

import { query } from '@jobforce/database';
import type { CostCategory, CostEvent, CostEventInput } from './types.js';

/** Registra un evento de coste. Idempotente si se pasa `idempotencyKey`. */
export async function registrarCoste(
  input: CostEventInput,
): Promise<{ id: string; duplicado: boolean }> {
  const cantidad = Number(input.cantidadUsd);
  if (!Number.isFinite(cantidad) || cantidad < 0) {
    throw new Error(`cantidad_usd inválida: ${input.cantidadUsd}`);
  }
  const rows = await query<{ id: string }>(
    `INSERT INTO cost_events
       (campaign_id, application_id, offer_id, categoria, cantidad_usd, detalles, idempotency_key)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::jsonb, $7)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [
      input.campaignId ?? null,
      input.applicationId ?? null,
      input.offerId ?? null,
      input.categoria satisfies CostCategory,
      cantidad.toFixed(4),
      JSON.stringify(input.detalles ?? {}),
      input.idempotencyKey ?? null,
    ],
  );
  if (rows.length > 0) return { id: rows[0].id, duplicado: false };
  // Conflicto de idempotencia: recuperar el id existente (si la clave es null
  // nunca hay conflicto, así que aquí la clave existe seguro).
  const prev = await query<{ id: string }>(
    `SELECT id FROM cost_events WHERE idempotency_key = $1`,
    [input.idempotencyKey ?? null],
  );
  return { id: prev[0]?.id ?? '', duplicado: true };
}

/** Lista eventos recientes, con filtros opcionales. */
export async function listarCostes(opts: {
  campaignId?: string;
  categoria?: CostCategory;
  limite?: number;
} = {}): Promise<CostEvent[]> {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (opts.campaignId) {
    params.push(opts.campaignId);
    conds.push(`campaign_id = $${params.length}::uuid`);
  }
  if (opts.categoria) {
    params.push(opts.categoria);
    conds.push(`categoria = $${params.length}`);
  }
  const limite = Math.min(Math.max(opts.limite ?? 100, 1), 1000);
  params.push(limite);
  const rows = await query<{
    id: string;
    campaign_id: string | null;
    application_id: string | null;
    offer_id: string | null;
    categoria: CostCategory;
    cantidad_usd: string;
    detalles: Record<string, unknown>;
    created_at: string;
  }>(
    `SELECT id, campaign_id, application_id, offer_id, categoria,
            cantidad_usd, detalles, created_at
       FROM cost_events
      ${conds.length > 0 ? 'WHERE ' + conds.join(' AND ') : ''}
      ORDER BY created_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows.map((r) => ({
    id: r.id,
    campaign_id: r.campaign_id,
    application_id: r.application_id,
    offer_id: r.offer_id,
    categoria: r.categoria,
    cantidad_usd: Number(r.cantidad_usd),
    detalles: r.detalles ?? {},
    created_at: r.created_at,
  }));
}

/** Suma de USD en un intervalo (para presupuestos diario/mensual). */
export async function sumarCostes(desde: string): Promise<number> {
  const rows = await query<{ total: string | null }>(
    `SELECT SUM(cantidad_usd)::text AS total FROM cost_events WHERE created_at >= $1::timestamptz`,
    [desde],
  );
  return Number(rows[0]?.total ?? 0);
}

/** Gasto total de una campaña (todas las categorías). */
export async function gastoCampana(campaignId: string): Promise<number> {
  const rows = await query<{ total: string | null }>(
    `SELECT SUM(cantidad_usd)::text AS total FROM cost_events WHERE campaign_id = $1::uuid`,
    [campaignId],
  );
  return Number(rows[0]?.total ?? 0);
}

/**
 * Registra una extracción de páginas (conectores de portales / Exa contents).
 * El coste en USD suele ser 0 (las APIs de los portales son gratuitas); lo
 * que se mide es el volumen: páginas y bytes.
 */
export async function registrarExtraccionPaginas(input: {
  campaignId?: string | null;
  offerId?: string | null;
  conector: string;
  paginas: number;
  bytes?: number;
  cantidadUsd?: number;
  idempotencyKey?: string;
}): Promise<{ id: string; duplicado: boolean }> {
  return registrarCoste({
    campaignId: input.campaignId ?? null,
    offerId: input.offerId ?? null,
    categoria: 'page_extract',
    cantidadUsd: input.cantidadUsd ?? 0,
    detalles: { conector: input.conector, paginas: input.paginas, bytes: input.bytes ?? null },
    idempotencyKey: input.idempotencyKey,
  });
}

/**
 * Registra tiempo de navegador Playwright de un envío.
 * Infra propia: coste 0 USD, pero se mide la duración para capacidad y
 * para el panel de costes por candidatura.
 */
export async function registrarTiempoNavegador(input: {
  applicationId: string;
  sendId: string;
  duracionMs: number;
}): Promise<{ id: string; duplicado: boolean }> {
  return registrarCoste({
    applicationId: input.applicationId,
    categoria: 'browser_time',
    cantidadUsd: 0,
    detalles: { send_id: input.sendId, duracion_ms: Math.round(input.duracionMs) },
    idempotencyKey: `browser:${input.sendId}`,
  });
}
