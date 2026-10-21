/**
 * Ejecuta UN encargo del Agente dentro del contenedor del backend
 * (mismo camino que la ruta del chat: crea el job y llama a
 * runAgentJob). Uso: node /tmp/run-agent-once.mjs <url>
 */
import { loadConfig } from '/app/packages/config/dist/index.js';
import { query, closePool } from '/app/packages/database/dist/index.js';

const config = loadConfig();
process.env.DATABASE_URL = config.databaseUrl;
const { runAgentJob } = await import('/app/apps/backend/dist/agent.js');

const url = process.argv[2];
const admin = await query('SELECT id FROM admin_users LIMIT 1');
const job = await query(
  `INSERT INTO agent_jobs (url, status, created_by) VALUES ($1, 'running', $2) RETURNING id`,
  [url, admin[0].id],
);
await query(`INSERT INTO agent_messages (job_id, role, content) VALUES ($1, 'user', $2)`, [
  job[0].id,
  `aplica a esta oferta: ${url}`,
]);
await query(`INSERT INTO agent_messages (job_id, role, content) VALUES ($1, 'agent', $2)`, [
  job[0].id,
  `🤖 Encargo aceptado: voy a aplicar a ${url}`,
]);
console.log('JOB_ID', job[0].id);
await runAgentJob(job[0].id, url, { config, actorId: admin[0].id });
const j = await query('SELECT status, step FROM agent_jobs WHERE id = $1', [job[0].id]);
console.log('JOB_FINAL', JSON.stringify(j[0]));
await closePool();
