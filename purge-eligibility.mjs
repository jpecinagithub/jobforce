/**
 * Purga del pool con el detector de elegibilidad actualizado
 * (2026-10-21): recorre las ofertas guardadas, aplica
 * detectNationalityRestriction sobre título + texto Exa y BORRA las
 * restringidas con toda su cadena (candidatura, documentos, envíos,
 * evaluaciones, etiquetas), desvinculando costes/Gmail/intervenciones.
 * Regla de Jon: estas ofertas no deben existir en su pool.
 */
const { loadConfig } = await import('/app/apps/backend/dist/config.js');
const db = await import('/app/apps/backend/dist/db.js');
const { detectNationalityRestriction } = await import('/app/packages/eval/dist/index.js');

await db.initDb(loadConfig());

const ofertas = await db.query(
  `SELECT id, title, url, raw->>'text' AS texto FROM offers`,
);
let purgadas = 0;
for (const o of ofertas) {
  const r = detectNationalityRestriction({
    title: o.title ?? '',
    url: o.url,
    highlights: [],
    fullText: o.texto ?? '',
  });
  if (!r.restricted) continue;
  console.log(`PURGAR ${o.title} :: ${r.phrase}`);
  await db.query(`UPDATE cost_events SET offer_id = NULL WHERE offer_id = $1`, [o.id]);
  await db.query(
    `UPDATE cost_events SET application_id = NULL WHERE application_id IN (SELECT id FROM applications WHERE offer_id = $1)`,
    [o.id],
  );
  await db.query(
    `UPDATE gmail_messages SET application_id = NULL WHERE application_id IN (SELECT id FROM applications WHERE offer_id = $1)`,
    [o.id],
  );
  await db.query(
    `UPDATE interventions SET application_id = NULL WHERE application_id IN (SELECT id FROM applications WHERE offer_id = $1)`,
    [o.id],
  );
  await db.query(
    `DELETE FROM sends WHERE application_id IN (SELECT id FROM applications WHERE offer_id = $1)`,
    [o.id],
  );
  await db.query(
    `DELETE FROM documents WHERE application_id IN (SELECT id FROM applications WHERE offer_id = $1)`,
    [o.id],
  );
  await db.query(`DELETE FROM applications WHERE offer_id = $1`, [o.id]);
  await db.query(`DELETE FROM evaluations WHERE offer_id = $1`, [o.id]);
  await db.query(`DELETE FROM etiquetas_ofertas WHERE offer_id = $1`, [o.id]);
  await db.query(`DELETE FROM offers WHERE id = $1`, [o.id]);
  purgadas++;
}
console.log(`TOTAL ofertas=${ofertas.length} purgadas=${purgadas}`);
const quedan = await db.query(`SELECT COUNT(*)::int AS n FROM offers`);
console.log(`Pool restante: ${quedan[0].n}`);
process.exit(0);
