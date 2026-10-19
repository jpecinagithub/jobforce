/**
 * Tests de costes (Fase 5): libro de eventos, presupuestos configurables,
 * circuit breaker por conector e integración con la ruta de búsqueda de Exa.
 *
 * Requieren `DATABASE_URL` en el entorno (PostgreSQL real, como el resto de
 * la suite del backend). No hacen llamadas reales a Exa: el cliente se
 * sustituye con `setCampaignTestDeps`.
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
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

let app: FastifyInstance;
let auth: AuthContext;

function makeFakeClient(falla: boolean): ExaClient {
  return {
    async search(opts): Promise<ExaSearchResponse> {
      if (falla) throw new Error('fallo simulado de Exa');
      return {
        requestId: `req-${opts.query}`,
        costDollars: 0.007,
        results: [
          {
            id: 'r1',
            title: 'CFO — Acme',
            url: `https://empleo.example/oferta/${opts.query}`,
            highlights: ['Se busca CFO con experiencia en IFRS'],
          },
        ],
      };
    },
  };
}

async function createCampaign(name = 'Costes'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/campaigns',
    payload: { name },
    headers: authed(auth),
  });
  assert.equal(res.statusCode, 201, `crear campaña: ${res.statusCode} ${res.body}`);
  return res.json<{ id: string }>().id;
}

describe('costes (Fase 5)', () => {
  before(async () => {
    app = await buildTestApp({ EXA_API_KEY: 'clave-falsa-de-test' });
  });
  after(async () => {
    resetCampaignTestDeps();
    await closeTestApp(app);
  });
  beforeEach(async () => {
    await resetDb();
    auth = await setupAndLogin(app);
    resetCampaignTestDeps();
  });

  it('GET /api/costs/summary muestra presupuestos con uso 0', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/costs/summary', headers: authed(auth, false) });
    assert.equal(res.statusCode, 200);
    const body = res.json<{
      diario: { usado_usd: number; limite_usd: number; agotado: boolean };
      mensual: { usado_usd: number; limite_usd: number; agotado: boolean };
      campana: null;
    }>();
    assert.equal(body.diario.limite_usd, 5);
    assert.equal(body.mensual.limite_usd, 50);
    assert.equal(body.diario.usado_usd, 0);
    assert.equal(body.diario.agotado, false);
    assert.equal(body.campana, null);
  });

  it('PUT /api/costs/budgets fija presupuestos y summary los refleja', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/costs/budgets',
      payload: { daily_usd: 12.5, monthly_usd: 60 },
      headers: authed(auth),
    });
    assert.equal(put.statusCode, 200);
    assert.deepEqual(put.json().presupuestos, { daily_usd: 12.5, monthly_usd: 60 });

    const res = await app.inject({ method: 'GET', url: '/api/costs/summary', headers: authed(auth, false) });
    const body = res.json<{ diario: { limite_usd: number }; mensual: { limite_usd: number } }>();
    assert.equal(body.diario.limite_usd, 12.5);
    assert.equal(body.mensual.limite_usd, 60);
  });

  it('PUT /api/costs/budgets rechaza valores negativos (400)', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/costs/budgets',
      payload: { daily_usd: -1 },
      headers: authed(auth),
    });
    assert.equal(put.statusCode, 400);
  });

  it('POST /api/costs/events registra llm_tokens con estimación y es idempotente', async () => {
    const payload = {
      categoria: 'llm_tokens',
      cantidad_usd: 0,
      detalles: { modelo: 'claude-sonnet-4-6', tokens_entrada: 1_000_000, tokens_salida: 1_000_000 },
      idempotency_key: 'llm:test-1',
    };
    const r1 = await app.inject({ method: 'POST', url: '/api/costs/events', payload, headers: authed(auth) });
    assert.equal(r1.statusCode, 201);
    assert.equal(r1.json<{ duplicado: boolean }>().duplicado, false);

    const r2 = await app.inject({ method: 'POST', url: '/api/costs/events', payload, headers: authed(auth) });
    assert.equal(r2.statusCode, 200);
    assert.equal(r2.json<{ duplicado: boolean }>().duplicado, true);

    // 1M in (3 $/M) + 1M out (15 $/M) = 18 USD, registrado una sola vez.
    const sum = await app.inject({ method: 'GET', url: '/api/costs/summary', headers: authed(auth, false) });
    const body = sum.json<{ diario: { usado_usd: number } }>();
    assert.equal(body.diario.usado_usd, 18);
  });

  it('GET /api/costs/events lista con filtros', async () => {
    const campId = await createCampaign();
    await app.inject({
      method: 'POST',
      url: '/api/costs/events',
      payload: { campaign_id: campId, categoria: 'page_extract', cantidad_usd: 0, detalles: { conector: 'ashby', paginas: 3 } },
      headers: authed(auth),
    });
    await app.inject({
      method: 'POST',
      url: '/api/costs/events',
      payload: { categoria: 'gmail', cantidad_usd: 0 },
      headers: authed(auth),
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/costs/events?campaign_id=${campId}&categoria=page_extract`,
      headers: authed(auth, false),
    });
    assert.equal(res.statusCode, 200);
    const eventos = res.json<{ eventos: Array<{ categoria: string }> }>().eventos;
    assert.equal(eventos.length, 1);
    assert.equal(eventos[0].categoria, 'page_extract');
  });

  it('la búsqueda de Exa registra eventos exa_search en el libro', async () => {
    setCampaignTestDeps({ createExaClient: () => makeFakeClient(false) });
    const campId = await createCampaign();
    const res = await app.inject({
      method: 'POST',
      url: `/api/campaigns/${campId}/search`,
      payload: { queries: ['CFO Madrid'], num_results: 3 },
      headers: authed(auth),
    });
    assert.equal(res.statusCode, 200, res.body);

    const sum = await app.inject({
      method: 'GET',
      url: `/api/costs/summary?campaign_id=${campId}`,
      headers: authed(auth, false),
    });
    const body = sum.json<{
      diario: { usado_usd: number };
      campana: { usada_usd: number; cap_exa_usd: number; agotada: boolean };
    }>();
    assert.ok(body.diario.usado_usd > 0, 'el gasto diario debe reflejar la búsqueda');
    assert.ok(body.campana.usada_usd > 0, 'el gasto de campaña debe reflejar la búsqueda');
    assert.equal(body.campana.cap_exa_usd, 3);
    assert.equal(body.campana.agotada, false);

    const ev = await app.inject({
      method: 'GET',
      url: `/api/costs/events?campaign_id=${campId}&categoria=exa_search`,
      headers: authed(auth, false),
    });
    assert.equal(ev.json<{ eventos: unknown[] }>().eventos.length, 1);
  });

  it('presupuesto diario agotado bloquea la búsqueda (409)', async () => {
    setCampaignTestDeps({ createExaClient: () => makeFakeClient(false) });
    const campId = await createCampaign();
    await app.inject({
      method: 'POST',
      url: '/api/costs/events',
      payload: { campaign_id: campId, categoria: 'exa_search', cantidad_usd: 0.02 },
      headers: authed(auth),
    });
    await app.inject({
      method: 'PUT',
      url: '/api/costs/budgets',
      payload: { daily_usd: 0.01 },
      headers: authed(auth),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/campaigns/${campId}/search`,
      payload: { queries: ['CFO Madrid'] },
      headers: authed(auth),
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json<{ error: string }>().error, 'presupuesto_diario_agotado');
  });

  it('5 fallos seguidos de Exa abren el breaker y la siguiente búsqueda da 503', async () => {
    setCampaignTestDeps({ createExaClient: () => makeFakeClient(true) });
    const campId = await createCampaign();
    // 5 consultas que fallan → 5 fallos seguidos → circuito abierto.
    const r1 = await app.inject({
      method: 'POST',
      url: `/api/campaigns/${campId}/search`,
      payload: { queries: ['a', 'b', 'c', 'd', 'e'] },
      headers: authed(auth),
    });
    assert.equal(r1.statusCode, 200);
    const fallos = r1.json<{ searches: Array<{ error?: string }> }>().searches.filter((s) => s.error);
    assert.equal(fallos.length, 5);

    const r2 = await app.inject({
      method: 'POST',
      url: `/api/campaigns/${campId}/search`,
      payload: { queries: ['otra'] },
      headers: authed(auth),
    });
    assert.equal(r2.statusCode, 503);
    assert.equal(r2.json<{ error: string }>().error, 'conector_deshabilitado_temporalmente');

    // El breaker aparece en el panel.
    const br = await app.inject({ method: 'GET', url: '/api/costs/breakers', headers: authed(auth, false) });
    const exa = br.json<{ conectores: Array<{ connector: string; disponible: boolean; consecutive_failures: number }> }>()
      .conectores.find((c) => c.connector === 'exa');
    assert.ok(exa, 'exa debe aparecer en breakers');
    assert.equal(exa.disponible, false);
    assert.ok(exa.consecutive_failures >= 5);

    // Reseteo manual → vuelve a estar disponible (y la búsqueda ya no da 503).
    const reset = await app.inject({
      method: 'POST',
      url: '/api/costs/breakers/exa/reset',
      headers: authed(auth),
    });
    assert.equal(reset.statusCode, 200);
    const r3 = await app.inject({
      method: 'POST',
      url: `/api/campaigns/${campId}/search`,
      payload: { queries: ['otra'] },
      headers: authed(auth),
    });
    assert.notEqual(r3.statusCode, 503);
  });

  it('un éxito tras fallos resetea el contador del breaker', async () => {
    // 4 fallos y luego un éxito: el contador vuelve a 0.
    setCampaignTestDeps({ createExaClient: () => makeFakeClient(true) });
    const campId = await createCampaign();
    await app.inject({
      method: 'POST',
      url: `/api/campaigns/${campId}/search`,
      payload: { queries: ['a', 'b', 'c', 'd'] },
      headers: authed(auth),
    });
    setCampaignTestDeps({ createExaClient: () => makeFakeClient(false) });
    await app.inject({
      method: 'POST',
      url: `/api/campaigns/${campId}/search`,
      payload: { queries: ['ok'] },
      headers: authed(auth),
    });
    const br = await app.inject({ method: 'GET', url: '/api/costs/breakers', headers: authed(auth, false) });
    const exa = br.json<{ conectores: Array<{ connector: string; consecutive_failures: number }> }>()
      .conectores.find((c) => c.connector === 'exa');
    assert.ok(exa);
    assert.equal(exa.consecutive_failures, 0);
  });

  it('PUT /api/campaigns/:id acepta total_budget_cap_usd y summary lo refleja', async () => {
    const campId = await createCampaign();
    const put = await app.inject({
      method: 'PUT',
      url: `/api/campaigns/${campId}`,
      payload: { total_budget_cap_usd: 10 },
      headers: authed(auth),
    });
    assert.equal(put.statusCode, 200);

    const get = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${campId}`,
      headers: authed(auth, false),
    });
    assert.equal(get.json<{ campaign: { total_budget_cap_usd: number } }>().campaign.total_budget_cap_usd, 10);

    const sum = await app.inject({
      method: 'GET',
      url: `/api/costs/summary?campaign_id=${campId}`,
      headers: authed(auth, false),
    });
    assert.equal(sum.json<{ campana: { cap_total_usd: number } }>().campana.cap_total_usd, 10);
  });

  it('GET /api/costs/summary exige sesión (401)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/costs/summary' });
    assert.equal(res.statusCode, 401);
  });
});
