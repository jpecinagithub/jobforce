/**
 * @jobforce/autonomy — Versionado de envíos.
 *
 * Cada envío conserva la versión de la política que estaba vigente cuando se
 * decidió (EvaluacionEnvio.versionPolitica). Este helper fija esa versión en
 * el momento del envío, para que la auditoría posterior no dependa de la
 * política que esté vigente cuando se consulte.
 */

import type { PoliticaAutonomia } from './types.js';

/**
 * Fija la versión de la política vigente en el momento del envío.
 * Devuelve el número de versión a conservar junto al registro del envío.
 */
export function versionarEnvio(politica: PoliticaAutonomia): number {
  return politica.version;
}

/**
 * Congela una copia profunda de la política para archivarla con el envío.
 * La copia queda aislada: cambios posteriores a la política viva no la
 * afectan.
 */
export function congelarPolitica(politica: PoliticaAutonomia): PoliticaAutonomia {
  return structuredClone(politica);
}
