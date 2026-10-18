/**
 * @jobforce/backend — Registro de auditoría.
 *
 * Toda acción relevante del backend deja un rastro en `audit_events`.
 * Regla de seguridad: en `details` JAMÁS se guardan secretos (contraseñas,
 * tokens de sesión o tokens CSRF).
 *
 * Si se pasa un `client`, el evento se registra dentro de esa transacción;
 * si no, se usa una conexión del pool.
 */

import { query, type PoolClient } from '@jobforce/database';

export interface AuditInput {
  actorId: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  /** Detalles libres, sin secretos. Se serializan como JSON. */
  details?: Record<string, unknown> | null;
}

export async function auditEvent(input: AuditInput, client?: PoolClient): Promise<void> {
  const sql = `INSERT INTO audit_events (actor_id, action, entity_type, entity_id, details)
     VALUES ($1, $2, $3, $4, $5::jsonb)`;
  const params: unknown[] = [
    input.actorId,
    input.action,
    input.entityType ?? null,
    input.entityId ?? null,
    input.details ? JSON.stringify(input.details) : null,
  ];
  if (client) {
    await client.query(sql, params);
  } else {
    await query(sql, params);
  }
}
