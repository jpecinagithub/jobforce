/**
 * Probe manual (NO es un test) del endpoint público de ofertas de Workday.
 *
 * Uso:  NODE_TLS_REJECT_UNAUTHORIZED=0 node scripts/probe-workday.mjs [tenant] [wdHost] [site]
 *       (por defecto: nvidia wd5 NVIDIAExternalCareerSite)
 *
 * Requiere el proxy de egress de esta VM (ver probe-ashby.mjs).
 * No guarda credenciales: el endpoint de jobs es público.
 */
import {
  createWorkdayClient,
  workdayJobsUrl,
  workdayJobPageUrl,
  WorkdayNotFoundError,
} from '../dist/index.js';

const site = {
  tenant: process.argv[2] ?? 'nvidia',
  wdHost: process.argv[3] ?? 'wd5',
  site: process.argv[4] ?? 'NVIDIAExternalCareerSite',
};
const client = createWorkdayClient();

console.log('URL:', workdayJobsUrl(site));
const page = await client.listJobs(site, { limit: 20, offset: 0 });
console.log(`OK: total=${page.total}, página con ${page.jobPostings.length} postings`);

const sample = page.jobPostings[0];
console.log('Ejemplo:', sample.title, '|', sample.locationsText, '| publicado:', sample.postedOn);
console.log('  página pública:', workdayJobPageUrl(site, sample.externalPath));

const detail = await client.getJob(site, sample.externalPath);
console.log('Detalle OK:', detail.title, '| req:', detail.jobReqId, '| inicio:', detail.startDate);
console.log('  descripción:', detail.jobDescription.length, 'caracteres | canApply:', detail.canApply);

// Detección de cierre: job inexistente -> 404
try {
  await client.getJob(site, '/job/X/Noexiste_0000000');
  console.log('AVISO: job inexistente no devolvió 404');
} catch (err) {
  if (err instanceof WorkdayNotFoundError) {
    console.log('Cierre: job inexistente -> 404 (detectable)');
  } else {
    throw err;
  }
}
