/**
 * Cliente de solo lectura para la API pública de postings de SmartRecruiters (Fase 4).
 *
 * Endpoints públicos (sin API key):
 *   GET https://api.smartrecruiters.com/v1/companies/{company}/postings?limit=&offset=
 *   GET https://api.smartrecruiters.com/v1/companies/{company}/postings/{postingId}
 *
 * Capacidades probadas de verdad (19-oct-2026, company real "SiloamCareers";
 * ver `docs/matriz-conectores.md`):
 * - Listado de ofertas: SÍ, paginado (`totalFound` + `limit`/`offset`).
 *   El listado devuelve solo metadatos (sin descripción).
 * - Detalle por oferta: SÍ (`jobAd.sections` con la descripción,
 *   `applyUrl`, `postingUrl`, `active`, `visibility`).
 * - Detección de cierre: un postingId inexistente devuelve HTTP 404 con
 *   `code: "RESOURCE_NOT_FOUND"`; una company desconocida devuelve HTTP 200
 *   con `totalFound: 0`.
 * - URL de aplicación: `https://jobs.smartrecruiters.com/{company}/{id}-{slug}?oga=true`
 *   (campo `applyUrl` del detalle).
 *
 * No incluye envío de candidaturas: la Application API exige credenciales de
 * partner (OAuth o X-SmartToken) que JOBFORCE no tiene.
 */

const SMARTRECRUITERS_API = 'https://api.smartrecruiters.com/v1/companies';
const REQUEST_TIMEOUT_MS = 30_000;

export interface SmartRecruitersListOptions {
  /** El "slug" de la empresa: la parte de `jobs.smartrecruiters.com/{company}`. */
  company: string;
  limit?: number;
  offset?: number;
}

export interface SmartRecruitersLocation {
  city: string | null;
  country: string | null;
  remote: boolean;
  hybrid: boolean;
  fullLocation: string | null;
}

/** Posting tal y como lo devuelve el listado (metadatos, sin descripción). */
export interface SmartRecruitersPostingSummary {
  id: string;
  name: string;
  uuid: string | null;
  refNumber: string | null;
  company: string;
  releasedDate: string | null;
  location: SmartRecruitersLocation | null;
  department: string | null;
  jobFunction: string | null;
  typeOfEmployment: string | null;
  experienceLevel: string | null;
  visibility: string | null;
  language: string | null;
}

export interface SmartRecruitersPostingsPage {
  offset: number;
  limit: number;
  totalFound: number;
  content: SmartRecruitersPostingSummary[];
}

export interface SmartRecruitersJobAdSection {
  title: string;
  text: string;
}

/** Detalle completo de una oferta (con descripción y URLs). */
export interface SmartRecruitersPosting extends SmartRecruitersPostingSummary {
  postingUrl: string;
  applyUrl: string;
  referralUrl: string | null;
  active: boolean;
  sections: Record<string, SmartRecruitersJobAdSection>;
}

/**
 * URL del listado público de ofertas de una empresa.
 * Probado: GET sobre esta URL devuelve HTTP 200 con `{totalFound, content}`.
 */
export function smartRecruitersPostingsUrl(opts: SmartRecruitersListOptions): string {
  const company = encodeURIComponent(opts.company.trim());
  const limit = opts.limit ?? 100;
  const offset = opts.offset ?? 0;
  return `${SMARTRECRUITERS_API}/${company}/postings?limit=${limit}&offset=${offset}`;
}

/**
 * URL del detalle público de una oferta.
 * Probado: GET sobre esta URL devuelve HTTP 200 con el posting completo;
 * para un postingId inexistente devuelve HTTP 404 (RESOURCE_NOT_FOUND).
 */
export function smartRecruitersPostingUrl(company: string, postingId: string): string {
  return `${SMARTRECRUITERS_API}/${encodeURIComponent(company.trim())}/postings/${encodeURIComponent(postingId)}`;
}

type UnknownRecord = Record<string, unknown>;

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function parseLocation(raw: unknown): SmartRecruitersLocation | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const l = raw as UnknownRecord;
  return {
    city: asNullableString(l.city),
    country: asNullableString(l.country),
    remote: l.remote === true,
    hybrid: l.hybrid === true,
    fullLocation: asNullableString(l.fullLocation),
  };
}

function parseSummary(item: unknown): SmartRecruitersPostingSummary {
  const p = (typeof item === 'object' && item !== null ? item : {}) as UnknownRecord;
  return {
    id: asString(p.id),
    name: asString(p.name),
    uuid: asNullableString(p.uuid),
    refNumber: asNullableString(p.refNumber),
    company: asString(p.company),
    releasedDate: asNullableString(p.releasedDate),
    location: parseLocation(p.location),
    department: asNullableString(p.department),
    jobFunction: asNullableString(p.function),
    typeOfEmployment: asNullableString(p.typeOfEmployment),
    experienceLevel: asNullableString(p.experienceLevel),
    visibility: asNullableString(p.visibility),
    language: asNullableString(p.language),
  };
}

