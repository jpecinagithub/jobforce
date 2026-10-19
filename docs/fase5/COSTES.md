# Costes por campaña y candidatura — Fase 5 (19-oct-2026)

## Libro de costes (`@jobforce/costs`)

`cost_events` es el registro inmutable de cada gasto o uso medible, con
idempotencia opcional (`idempotency_key`). Categorías:

| categoría      | qué mide                                  | USD  |
|----------------|-------------------------------------------|------|
| `exa_search`   | búsquedas en Exa (coste real facturado)   | real |
| `page_extract` | páginas extraídas de portales/conectores  | 0*   |
| `llm_tokens`   | tokens del proveedor LLM externo          | estimado por tarifa |
| `browser_time` | tiempo de navegador Playwright por envío  | 0    |
| `gmail`        | operaciones de Gmail                      | 0    |
| `otro`        | otros gastos imputables                   | real |

\* Las APIs de los portales (Ashby, SmartRecruiters, Workday) son gratuitas;
se mide el volumen (páginas, bytes) por si algún conector factura en el futuro.

El backend imputa automáticamente: cada búsqueda Exa (`exa_search`, con la
misma transacción que actualiza `searches`/`campaigns.exa_spent_usd`) y cada
sesión de navegador del ejecutor de envíos (`browser_time` por candidatura,
en el `finally` de `procesarEnvio`). Los tokens LLM los reporta el runtime
del agente con `POST /api/costs/events` (si vienen tokens sin cantidad, se
estima con la tarifa de `COST_LLM_PRICES_JSON` o las orientativas).

## Presupuestos (tres niveles)

1. **Diario global** (`budget_config.daily_usd`, defecto 5 $).
2. **Mensual global** (`budget_config.monthly_usd`, defecto 50 $).
3. **Por campaña**: `exa_budget_cap_usd` (heredado, solo Exa) y
   `total_budget_cap_usd` (nuevo, todas las categorías; null = sin tope).

La ruta de búsqueda devuelve **409** (`presupuesto_diario_agotado`,
`presupuesto_mensual_agotado`, `presupuesto_campana_agotado` o el heredado
`presupuesto_exa_agotado`) antes de gastar. El ejecutor no abre el navegador
si el presupuesto mensual está agotado (intervención `fuera_de_politica`).

Configuración: variables `COST_DAILY_BUDGET_USD` / `COST_MONTHLY_BUDGET_USD`
(se siembran al arrancar si están definidas) y `PUT /api/costs/budgets` en el
panel. Lectura: `GET /api/costs/summary?campaign_id=`.

## Circuit breaker por conector

Tras **N fallos seguidos** (defecto 5, `BREAKER_FAILURE_THRESHOLD`), el
conector se desactiva con backoff exponencial (base 5 min,
`BREAKER_BASE_BACKOFF_MS`; se duplica por exceso, tope 4 h). Un éxito
resetea el contador. Estado en `connector_breakers` (sobrevive a reinicios).

Integrado en la ruta de búsqueda de Exa: con el circuito abierto responde
**503** `conector_deshabilitado_temporalmente` sin consumir presupuesto.
Panel: `GET /api/costs/breakers`, reseteo manual
`POST /api/costs/breakers/:connector/reset`. Helper `conBreaker()` para
futuros conectores.

## Migración

`006_fase5_costes.sql`: `cost_events`, `connector_breakers`,
`budget_config` (siembras 5 $/50 $) y `campaigns.total_budget_cap_usd`.
