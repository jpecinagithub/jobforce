/**
 * @jobforce/costs — Estimación de costes de LLM (Fase 5).
 *
 * El backend de JOBFORCE evalúa con reglas deterministas (sin LLM); los
 * tokens de LLM los consume el runtime del agente con el proveedor externo
 * que aporta Jon. Cuando ese consumo se conoce (p. ej. lo reporta el propio
 * runtime), se registra con `registrarCosteLlm` usando estas tarifas.
 *
 * Las tarifas se pueden sobrescribir con la variable de entorno
 * COST_LLM_PRICES_JSON: {"modelo": {"input": 1.25, "output": 5.0}} (USD por
 * millón de tokens). Los valores por defecto son orientativos y se marcan
 * como estimación en los detalles del evento.
 */

/** USD por millón de tokens: { input, output }. */
export interface LlmPrice {
  input: number;
  output: number;
}

/** Tarifas orientativas (revisar periódicamente contra el proveedor). */
export const DEFAULT_LLM_PRICES: Record<string, LlmPrice> = {
  'claude-opus-4-6': { input: 5.0, output: 25.0 },
  'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0 },
  'gpt-5': { input: 1.25, output: 10.0 },
  'gpt-5-mini': { input: 0.25, output: 2.0 },
  'mimo-v2.6-flash': { input: 0.0, output: 0.0 },
};

/** Lee tarifas de `COST_LLM_PRICES_JSON` si está definida; si no, las de defecto. */
export function cargarPreciosLlm(env: NodeJS.ProcessEnv = process.env): Record<string, LlmPrice> {
  const raw = env.COST_LLM_PRICES_JSON?.trim();
  if (!raw) return { ...DEFAULT_LLM_PRICES };
  try {
    const parsed = JSON.parse(raw) as Record<string, { input?: number; output?: number }>;
    const out: Record<string, LlmPrice> = { ...DEFAULT_LLM_PRICES };
    for (const [modelo, p] of Object.entries(parsed)) {
      const input = Number(p?.input);
      const output = Number(p?.output);
      if (Number.isFinite(input) && Number.isFinite(output) && input >= 0 && output >= 0) {
        out[modelo] = { input, output };
      }
    }
    return out;
  } catch {
    return { ...DEFAULT_LLM_PRICES };
  }
}

/** Estima el coste USD de una llamada LLM. */
export function estimarCosteLlm(
  modelo: string,
  tokensEntrada: number,
  tokensSalida: number,
  precios: Record<string, LlmPrice> = DEFAULT_LLM_PRICES,
): { costeUsd: number; tarifaUsada: LlmPrice | null; estimacion: boolean } {
  const tarifa = precios[modelo] ?? null;
  if (!tarifa) {
    return { costeUsd: 0, tarifaUsada: null, estimacion: true };
  }
  const coste = (tokensEntrada / 1_000_000) * tarifa.input + (tokensSalida / 1_000_000) * tarifa.output;
  return { costeUsd: Math.round(coste * 10000) / 10000, tarifaUsada: tarifa, estimacion: false };
}
