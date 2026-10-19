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
