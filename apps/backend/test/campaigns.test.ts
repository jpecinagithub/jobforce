/**
 * Tests de campañas (Fase 2): CRUD, validaciones, control de presupuesto de Exa
 * y flujo completo de búsqueda con dobles (sin red).
 *
 * Requieren `DATABASE_URL` en el entorno. No hacen llamadas reales a Exa:
 * el cliente y el evaluador se sustituyen con `setCampaignTestDeps`.
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { query } from '@jobforce/database';
import {
  authed,
  buildTestApp,
  closeTestApp,
  resetDb,
  setupAndLogin,
  type AuthContext,
} from './helpers.js';
import { resetCampaignTestDeps, setCampaignTestDeps } from '../src/routes/campaigns.js';
import type { ExaClient, ExaSearchResponse } from '@jobforce/search';
import type { EvaluationResult } from '@jobforce/eval';

/** Cliente Exa falso: determinista, sin red. Falla con la consulta 'falla'. */
function makeFakeClient(onCall?: () => void): ExaClient {
  return {
    async getContents() {
      return { texts: new Map<string, string>(), costDollars: 0 };
    },
    async search(opts): Promise<ExaSearchResponse> {
      onCall?.();
      if (opts.query === 'falla') {
        throw new Error('fallo simulado de Exa');
      }
      return {
        requestId: `req-${opts.query}`,
        costDollars: 0.007,
        results: [
          {
            id: 'r1',
            title: 'CFO — Acme',
            url: 'https://empleo.example/oferta/1?utm_source=boletin',
            highlights: ['Se busca CFO con experiencia en IFRS'],
          },
          {
            id: 'r2',
            title: 'CFO — Acme (duplicada)',
            url: 'https://empleo.example/oferta/1?fbclid=abc123',
            highlights: ['Se busca CFO con experiencia en IFRS'],
          },
          {
            id: 'r3',
            title: 'Junior Accountant — Beta',
            url: 'https://jobs.example/junior',
            publishedDate: '2026-10-10',
            author: 'Beta',
            highlights: [],
          },
        ],
      };
    },
  };
}

/** Evaluador falso: cumple salvo que el título mencione "Junior". */
function fakeEvaluateOffer(offer: { title: string }): EvaluationResult {
  if (/junior/i.test(offer.title)) {
    return {
      mandatory_verdict: 'sin_evidencia',
      mandatory_details: [
        {
          requisito_id: 'rol',
          descripcion: 'Puesto senior en finanzas',
          estado: 'sin_evidencia',
          evidencia: '',
        },
      ],
      score: null,
      breakdown: [],
    };
  }
  return {
    mandatory_verdict: 'cumple',
    mandatory_details: [
      {
        requisito_id: 'rol',
        descripcion: 'Puesto senior en finanzas',
        estado: 'cumple',
        evidencia: 'CFO — Acme',
      },
    ],
    score: 85.5,
    breakdown: [],
  };
}

async function createCampaign(
  app: FastifyInstance,
  auth: AuthContext,
  payload: Record<string, unknown> = { name: 'CFO Europa' },
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/campaigns',
    payload,
    headers: authed(auth),
  });
  assert.equal(res.statusCode, 201, `creación inesperada: ${res.statusCode} ${res.body}`);
  return res.json<{ id: string }>().id;
}

