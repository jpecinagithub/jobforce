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
  checkUrlStatus,
  checkUrlStatusDetailed,
  extractApplyUrl,
  extractCompany,
  extractLocation,
  jnjCareersJobUrl,
  reliefWebJobId,
  workdayCxsJobUrl,
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

// ---------------------------------------------------------------------------
// checkUrlStatus (tri-estado: la etiqueta «enlace roto» exige confirmación)
// ---------------------------------------------------------------------------

describe('checkUrlStatus', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const stubStatus = (status: number) => {
    globalThis.fetch = (async () => new Response(null, { status })) as typeof fetch;
  };

  const stubByMethod = (head: number, get: number) => {
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) =>
      new Response(null, { status: init?.method === 'GET' ? get : head })) as typeof fetch;
  };

  const dnsError = () =>
    Object.assign(new Error('fetch failed'), {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND portal.example'), {
        code: 'ENOTFOUND',
      }),
    });

  it('200 → alive', async () => {
    stubStatus(200);
    assert.equal(await checkUrlStatus('https://example.com/oferta'), 'alive');
  });

  it('404 en HEAD y GET → broken (confirmado)', async () => {
    stubByMethod(404, 404);
    assert.equal(await checkUrlStatus('https://example.com/muerta'), 'broken');
  });

  it('410 en HEAD y GET → broken (confirmado)', async () => {
    stubByMethod(410, 410);
    assert.equal(await checkUrlStatus('https://example.com/muerta'), 'broken');
  });

  it('404 en HEAD pero 200 en GET → alive (el HEAD mentía)', async () => {
    stubByMethod(404, 200);
    assert.equal(await checkUrlStatus('https://example.com/oferta'), 'alive');
  });

  it('403 en ambos → unknown (muro anti-bots, no es un roto)', async () => {
    stubByMethod(403, 403);
    assert.equal(await checkUrlStatus('https://example.com/protegida'), 'unknown');
  });

  it('404 en HEAD pero 403 en GET → unknown (sin confirmación)', async () => {
    stubByMethod(404, 403);
    assert.equal(await checkUrlStatus('https://example.com/dudosa'), 'unknown');
  });

  it('500 → unknown (fallo transitorio del portal)', async () => {
    stubStatus(500);
    assert.equal(await checkUrlStatus('https://example.com/caida'), 'unknown');
  });

  it('dominio inexistente (ENOTFOUND en ambos) → broken', async () => {
    globalThis.fetch = (async () => {
      throw dnsError();
    }) as typeof fetch;
    assert.equal(await checkUrlStatus('https://no-existe.example/oferta'), 'broken');
  });

  it('error de red genérico → unknown', async () => {
    globalThis.fetch = (async () => {
      throw new Error('boom');
    }) as typeof fetch;
    assert.equal(await checkUrlStatus('https://example.com/oferta'), 'unknown');
  });
});

// ---------------------------------------------------------------------------
// Workday: la página pública es una SPA con 200 siempre; manda su API CXS
// ---------------------------------------------------------------------------

describe('Workday (API CXS)', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const GSK =
    'https://gsk.wd5.myworkdayjobs.com/en-US/GSKCareers/job/Finance-Manager--Group-Reporting_447915-1';

  /** La SPA siempre responde 200; la API CXS responde `apiStatus`. */
  const stubWorkday = (apiStatus: number) => {
    globalThis.fetch = (async (url: unknown) =>
      new Response(null, {
        status: String(url).includes('/wday/cxs/') ? apiStatus : 200,
      })) as typeof fetch;
  };

  it('workdayCxsJobUrl construye la URL de la API (con y sin locale)', () => {
    assert.equal(
      workdayCxsJobUrl(GSK),
      'https://gsk.wd5.myworkdayjobs.com/wday/cxs/gsk/GSKCareers/job/Finance-Manager--Group-Reporting_447915-1',
    );
    assert.equal(
      workdayCxsJobUrl('https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/Tel-Aviv/Dev_JR1'),
      'https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/job/Tel-Aviv/Dev_JR1',
    );
    assert.equal(workdayCxsJobUrl('https://boards.greenhouse.io/acme/jobs/123'), null);
    assert.equal(workdayCxsJobUrl('https://gsk.wd5.myworkdayjobs.com/GSKCareers'), null);
  });

  it('API 404 → broken, aunque la página pública devuelva 200', async () => {
    stubWorkday(404);
    assert.deepEqual(await checkUrlStatusDetailed(GSK), { status: 'broken', via: 'workday_api' });
    assert.equal(await checkUrlAlive(GSK), false);
  });

  it('API 200 → alive', async () => {
    stubWorkday(200);
    assert.deepEqual(await checkUrlStatusDetailed(GSK), { status: 'alive', via: 'workday_api' });
  });

  it('API no concluyente (500) → unknown, nunca el 200 de la SPA', async () => {
    stubWorkday(500);
    assert.equal(await checkUrlStatus(GSK), 'unknown');
  });
});

