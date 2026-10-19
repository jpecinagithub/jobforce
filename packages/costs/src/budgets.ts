/**
 * @jobforce/costs — Presupuestos configurables (Fase 5).
 *
 * Tres niveles:
 *  1. Diario global (`budget_config.daily_usd`).
 *  2. Mensual global (`budget_config.monthly_usd`).
 *  3. Por campaña: `campaigns.exa_budget_cap_usd` (solo Exa, heredado de
 *     Fase 2) y `campaigns.total_budget_cap_usd` (todas las categorías;
 *     null = sin tope propio).
 *
 * La fuente de gasto es siempre `cost_events`. Los valores de
 * `budget_config` se siembran en la migración 006 y pueden cambiarse con
 * `fijarPresupuesto` (API `PUT /api/costs/budgets`) o al arrancar el backend
 * si las variables `COST_DAILY_BUDGET_USD` / `COST_MONTHLY_BUDGET_USD`
 * están definidas (tienen prioridad sobre lo guardado).
 */

import { query } from '@jobforce/database';
import { gastoCampana, sumarCostes } from './ledger.js';
import type { BudgetStatus, BudgetUsage } from './types.js';

export type BudgetKey = 'daily_usd' | 'monthly_usd';

/** Lee un presupuesto global (USD). */
export async function leerPresupuesto(clave: BudgetKey): Promise<number> {
  const rows = await query<{ valor_usd: string }>(
    `SELECT valor_usd FROM budget_config WHERE clave = $1`,
    [clave],
  );
  if (rows.length === 0) throw new Error(`presupuesto desconocido: ${clave}`);
  return Number(rows[0].valor_usd);
}

/** Fija un presupuesto global (USD >= 0). Devuelve el valor guardado. */
export async function fijarPresupuesto(clave: BudgetKey, valorUsd: number): Promise<number> {
  const v = Number(valorUsd);
  if (!Number.isFinite(v) || v < 0) {
    throw new Error(`presupuesto inválido para ${clave}: ${valorUsd}`);
  }
  const rows = await query<{ valor_usd: string }>(
    `INSERT INTO budget_config (clave, valor_usd, actualizado_en)
     VALUES ($1, $2, now())
     ON CONFLICT (clave) DO UPDATE
        SET valor_usd = EXCLUDED.valor_usd, actualizado_en = now()
     RETURNING valor_usd`,
    [clave, v.toFixed(4)],
  );
  return Number(rows[0].valor_usd);
}

/** Gasto USD de hoy (desde las 00:00 locales del servidor). */
export async function usoDiario(): Promise<number> {
  const inicio = new Date();
  inicio.setHours(0, 0, 0, 0);
  return sumarCostes(inicio.toISOString());
}

/** Gasto USD del mes natural en curso. */
export async function usoMensual(): Promise<number> {
  const ahora = new Date();
  const inicio = new Date(ahora.getFullYear(), ahora.getMonth(), 1, 0, 0, 0, 0);
  return sumarCostes(inicio.toISOString());
}

function usoFrenteA(usado: number, limite: number): BudgetUsage {
  return { usado_usd: usado, limite_usd: limite, agotado: usado >= limite };
}

/**
 * Estado completo de presupuestos. Si se pasa `campaignId`, incluye el
 * nivel de campaña (cap Exa + cap total).
 */
export async function verificarPresupuestos(campaignId?: string): Promise<BudgetStatus> {
  const [dailyUsd, monthlyUsd, usadoDia, usadoMes] = await Promise.all([
    leerPresupuesto('daily_usd'),
    leerPresupuesto('monthly_usd'),
    usoDiario(),
    usoMensual(),
  ]);
  let campana: BudgetStatus['campana'] = null;
  if (campaignId) {
    const rows = await query<{ exa_budget_cap_usd: string; total_budget_cap_usd: string | null }>(
      `SELECT exa_budget_cap_usd, total_budget_cap_usd FROM campaigns WHERE id = $1::uuid`,
      [campaignId],
    );
    if (rows.length > 0) {
      const usada = await gastoCampana(campaignId);
      const capExa = Number(rows[0].exa_budget_cap_usd);
      const capTotal = rows[0].total_budget_cap_usd === null ? null : Number(rows[0].total_budget_cap_usd);
      campana = {
        usada_usd: usada,
        cap_exa_usd: capExa,
        cap_total_usd: capTotal,
        agotada: usada >= capExa || (capTotal !== null && usada >= capTotal),
      };
    }
  }
  return {
    diario: usoFrenteA(usadoDia, dailyUsd),
    mensual: usoFrenteA(usadoMes, monthlyUsd),
    campana,
  };
}

/**
 * ¿Se puede gastar ahora? Devuelve ok:false con el motivo en español cuando
 * algún presupuesto (diario, mensual o de campaña) está agotado.
 */
export async function presupuestoDisponible(
  campaignId?: string,
): Promise<{ ok: true } | { ok: false; motivo: string; codigo: string }> {
  const st = await verificarPresupuestos(campaignId);
  if (st.diario.agotado) {
    return {
      ok: false,
      codigo: 'presupuesto_diario_agotado',
      motivo: `presupuesto diario agotado: ${st.diario.usado_usd.toFixed(4)} USD usados de ${st.diario.limite_usd.toFixed(4)} USD`,
    };
  }
  if (st.mensual.agotado) {
    return {
      ok: false,
      codigo: 'presupuesto_mensual_agotado',
      motivo: `presupuesto mensual agotado: ${st.mensual.usado_usd.toFixed(4)} USD usados de ${st.mensual.limite_usd.toFixed(4)} USD`,
    };
  }
  if (st.campana?.agotada) {
    return {
      ok: false,
      codigo: 'presupuesto_campana_agotado',
      motivo: `presupuesto de campaña agotado: ${st.campana.usada_usd.toFixed(4)} USD usados (tope Exa ${st.campana.cap_exa_usd?.toFixed(4)}${st.campana.cap_total_usd !== null ? `, tope total ${st.campana.cap_total_usd.toFixed(4)}` : ''})`,
    };
  }
  return { ok: true };
}