describe('campañas', () => {
  let app: FastifyInstance;
  let auth: AuthContext;

  before(async () => {
    // Clave falsa: los tests usan el doble de Exa (setCampaignTestDeps), nunca la red.
    app = await buildTestApp({ EXA_API_KEY: 'clave-falsa-de-test' });
  });
  beforeEach(async () => {
    await resetDb();
    resetCampaignTestDeps();
    auth = await setupAndLogin(app);
  });
  after(async () => {
    resetCampaignTestDeps();
    await closeTestApp(app);
  });

  it('POST /api/campaigns crea una campaña con criterios por defecto', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/campaigns',
      payload: { name: 'CFO Europa' },
      headers: authed(auth),
    });
    assert.equal(res.statusCode, 201);
    const created = res.json<{ id: string; name: string }>();
    assert.match(created.id, /^[0-9a-f-]{36}$/i);
    assert.equal(created.name, 'CFO Europa');

    const detail = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${created.id}`,
      headers: authed(auth, false),
    });
    assert.equal(detail.statusCode, 200);
    const campaign = detail.json<{ campaign: Record<string, unknown> }>().campaign;
    assert.equal(campaign.status, 'draft');
    assert.equal(campaign.exa_spent_usd, 0);
    assert.equal(campaign.exa_budget_cap_usd, 3);
    const criteria = campaign.criteria as { roles: string[] };
    assert.ok(criteria.roles.includes('CFO'), 'los criterios por defecto incluyen CFO');
  });

  it('POST /api/campaigns rechaza nombre vacío (400)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/campaigns',
      payload: { name: '   ' },
      headers: authed(auth),
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json<{ error: string }>().error, 'datos_invalidos');
  });

  it('POST /api/campaigns rechaza límite de presupuesto ≤ 0 o > 100 (400)', async () => {
    for (const cap of [0, -5, 100.01]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/campaigns',
        payload: { name: 'X', exa_budget_cap_usd: cap },
        headers: authed(auth),
      });
      assert.equal(res.statusCode, 400, `límite ${cap} debería rechazarse`);
    }
  });

  it('GET /api/campaigns lista con contadores', async () => {
    await createCampaign(app, auth, { name: 'Una' });
    await createCampaign(app, auth, { name: 'Dos' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/campaigns',
      headers: authed(auth, false),
    });
    assert.equal(res.statusCode, 200);
    const body = res.json<{ campaigns: Array<Record<string, unknown>> }>();
    assert.equal(body.campaigns.length, 2);
    for (const c of body.campaigns) {
      assert.equal(c.searches_count, 0);
      assert.equal(c.offers_count, 0);
    }
  });

  it('GET /api/campaigns/:id con UUID inválido → 400 campana_invalida', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/campaigns/no-es-un-uuid',
      headers: authed(auth, false),
    });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.json(), { error: 'campana_invalida' });
  });

  it('GET /api/campaigns/:id inexistente → 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/campaigns/12345678-1234-1234-1234-123456789abc',
      headers: authed(auth, false),
    });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.json(), { error: 'campana_no_encontrada' });
  });

  it('PUT /api/campaigns/:id actualiza nombre y estado', async () => {
    const id = await createCampaign(app, auth);
    const res = await app.inject({
      method: 'PUT',
      url: `/api/campaigns/${id}`,
      payload: { name: 'CFO Latam', status: 'active' },
      headers: authed(auth),
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true });

    const detail = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${id}`,
      headers: authed(auth, false),
    });
    const campaign = detail.json<{ campaign: Record<string, unknown> }>().campaign;
    assert.equal(campaign.name, 'CFO Latam');
    assert.equal(campaign.status, 'active');
  });

  it('PUT /api/campaigns/:id con UUID inválido → 400', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/campaigns/xxx',
      payload: { name: 'X' },
      headers: authed(auth),
    });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.json(), { error: 'campana_invalida' });
  });

  it('presupuesto agotado → 409 sin llamar a Exa', async () => {
    const id = await createCampaign(app, auth, { name: 'Barata', exa_budget_cap_usd: 0.05 });
    await query('UPDATE campaigns SET exa_spent_usd = 0.04 WHERE id = $1', [id]);

    let llamadas = 0;
    setCampaignTestDeps({
      createExaClient: () => {
        llamadas += 1;
        return makeFakeClient();
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/campaigns/${id}/search`,
      payload: { queries: ['CFO', 'Controller'], num_results: 5 },
      headers: authed(auth),
    });
    // 2 consultas × 0,01 $ de estimación = 0,02; 0,04 + 0,02 > 0,05 → 409.
    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.json(), {
      error: 'presupuesto_exa_agotado',
      gastado: 0.04,
      limite: 0.05,
    });
    assert.equal(llamadas, 0, 'el cliente de Exa no debe crearse con presupuesto agotado');

    const searches = await query<{ n: string }>('SELECT COUNT(*) AS n FROM searches');
    assert.equal(Number(searches[0].n), 0, 'no debe registrarse ninguna búsqueda');
    const spent = await query<{ s: string }>('SELECT exa_spent_usd AS s FROM campaigns WHERE id = $1', [
      id,
    ]);
    assert.equal(Number(spent[0].s), 0.04, 'el gasto no debe moverse');
  });

  it('flujo completo de búsqueda con dobles: ofertas, duplicados, gasto y evaluación', async () => {
    setCampaignTestDeps({
      createExaClient: () => makeFakeClient(),
      evaluateOffer: (offer, criteria, facts) => fakeEvaluateOffer(offer),
    });
    const id = await createCampaign(app, auth);

    const res = await app.inject({
      method: 'POST',
      url: `/api/campaigns/${id}/search`,
      payload: { queries: ['CFO Europa'], num_results: 3 },
      headers: authed(auth),
    });
    assert.equal(res.statusCode, 200);
    const body = res.json<{
      searches: Array<{
        id: string;
        query: string;
        results_count: number;
        duplicates_count: number;
        cost_usd: number;
      }>;
      total_cost_usd: number;
    }>();
    assert.equal(body.searches.length, 1);
    assert.equal(body.searches[0].results_count, 3);
    assert.equal(body.searches[0].duplicates_count, 1, 'la URL duplicada (utm/fbclid) se descuenta');
    assert.equal(body.searches[0].cost_usd, 0.007);
    assert.equal(body.total_cost_usd, 0.007);

    // El gasto de la campaña refleja el coste real.
    const detail = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${id}`,
      headers: authed(auth, false),
    });
    assert.equal(detail.json<{ campaign: Record<string, unknown> }>().campaign.exa_spent_usd, 0.007);

    // Las ofertas llegan con su evaluación.
    const offersRes = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${id}/offers`,
      headers: authed(auth, false),
    });
    assert.equal(offersRes.statusCode, 200);
    const offers = offersRes.json<{
      offers: Array<{
        title: string | null;
        evaluation: { mandatory_verdict: string; score: number | null } | null;
      }>;
    }>().offers;
    assert.equal(offers.length, 2);
    for (const o of offers) {
      assert.ok(o.evaluation, 'toda oferta nueva debe quedar evaluada');
    }

    // Re-evaluación: toca las 2 ofertas.
    const evalRes = await app.inject({
      method: 'POST',
      url: `/api/campaigns/${id}/evaluate`,
      headers: authed(auth),
    });
    assert.equal(evalRes.statusCode, 200);
    assert.deepEqual(evalRes.json(), { evaluated: 2 });

    // Informe: 1 válida (CFO), 1 descarte (Junior, sin evidencia).
    const reportRes = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${id}/report`,
      headers: authed(auth, false),
    });
    assert.equal(reportRes.statusCode, 200);
    const report = reportRes.json<{ report: Record<string, unknown> }>().report as {
      vacantes_leidas: number;
      duplicados_descartados: number;
      ofertas: Array<{ titulo: string; puntuacion: number | null }>;
      descartes: Array<{ titulo: string; motivo: string; evidencia: string }>;
      nuevas_coincidencias: number;
      gasto_total_usd: number;
      presupuesto_usd: number;
      fuentes_intentadas: string[];
    };
    assert.equal(report.vacantes_leidas, 2);
    assert.equal(report.duplicados_descartados, 1);
    assert.equal(report.ofertas.length, 1);
    assert.equal(report.ofertas[0].titulo, 'CFO — Acme');
    assert.equal(report.ofertas[0].puntuacion, 85.5);
    assert.equal(report.descartes.length, 1);
    assert.equal(report.descartes[0].titulo, 'Junior Accountant — Beta');
    assert.match(report.descartes[0].motivo, /sin evidencia/);
    assert.equal(report.nuevas_coincidencias, 1);
    assert.equal(report.gasto_total_usd, 0.007);
    assert.equal(report.presupuesto_usd, 3);
    assert.deepEqual(report.fuentes_intentadas, ['empleo.example', 'jobs.example']);

    const saved = await query<{ n: string }>(
      'SELECT COUNT(*) AS n FROM campaign_reports WHERE campaign_id = $1',
      [id],
    );
    assert.equal(Number(saved[0].n), 1, 'el informe debe quedar guardado');
  });

  it('un fallo de Exa marca la búsqueda en error y sigue con las demás', async () => {
    setCampaignTestDeps({
      createExaClient: () => makeFakeClient(),
      evaluateOffer: (offer, criteria, facts) => fakeEvaluateOffer(offer),
    });
    const id = await createCampaign(app, auth);

    const res = await app.inject({
      method: 'POST',
      url: `/api/campaigns/${id}/search`,
      payload: { queries: ['CFO', 'falla'] },
      headers: authed(auth),
    });
    assert.equal(res.statusCode, 200);
    const body = res.json<{
      searches: Array<{ query: string; error?: string; results_count: number }>;
      total_cost_usd: number;
    }>();
    assert.equal(body.searches.length, 2);
    const failed = body.searches.find((s) => s.query === 'falla');
    assert.ok(failed?.error, 'la búsqueda fallida informa el error');
    assert.equal(failed?.results_count, 0);
    const ok = body.searches.find((s) => s.query === 'CFO');
    assert.equal(ok?.results_count, 3, 'la búsqueda buena completa el flujo');

    const rows = await query<{ status: string; n: string }>(
      'SELECT status, COUNT(*) AS n FROM searches WHERE campaign_id = $1 GROUP BY status',
      [id],
    );
    const byStatus = Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
    assert.deepEqual(byStatus, { done: 1, error: 1 });
  });
});

