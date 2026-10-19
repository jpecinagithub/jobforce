/**
 * @jobforce/costs — Tipos del registro de costes (Fase 5).
 *
 * Un evento de coste es un hecho inmutable: cuánto se gastó (USD), en qué
 * categoría, y a qué campaña / oferta / candidatura pertenece. El libro
 * (`ledger.ts`) es la fuente única de verdad para presupuestos; los campos
 * agregados heredados (`campaigns.exa_spent_usd`, `searches.cost_usd`) se
 * mantienen sincronizados por compatibilidad pero ya no deciden nada solos.
 */

/** Categorías de coste reconocidas. */
export type CostCategory =
  | 'exa_search' // búsquedas en Exa (USD reales facturados por Exa)
  | 'page_extract' // páginas extraídas de portales/conectores (conteo; coste 0 salvo que el conector facture)
  | 'llm_tokens' // tokens de LLM del proveedor externo (estimación por tarifa)
  | 'browser_time' // tiempo de navegador Playwright (infra propia; coste 0, se mide duración)
  | 'gmail' // operaciones de Gmail (cuota; coste 0)
  | 'otro'; // cualquier otro gasto imputable

export const COST_CATEGORIES: readonly CostCategory[] = [
  'exa_search',
  'page_extract',
  'llm_tokens',
  'browser_time',
  'gmail',
  'otro',
];

/** Entrada para registrar un evento de coste. */
export interface CostEventInput {
  campaignId?: string | null;
  applicationId?: string | null;
  offerId?: string | null;
  categoria: CostCategory;
  /** Cantidad en USD (puede ser 0 para eventos que solo miden uso). */
  cantidadUsd: number;
  /** Detalles libres: tokens, páginas, duración_ms, search_id, modelo… */
  detalles?: Record<string, unknown>;
  /**
   * Clave de idempotencia opcional. Si se repite, el segundo registro se
   * ignora (no duplica el gasto).
   */
  idempotencyKey?: string;
}

/** Evento de coste ya persistido. */
export interface CostEvent {
  id: string;
  campaign_id: string | null;
  application_id: string | null;
  offer_id: string | null;
  categoria: CostCategory;
  cantidad_usd: number;
  detalles: Record<string, unknown>;
  created_at: string;
}

/** Uso frente a límite de un presupuesto. */
export interface BudgetUsage {
  usado_usd: number;
  limite_usd: number;
  /** true cuando usado >= limite. */
  agotado: boolean;
}

/** Estado completo de presupuestos (global + por campaña). */
export interface BudgetStatus {
  diario: BudgetUsage;
  mensual: BudgetUsage;
  campana: {
    usada_usd: number;
    cap_exa_usd: number | null;
    cap_total_usd: number | null;
    agotada: boolean;
  } | null;
}

/** Estado persistido de un circuit breaker por conector. */
export interface BreakerState {
  connector: string;
  consecutive_failures: number;
  total_failures: number;
  /** ISO instantáneo hasta el que el conector está deshabilitado, o null. */
  opened_until: string | null;
  last_failure_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
}

/** Opciones del circuit breaker. */
export interface BreakerOptions {
  /** Fallos seguidos que abren el circuito (defecto 5). */
  umbralFallos?: number;
  /** Backoff base en ms (defecto 5 min); se duplica por exceso, tope 4 h. */
  backoffBaseMs?: number;
}
