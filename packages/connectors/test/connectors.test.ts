/**
 * Tests unitarios de @jobforce/connectors.
 *
 * Sin red: solo funciones puras (construcción de URLs, parseo de respuestas)
 * con fixtures recortadas de respuestas REALES obtenidas el 19-oct-2026
 * (ver `test/fixtures/` y `docs/matriz-conectores.md`). Los clientes se
 * prueban con un stub de `fetch` inyectado; los probes en vivo son scripts
 * manuales en `scripts/probe-*.mjs` y NO forman parte de los tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  ashbyBoardUrl,
  ashbyJobPageUrl,
  ashbyApplyUrl,
  ashbyFindJob,
  parseAshbyBoard,
  smartRecruitersPostingsUrl,
  smartRecruitersPostingUrl,
  parseSmartRecruitersPostings,
  parseSmartRecruitersPosting,
  isSmartRecruitersPostingOpen,
  SmartRecruitersNotFoundError,
  createSmartRecruitersClient,
  workdaySiteBase,
  workdayJobsUrl,
  workdayJobDetailUrl,
  workdayJobPageUrl,
  workdayJobsRequestBody,
  parseWorkdayJobs,
  parseWorkdayJobDetail,
  WorkdayNotFoundError,
  createWorkdayClient,
  createAshbyClient,
  greenhouseBoardUrl,
  greenhouseJobDetailUrl,
  greenhouseJobPageUrl,
  parseGreenhouseBoard,
  parseGreenhouseJob,
  GreenhouseNotFoundError,
  createGreenhouseClient,
} from '../src/index.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, name), 'utf8')) as unknown;
}

// ---------------------------------------------------------------------------
// Ashby
// ---------------------------------------------------------------------------

describe('Ashby: construcción de URLs', () => {
  it('el listado incluye ?includeCompensation=true por defecto', () => {
    assert.equal(
      ashbyBoardUrl({ orgHost: 'linear' }),
      'https://api.ashbyhq.com/posting-api/job-board/linear?includeCompensation=true',
    );
  });

  it('permite desactivar la compensación', () => {
    assert.equal(
      ashbyBoardUrl({ orgHost: 'linear', includeCompensation: false }),
      'https://api.ashbyhq.com/posting-api/job-board/linear',
    );
  });

  it('la página pública y la URL de aplicación siguen el patrón observado', () => {
    const id = '1fc309c8-da20-4ff2-84c7-8b863ece2b0a';
    assert.equal(
      ashbyJobPageUrl('notion', id),
      `https://jobs.ashbyhq.com/notion/${id}`,
    );
    assert.equal(
      ashbyApplyUrl('notion', id),
      `https://jobs.ashbyhq.com/notion/${id}/application`,
    );
  });

  it('codifica el orgHost', () => {
    assert.ok(ashbyBoardUrl({ orgHost: 'mi empresa' }).includes('mi%20empresa'));
  });
});

describe('Ashby: parseo del listado (fixture real)', () => {
  const board = parseAshbyBoard(loadFixture('ashby-board.json'));

  it('extrae las ofertas con sus campos', () => {
    assert.equal(board.jobs.length, 2);
    const [first] = board.jobs;
    assert.ok(first.id.length > 0);
    assert.ok(first.title.length > 0);
    assert.ok(first.jobUrl.length > 0);
    assert.ok(first.applyUrl.endsWith('/application'));
  });

  it('la respuesta ya trae la descripción (no hace falta pedir detalle)', () => {
    const [first] = board.jobs;
    assert.ok(first.descriptionHtml.length > 0);
    assert.ok(first.descriptionPlain.length > 0);
  });

  it('ashbyFindJob localiza una oferta por id', () => {
    const [first] = board.jobs;
    assert.equal(ashbyFindJob(board, first.id)?.title, first.title);
    assert.equal(ashbyFindJob(board, 'id-inexistente'), undefined);
  });

  it('lanza si la respuesta no trae `jobs`', () => {
    assert.throws(() => parseAshbyBoard({}), /`jobs`/);
    assert.throws(() => parseAshbyBoard(null), /objeto JSON/);
  });
});

describe('Ashby: cliente con fetch stub', () => {
  const board = loadFixture('ashby-board.json');

  it('listJobs devuelve el board parseado', async () => {
    const client = createAshbyClient((async () =>
      new Response(JSON.stringify(board), { status: 200 })) as typeof fetch);
    const result = await client.listJobs({ orgHost: 'linear' });
    assert.equal(result.jobs.length, 2);
  });

  it('una organización desconocida (404) lanza un error claro', async () => {
    const client = createAshbyClient((async () =>
      new Response('Not Found', { status: 404 })) as typeof fetch);
    await assert.rejects(() => client.listJobs({ orgHost: 'noexiste' }), /organización desconocida/);
  });
});

// ---------------------------------------------------------------------------
// SmartRecruiters
// ---------------------------------------------------------------------------

describe('SmartRecruiters: construcción de URLs', () => {
  it('el listado es paginado con limit/offset', () => {
    assert.equal(
      smartRecruitersPostingsUrl({ company: 'SiloamCareers', limit: 5, offset: 10 }),
      'https://api.smartrecruiters.com/v1/companies/SiloamCareers/postings?limit=5&offset=10',
    );
    assert.equal(
      smartRecruitersPostingsUrl({ company: 'SiloamCareers' }),
      'https://api.smartrecruiters.com/v1/companies/SiloamCareers/postings?limit=100&offset=0',
    );
  });

  it('el detalle sigue el patrón /companies/{company}/postings/{id}', () => {
    assert.equal(
      smartRecruitersPostingUrl('SiloamCareers', '6000000001496266'),
      'https://api.smartrecruiters.com/v1/companies/SiloamCareers/postings/6000000001496266',
    );
  });
});

describe('SmartRecruiters: parseo (fixtures reales)', () => {
  it('el listado devuelve totalFound y metadatos sin descripción', () => {
    const page = parseSmartRecruitersPostings(loadFixture('smartrecruiters-postings.json'));
    assert.equal(page.totalFound, 720);
    assert.equal(page.content.length, 2);
    const [first] = page.content;
    assert.ok(first.id.length > 0);
    assert.ok(first.name.length > 0);
    assert.ok(first.releasedDate != null);
    assert.ok(first.location != null);
  });

  it('el detalle trae descripción, applyUrl y estado', () => {
    const posting = parseSmartRecruitersPosting(loadFixture('smartrecruiters-posting.json'));
    assert.ok(posting.postingUrl.startsWith('https://jobs.smartrecruiters.com/'));
    assert.ok(posting.applyUrl.includes('?oga=true'));
    assert.equal(posting.active, true);
    const sections = Object.values(posting.sections);
    assert.ok(sections.length > 0);
    assert.ok(sections.some((s) => s.text.length > 0));
  });

  it('isSmartRecruitersPostingOpen respeta active y visibility', () => {
    const posting = parseSmartRecruitersPosting(loadFixture('smartrecruiters-posting.json'));
    assert.equal(isSmartRecruitersPostingOpen(posting), true);
    assert.equal(isSmartRecruitersPostingOpen({ ...posting, active: false }), false);
    assert.equal(
      isSmartRecruitersPostingOpen({ ...posting, visibility: 'INTERNAL' }),
      false,
    );
  });

  it('lanza si la forma no es la esperada', () => {
    assert.throws(() => parseSmartRecruitersPostings({}), /`content`/);
    assert.throws(() => parseSmartRecruitersPosting(null), /objeto JSON/);
  });
});

describe('SmartRecruiters: cliente con fetch stub', () => {
  it('un 404 en el detalle lanza SmartRecruitersNotFoundError', async () => {
    const client = createSmartRecruitersClient((async () =>
      new Response(JSON.stringify({ code: 'RESOURCE_NOT_FOUND' }), {
        status: 404,
      })) as typeof fetch);
    await assert.rejects(
      () => client.getPosting('SiloamCareers', '0000000000000000'),
      (err: unknown) => err instanceof SmartRecruitersNotFoundError,
    );
  });
});

// ---------------------------------------------------------------------------
// Workday
// ---------------------------------------------------------------------------

const NVIDIA_SITE = { tenant: 'nvidia', wdHost: 'wd5', site: 'NVIDIAExternalCareerSite' } as const;

describe('Workday: construcción de URLs', () => {
  it('la base combina tenant, wdHost y site', () => {
    assert.equal(
      workdaySiteBase(NVIDIA_SITE),
      'https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite',
    );
    assert.equal(
      workdayJobsUrl(NVIDIA_SITE),
      'https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/jobs',
    );
  });

  it('el detalle cuelga del externalPath tal cual (ya empieza por /job/)', () => {
    const externalPath = '/job/Israel-Tel-Aviv/SDK-Eth-Software-Engineer--Networking_JR2013956';
    assert.equal(
      workdayJobDetailUrl(NVIDIA_SITE, externalPath),
      `https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite${externalPath}`,
    );
  });

  it('la página pública usa el site sin el prefijo /wday/cxs', () => {
    const externalPath = '/job/Israel-Tel-Aviv/SDK-Eth-Software-Engineer--Networking_JR2013956';
    assert.equal(
      workdayJobPageUrl(NVIDIA_SITE, externalPath),
      `https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite${externalPath}`,
    );
  });

  it('el cuerpo del listado recorta limit a 20', () => {
    const body = workdayJobsRequestBody({ limit: 100, offset: 40, searchText: 'finance' });
    assert.deepEqual(body, {
      appliedFacets: {},
      limit: 20,
      offset: 40,
      searchText: 'finance',
    });
  });
});

describe('Workday: parseo (fixtures reales)', () => {
  it('el listado trae total y postings con externalPath', () => {
    const page = parseWorkdayJobs(loadFixture('workday-jobs.json'));
    assert.equal(page.total, 2000);
    assert.ok(page.jobPostings.length > 0);
    const [first] = page.jobPostings;
    assert.ok(first.title.length > 0);
    assert.ok(first.externalPath.startsWith('/job/'));
    assert.ok(first.bulletFields.length > 0);
  });

  it('el detalle trae jobDescription y metadatos', () => {
    const detail = parseWorkdayJobDetail(loadFixture('workday-job-detail.json'));
    assert.ok(detail.title.length > 0);
    assert.ok(detail.jobDescription.length > 0);
    assert.ok(detail.jobReqId != null);
    assert.ok(detail.startDate != null);
    assert.equal(typeof detail.canApply, 'boolean');
  });

  it('lanza si la forma no es la esperada', () => {
    assert.throws(() => parseWorkdayJobs({}), /`jobPostings`/);
    assert.throws(() => parseWorkdayJobDetail({}), /`jobPostingInfo`/);
  });
});

describe('Workday: cliente con fetch stub', () => {
  it('un 404 en el detalle lanza WorkdayNotFoundError', async () => {
    const client = createWorkdayClient((async () =>
      new Response(JSON.stringify({ message: 'not found' }), { status: 404 })) as typeof fetch);
    await assert.rejects(
      () => client.getJob(NVIDIA_SITE, '/job/X/Noexiste_0000000'),
      (err: unknown) => err instanceof WorkdayNotFoundError,
    );
  });

  it('valida que el site esté completo', async () => {
    const client = createWorkdayClient();
    await assert.rejects(
      () => client.listJobs({ tenant: '', wdHost: 'wd5', site: 'X' }),
      /`tenant` es obligatorio/,
    );
  });
});

// ---------------------------------------------------------------------------
// Greenhouse
// ---------------------------------------------------------------------------

describe('Greenhouse: construcción de URLs', () => {
  it('el listado usa el board token', () => {
    assert.equal(
      greenhouseBoardUrl({ boardToken: 'okx' }),
      'https://boards-api.greenhouse.io/v1/boards/okx/jobs',
    );
  });

  it('el detalle añade ?content=true', () => {
    assert.equal(
      greenhouseJobDetailUrl('okx', 7608993003),
      'https://boards-api.greenhouse.io/v1/boards/okx/jobs/7608993003?content=true',
    );
  });

  it('la página pública sigue el patrón job-boards.greenhouse.io', () => {
    assert.equal(
      greenhouseJobPageUrl('okx', 7608993003),
      'https://job-boards.greenhouse.io/okx/jobs/7608993003',
    );
  });
});

describe('Greenhouse: parseo de fixtures reales (19-oct-2026, board okx)', () => {
  it('el listado parsea id, título, url y ubicación', () => {
    const jobs = parseGreenhouseBoard(loadFixture('greenhouse-board.json'));
    assert.ok(jobs.length > 0);
    const [first] = jobs;
    assert.equal(typeof first.id, 'number');
    assert.ok(first.title.length > 0);
    assert.ok(first.absoluteUrl.startsWith('https://job-boards.greenhouse.io/'));
    assert.equal(typeof first.locationName, 'string');
  });

  it('el detalle trae content, departamentos y oficinas', () => {
    const job = parseGreenhouseJob(loadFixture('greenhouse-job-detail.json'));
    assert.ok(job.content != null && job.content.length > 0);
    assert.ok(job.departments.length > 0);
    assert.ok(job.offices.length > 0);
  });

  it('lanza si la forma no es la esperada', () => {
    assert.throws(() => parseGreenhouseBoard({}), /`jobs`/);
    assert.throws(() => parseGreenhouseJob({}), /`id`/);
    assert.throws(() => parseGreenhouseJob(null), /objeto JSON/);
  });
});

describe('Greenhouse: cliente con fetch simulado', () => {
  it('listJobs exige boardToken', async () => {
    const client = createGreenhouseClient(async () => {
      throw new Error('no debería llamarse');
    });
    await assert.rejects(() => client.listJobs({ boardToken: '  ' }), /boardToken/);
  });

  it('getJob exige jobId entero positivo', async () => {
    const client = createGreenhouseClient(async () => {
      throw new Error('no debería llamarse');
    });
    await assert.rejects(() => client.getJob('okx', 0), /jobId/);
  });

  it('un 404 se convierte en GreenhouseNotFoundError', async () => {
    const client = createGreenhouseClient((async () =>
      new Response('{}', { status: 404 })) as typeof fetch);
    await assert.rejects(
      () => client.getJob('okx', 1),
      (err: unknown) => err instanceof GreenhouseNotFoundError,
    );
  });

  it('listJobs parsea la respuesta del fetch', async () => {
    const fixture = loadFixture('greenhouse-board.json');
    const client = createGreenhouseClient((async () =>
      new Response(JSON.stringify(fixture), { status: 200 })) as typeof fetch);
    const jobs = await client.listJobs({ boardToken: 'okx' });
    assert.ok(jobs.length > 0);
    assert.equal(jobs[0].id, (fixture as { jobs: { id: number }[] }).jobs[0].id);
  });
});
