/**
 * Cliente de solo lectura para la Job Board API pública de Greenhouse (Fase 6).
 *
 * Endpoints públicos (sin API key):
 *   GET https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs
 *   GET https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs/{id}?content=true
 *
 * Capacidades probadas de verdad (19-oct-2026, board `okx`; boards reales de
 * la campaña F3: `envoyglobalinc`, `okx`, `atlasxhm`; ver
 * `docs/matriz-conectores.md`):
 * - Listado de ofertas: SÍ (id, title, absolute_url, location.name, ...).
 * - Detalle de oferta: SÍ con `?content=true` (descripción HTML completa en
 *   `content`, además de `departments` y `offices`).
 * - Detección de cierre: job id inexistente → HTTP 404; board inexistente →
 *   HTTP 404.
 * - URL de aplicación: campo `absolute_url` de cada oferta.
 *
 * No incluye envío de candidaturas: la API pública es de lectura.
 */

const GREENHOUSE_BOARDS_API = 'https://boards-api.greenhouse.io/v1/boards';
const REQUEST_TIMEOUT_MS = 30_000;

export interface GreenhouseBoardOptions {
  /**
   * El "slug" de la empresa: la parte de
   * `job-boards.greenhouse.io/{board_token}/jobs/...`.
   */
  boardToken: string;
}

/** Oferta tal y como la devuelve la Job Board API pública de Greenhouse. */
export interface GreenhouseJob {
  id: number;
  title: string;
  absoluteUrl: string;
  locationName: string | null;
  companyName: string | null;
  firstPublished: string | null;
  updatedAt: string | null;
  /** Departamentos (solo en detalle con ?content=true). */
  departments: string[];
  /** Oficinas (solo en detalle con ?content=true). */
  offices: string[];
  /** Descripción HTML completa (solo en detalle con ?content=true). */
  content: string | null;
}

/**
 * URL del listado público de ofertas de una organización.
 * Probado: GET sobre esta URL devuelve HTTP 200 con `{ jobs: [...] }`.
 */
export function greenhouseBoardUrl(opts: GreenhouseBoardOptions): string {
  const board = encodeURIComponent(opts.boardToken.trim());
  return `${GREENHOUSE_BOARDS_API}/${board}/jobs`;
}

/**
 * URL del detalle público de una oferta (con descripción completa).
 * Probado: `?content=true` devuelve HTTP 200 con `content`; un id
 * inexistente devuelve HTTP 404 (heurística de cierre).
 */
export function greenhouseJobDetailUrl(boardToken: string, jobId: number): string {
  const board = encodeURIComponent(boardToken.trim());
  return `${GREENHOUSE_BOARDS_API}/${board}/jobs/${jobId}?content=true`;
}

/**
 * URL de la página pública de una oferta (visible en el navegador).
 * Es el mismo patrón que devuelve el campo `absolute_url` de la API.
 */
export function greenhouseJobPageUrl(boardToken: string, jobId: number): string {
  const board = encodeURIComponent(boardToken.trim());
  return `https://job-boards.greenhouse.io/${board}/jobs/${jobId}`;
}

type UnknownRecord = Record<string, unknown>;

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === 'string') return item;
      if (typeof item === 'object' && item !== null) {
        const name = (item as UnknownRecord).name;
        return typeof name === 'string' ? name : '';
      }
      return '';
    })
    .filter((s) => s !== '');
}

/**
 * Parsea una oferta cruda de la API (listado o detalle).
 * Lanza si la forma no es la esperada (no inventa ofertas).
 */
export function parseGreenhouseJob(raw: unknown): GreenhouseJob {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Greenhouse: la oferta no es un objeto JSON');
  }
  const j = raw as UnknownRecord;
  const location = (typeof j.location === 'object' && j.location !== null ? j.location : {}) as UnknownRecord;
  const id = asNumber(j.id);
  if (!id) {
    throw new Error('Greenhouse: la oferta no trae `id` numérico');
  }
  return {
    id,
    title: asString(j.title),
    absoluteUrl: asString(j.absolute_url),
    locationName: asNullableString(location.name),
    companyName: asNullableString(j.company_name),
    firstPublished: asNullableString(j.first_published),
    updatedAt: asNullableString(j.updated_at),
    departments: asStringArray(j.departments),
    offices: asStringArray(j.offices),
    content: typeof j.content === 'string' ? j.content : null,
  };
}

/**
 * Parsea la respuesta cruda del endpoint del listado.
 * Lanza si la forma no es la esperada (no inventa ofertas).
 */
export function parseGreenhouseBoard(raw: unknown): GreenhouseJob[] {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Greenhouse: la respuesta no es un objeto JSON');
  }
  const body = raw as UnknownRecord;
  if (!Array.isArray(body.jobs)) {
    throw new Error('Greenhouse: la respuesta no contiene el array `jobs`');
  }
  return (body.jobs as unknown[]).map(parseGreenhouseJob);
}

/** Error cuando el board o la oferta no existen (HTTP 404). */
export class GreenhouseNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GreenhouseNotFoundError';
  }
}

export interface GreenhouseClient {
  /** Descarga el listado completo de ofertas publicadas de la organización. */
  listJobs(opts: GreenhouseBoardOptions): Promise<GreenhouseJob[]>;
  /** Descarga el detalle de una oferta (con descripción completa). */
  getJob(boardToken: string, jobId: number): Promise<GreenhouseJob>;
}

export function createGreenhouseClient(fetchImpl: typeof fetch = fetch): GreenhouseClient {
  async function requestJson(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, { signal: controller.signal });
      if (res.status === 404) {
        throw new GreenhouseNotFoundError(`Greenhouse: no encontrado — HTTP 404 (${url})`);
      }
      if (!res.ok) {
        throw new Error(`Greenhouse: HTTP ${res.status} ${res.statusText}`);
      }
      try {
        return (await res.json()) as unknown;
      } catch {
        throw new Error('Greenhouse: la respuesta no es un JSON válido');
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('Greenhouse: la petición ha agotado el tiempo de espera (30 s)');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function listJobs(opts: GreenhouseBoardOptions): Promise<GreenhouseJob[]> {
    if (!opts.boardToken || !opts.boardToken.trim()) {
      throw new Error('Greenhouse: `boardToken` es obligatorio');
    }
    return parseGreenhouseBoard(await requestJson(greenhouseBoardUrl(opts)));
  }

  async function getJob(boardToken: string, jobId: number): Promise<GreenhouseJob> {
    if (!boardToken || !boardToken.trim()) {
      throw new Error('Greenhouse: `boardToken` es obligatorio');
    }
    if (!Number.isInteger(jobId) || jobId <= 0) {
      throw new Error('Greenhouse: `jobId` debe ser un entero positivo');
    }
    return parseGreenhouseJob(await requestJson(greenhouseJobDetailUrl(boardToken, jobId)));
  }

  return { listJobs, getJob };
}