// ---------------------------------------------------------------------------
// Breezy HR: posición cerrada = HTTP 200 con plantilla «Position Closed»
// ---------------------------------------------------------------------------

describe('Breezy HR (cierre por contenido)', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const BREEZY = 'https://immersive-technologies.breezy.hr/p/20be2cb6f85a-finance-manager-latam';

  const stubHtml = (html: string, status = 200) => {
    globalThis.fetch = (async () => new Response(html, { status })) as typeof fetch;
  };

  it('200 con la plantilla de cierre → broken', async () => {
    stubHtml(
      '<div class="application-confirmed"><h1>Position Closed</h1><p>Sorry, this position is no longer accepting candidates.</p></div>',
    );
    assert.deepEqual(await checkUrlStatusDetailed(BREEZY), {
      status: 'broken',
      via: 'breezy_content',
    });
    assert.equal(await checkUrlAlive(BREEZY), false);
  });

  it('200 con la oferta abierta (formulario de candidatura) → alive', async () => {
    stubHtml('<h1>Finance Manager Latam</h1><p>We are looking for a Finance Manager.</p><button>Apply for this position</button>');
    assert.equal(await checkUrlStatus(BREEZY), 'alive');
  });

  it('404 → broken', async () => {
    stubHtml('not found', 404);
    assert.equal(await checkUrlStatus(BREEZY), 'broken');
  });

  it('error de red → unknown', async () => {
    globalThis.fetch = (async () => {
      throw new Error('boom');
    }) as typeof fetch;
    assert.equal(await checkUrlStatus(BREEZY), 'unknown');
  });
});

// ---------------------------------------------------------------------------
// JnJ: la CXS del tenant jj da 403; manda careers.jnj.com (Phenom)
// ---------------------------------------------------------------------------

describe('JnJ (CXS cerrada → careers.jnj.com)', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const JJ =
    'https://jj.wd5.myworkdayjobs.com/en-US/JJ/job/Lead-GS-Finance-CFM-Innovative-Medicine_R-101032';

  it('jnjCareersJobUrl deriva la URL del sitio desde el req del slug', () => {
    assert.equal(jnjCareersJobUrl(JJ), 'https://www.careers.jnj.com/en/jobs/r-101032/');
    assert.equal(jnjCareersJobUrl('https://gsk.wd5.myworkdayjobs.com/en-US/GSKCareers/job/X_1'), null);
  });

  it('CXS 403 + sitio 404 → broken vía jnj_careers', async () => {
    globalThis.fetch = (async (url: unknown) =>
      new Response(null, {
        status: String(url).includes('careers.jnj.com') ? 404 : 403,
      })) as typeof fetch;
    assert.deepEqual(await checkUrlStatusDetailed(JJ), { status: 'broken', via: 'jnj_careers' });
  });

  it('CXS 403 + sitio 200 → alive vía jnj_careers', async () => {
    globalThis.fetch = (async (url: unknown) =>
      new Response(null, {
        status: String(url).includes('careers.jnj.com') ? 200 : 403,
      })) as typeof fetch;
    assert.equal(await checkUrlStatus(JJ), 'alive');
  });

  it('CXS 200 → alive vía workday_api (sin tocar el sitio)', async () => {
    let calls = 0;
    globalThis.fetch = (async (url: unknown) => {
      calls++;
      assert.ok(String(url).includes('/wday/cxs/'), 'solo debe llamarse a la CXS');
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    assert.deepEqual(await checkUrlStatusDetailed(JJ), { status: 'alive', via: 'workday_api' });
    assert.equal(calls, 1);
  });
});

// ---------------------------------------------------------------------------
// ReliefWeb: manda su API (la web miente desde IPs de datacenter)
// ---------------------------------------------------------------------------

describe('ReliefWeb (API oficial)', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const RW = 'https://reliefweb.int/job/4231682/operational-finance-advisor';

  it('reliefWebJobId extrae el id solo de URLs de oferta de ReliefWeb', () => {
    assert.equal(reliefWebJobId(RW), '4231682');
    assert.equal(reliefWebJobId('https://reliefweb.int/jobs'), null);
    assert.equal(reliefWebJobId('https://example.com/job/4231682'), null);
  });

  it('API 404 (oferta purgada) → broken', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ status: 404 }), { status: 404 })) as typeof fetch;
    assert.deepEqual(await checkUrlStatusDetailed(RW), { status: 'broken', via: 'reliefweb_api' });
  });

  it('API 403 (existe pero appname no aprobado) → unknown', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ status: 403 }), { status: 403 })) as typeof fetch;
    assert.equal(await checkUrlStatus(RW), 'unknown');
  });

  it('API 200 publicada sin cierre vencido → alive; expirada → broken', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ data: [{ fields: { status: 'published', date: { closing: '2999-01-01' } } }] }),
        { status: 200 },
      )) as typeof fetch;
    assert.equal(await checkUrlStatus(RW), 'alive');
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ data: [{ fields: { status: 'expired', date: { closing: '2020-01-01' } } }] }),
        { status: 200 },
      )) as typeof fetch;
    assert.equal(await checkUrlStatus(RW), 'broken');
  });
});

