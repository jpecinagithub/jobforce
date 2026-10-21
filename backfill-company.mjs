/**
 * Backfill de empresa (2026-10-21): recalcula offers.company con la
 * extractCompany desplegada a partir del raw de Exa guardado (título,
 * URL, texto, author). Solo pisa el valor si la extracción da un
 * nombre; si no da ninguno, limpia únicamente la basura conocida del
 * author viejo («Publicada el» y similares). 
 * Uso: docker cp al contenedor del backend y `node /tmp/backfill-company.mjs`.
 */
import { extractCompany } from '/app/packages/search/dist/index.js';
import { query, closePool } from '/app/packages/database/dist/index.js';

const rows = await query('SELECT id, title, url, company, raw FROM offers ORDER BY title');
let updated = 0;
let cleaned = 0;
let kept = 0;
for (const r of rows) {
  const raw = r.raw ?? {};
  const computed = extractCompany({
    title: r.title,
    url: r.url,
    text: raw.text ?? null,
    author: raw.author ?? null,
  });
  if (computed && computed !== r.company) {
    await query('UPDATE offers SET company = $2 WHERE id = $1', [r.id, computed]);
    updated++;
    console.log(`EMPRESA ${r.title} :: ${r.company ?? '(null)'} -> ${computed}`);
  } else if (
    !computed &&
    r.company &&
    (/publicada|published|posted/i.test(r.company) ||
      // La primera versión del backfill asignó como «empresa» el primer
      // segmento en títulos «Puesto - Portal»: si la empresa guardada ES
      // ese segmento inicial del título, era el puesto, no la empresa.
      (r.title ?? '').startsWith(r.company))
  ) {
    await query('UPDATE offers SET company = NULL WHERE id = $1', [r.id]);
    cleaned++;
    console.log(`LIMPIEZA ${r.title} :: ${r.company} -> (null)`);
  } else {
    kept++;
  }
}
const stats = await query(
  'SELECT count(*)::int total, count(company)::int con_empresa FROM offers',
);
console.log(`RESUMEN actualizadas=${updated} limpiadas=${cleaned} sin_cambio=${kept} | pool: ${stats[0].con_empresa}/${stats[0].total} con empresa`);
await closePool();
