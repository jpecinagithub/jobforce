/**
 * @jobforce/database — Acceso a PostgreSQL.
 *
 * Pool único por proceso y helpers tipados. La configuración de la conexión
 * sale de `DATABASE_URL` (ver `packages/config` para la validación completa).
 */

import { Pool, type PoolClient, type QueryResultRow } from 'pg';

let pool: Pool | undefined;

/** Devuelve el pool compartido, creándolo en el primer uso. */
export function getPool(connectionString?: string): Pool {
  if (!pool) {
    const cs = connectionString ?? process.env.DATABASE_URL;
    if (!cs) {
      throw new Error('DATABASE_URL no está definida. Copia .env.example a .env y rellénala.');
    }
    pool = new Pool({ connectionString: cs });
  }
  return pool;
}

/** Consulta simple tipada: devuelve las filas. */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const { rows } = await getPool().query<T>(text, params as unknown[]);
  return rows;
}

/** Ejecuta `fn` dentro de una transacción (COMMIT/ROLLBACK automáticos). */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Cierra el pool (útil en tests y al apagar el proceso). */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
