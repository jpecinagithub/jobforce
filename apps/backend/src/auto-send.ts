/**
 * @jobforce/backend — Disparo automático de envíos (Fase 8.3).
 *
 * En modo `ejecutar_automatico` con la política AUTORIZADA por Jon, tras la
 * preparación automática se solicita el envío de las candidaturas listas
 * de la campaña reutilizando `solicitarEnvio` (la misma lógica de
 * request-send: checks, cuotas, presupuesto, sonda de vigencia y decisión
 * de política). El motor de política decide por candidatura:
 *
 *   - ≥ umbral automático (75) y todo en regla → `permitido` → encolado.
 *   - 70–74 → `requiere_revision`: la candidatura espera a Jon en Revisión
 *     (su aprobación expresa la envía; no es un error ni genera ruido).
 *   - Fuera de política / checks fallidos → no se encola; queda registrado
 *     en la auditoría agregada del barrido, sin intervenciones por
 *     candidatura (la bandeja no se llena con el flujo normal).
 *
 * Fuera del modo automático o sin autorización escrita no hace nada.
 * Nunca lanza: un fallo del barrido no tumba la búsqueda que lo disparó.
 */

import { query } from '@jobforce/database';
import { auditEvent } from './audit.js';
import { getEffectivePolicy, isAuthorized } from './routes/autonomy.js';
import { solicitarEnvio } from './routes/sends.js';

export interface BarridoAutomaticoResultado {
  intentadas: number;
  encolados: number;
  omitido?: string;
}

export async function solicitarEnviosAutomaticos(
  campaignId: string,
  actorId: string | null,
): Promise<BarridoAutomaticoResultado> {
  const policy = await getEffectivePolicy();
  if (!policy) return { intentadas: 0, encolados: 0, omitido: 'sin_politica' };
  if (policy.policy.modoActivo !== 'ejecutar_automatico') {
    return { intentadas: 0, encolados: 0, omitido: 'modo_no_automatico' };
  }
  if (!isAuthorized(policy)) {
    return { intentadas: 0, encolados: 0, omitido: 'politica_no_autorizada' };
  }

  const rows = await query<{ id: string }>(
    `SELECT id FROM applications
      WHERE campaign_id = $1 AND status = 'ready_for_review'
      ORDER BY created_at ASC`,
    [campaignId],
  );
  let encolados = 0;
  const detalle: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    try {
      const res = await solicitarEnvio(row.id, { actorId });
      if (res.outcome === 'encolado' || res.outcome === 'repetido') {
        encolados += 1;
        detalle.push({ application_id: row.id, outcome: res.outcome });
      } else if (res.outcome === 'bloqueado') {
        detalle.push({
          application_id: row.id,
          outcome: 'bloqueado',
          decision: res.decision,
          motivos: res.motivos,
        });
      } else {
        detalle.push({ application_id: row.id, outcome: res.outcome });
      }
    } catch (err) {
      detalle.push({
        application_id: row.id,
        outcome: 'error',
        error: (err instanceof Error ? err.message : 'error desconocido').slice(0, 300),
      });
    }
  }
  if (rows.length > 0) {
    await auditEvent({
      actorId,
      action: 'autosend_sweep',
      entityType: 'campaign',
      entityId: campaignId,
      details: {
        policy_version: policy.version,
        intentadas: rows.length,
        encolados,
        resultados: detalle,
      },
    });
  }
  return { intentadas: rows.length, encolados };
}
