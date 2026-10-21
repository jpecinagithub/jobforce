/**
 * Re-comprobación COMPLETA del pool (2026-10-21) con la sonda desplegada
 * (genérica + Workday CXS + Breezy contenido + respaldo JnJ):
 *  - alive   -> url_ok = true
 *  - unknown -> url_ok = null (sin etiqueta)
 *  - broken  -> se BORRA si no tiene candidaturas; si las tiene, url_ok=false.
 * Uso: docker cp al contenedor del backend y `node /tmp/recheck-all.mjs`.
 */
import { checkUrlStatusDetailed } from '/app/packages/search/dist/index.js';
import { query, closePool } from '/app/packages/database/dist/index.js';

const rows = await query('SELECT id, title, url, url_ok FROM offers ORDER BY title');
console.log(`ofertas a re-comprobar: ${rows.length}`);
let alive = 0;
let unknown = 0;
let borradas = 0;
let rotasConCandidatura = 0;
for (const r of rows) {
  const { status, via } = await checkUrlStatusDetailed(r.url);
  if (status === 'alive') {
    await query('UPDATE offers SET url_ok = true, url_checked_at = now() WHERE id = $1', [r.id]);
    alive++;
  } else if (status === 'unknown') {
    await query('UPDATE offers SET url_ok = NULL, url_checked_at = now() WHERE id = $1', [r.id]);
    unknown++;
    console.log(`UNKNOWN(${via}) ${r.title} :: ${r.url}`);
  } else {
    const apps = await query('SELECT COUNT(*)::int AS n FROM applications WHERE offer_id = $1', [r.id]);
    if (apps[0].n === 0) {
      await query('DELETE FROM etiquetas_ofertas WHERE offer_id = $1', [r.id]);
      await query('DELETE FROM evaluations WHERE offer_id = $1', [r.id]);
      await query('DELETE FROM offers WHERE id = $1', [r.id]);
      borradas++;
      console.log(`BROKEN(${via})->BORRADA ${r.title} :: ${r.url}`);
    } else {
      await query('UPDATE offers SET url_ok = false, url_checked_at = now() WHERE id = $1', [r.id]);
      rotasConCandidatura++;
      console.log(`BROKEN(${via})->CONSERVADA (tiene candidatura) ${r.title} :: ${r.url}`);
    }
  }
}
console.log(`RESUMEN alive=${alive} unknown=${unknown} borradas=${borradas} rotas_con_candidatura=${rotasConCandidatura}`);
await closePool();
