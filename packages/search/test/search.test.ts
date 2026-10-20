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
  checkUrlAlive,
  looksLikePersonProfile,
  extractApplicationContact,
  selectQueries,
  fetchOfferText,
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
    assert.equal(seenBody.query, 'CFO finance job');
    assert.equal(seenBody.type, 'auto');
    assert.equal(seenBody.numResults, 5);
    assert.deepEqual(seenBody.excludeDomains, ['linkedin.com', 'exa.ai', 'rocketreach.co', 'zoominfo.com', 'signalhire.com', 'theorg.com', 'apollo.io', 'lusha.com']);
    assert.deepEqual(seenBody.contents, { highlights: true, text: { maxCharacters: 8000 } });
    // Actualidad: startPublishedDate dentro de la ventana de 30 días.
    const desde = new Date(String(seenBody.startPublishedDate)).getTime();
    const ahora = Date.now();
    assert.ok(Number.isFinite(desde), 'startPublishedDate debe ser una fecha ISO');
    assert.ok(ahora - desde >= 29 * 24 * 3600 * 1000 && ahora - desde <= 31 * 24 * 3600 * 1000);

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

  it('propaga el texto completo del resultado cuando Exa lo trae', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          requestId: 'x',
          results: [
            { id: 'r1', title: 'FM', url: 'https://example.com/1', text: 'Cuerpo completo de la oferta…' },
            { id: 'r2', title: 'FM2', url: 'https://example.com/2', text: '' },
          ],
        }),
        { status: 200 },
      )) as typeof fetch;
    const client = createExaClient('clave-ficticia');
    const res = await client.search({ query: 'q', numResults: 2 });
    assert.equal(res.results[0].text, 'Cuerpo completo de la oferta…');
    assert.ok(!('text' in res.results[1]));
  });

  it('getContents devuelve el mapa url→texto y el coste', async () => {
    let seenUrl = '';
    globalThis.fetch = (async (url: unknown) => {
      seenUrl = String(url);
      return new Response(
        JSON.stringify({
          costDollars: { total: 0.002 },
          results: [
            { url: 'https://example.com/a', text: 'Texto A' },
            { url: 'https://example.com/b', text: '' },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const client = createExaClient('clave-ficticia');
    const res = await client.getContents(['https://example.com/a', 'https://example.com/b']);
    assert.equal(seenUrl, 'https://api.exa.ai/contents');
    assert.equal(res.texts.get('https://example.com/a'), 'Texto A');
    assert.equal(res.texts.has('https://example.com/b'), false);
    assert.equal(res.costDollars, 0.002);
    const vacio = await client.getContents([]);
    assert.equal(vacio.texts.size, 0);
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

describe('looksLikePersonProfile', () => {
  it('detecta los perfiles de personas reales vistos en producción', () => {
    for (const t of [
      'Oriol Camí Marnet',
      'LUZANGELA BERNAL',
      'zango ousmane',
      'Tamara Garcia',
      'Marcel FEZE',
      'Wilmar Ivan Paez Pataquiva',
      'Edward Andres Gonzalez Mancera',
      'Khadim Ndiaye',
    ]) {
      assert.equal(looksLikePersonProfile(t), true, t);
    }
  });

  it('nunca descarta una oferta de verdad', () => {
    for (const t of [
      'Finance Manager RCA - Coordination SUD',
      'Country Financial Controller – NGO Jobs Africa',
      'Coordinador/a expatriado/a Delegación de África Occidental',
      'TÉCNICO/A PROYECTOS EN MALI - Red ONGD de Madrid',
      'Administrativo/a de contabilidad y servicios generales',
      'Head of Operational Finance & Support Services',
      'Finance Manager',
      'Senior Finance Manager, CFM & Special Projects',
      'Global administrative coordinator – international missions',
      'RECRUTEMENT D’UN RESPONSABLE ADMINISTRATIF ET FINANCIER',
      null,
      '',
      'ReliefWeb',
    ]) {
      assert.equal(looksLikePersonProfile(t), false, String(t));
    }
  });
});

describe('extractApplicationContact', () => {
  it('extrae el email de aplicación y su frase (caso real Mundubat)', () => {
    const c = extractApplicationContact('Coordinador/a expatriado/a', [
      'Las personas interesadas deberán enviar su candidatura antes del 23 de octubre a candidaturas@mundubat.org indicando en el asunto “Coordinador/a África Occ.”.',
    ]);
    assert.equal(c?.email, 'candidaturas@mundubat.org');
    assert.ok(c && c.notes.includes('asunto'));
  });

  it('ignora buzones no-reply y devuelve null si no hay email', () => {
    assert.equal(
      extractApplicationContact('Finance Manager', ['Avisos automáticos: no-reply@empresa.com']),
      null,
    );
    assert.equal(extractApplicationContact('Finance Manager', ['Sin contacto por correo.']), null);
    assert.equal(extractApplicationContact(null, null), null);
  });
});

describe('selectQueries', () => {
  const diez = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8', 'q9', 'q10'];

  it('con ≤5 consultas devuelve todas', () => {
    assert.deepEqual(selectQueries(['a', 'b']), ['a', 'b']);
    assert.deepEqual(selectQueries(diez.slice(0, 5)), diez.slice(0, 5));
  });

  it('con 10 consultas rota por día: dos días seguidos cubren las 10', () => {
    const d1 = selectQueries(diez, new Date('2026-10-20T08:00:00Z'));
    const d2 = selectQueries(diez, new Date('2026-10-21T08:00:00Z'));
    assert.equal(d1.length, 5);
    assert.equal(d2.length, 5);
    assert.deepEqual([...d1, ...d2].sort(), [...diez].sort());
    // El mismo día siempre elige las mismas (determinista).
    assert.deepEqual(selectQueries(diez, new Date('2026-10-20T23:00:00Z')), d1);
  });
});

describe('fetchOfferText', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('extrae texto legible del HTML (sin scripts ni estilos)', async () => {
    globalThis.fetch = (async () =>
      new Response(
        '<html><head><style>.x{color:red}</style><script>var a=1;</script></head>' +
          '<body><h1>Finance Manager</h1><p>We are hiring &amp; growing.</p><p>Apply now.</p></body></html>',
        { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
      )) as typeof fetch;
    const text = await fetchOfferText('https://example.com/job');
    assert.ok(text && text.includes('Finance Manager'));
    assert.ok(text && text.includes('We are hiring & growing.'));
    assert.ok(text && !text.includes('var a=1'));
    assert.ok(text && !text.includes('color:red'));
  });

  it('devuelve null con HTTP de error o contenido no HTML', async () => {
    globalThis.fetch = (async () =>
      new Response('not found', { status: 404, headers: { 'Content-Type': 'text/html' } })) as typeof fetch;
    assert.equal(await fetchOfferText('https://example.com/404'), null);
    globalThis.fetch = (async () =>
      new Response('{"a":1}', { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    assert.equal(await fetchOfferText('https://example.com/api'), null);
  });
});

describe('EXA_COST_ESTIMATE_PER_SEARCH_USD', () => {
  it('es la estimación conservadora del contrato', () => {
    assert.equal(EXA_COST_ESTIMATE_PER_SEARCH_USD, 0.01);
  });
});

// ---------------------------------------------------------------------------
// checkUrlAlive
// ---------------------------------------------------------------------------

describe('checkUrlAlive', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('devuelve true con HEAD 200', async () => {
    globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof fetch;
    assert.equal(await checkUrlAlive('https://example.com/oferta'), true);
  });

  it('devuelve false con 404', async () => {
    globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
    assert.equal(await checkUrlAlive('https://example.com/muerta'), false);
  });

  it('reintenta con GET si HEAD devuelve 405', async () => {
    let calls = 0;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      calls += 1;
      if (init?.method === 'HEAD') return new Response(null, { status: 405 });
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    assert.equal(await checkUrlAlive('https://example.com/oferta'), true);
    assert.equal(calls, 2);
  });

  it('devuelve false ante error de red', async () => {
    globalThis.fetch = (async () => {
      throw new Error('boom');
    }) as typeof fetch;
    assert.equal(await checkUrlAlive('https://example.com/oferta'), false);
  });
});
