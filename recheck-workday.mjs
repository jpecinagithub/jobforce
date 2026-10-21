/**
 * Remediación (2026-10-21): re-comprueba contra la API CXS las ofertas de
 * Workday del pool, que la sonda HTML había marcado url_ok=true con el
 * 200 vacío de la SPA. Usa la checkUrlStatusDetailed ya desplegada.
 *  - alive   -> url_ok = true
 *  - unknown -> url_ok = null
 *  - broken  -> se BORRA si no tiene candidaturas; si las tiene, url_ok=false.
 * Uso: docker cp al contenedor del backend y `node /tmp/recheck-workday.mjs`.
 */
import { checkUrlStatusDetailed } from '/app/packages/search/dist/index.js';
import { query, closePool } from '/app/packages/database/dist/index.js';

const rows = await query(
  "SELECT id, title, url FROM offers WHERE url LIKE '%myworkdayjobs%' ORDER BY title",
);
console.log(`ofertas Workday a re-comprobar: ${rows.length}`);
let alive = 0;
let unknown = 0;
let borradas = 0;
let rotasConCandidatura = 0;
for (const r of rows) {
  const { status, via } = await checkUrlStatusDetailed(r.url);
  if (status === 'alive') {
    await query('UPDATE offers SET url_ok = true, url_checked_at = now() WHERE id = $1', [r.id]);
    alive++;
    console.log(`ALIVE   ${r.title} :: ${r.url}`);
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
      console.log(`BROKEN->BORRADA ${r.title} :: ${r.url}`);
    } else {
      await query('UPDATE offers SET url_ok = false, url_checked_at = now() WHERE id = $1', [r.id]);
      rotasConCandidatura++;
      console.log(`BROKEN->CONSERVADA (tiene candidatura) ${r.title} :: ${r.url}`);
    }
  }
}
console.log(`RESUMEN alive=${alive} unknown=${unknown} borradas=${borradas} rotas_con_candidatura=${rotasConCandidatura}`);
await closePool();