/**
 * Parsea la respuesta cruda del endpoint de listado.
 * Lanza si la forma no es la esperada (no inventa ofertas).
 */
export function parseSmartRecruitersPostings(raw: unknown): SmartRecruitersPostingsPage {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('SmartRecruiters: la respuesta no es un objeto JSON');
  }
  const body = raw as UnknownRecord;
  if (!Array.isArray(body.content)) {
    throw new Error('SmartRecruiters: la respuesta no contiene el array `content`');
  }
  const asNumber = (v: unknown): number => (typeof v === 'number' ? v : 0);
  return {
    offset: asNumber(body.offset),
    limit: asNumber(body.limit),
    totalFound: asNumber(body.totalFound),
    content: (body.content as unknown[]).map(parseSummary),
  };
}

/**
 * Parsea la respuesta cruda del endpoint de detalle.
 * Lanza si la forma no es la esperada.
 */
export function parseSmartRecruitersPosting(raw: unknown): SmartRecruitersPosting {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('SmartRecruiters: la respuesta no es un objeto JSON');
  }
  const body = raw as UnknownRecord;
  const summary = parseSummary(body);
  const sections: Record<string, SmartRecruitersJobAdSection> = {};
  const jobAd = body.jobAd as UnknownRecord | undefined;
  const rawSections = (jobAd != null ? jobAd.sections : undefined) as
    | Record<string, unknown>
    | undefined;
  if (rawSections != null && typeof rawSections === 'object') {
    for (const [key, value] of Object.entries(rawSections)) {
      const s = (typeof value === 'object' && value !== null ? value : {}) as UnknownRecord;
      sections[key] = { title: asString(s.title), text: asString(s.text) };
    }
  }
  return {
    ...summary,
    postingUrl: asString(body.postingUrl),
    applyUrl: asString(body.applyUrl),
    referralUrl: asNullableString(body.referralUrl),
    active: body.active === true,
    sections,
  };
}

/**
 * ¿Sigue vigente la oferta? El detalle incluye `active`; una oferta cerrada
 * o inexistente devuelve HTTP 404 en el endpoint de detalle.
 */
export function isSmartRecruitersPostingOpen(posting: SmartRecruitersPosting): boolean {
  return posting.active && posting.visibility !== 'INTERNAL';
}

export interface SmartRecruitersClient {
  /** Descarga una página del listado de ofertas (solo metadatos). */
  listPostings(opts: SmartRecruitersListOptions): Promise<SmartRecruitersPostingsPage>;
  /** Descarga el detalle completo de una oferta (con descripción). */
  getPosting(company: string, postingId: string): Promise<SmartRecruitersPosting>;
}

export class SmartRecruitersNotFoundError extends Error {
  constructor(company: string, postingId: string) {
    super(`SmartRecruiters: oferta no encontrada (${company}/${postingId}) — HTTP 404`);
    this.name = 'SmartRecruitersNotFoundError';
  }
}

export function createSmartRecruitersClient(
  fetchImpl: typeof fetch = fetch,
): SmartRecruitersClient {
  async function requestJson(url: string): Promise<{ status: number; body: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, { signal: controller.signal });
      let body: unknown = null;
      try {
        body = (await res.json()) as unknown;
      } catch {
        // cuerpo no JSON: el estado HTTP ya es informativo
      }
      return { status: res.status, body };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('SmartRecruiters: la petición ha agotado el tiempo de espera (30 s)');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function listPostings(
    opts: SmartRecruitersListOptions,
  ): Promise<SmartRecruitersPostingsPage> {
    if (!opts.company || !opts.company.trim()) {
      throw new Error('SmartRecruiters: `company` es obligatorio');
    }
    const { status, body } = await requestJson(smartRecruitersPostingsUrl(opts));
    if (status !== 200) {
      throw new Error(`SmartRecruiters: HTTP ${status} al listar ofertas`);
    }
    return parseSmartRecruitersPostings(body);
  }

  async function getPosting(company: string, postingId: string): Promise<SmartRecruitersPosting> {
    if (!company || !company.trim()) {
      throw new Error('SmartRecruiters: `company` es obligatorio');
    }
    if (!postingId) {
      throw new Error('SmartRecruiters: `postingId` es obligatorio');
    }
    const { status, body } = await requestJson(smartRecruitersPostingUrl(company, postingId));
    if (status === 404) {
      throw new SmartRecruitersNotFoundError(company, postingId);
    }
    if (status !== 200) {
      throw new Error(`SmartRecruiters: HTTP ${status} al leer la oferta`);
    }
    return parseSmartRecruitersPosting(body);
  }

  return { listPostings, getPosting };
}
