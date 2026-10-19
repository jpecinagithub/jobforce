/**
 * Probe manual (NO es un test) de la Posting API pública de Ashby.
 *
 * Uso:  NODE_TLS_REJECT_UNAUTHORIZED=0 node scripts/probe-ashby.mjs [orgHost]
 *       (por defecto orgHost = "linear")
 *
 * Requiere el proxy de egress de esta VM (variables HTTPS_PROXY/HTTP_PROXY
 * del entorno; NODE_USE_ENV_PROXY=1 hace que el fetch nativo lo use).
 * NODE_TLS_REJECT_UNAUTHORIZED=0 es necesario SOLO aquí por la
 * interceptación TLS (MITM) del proxy; nunca en producción.
 *
 * No guarda credenciales: la API pública no necesita ninguna.
 */
import { createAshbyClient, ashbyBoardUrl, ashbyApplyUrl } from '../dist/index.js';

const orgHost = process.argv[2] ?? 'linear';
const client = createAshbyClient();

console.log('URL:', ashbyBoardUrl({ orgHost }));
const board = await client.listJobs({ orgHost });
console.log(`OK: ${board.jobs.length} ofertas en "${orgHost}" (apiVersion ${board.apiVersion})`);

const sample = board.jobs[0];
console.log('Ejemplo:', sample.title, '|', sample.location, '| remoto:', sample.isRemote);
console.log('  publicado:', sample.publishedAt, '| listado:', sample.isListed);
console.log('  descripción (plain):', sample.descriptionPlain.length, 'caracteres');
console.log('  applyUrl:', sample.applyUrl || ashbyApplyUrl(orgHost, sample.id));

// Detección de cierre: re-buscar el id en un listado fresco
const refetch = await client.listJobs({ orgHost });
const stillListed = refetch.jobs.some((j) => j.id === sample.id);
console.log(`Cierre: la oferta ${sample.id} ${stillListed ? 'sigue' : 'YA NO está'} en el listado`);

// Organización inexistente -> 404
try {
  await client.listJobs({ orgHost: 'orgquenoexiste12345xyz' });
  console.log('AVISO: org inexistente no devolvió 404');
} catch (err) {
  console.log('Org inexistente:', err.message);
}
