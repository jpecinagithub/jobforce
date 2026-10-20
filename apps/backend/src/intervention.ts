/**
 * @jobforce/backend — Creación de intervenciones manuales (bandeja).
 *
 * Compartido por la preparación de candidaturas y el encadenado
 * aprobación → envío. Si ya existe una intervención ABIERTA del mismo tipo
 * para la misma candidatura, se reutiliza (no se duplica ruido en la
 * bandeja): mismo criterio que el ejecutor de envíos.
 */

import { query } from '@jobforce/database';

export type InterventionKind =
  | 'datos_desconocidos'
  | 'pregunta_ambigua'
  | 'captcha_mfa'
  | 'fuera_de_politica'
  | 'envio_incierto'
  | 'error_tecnico';

export async function crearIntervencionSiNoAbierta(
  kind: InterventionKind,
  applicationId: string | null,
  contexto: Record<string, unknown>,
): Promise<string> {
  const abiertas = await query<{ id: string }>(
    `SELECT id FROM interventions
      WHERE kind = $1
        AND application_id IS NOT DISTINCT FROM $2::uuid
        AND status = 'abierta'
      ORDER BY created_at DESC LIMIT 1`,
    [kind, applicationId],
  );
  if (abiertas.length > 0) return abiertas[0].id;
  const creadas = await query<{ id: string }>(
    `INSERT INTO interventions (kind, application_id, context)
     VALUES ($1, $2::uuid, $3::jsonb) RETURNING id`,
    [kind, applicationId, JSON.stringify(contexto)],
  );
  return creadas[0].id;
}
