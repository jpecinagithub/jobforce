/**
 * Cliente de solo lectura para la Posting API pública de Ashby (Fase 4).
 *
 * Endpoint público (sin API key):
 *   GET https://api.ashbyhq.com/posting-api/job-board/{orgHost}
 *   con parámetro opcional `?includeCompensation=true`
 *
 * Capacidades probadas de verdad (19-oct-2026, orgHost reales "notion" y
 * "linear"; ver `docs/matriz-conectores.md`):
 * - Listado de ofertas: SÍ (la respuesta ya incluye la descripción completa
 *   de cada oferta: descriptionHtml y descriptionPlain).
 * - Detalle por oferta: la API de detalle por id exige API key (401 sin
 *   clave). El detalle se obtiene buscando el id dentro del listado, o
 *   leyendo la página pública `https://jobs.ashbyhq.com/{orgHost}/{jobId}`.
 * - Detección de cierre: la organización inexistente devuelve HTTP 404; una
 *   oferta eliminada desaparece del listado (y su página pública pasa a
 *   mostrar el título genérico "Jobs" en lugar del título de la oferta).
 * - URL de aplicación: `https://jobs.ashbyhq.com/{orgHost}/{jobId}/application`
 *   (campo `applyUrl` de cada oferta).
 *
 * No incluye envío de candidaturas: la API pública es de lectura.
 */

const ASHBY_POSTING_API = 'https://api.ashbyhq.com/posting-api/job-board';
const ASHBY_JOBS_HOST = 'https://jobs.ashbyhq.com';
const REQUEST_TIMEOUT_MS = 30_000;

export interface AshbyBoardOptions {
  /** El "slug" de la empresa: la parte de `jobs.ashbyhq.com/{orgHost}`. */
  orgHost: string;
  /** Incluye bandas salariales cuando la empresa las publica (por defecto true). */
  includeCompensation?: boolean;
}

/** Oferta tal y como la devuelve la Posting API pública de Ashby. */
export interface AshbyJob {
  id: string;
  title: string;
  department: string | null;
  team: string | null;
  employmentType: string | null;
  location: string | null;
  isListed: boolean;
  isRemote: boolean;
  workplaceType: string | null;
  publishedAt: string | null;
  jobUrl: string;
  applyUrl: string;
  descriptionHtml: string;
  descriptionPlain: string;
  compensationTierSummary: string | null;
}

export interface AshbyBoard {
  apiVersion: string;
  jobs: AshbyJob[];
}

/**
 * URL del listado público de ofertas de una organización.
 * Probado: GET sobre esta URL devuelve HTTP 200 con `{ jobs: [...] }`.
 */
export function ashbyBoardUrl(opts: AshbyBoardOptions): string {
  const org = encodeURIComponent(opts.orgHost.trim());
  const includeCompensation = opts.includeCompensation ?? true;
  return `${ASHBY_POSTING_API}/${org}${includeCompensation ? '?includeCompensation=true' : ''}`;
}

/**
 * URL de la página pública de una oferta (detalle visible en el navegador).
 * Probado: para una oferta real devuelve HTTP 200 con su título en <title>;
 * para un id inexistente devuelve HTTP 200 con el título genérico "Jobs"
 * (heurística de cierre).
 */
export function ashbyJobPageUrl(orgHost: string, jobId: string): string {
  return `${ASHBY_JOBS_HOST}/${encodeURIComponent(orgHost.trim())}/${encodeURIComponent(jobId)}`;
}

/**
 * URL del formulario de aplicación de una oferta.
 * Es el mismo patrón que devuelve el campo `applyUrl` de la API.
 */
export function ashbyApplyUrl(orgHost: string, jobId: string): string {
  return `${ashbyJobPageUrl(orgHost, jobId)}/application`;
}

/**
 * Busca una oferta por id dentro de un listado ya descargado.
 * (El endpoint de detalle por id de la Posting API exige API key.)
 */
export function ashbyFindJob(board: AshbyBoard, jobId: string): AshbyJob | undefined {
  return board.jobs.find((j) => j.id === jobId);
}

type UnknownRecord = Record<string, unknown>;

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Parsea la respuesta cruda del endpoint del listado.
 * Lanza si la forma no es la esperada (no inventa ofertas).
 */
export function parseAshbyBoard(raw: unknown): AshbyBoard {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Ashby: la respuesta no es un objeto JSON');
  }
  const body = raw as UnknownRecord;
  if (!Array.isArray(body.jobs)) {
    throw new Error('Ashby: la respuesta no contiene el array `jobs`');
  }
  const jobs: AshbyJob[] = (body.jobs as unknown[]).map((item) => {
    const j = (typeof item === 'object' && item !== null ? item : {}) as UnknownRecord;
    return {
      id: asString(j.id),
      title: asString(j.title),
      department: asNullableString(j.department),
      team: asNullableString(j.team),
      employmentType: asNullableString(j.employmentType),
      location: asNullableString(j.location),
      isListed: j.isListed === true,
      isRemote: j.isRemote === true,
      workplaceType: asNullableString(j.workplaceType),
      publishedAt: asNullableString(j.publishedAt),
      jobUrl: asString(j.jobUrl),
      applyUrl: asString(j.applyUrl),
      descriptionHtml: asString(j.descriptionHtml),
      descriptionPlain: asString(j.descriptionPlain),
      compensationTierSummary: asNullableString(j.compensationTierSummary),
    };
  });
  return { apiVersion: asString(body.apiVersion), jobs };
}

export interface AshbyClient {
  /** Descarga el listado completo de ofertas publicadas de la organización. */
  listJobs(opts: AshbyBoardOptions): Promise<AshbyBoard>;
}

export function createAshbyClient(fetchImpl: typeof fetch = fetch): AshbyClient {
  async function listJobs(opts: AshbyBoardOptions): Promise<AshbyBoard> {
    if (!opts.orgHost || !opts.orgHost.trim()) {
      throw new Error('Ashby: `orgHost` es obligatorio');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetchImpl(ashbyBoardUrl(opts), { signal: controller.signal });
      if (res.status === 404) {
        throw new Error(`Ashby: organización desconocida (${opts.orgHost}) — HTTP 404`);
      }
      if (!res.ok) {
        throw new Error(`Ashby: HTTP ${res.status} ${res.statusText}`);
      }
      let body: unknown;
      try {
        body = (await res.json()) as unknown;
      } catch {
        throw new Error('Ashby: la respuesta no es un JSON válido');
      }
      return parseAshbyBoard(body);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('Ashby: la petición ha agotado el tiempo de espera (30 s)');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  return { listJobs };
}
