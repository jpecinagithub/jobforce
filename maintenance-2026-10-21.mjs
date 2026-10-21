/**
 * Mantenimiento 2026-10-21 (una sola pasada, idempotente):
 *  A) Purga de elegibilidad: borra las ofertas que el detector
 *     actualizado marca como restringidas (regla de Jon: no deben
 *     existir en su pool), con toda su cadena.
 *  B) Backfill DESTINO: rellena offers.location con extractLocation
 *     sobre el texto guardado, solo donde está NULL.
 * Usa pg directo (DATABASE_URL del contenedor) + los dist de paquetes.
 */
import pg from '/app/node_modules/.pnpm/pg@8.23.1/node_modules/pg/lib/index.js';
const { detectNationalityRestriction } = await import('/app/packages/eval/dist/index.js');
const { extractLocation } = await import('/app/packages/search/dist/index.js');

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (sql, params) => pool.query(sql, params).then((r) => r.rows);

// ---- A) Purga
const ofertas = await q(`SELECT id, title, url, raw->>'text' AS texto FROM offers`);
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
  await q(`UPDATE cost_events SET offer_id = NULL WHERE offer_id = $1`, [o.id]);
  await q(
    `UPDATE cost_events SET application_id = NULL WHERE application_id IN (SELECT id FROM applications WHERE offer_id = $1)`,
    [o.id],
  );
  await q(
    `UPDATE gmail_messages SET application_id = NULL WHERE application_id IN (SELECT id FROM applications WHERE offer_id = $1)`,
    [o.id],
  );
  await q(
    `UPDATE interventions SET application_id = NULL WHERE application_id IN (SELECT id FROM applications WHERE offer_id = $1)`,
    [o.id],
  );
  await q(
    `DELETE FROM sends WHERE application_id IN (SELECT id FROM applications WHERE offer_id = $1)`,
    [o.id],
  );
  await q(
    `DELETE FROM documents WHERE application_id IN (SELECT id FROM applications WHERE offer_id = $1)`,
    [o.id],
  );
  await q(`DELETE FROM applications WHERE offer_id = $1`, [o.id]);
  await q(`DELETE FROM evaluations WHERE offer_id = $1`, [o.id]);
  await q(`DELETE FROM etiquetas_ofertas WHERE offer_id = $1`, [o.id]);
  await q(`DELETE FROM offers WHERE id = $1`, [o.id]);
  purgadas++;
}
console.log(`A) pool=${ofertas.length} purgadas=${purgadas}`);

// ---- B) Backfill DESTINO
const sinDestino = await q(
  `SELECT id, title, url, raw->>'text' AS texto FROM offers WHERE location IS NULL`,
);
let rellenas = 0;
for (const o of sinDestino) {
  const loc = extractLocation({ title: o.title, url: o.url, text: o.texto });
  if (!loc) continue;
  await q(`UPDATE offers SET location = $2 WHERE id = $1`, [o.id, loc]);
  rellenas++;
}
const total = await q(`SELECT COUNT(*)::int AS n, COUNT(location)::int AS con FROM offers`);
console.log(
  `B) backfill: ${rellenas} nuevas; cobertura DESTINO: ${total[0].con}/${total[0].n} ofertas`,
);
await pool.end();
process.exit(0);
