/**
 * @jobforce/config — Carga y validación de la configuración de JOBFORCE.
 *
 * Toda la configuración sale de variables de entorno y se valida con zod.
 * Si algo falta o es inválido, `loadConfig` lanza un Error con el detalle.
 */

import { z } from 'zod';

/** Acepta "true"/"1"/"yes" (insensible a mayúsculas y espacios). */
const BooleanFromEnv = z
  .string()
  .trim()
  .toLowerCase()
  .transform((v) => v === 'true' || v === '1' || v === 'yes')
  .optional();

const RawConfigSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL es obligatoria y no puede estar vacía'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SESSION_COOKIE_SECURE: BooleanFromEnv,
  SESSION_TTL_HOURS: z.coerce.number().positive().default(24),
  // Rate limit del login (por IP). Configurable para poder relajarlo en tests
  // sin tocar el valor estricto de producción.
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  LOGIN_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(5 * 60 * 1000),
  // Clave de Exa (Fase 2, búsqueda de ofertas). Opcional: sin ella, la
  // búsqueda responde 503 `exa_no_configurado`. Nunca se loguea su valor.
  EXA_API_KEY: z
    .string()
    .trim()
    .transform((v) => (v === '' ? undefined : v))
    .optional(),
  // Worker del ejecutor de envíos (Fase 4+). Desactivado por defecto: solo se
  // activa explícitamente en el despliegue donde deba correr el worker.
  SENDER_WORKER_ENABLED: BooleanFromEnv,
  // Presupuestos globales de costes (Fase 5). Si están definidas, al arrancar
  // el backend se siembran en `budget_config` (tienen prioridad sobre el valor
  // guardado). El panel puede cambiarlos después con PUT /api/costs/budgets.
  COST_DAILY_BUDGET_USD: z.coerce.number().min(0).optional(),
  COST_MONTHLY_BUDGET_USD: z.coerce.number().min(0).optional(),
  // Tarifas LLM en JSON: {"modelo": {"input": x, "output": y}} (USD por millón
  // de tokens). Opcional; si no, se usan las orientativas de @jobforce/costs.
  COST_LLM_PRICES_JSON: z.string().trim().optional(),
  // Circuit breaker (Fase 5): fallos seguidos que abren el circuito y backoff
  // base en ms.
  BREAKER_FAILURE_THRESHOLD: z.coerce.number().int().min(1).default(5),
  BREAKER_BASE_BACKOFF_MS: z.coerce.number().int().min(1000).default(5 * 60 * 1000),
  // Cifrado de secretos en reposo (Fase 5, Gmail OAuth). Clave de 32 bytes en
  // base64 o hexadecimal. Opcional al arrancar: solo se exige cuando se
  // guarda o se lee un secreto (p. ej. el refresh_token de Gmail). El valor
  // nunca se incluye en logs ni en respuestas.
  SECRETS_ENCRYPTION_KEY: z
    .string()
    .trim()
    .transform((v) => (v === '' ? undefined : v))
    .optional(),
  // OAuth de Google (Fase 5). Opcionales: el panel puede guardar las
  // credenciales cifradas en `protected_settings`, que tienen prioridad
  // sobre estas variables. GOOGLE_REDIRECT_URI tiene un valor por defecto
  // igual a la URI pública definitiva del despliegue Oracle.
  GOOGLE_CLIENT_ID: z
    .string()
    .trim()
    .transform((v) => (v === '' ? undefined : v))
    .optional(),
  GOOGLE_CLIENT_SECRET: z
    .string()
    .trim()
    .transform((v) => (v === '' ? undefined : v))
    .optional(),
  GOOGLE_REDIRECT_URI: z
    .string()
    .trim()
    .default('https://jpecina.duckdns.org/jobforce/api/integraciones/gmail/callback'),
  // Endpoints de Google (inyectables en tests; en producción, los reales).
  GOOGLE_AUTH_URL: z
    .string()
    .trim()
    .default('https://accounts.google.com/o/oauth2/v2/auth'),
  GOOGLE_TOKEN_URL: z
    .string()
    .trim()
    .default('https://oauth2.googleapis.com/token'),
  GOOGLE_USERINFO_URL: z
    .string()
    .trim()
    .default('https://www.googleapis.com/oauth2/v2/userinfo'),
});

const ConfigSchema = RawConfigSchema.transform((raw) => ({
  databaseUrl: raw.DATABASE_URL,
  port: raw.PORT,
  nodeEnv: raw.NODE_ENV,
  // Por defecto, cookie segura en producción aunque no se indique.
  sessionCookieSecure: raw.SESSION_COOKIE_SECURE ?? raw.NODE_ENV === 'production',
  sessionTtlHours: raw.SESSION_TTL_HOURS,
  loginRateLimitMax: raw.LOGIN_RATE_LIMIT_MAX,
  loginRateLimitWindowMs: raw.LOGIN_RATE_LIMIT_WINDOW_MS,
  // null cuando EXA_API_KEY no está definida: la búsqueda queda deshabilitada
  // (503) hasta que se configure. El valor nunca se incluye en logs ni auditoría.
  exaApiKey: raw.EXA_API_KEY ?? null,
  // Worker del ejecutor de envíos: desactivado por defecto.
  senderWorkerEnabled: raw.SENDER_WORKER_ENABLED ?? false,
  // Presupuestos de costes (Fase 5): null = no sembrar al arrancar.
  costDailyBudgetUsd: raw.COST_DAILY_BUDGET_USD ?? null,
  costMonthlyBudgetUsd: raw.COST_MONTHLY_BUDGET_USD ?? null,
  breakerFailureThreshold: raw.BREAKER_FAILURE_THRESHOLD,
  breakerBaseBackoffMs: raw.BREAKER_BASE_BACKOFF_MS,
  // null cuando SECRETS_ENCRYPTION_KEY no está definida: el guardado y la
  // lectura de secretos responden 503 hasta que se configure. El valor
  // nunca se incluye en logs ni en respuestas.
  secretsEncryptionKey: raw.SECRETS_ENCRYPTION_KEY ?? null,
  // Credenciales OAuth de Google (null = no definidas en el entorno; el
  // panel puede aportarlas cifradas desde `protected_settings`).
  googleClientId: raw.GOOGLE_CLIENT_ID ?? null,
  googleClientSecret: raw.GOOGLE_CLIENT_SECRET ?? null,
  googleRedirectUri: raw.GOOGLE_REDIRECT_URI,
  googleAuthUrl: raw.GOOGLE_AUTH_URL,
  googleTokenUrl: raw.GOOGLE_TOKEN_URL,
  googleUserinfoUrl: raw.GOOGLE_USERINFO_URL,
}));

export type AppConfig = z.output<typeof ConfigSchema>;

/**
 * Valida las variables de entorno y devuelve la configuración tipada.
 * Lanza un Error descriptivo si la configuración no es válida.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const detalles = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Configuración inválida: ${detalles}`);
  }
  return parsed.data;
}
