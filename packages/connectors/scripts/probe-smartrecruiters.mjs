/**
 * Probe manual (NO es un test) de la API pública de postings de SmartRecruiters.
 *
 * Uso:  NODE_TLS_REJECT_UNAUTHORIZED=0 node scripts/probe-smartrecruiters.mjs [company]
 *       (por defecto company = "SiloamCareers")
 *
 * Requiere el proxy de egress de esta VM (ver probe-ashby.mjs).
 * No guarda credenciales: los postings públicos no necesitan ninguna.
 */
import {
  createSmartRecruitersClient,
  smartRecruitersPostingsUrl,
  isSmartRecruitersPostingOpen,
  SmartRecruitersNotFoundError,
} from '../dist/index.js';

const company = process.argv[2] ?? 'SiloamCareers';
const client = createSmartRecruitersClient();

console.log('URL:', smartRecruitersPostingsUrl({ company, limit: 5 }));
const page = await client.listPostings({ company, limit: 5 });
console.log(`OK: totalFound=${page.totalFound}, página con ${page.content.length} postings`);

const sample = page.content[0];
console.log('Ejemplo:', sample.name, '|', sample.location?.fullLocation, '| publicado:', sample.releasedDate);

const detail = await client.getPosting(company, sample.id);
console.log('Detalle OK:', detail.name, '| active:', detail.active, '| visibility:', detail.visibility);
console.log('  postingUrl:', detail.postingUrl);
console.log('  applyUrl:', detail.applyUrl);
console.log('  secciones:', Object.keys(detail.sections).join(', '));
console.log('  ¿abierta?', isSmartRecruitersPostingOpen(detail));

// Detección de cierre: id inexistente -> 404
try {
  await client.getPosting(company, '0000000000000000');
  console.log('AVISO: id inexistente no devolvió 404');
} catch (err) {
  if (err instanceof SmartRecruitersNotFoundError) {
    console.log('Cierre: id inexistente -> 404 RESOURCE_NOT_FOUND (detectable)');
  } else {
    throw err;
  }
}

// Company desconocida -> 200 con totalFound 0
const unknown = await client.listPostings({ company: 'EmpresaQueNoExisteXYZ123', limit: 1 });
console.log(`Company desconocida: totalFound=${unknown.totalFound}`);
