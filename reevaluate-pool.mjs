/**
 * Re-evaluación del pool (2026-10-21): aplica el evaluador desplegado a
 * TODAS las ofertas con las MISMAS entradas de la ingesta (título +
 * highlights + texto completo de Exa guardado en raw), a diferencia del
 * endpoint POST /evaluate, que re-evalúa sin texto completo.
 * Persiste igual que el backend (INSERT ... ON CONFLICT DO UPDATE) y
 * reporta los cambios de veredicto.
 * Uso: docker cp al contenedor del backend y `node /tmp/reevaluate-pool.mjs`.
 */
import { evaluateOffer } from '/app/packages/eval/dist/index.js';
import { fetchOfferText } from '/app/packages/search/dist/index.js';
import { query, closePool } from '/app/packages/database/dist/index.js';

const versions = await query(
  "SELECT id FROM profile_versions WHERE status = 'active' ORDER BY version_no DESC LIMIT 1",
);
const versionId = versions.length ? versions[0].id : null;
const facts = versionId
  ? await query('SELECT category, key, value FROM profile_facts WHERE profile_version_id = $1', [versionId])
  : [];

const campaigns = await query('SELECT id, name, criteria FROM campaigns');
let total = 0;
let cambios = 0;
for (const c of campaigns) {
  const offers = await query(
    "SELECT id, title, url, highlights, raw->>'text' AS texto FROM offers WHERE campaign_id = $1",
    [c.id],
  );
  const previas = await query(
    'SELECT offer_id, mandatory_verdict FROM evaluations WHERE campaign_id = $1',
    [c.id],
  );
  const prev = new Map(previas.map((p) => [p.offer_id, p.mandatory_verdict]));
  for (const o of offers) {
    total++;
    // Como en la ingesta: manda el texto de Exa; si no lo hay (o es muy
    // corto), el texto descargado de la página. Sin esto, las ofertas
    // que Exa trajo sin texto pierden el cuerpo que las evaluó.
    let texto = o.texto && o.texto.trim().length >= 200 ? o.texto : undefined;
    if (!texto) {
      texto = (await fetchOfferText(o.url)) ?? o.texto ?? undefined;
    }
    const ev = evaluateOffer(
      {
        title: o.title ?? '',
        url: o.url,
        highlights: Array.isArray(o.highlights) ? o.highlights : [],
        ...(texto ? { fullText: texto } : {}),
      },
      c.criteria,
      facts,
    );
    await query(
      `INSERT INTO evaluations
         (offer_id, campaign_id, profile_version_id, mandatory_verdict,
          mandatory_details, score, breakdown)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb)
       ON CONFLICT (offer_id, campaign_id) DO UPDATE SET
         profile_version_id = EXCLUDED.profile_version_id,
         mandatory_verdict = EXCLUDED.mandatory_verdict,
         mandatory_details = EXCLUDED.mandatory_details,
         score = EXCLUDED.score,
         breakdown = EXCLUDED.breakdown,
         created_at = now()`,
      [
        o.id,
        c.id,
        versionId,
        ev.mandatory_verdict,
        JSON.stringify(ev.mandatory_details),
        ev.score,
        JSON.stringify(ev.breakdown),
      ],
    );
    const antes = prev.get(o.id) ?? '(sin evaluación)';
    if (antes !== ev.mandatory_verdict) {
      cambios++;
      console.log(`CAMBIO [${c.name}] ${o.title} :: ${antes} -> ${ev.mandatory_verdict} :: ${o.url}`);
    }
  }
}
console.log(`RESUMEN ofertas=${total} cambios_de_veredicto=${cambios}`);
await closePool();
