/**
 * Cliente de solo lectura para el endpoint público de ofertas de Workday (Fase 4).
 *
 * Endpoint público (sin autenticación):
 *   POST https://{tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs
 *   body: {"appliedFacets":{},"limit":20,"offset":0,"searchText":""}
 *
 *   GET  https://{tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/job{externalPath}
 *        (detalle; `externalPath` viene en cada posting del listado)
 *
 * Capacidades probadas de verdad (19-oct-2026, tenant "nvidia", wd5, site
 * "NVIDIAExternalCareerSite"; ver `docs/matriz-conectores.md`):
 * - Listado de ofertas: SÍ. `limit` tiene un máximo efectivo de 20; `total`
 *   solo llega en la primera página; los resultados están topados a 2000
 *   (hay que partir por facetas para más).
 * - Detalle por oferta: SÍ (`jobPostingInfo` con `jobDescription` en HTML,
 *   `postedOn`, `startDate`, `jobReqId`, `canApply`, `endDate`).
 *   Las fechas del listado son texto ("Posted Today"); la fecha real está
 *   en el detalle.
 * - Detección de cierre: un job inexistente devuelve HTTP 404 con mensaje
 *   "not found".
 * - URL de aplicación: la página pública de la oferta
 *   `https://{tenant}.wd{N}.myworkdayjobs.com/{site}/job/{externalPath}`
 *   (el apply se hace dentro de la sesión del candidato; no hay endpoint
 *   público de envío).
 *
 * No incluye envío de candidaturas: requiere sesión de candidato en Workday.
 */

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_LIMIT = 20;

export interface WorkdaySite {
  /** p. ej. "nvidia" en `nvidia.wd5.myworkdayjobs.com` */
  tenant: string;
  /** p. ej. "wd5" en `nvidia.wd5.myworkdayjobs.com` */
  wdHost: string;
  /** p. ej. "NVIDIAExternalCareerSite" */
  site: string;
}

export interface WorkdayJobsQuery {
  limit?: number;
  offset?: number;
  searchText?: string;
  appliedFacets?: Record<string, unknown>;
}

/** Posting tal y como lo devuelve el listado (sin descripción completa). */
export interface WorkdayJobPosting {
  title: string;
  /** Ruta relativa para el detalle, p. ej. "/job/Israel-Tel-Aviv/SDK-Eth-Software-Engineer--Networking_JR2013956" */
  externalPath: string;
  locationsText: string | null;
  postedOn: string | null;
  bulletFields: string[];
}

/** Detalle de una oferta (con descripción). */
export interface WorkdayJobDetail {
  id: string;
  title: string;
  jobDescription: string;
  location: string | null;
  additionalLocations: string[];
  postedOn: string | null;
  startDate: string | null;
  timeType: string | null;
  jobReqId: string | null;
  canApply: boolean;
  externalUrl: string | null;
  endDate: string | null;
  country: string | null;
}

export interface WorkdayJobsPage {
  total: number;
  jobPostings: WorkdayJobPosting[];
}

/**
 * URL base del site de Workday.
 * Probado: POST a `{base}/jobs` devuelve HTTP 200 con `{total, jobPostings}`.
 */
export function workdaySiteBase(site: WorkdaySite): string {
  const tenant = encodeURIComponent(site.tenant.trim());
  const wdHost = site.wdHost.trim();
  const siteName = encodeURIComponent(site.site.trim());
  return `https://${tenant}.${wdHost}.myworkdayjobs.com/wday/cxs/${tenant}/${siteName}`;
}

/**
 * URL del listado (método POST).
 */
export function workdayJobsUrl(site: WorkdaySite): string {
  return `${workdaySiteBase(site)}/jobs`;
}

/**
 * Normaliza el `externalPath` del listado: el endpoint de detalle y la
 * página pública lo usan tal cual (ya empieza por `/job/...`).
 */
function normalizeExternalPath(externalPath: string): string {
  if (externalPath.startsWith('/job/')) return externalPath;
  const path = externalPath.startsWith('/') ? externalPath : `/${externalPath}`;
  return `/job${path}`;
}

/**
 * URL del detalle de una oferta (método GET), a partir del `externalPath`
 * del listado.
 * Probado: devuelve HTTP 200 con `jobPostingInfo`; para un job inexistente
 * devuelve HTTP 404.
 */
export function workdayJobDetailUrl(site: WorkdaySite, externalPath: string): string {
  return `${workdaySiteBase(site)}${normalizeExternalPath(externalPath)}`;
}

/**
 * URL de la página pública de la oferta (para el navegador / apply manual).
 */
export function workdayJobPageUrl(site: WorkdaySite, externalPath: string): string {
  const tenant = encodeURIComponent(site.tenant.trim());
  const wdHost = site.wdHost.trim();
  const siteName = encodeURIComponent(site.site.trim());
  return `https://${tenant}.${wdHost}.myworkdayjobs.com/${siteName}${normalizeExternalPath(externalPath)}`;
}

/**
 * Cuerpo de la petición de listado. `limit` se recorta a 20 (máximo
 * efectivo observado del endpoint).
 */
