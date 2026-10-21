/**
 * Purga del pool (2026-10-21): elimina las ofertas con restricción de
 * nacionalidad (regla de Jon: inaplicables para él SIEMPRE, no deben ni
 * aparecer). Usa detectNationalityRestriction desplegado sobre título +
 * texto guardado (raw.text / raw.full_text). Las que tengan candidaturas
 * NO se borran: se listan para decisión manual.
 * Uso: docker cp al contenedor del backend y `node /tmp/purge-nationality.mjs`.
 */
import { detectNationalityRestriction } from '/app/packages/eval/dist/index.js';
import { query, closePool } from '/app/packages/database/dist/index.js';

const rows = await query(
  `SELECT id, title, url, highlights, raw FROM offers ORDER BY title`,
);
let borradas = 0;
let conCandidatura = 0;
for (const r of rows) {
  const raw = r.raw ?? {};
  const det = detectNationalityRestriction({
    title: r.title,
    highlights: Array.isArray(r.highlights) ? r.highlights : [],
    fullText: raw.full_text ?? raw.text ?? undefined,
  });
  if (!det.restricted) continue;
  const apps = await query('SELECT COUNT(*)::int AS n FROM applications WHERE offer_id = $1', [r.id]);
  if (apps[0].n === 0) {
    await query('DELETE FROM etiquetas_ofertas WHERE offer_id = $1', [r.id]);
    await query('DELETE FROM evaluations WHERE offer_id = $1', [r.id]);
    await query('DELETE FROM offers WHERE id = $1', [r.id]);
    borradas++;
    console.log(`BORRADA ${r.title} :: «${det.phrase}»`);
  } else {
    conCandidatura++;
    console.log(`CON_CANDIDATURA (no borrada) ${r.title} :: «${det.phrase}»`);
  }
}
const total = await query('SELECT count(*)::int AS n FROM offers');
console.log(`RESUMEN borradas=${borradas} con_candidatura=${conCandidatura} pool=${total[0].n}`);
await closePool();