describe('campañas sin clave de Exa', () => {
  let app: FastifyInstance;
  let auth: AuthContext;

  before(async () => {
    // Sin EXA_API_KEY: exaApiKey queda a null.
    app = await buildTestApp();
  });
  beforeEach(async () => {
    await resetDb();
    resetCampaignTestDeps();
    auth = await setupAndLogin(app);
  });
  after(async () => {
    resetCampaignTestDeps();
    await closeTestApp(app);
  });

  it('sin clave de Exa → 503 exa_no_configurado', async () => {
    const id = await createCampaign(app, auth);
    const res = await app.inject({
      method: 'POST',
      url: `/api/campaigns/${id}/search`,
      payload: { queries: ['CFO'] },
      headers: authed(auth),
    });
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.json(), { error: 'exa_no_configurado' });
  });

  it('DELETE /api/campaigns/:id borra la campaña y desvincula el libro de costes', async () => {
    const id = await createCampaign(app, auth);
    await query(
      `INSERT INTO offers (campaign_id, canonical_url, url, title, company)
       VALUES ($1, 'https://example.com/1', 'https://example.com/1', 'CFO', 'Acme')`,
      [id],
    );
    await query(
      `INSERT INTO cost_events (campaign_id, categoria, cantidad_usd, detalles)
       VALUES ($1, 'exa_search', 0.035, '{}'::jsonb)`,
      [id],
    );

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/campaigns/${id}`,
      headers: authed(auth),
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json(), { ok: true });

    const despues = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${id}`,
      headers: authed(auth),
    });
    assert.equal(despues.statusCode, 404);
    const ofertas = await query('SELECT COUNT(*) AS n FROM offers WHERE campaign_id = $1', [id]);
    assert.equal(Number(ofertas[0].n), 0);
    // El gasto queda registrado pero desvinculado de la campaña borrada.
    const costes = await query<{ campaign_id: string | null }>(
      'SELECT campaign_id FROM cost_events',
    );
    assert.equal(costes.length, 1);
    assert.equal(costes[0].campaign_id, null);
  });

  it('DELETE /api/campaigns/:id con candidaturas enviadas → 409 y no borra', async () => {
    const id = await createCampaign(app, auth);
    const oferta = await query<{ id: string }>(
      `INSERT INTO offers (campaign_id, canonical_url, url, title, company)
       VALUES ($1, 'https://example.com/2', 'https://example.com/2', 'CFO', 'Acme')
       RETURNING id`,
      [id],
    );
    await query(
      `INSERT INTO applications (campaign_id, offer_id, status)
       VALUES ($1, $2, 'submitted')`,
      [id, oferta[0].id],
    );
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/campaigns/${id}`,
      headers: authed(auth),
    });
    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.json(), { error: 'campana_con_envios_reales' });
    const sigue = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${id}`,
      headers: authed(auth),
    });
    assert.equal(sigue.statusCode, 200);
  });

  it('DELETE /api/campaigns/:id inexistente → 404', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/campaigns/00000000-0000-4000-8000-000000000000',
      headers: authed(auth),
    });
    assert.equal(res.statusCode, 404);
  });
});