export function workdayJobsRequestBody(query: WorkdayJobsQuery): Record<string, unknown> {
  const limit = Math.min(Math.max(query.limit ?? MAX_LIMIT, 1), MAX_LIMIT);
  return {
    appliedFacets: query.appliedFacets ?? {},
    limit,
    offset: query.offset ?? 0,
    searchText: query.searchText ?? '',
  };
}

type UnknownRecord = Record<string, unknown>;

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Parsea la respuesta cruda del endpoint de listado.
 * Lanza si la forma no es la esperada (no inventa ofertas).
 */
export function parseWorkdayJobs(raw: unknown): WorkdayJobsPage {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Workday: la respuesta no es un objeto JSON');
  }
  const body = raw as UnknownRecord;
  if (!Array.isArray(body.jobPostings)) {
    throw new Error('Workday: la respuesta no contiene el array `jobPostings`');
  }
  const jobPostings: WorkdayJobPosting[] = (body.jobPostings as unknown[]).map((item) => {
    const p = (typeof item === 'object' && item !== null ? item : {}) as UnknownRecord;
    const bullets = Array.isArray(p.bulletFields)
      ? (p.bulletFields as unknown[]).filter((b): b is string => typeof b === 'string')
      : [];
    return {
      title: asString(p.title),
      externalPath: asString(p.externalPath),
      locationsText: asNullableString(p.locationsText),
      postedOn: asNullableString(p.postedOn),
      bulletFields: bullets,
    };
  });
  return {
    total: typeof body.total === 'number' ? body.total : jobPostings.length,
    jobPostings,
  };
}

/**
 * Parsea la respuesta cruda del endpoint de detalle.
 * Lanza si la forma no es la esperada.
 */
export function parseWorkdayJobDetail(raw: unknown): WorkdayJobDetail {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Workday: la respuesta no es un objeto JSON');
  }
  const body = raw as UnknownRecord;
  const info = body.jobPostingInfo as UnknownRecord | undefined;
  if (info == null || typeof info !== 'object') {
    throw new Error('Workday: la respuesta no contiene `jobPostingInfo`');
  }
  const asStringArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  return {
    id: asString(info.id),
    title: asString(info.title),
    jobDescription: asString(info.jobDescription),
    location: asNullableString(info.location),
    additionalLocations: asStringArray(info.additionalLocations),
    postedOn: asNullableString(info.postedOn),
    startDate: asNullableString(info.startDate),
    timeType: asNullableString(info.timeType),
    jobReqId: asNullableString(info.jobReqId),
    canApply: info.canApply === true,
    externalUrl: asNullableString(info.externalUrl),
    endDate: asNullableString(info.endDate),
    country: asNullableString(info.country),
  };
}

export interface WorkdayClient {
  /** Descarga una página del listado de ofertas (POST, sin descripción). */
  listJobs(site: WorkdaySite, query?: WorkdayJobsQuery): Promise<WorkdayJobsPage>;
  /** Descarga el detalle de una oferta (GET, con descripción). */
  getJob(site: WorkdaySite, externalPath: string): Promise<WorkdayJobDetail>;
}

export class WorkdayNotFoundError extends Error {
  constructor(site: WorkdaySite, externalPath: string) {
    super(`Workday: oferta no encontrada (${site.tenant}/${externalPath}) — HTTP 404`);
    this.name = 'WorkdayNotFoundError';
  }
}

export function createWorkdayClient(fetchImpl: typeof fetch = fetch): WorkdayClient {
  function requireSite(site: WorkdaySite): void {
    if (!site.tenant || !site.tenant.trim()) {
      throw new Error('Workday: `tenant` es obligatorio');
    }
    if (!site.wdHost || !site.wdHost.trim()) {
      throw new Error('Workday: `wdHost` es obligatorio');
    }
    if (!site.site || !site.site.trim()) {
      throw new Error('Workday: `site` es obligatorio');
    }
  }

  async function readJson(res: Response): Promise<unknown> {
    try {
      return (await res.json()) as unknown;
    } catch {
      throw new Error('Workday: la respuesta no es un JSON válido');
    }
  }

  async function listJobs(site: WorkdaySite, query: WorkdayJobsQuery = {}): Promise<WorkdayJobsPage> {
    requireSite(site);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetchImpl(workdayJobsUrl(site), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(workdayJobsRequestBody(query)),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`Workday: HTTP ${res.status} ${res.statusText} al listar ofertas`);
      }
      return parseWorkdayJobs(await readJson(res));
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('Workday: la petición ha agotado el tiempo de espera (30 s)');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function getJob(site: WorkdaySite, externalPath: string): Promise<WorkdayJobDetail> {
    requireSite(site);
    if (!externalPath) {
      throw new Error('Workday: `externalPath` es obligatorio');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetchImpl(workdayJobDetailUrl(site, externalPath), {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (res.status === 404) {
        throw new WorkdayNotFoundError(site, externalPath);
      }
      if (!res.ok) {
        throw new Error(`Workday: HTTP ${res.status} ${res.statusText} al leer la oferta`);
      }
      return parseWorkdayJobDetail(await readJson(res));
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('Workday: la petición ha agotado el tiempo de espera (30 s)');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  return { listJobs, getJob };
}