// ---------------------------------------------------------------------------
// Ashby: manda su API pública de la bolsa (la SPA responde «Job not found»)
// ---------------------------------------------------------------------------

describe('Ashby (posting-api)', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const VIVA = 'd33db597-0b1f-4170-9095-9c32b6b18443';
  const MUERTA = 'd1be3425-2d78-4141-9f9c-10f61930ccbf';
  const URL_VIVA = `https://jobs.ashbyhq.com/possible-finance/${VIVA}`;
  const URL_MUERTA = `https://jobs.ashbyhq.com/possible-finance/${MUERTA}/application`;

  it('ashbyJobRef extrae org e id solo de URLs de oferta de Ashby', async () => {
    const { ashbyJobRef } = await import('../src/index.ts');
    assert.deepEqual(ashbyJobRef(URL_VIVA), { org: 'possible-finance', id: VIVA });
    assert.deepEqual(ashbyJobRef(URL_MUERTA), { org: 'possible-finance', id: MUERTA });
    assert.equal(ashbyJobRef('https://jobs.ashbyhq.com/possible-finance'), null);
    assert.equal(ashbyJobRef('https://example.com/possible-finance/' + VIVA), null);
  });

  it('id presente en la bolsa → alive; ausente → broken (vía ashby_api)', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ jobs: [{ id: VIVA }, { id: 'otra' }] }), { status: 200 })) as typeof fetch;
    assert.deepEqual(await checkUrlStatusDetailed(URL_VIVA), { status: 'alive', via: 'ashby_api' });
    assert.deepEqual(await checkUrlStatusDetailed(URL_MUERTA), { status: 'broken', via: 'ashby_api' });
  });

  it('API no disponible → unknown (nunca roto sin evidencia)', async () => {
    globalThis.fetch = (async () => new Response('no', { status: 503 })) as typeof fetch;
    assert.deepEqual(await checkUrlStatusDetailed(URL_VIVA), { status: 'unknown', via: 'ashby_api' });
  });
});

// ---------------------------------------------------------------------------
// extractApplyUrl
// ---------------------------------------------------------------------------

describe('extractApplyUrl', () => {
  it('encuentra el enlace en la sección «How to apply» (caso Sightsavers)', () => {
    const text = [
      'We are looking for a Project Finance Officer.',
      '',
      '## How to apply',
      '',
      'To apply for this opportunity, please complete your application using the link provided below:',
      '',
      'https://careers.sightsavers.org/jobs/1669?lang=en-us',
      '',
      'As an equal opportunity employer, we encourage applications.',
    ].join('\n');
    assert.equal(
      extractApplyUrl(text, 'https://reliefweb.int/job/4234456/project-finance-officer'),
      'https://careers.sightsavers.org/jobs/1669?lang=en-us',
    );
  });

  it('sin sección, usa el enlace con pinta de aplicación (markdown)', () => {
    const text =
      'Finance Manager role. [Apply for this job](https://acme.jobs.personio.com/job/123) before Friday. Share: [Facebook](https://facebook.com/share)';
    assert.equal(
      extractApplyUrl(text, 'https://www.devex.com/jobs/finance-manager-1'),
      'https://acme.jobs.personio.com/job/123',
    );
  });

  it('sin enlaces útiles → null (no inventa)', () => {
    assert.equal(extractApplyUrl('A job with no links at all.', 'https://example.org/j/1'), null);
    assert.equal(
      extractApplyUrl('Share this job on https://facebook.com/share', 'https://example.org/j/1'),
      null,
    );
    assert.equal(extractApplyUrl(null, 'https://example.org/j/1'), null);
  });
});

// ---------------------------------------------------------------------------
// extractCompany
// ---------------------------------------------------------------------------

