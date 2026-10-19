/**
 * Tests unitarios de @jobforce/search (sin red: el cliente se prueba con
 * `globalThis.fetch` sustituido por un stub; la API key es ficticia).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createExaClient,
  generateQueries,
  canonicalUrl,
  EXA_COST_ESTIMATE_PER_SEARCH_USD,
} from '../src/index.js';
import { defaultCriteria, type CampaignCriteria } from '@jobforce/domain';

// ---------------------------------------------------------------------------
// canonicalUrl
// ---------------------------------------------------------------------------

describe('canonicalUrl', () => {
  it('pone el host en minúsculas', () => {
    assert.equal(
      canonicalUrl('https://EXAMPLE.com/Oferta/123'),
      'https://example.com/Oferta/123',
    );
  });

  it('quita el fragmento', () => {
    assert.equal(
      canonicalUrl('https://example.com/oferta/123#descripcion'),
      'https://example.com/oferta/123',
    );
  });

  it('quita los parámetros utm_* conservando los demás', () => {
    assert.equal(
      canonicalUrl('https://example.com/o?id=42&utm_source=google&utm_medium=cpc&lang=es'),
      'https://example.com/o?id=42&lang=es',
    );
  });

  it('quita fbclid, gclid y msclkid', () => {
    assert.equal(
      canonicalUrl('https://example.com/o?fbclid=AAA&id=7&gclid=BBB&msclkid=CCC'),
      'https://example.com/o?id=7',
    );
  });

  it('quita la barra final salvo en la raíz', () => {
    assert.equal(canonicalUrl('https://example.com/oferta/'), 'https://example.com/oferta');
    assert.equal(canonicalUrl('https://example.com/'), 'https://example.com/');
  });

  it('devuelve la entrada tal cual ante una URL inválida (no lanza)', () => {
    assert.equal(canonicalUrl('esto-no-es-una-url'), 'esto-no-es-una-url');
    assert.equal(canonicalUrl(''), '');
  });
});

// ---------------------------------------------------------------------------
// generateQueries
// ---------------------------------------------------------------------------

describe('generateQueries', () => {
  it('devuelve las queries dadas tal cual', () => {
    const criteria = defaultCriteria();
    criteria.queries = ['CFO Madrid', 'Finance Manager remoto'];
    assert.deepEqual(generateQueries(criteria), ['CFO Madrid', 'Finance Manager remoto']);
  });

  it('limita las queries dadas a 5', () => {
    const criteria = defaultCriteria();
    criteria.queries = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7'];
    assert.deepEqual(generateQueries(criteria), ['q1', 'q2', 'q3', 'q4', 'q5']);
  });

  it('genera plantillas desde los roles con modificador remote si location es remote_ok', () => {
    const criteria = defaultCriteria();
    criteria.queries = [];
    const queries = generateQueries(criteria);
    assert.equal(queries.length, 5);
    // roles por defecto: ["CFO", "Finance Manager", "Controller"]; location: remote_ok
    assert.equal(
      queries[0],
      '"CFO" OR "Finance Manager" OR "Controller" finance job remote',
    );
    assert.ok(queries.every((q) => q.endsWith(' remote')));
    assert.ok(queries.every((q) => q.includes('"CFO" OR "Finance Manager" OR "Controller"')));
  });

  it('no añade "remote" si location no es remote_ok', () => {
    const criteria = defaultCriteria();
    criteria.queries = [];
    criteria.roles = ['Controller'];
    criteria.mandatory = criteria.mandatory.filter((r) => r.kind !== 'location');
    const queries = generateQueries(criteria);
    assert.equal(queries.length, 5);
    assert.equal(queries[0], '"Controller" finance job');
    assert.ok(queries.every((q) => !q.includes('remote')));
  });

  it('usa "finance" como término genérico si no hay roles', () => {
    const criteria: CampaignCriteria = { ...defaultCriteria(), roles: [], queries: [] };
    const queries = generateQueries(criteria);
    assert.equal(queries.length, 5);
    assert.ok(queries[0].startsWith('"finance"'));
  });
});

// ---------------------------------------------------------------------------
// createExaClient (con fetch sustituido: sin red real)
// ---------------------------------------------------------------------------

describe('createExaClient', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = async () => {
      throw new Error('fetch no debería llamarse sin stub');
    };
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('hace el POST con la forma canónica y parsea la respuesta', async () => {
    let seenUrl = '';
    let seenHeaders: Record<string, string> = {};
    let seenBody: Record<string, unknown> = {};

    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      seenUrl = String(url);
      seenHeaders = Object.fromEntries(new Headers(init?.headers).entries());
      seenBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          requestId: 'req-123',
          costDollars: { total: 0.008 },
          results: [
            {
              id: 'r1',
              title: 'CFO — Madrid',
              url: 'https://example.com/oferta/1',
              publishedDate: '2026-10-15',
              author: 'Acme',
              highlights: ['CFO con experiencia en IFRS'],
            },
            { id: 'r2', title: 'Controller', url: 'https://example.com/oferta/2' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;

    const client = createExaClient('clave-ficticia');
    const res = await client.search({ query: 'CFO finance job', numResults: 5 });

    assert.equal(seenUrl, 'https://api.exa.ai/search');
    assert.equal(seenHeaders['x-api-key'], 'clave-ficticia');
    assert.equal(seenHeaders['content-type'], 'application/json');
    assert.deepEqual(seenBody, {
      query: 'CFO finance job',
      type: 'auto',
      numResults: 5,
      contents: { highlights: true },
    });

    assert.equal(res.requestId, 'req-123');
    assert.equal(res.costDollars, 0.008);
    assert.equal(res.results.length, 2);
    assert.equal(res.results[0].id, 'r1');
    assert.equal(res.results[0].title, 'CFO — Madrid');
    assert.equal(res.results[0].url, 'https://example.com/oferta/1');
    assert.equal(res.results[0].publishedDate, '2026-10-15');
    assert.equal(res.results[0].author, 'Acme');
    assert.deepEqual(res.results[0].highlights, ['CFO con experiencia en IFRS']);
    assert.ok(!('publishedDate' in res.results[1]));
    assert.ok(!('highlights' in res.results[1]));
  });

  it('costDollars es 0 si la API no devuelve costDollars', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ requestId: 'x', results: [] }), { status: 200 })) as typeof fetch;

    const client = createExaClient('clave-ficticia');
    const res = await client.search({ query: 'q', numResults: 1 });
    assert.equal(res.costDollars, 0);
  });

  it('lanza un error claro en español ante un HTTP de error', async () => {
    globalThis.fetch = (async () =>
      new Response('invalid api key', { status: 401, statusText: 'Unauthorized' })) as typeof fetch;

    const client = createExaClient('clave-ficticia');
    await assert.rejects(
      () => client.search({ query: 'q', numResults: 1 }),
      /Exa: HTTP 401/,
    );
  });
});

// ---------------------------------------------------------------------------
// constante de estimación
// ---------------------------------------------------------------------------

describe('EXA_COST_ESTIMATE_PER_SEARCH_USD', () => {
  it('es la estimación conservadora del contrato', () => {
    assert.equal(EXA_COST_ESTIMATE_PER_SEARCH_USD, 0.01);
  });
});
