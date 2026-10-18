/**
 * @jobforce/database — Runner de migraciones de JOBFORCE.
 *
 * - Crea la tabla `schema_migrations` si no existe.
 * - Aplica en orden los ficheros `migrations/NNN_*.sql` pendientes.
 * - Cada migración corre dentro de su propia transacción y queda registrada.
 *
 * Uso: `pnpm --filter @jobforce/database migrate` (tras `pnpm build`),
 * con `DATABASE_URL` definida en el entorno.
 */

import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { Client } from 'pg';

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL no está definida. Copia .env.example a .env y rellénala.');
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query<{ version: string }>('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.version));

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (applied.has(version)) {
        console.log(`[migrate] ${version}: ya aplicada, se omite`);
        continue;
      }
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      console.log(`[migrate] aplicando ${version}...`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
        await client.query('COMMIT');
        console.log(`[migrate] ${version}: OK`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
    console.log('[migrate] base de datos al día');
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error('[migrate] ERROR:', err instanceof Error ? err.message : err);
  process.exit(1);
});