describe('extractCompany', () => {
  it('campo Company del texto de Exa, con pulido de tenant', () => {
    assert.equal(
      extractCompany({
        title: 'Finance manager - Logo - Myworkdayjobs.com',
        url: 'https://dssmith.wd3.myworkdayjobs.com/en-US/careers/job/Finance-manager_R-15037',
        text: '# Finance manager at Dssmith\n\n- **Company:** Dssmith\n- **Location:** Tallinn',
      }),
      'DS Smith',
    );
  });

  it('patrón «… at X» del título', () => {
    assert.equal(
      extractCompany({
        title: 'Finance Analyst - North America Deliver at Kenvue',
        url: 'https://kenvue.wd5.myworkdayjobs.com/en-US/kenvue/job/Finance-Analyst_1',
      }),
      'Kenvue',
    );
    assert.equal(
      extractCompany({
        title: 'Lead GS Finance CFM Innovative Medicine at Jj',
        url: 'https://jj.wd5.myworkdayjobs.com/en-US/JJ/job/Lead_R-101032',
      }),
      'J&J',
    );
    assert.equal(
      extractCompany({
        title: 'School Business Manager – Established Primary School at Marchant Recruitment',
        url: 'https://example.com/job/1',
      }),
      'Marchant Recruitment',
    );
  });

  it('segmento inicial «Empresa - Puesto»', () => {
    assert.equal(
      extractCompany({ title: 'Harmattan AI - Finance Manager MEA', url: 'https://example.com/j/2' }),
      'Harmattan AI',
    );
  });

  it('tenant del ATS cuando el título no dice nada', () => {
    assert.equal(
      extractCompany({
        title: 'IT Specialist - Myworkdayjobs.com',
        url: 'https://jotun.wd3.myworkdayjobs.com/en-US/Jotun_careers/job/IT-Specialist_R10373',
      }),
      'Jotun',
    );
    assert.equal(
      extractCompany({
        title: 'Finance Manager Latam',
        url: 'https://immersive-technologies.breezy.hr/p/20be2cb6f85a-finance-manager-latam',
      }),
      'Immersive Technologies',
    );
  });

  it('author basura NO es empresa; «X Careers» sí', () => {
    assert.equal(
      extractCompany({ title: 'Finance Manager', url: 'https://example.com/j/3', author: 'Publicada el' }),
      null,
    );
    assert.equal(
      extractCompany({
        title: 'Senior Finance Manager, MTO, Beerse',
        url: 'https://www.careers.jnj.com/en/jobs/r-106067/x/',
        author: 'Johnson, Johnson Careers',
      }),
      'Johnson & Johnson',
    );
  });

  it('título «Puesto - Portal» en español NO es empresa (caso La Coordinadora)', () => {
    assert.equal(
      extractCompany({
        title: 'Técnico/a de contabilidad - La Coordinadora de Organizaciones para el Desarrollo',
        url: 'https://www.coordinadoraongd.org/empleo/tecnico-contabilidad',
      }),
      null,
    );
    assert.equal(
      extractCompany({
        title: 'TÉCNICO/A PROYECTOS EN MALI - Red ONGD de Madrid',
        url: 'https://www.coordinadoraongd.org/empleo/tecnico-mali',
      }),
      null,
    );
  });

  it('sin señal → null (ReliefWeb no es la empresa)', () => {
    assert.equal(
      extractCompany({
        title: 'Finance Manager - Syrian Arab Republic | ReliefWeb',
        url: 'https://reliefweb.int/job/4233466/finance-manager',
      }),
      null,
    );
  });
});

describe('extractLocation (columna DESTINO)', () => {
  it('ReliefWeb: combina City + Country del texto estructurado', () => {
    assert.equal(
      extractLocation({
        title: 'Finance Manager Lebanon',
        url: 'https://reliefweb.int/job/4233812/x',
        text: 'Some intro\nCountry: Lebanon\nCity: Beirut\nClosing date 5 Nov 2026',
      }),
      'Beirut, Lebanon',
    );
  });

  it('etiqueta Location: en un ATS', () => {
    assert.equal(
      extractLocation({
        title: 'Accounting Manager',
        url: 'https://x.example/j/1',
        text: 'About the role\nLocation: Mexico City, Mexico\nApply now',
      }),
      'Mexico City, Mexico',
    );
  });

  it('sufijo del título ReliefWeb', () => {
    assert.equal(
      extractLocation({
        title: 'Head of Finance & Administration - Somalia | ReliefWeb',
        url: 'https://reliefweb.int/job/1/x',
        text: 'sin campos estructurados',
      }),
      'Somalia',
    );
  });

  it('sin evidencia → null (nunca inventa)', () => {
    assert.equal(
      extractLocation({
        title: 'Finance Manager at Acme',
        url: 'https://x.example/j/2',
        text: 'Great role in a great team. Apply by email.',
      }),
      null,
    );
  });
});
