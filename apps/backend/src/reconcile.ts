/**
 * @jobforce/backend — Conciliación de envíos inciertos (Fase 4).
 *
 * FLUJO DE CONCILIACIÓN (contrato):
 *
 * Un envío queda en estado `uncertain` cuando el motor no puede confirmar si
 * la candidatura llegó al portal (p. ej. la página de confirmación no cargó,
 * la red cayó tras pulsar Submit, o apareció un desafío CAPTCHA/MFA).
 * En ese estado NUNCA se reintenta a ciegas: un reintento ciego puede crear
 * una candidatura duplicada en el portal, lo que daña la reputación de Jon.
 *
 * Orden de conciliación:
 *   1. `marcarEnvioIncierto` pasa la fila de `sends` a `uncertain` y abre una
 *      intervención de tipo `envio_incierto` (no bloquea otras candidaturas).
 *   2. Antes de reintentar, el motor RE-VERIFICA la confirmación por una vía
 *      independiente: el seguimiento Gmail (mensaje `confirmacion_envio`
 *      vinculado a la candidatura) o una sonda del portal (la oferta sigue
 *      listada como "applied" / el panel del candidato muestra la candidatura).
 *   3. Si la confirmación aparece → la fila pasa a `sent` y la intervención
 *      se resuelve con la evidencia encontrada.
 *   4. Si no hay confirmación → se reintenta UNA vez con una clave de
 *      idempotencia NUEVA (nunca se reutiliza la del intento incierto) o se
 *      deja en manos de Jon desde la bandeja de intervenciones.
 *   5. Si el reintento confirma un duplicado en el portal → `sent` con nota
 *      de duplicado en la evidencia; no se borra el rastro.
 *
 * Este módulo implementa el paso 1. Los pasos 2-5 los ejecutará el motor de
 * autonomía (Worker 1) cuando exista; la API expone el estado para que el
 * panel muestre la bandeja de intervenciones.
 */

import { query } from '@jobforce/database';
import { auditEvent } from './audit.js';

export interface MarcarInciertoInput {
  sendId: string;
  applicationId: string;
  /** Causa legible: qué impidió confirmar el envío. */
  causa: string;
  actorId: string | null;
}

export interface MarcarInciertoResult {
  sendId: string;
  interventionId: string;
}

/**
 * Marca un envío como incierto y abre la intervención correspondiente.
 * Idempotente respecto a la intervención: si ya existe una intervención
 * `envio_incierto` abierta para esta candidatura, se reutiliza.
 */
export async function marcarEnvioIncierto(
  input: MarcarInciertoInput,
): Promise<MarcarInciertoResult> {
  const now = new Date().toISOString();

  const sends = await query<{ id: string; status: string }>(
    `UPDATE sends
        SET status = 'uncertain',
            evidence = evidence || $2::jsonb,
            updated_at = now()
      WHERE id = $1
      RETURNING id, status`,
    [
      input.sendId,
      JSON.stringify({ incierto: { causa: input.causa, marcado_en: now } }),
    ],
  );
  if (sends.length === 0) {
    throw new Error('envio_no_encontrado');
  }

  const existentes = await query<{ id: string }>(
    `SELECT id FROM interventions
      WHERE kind = 'envio_incierto'
        AND application_id = $1
        AND status = 'abierta'
      ORDER BY created_at DESC LIMIT 1`,
    [input.applicationId],
  );
  let interventionId: string;
  if (existentes.length > 0) {
    interventionId = existentes[0].id;
  } else {
    const created = await query<{ id: string }>(
      `INSERT INTO interventions (kind, application_id, context)
       VALUES ('envio_incierto', $1, $2::jsonb)
       RETURNING id`,
      [
        input.applicationId,
        JSON.stringify({ send_id: input.sendId, causa: input.causa, marcado_en: now }),
      ],
    );
    interventionId = created[0].id;
  }

  await auditEvent({
    actorId: input.actorId,
    action: 'send_marked_uncertain',
    entityType: 'send',
    entityId: input.sendId,
    details: { application_id: input.applicationId, causa: input.causa, interventionId },
  });

  return { sendId: input.sendId, interventionId };
}
