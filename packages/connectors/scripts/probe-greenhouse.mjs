/**
 * Probe manual (NO es un test) de la Job Board API pública de Greenhouse.
 *
 * Uso:  NODE_TLS_REJECT_UNAUTHORIZED=0 node scripts/probe-greenhouse.mjs [boardToken]
 *       (por defecto boardToken = "okx"; boards reales de la campaña F3:
 *       envoyglobalinc, okx, atlasxhm)
 *
 * Requiere el proxy de egress de esta VM (variables HTTPS_PROXY/HTTP_PROXY
 * del entorno; NODE_USE_ENV_PROXY=1 hace que el fetch nativo lo use).
 * NODE_TLS_REJECT_UNAUTHORIZED=0 es necesario SOLO aquí por la
 * interceptación TLS (MITM) del proxy; nunca en producción.
 *
 * No guarda credenciales: la API pública no necesita ninguna.
 */
import { createGreenhouseClient, greenhouseBoardUrl, greenhouseJobPageUrl } from '../dist/index.js';

const boardToken = process.argv[2] ?? 'okx';
const client = createGreenhouseClient();

console.log('URL:', greenhouseBoardUrl({ boardToken }));
const jobs = await client.listJobs({ boardToken });
console.log(`OK: ${jobs.length} ofertas en "${boardToken}"`);

const sample = jobs[0];
console.log('Ejemplo:', sample.title, '|', sample.locationName);
console.log('  publicado:', sample.firstPublished, '| actualizado:', sample.updatedAt);
console.log('  página:', sample.absoluteUrl || greenhouseJobPageUrl(boardToken, sample.id));

const detail = await client.getJob(boardToken, sample.id);
console.log('Detalle:', detail.title);
console.log('  departamentos:', detail.departments.join(', ') || '—');
console.log('  oficinas:', detail.offices.join(', ') || '—');
console.log('  content:', (detail.content ?? '').length, 'caracteres');

// Detección de cierre: un id inexistente debe dar 404
try {
  await client.getJob(boardToken, 1);
  console.log('AVISO: el id 1 existe (no se pudo probar el 404)');
} catch (err) {
  console.log('Cierre (id bogus):', err instanceof Error ? `${err.name}: ${err.message.slice(0, 80)}` : err);
}
