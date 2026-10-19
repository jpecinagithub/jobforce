/**
 * @jobforce/costs — Registro de costes por campaña y candidatura (Fase 5).
 *
 * - `ledger.ts`: libro inmutable de eventos de coste (fuente única de verdad).
 * - `budgets.ts`: presupuestos diario / mensual / por campaña, configurables.
 * - `breaker.ts`: circuit breaker por conector con backoff exponencial.
 * - `llm.ts`: estimación de costes de tokens del proveedor LLM externo.
 */

export * from './types.js';
export {
  registrarCoste,
  listarCostes,
  sumarCostes,
  gastoCampana,
  registrarExtraccionPaginas,
  registrarTiempoNavegador,
} from './ledger.js';
export {
  leerPresupuesto,
  fijarPresupuesto,
  usoDiario,
  usoMensual,
  verificarPresupuestos,
  presupuestoDisponible,
} from './budgets.js';
export {
  estadoConector,
  conectorDisponible,
  registrarExito,
  registrarFallo,
  resetearConector,
  listarConectores,
  conBreaker,
  DEFAULT_UMBRAL_FALLOS,
  DEFAULT_BACKOFF_BASE_MS,
} from './breaker.js';
export { estimarCosteLlm, cargarPreciosLlm, DEFAULT_LLM_PRICES } from './llm.js';
export type { LlmPrice } from './llm.js';
