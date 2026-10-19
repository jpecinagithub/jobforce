/**
 * Adaptador de la API de Exa para búsqueda de ofertas de empleo (Fase 2).
 *
 * No tiene dependencias externas: usa el `fetch` global de Node 22.
 * La API key se pasa en tiempo de ejecución (env EXA_API_KEY en el backend);
 * NUNCA se guarda en el repo ni en el código.
 */

import type { CampaignCriteria, MandatoryRequirement } from '@jobforce/domain';

export interface ExaSearchOptions {
  query: string;
  numResults: number;
}

export interface ExaResult {
  id: string;
  title: string;
  url: string;
  publishedDate?: string;
  author?: string;
  highlights?: string[];
}

export interface ExaSearchResponse {
  results: ExaResult[];
  requestId: string;
  costDollars: number;
}

export interface ExaClient {
  search(opts: ExaSearchOptions): Promise<ExaSearchResponse>;
}

const EXA_SEARCH_URL = 'https://api.exa.ai/search';
const SEARCH_TIMEOUT_MS = 30_000;

/**
 * Estimación conservadora del coste por búsqueda ANTES de conocer el coste
 * real devuelto por la API (usada para bloquear búsquedas que superen el
 * presupuesto de la campaña; el coste real se resta después de cada llamada).
 */
export const EXA_COST_ESTIMATE_PER_SEARCH_USD = 0.01;

export function createExaClient(apiKey: string): ExaClient {
  async function search(opts: ExaSearchOptions): Promise<ExaSearchResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(EXA_SEARCH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        // La skill canónica de Exa (build-with-exa) define esta forma:
        // type "auto" explícito y highlights dentro de `contents`.
        body: JSON.stringify({
          query: opts.query,
          type: 'auto',
          numResults: opts.numResults,
          contents: { highlights: true },
        }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('Exa: la petición ha agotado el tiempo de espera (30 s)');
      }
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Exa: error de red al contactar con la API: ${detail}`);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      let detail = '';
      try {
        const text = await res.text();
        if (text) detail = ` — ${text.slice(0, 300)}`;
      } catch {
        // si no se puede leer el cuerpo, el código HTTP ya es informativo
      }
      throw new Error(`Exa: HTTP ${res.status} ${res.statusText}${detail}`);
    }

    let body: {
      results?: Array<{
        id?: string;
        title?: string | null;
        url?: string;
        publishedDate?: string | null;
        author?: string | null;
        highlights?: string[] | null;
      }>;
      requestId?: string;
      costDollars?: { total?: number } | null;
    };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new Error('Exa: la respuesta no es un JSON válido');
    }

    const results: ExaResult[] = (body.results ?? []).map((r) => ({
      id: r.id ?? '',
      title: r.title ?? '',
      url: r.url ?? '',
      ...(r.publishedDate ? { publishedDate: r.publishedDate } : {}),
      ...(r.author ? { author: r.author } : {}),
      ...(Array.isArray(r.highlights) ? { highlights: r.highlights } : {}),
    }));

    return {
      results,
      requestId: typeof body.requestId === 'string' ? body.requestId : '',
      costDollars: body.costDollars?.total ?? 0,
    };
  }

  return { search };
}

const MAX_QUERIES = 5;

/**
 * Devuelve las consultas de búsqueda para una campaña (máximo 5).
 *
 * - Si `criteria.queries` no está vacío → se devuelve tal cual (recortado a 5).
 * - Si está vacío → se generan plantillas deterministas a partir de los roles:
 *
 *   T1. `<roles> finance job`          — búsqueda general de empleo
 *   T2. `<roles> job offer`           — variante de phrasing ("oferta de empleo")
 *   T3. `<roles> vacancy`            — phrasing británico, habitual en portales europeos
 *   T4. `<roles> hiring`             — anuncios de contratación activos
 *   T5. `<roles> senior finance`      — refuerza el nivel senior de los roles
 *
 *   Donde `<roles>` es la unión con " OR " de los roles entrecomillados, p. ej.:
 *   `"CFO" OR "Finance Manager" OR "Controller"`.
 *
 *   Si el requisito de ubicación (kind "location") tiene mode === "remote_ok",
 *   se añade el modificador "remote" a cada consulta para favorecer vacantes remotas.
 *   Si no hay roles definidos, se usa "finance" como término genérico.
 */
export function generateQueries(criteria: CampaignCriteria): string[] {
  if (criteria.queries.length > 0) {
    return criteria.queries.slice(0, MAX_QUERIES);
  }

  const locationReq: MandatoryRequirement | undefined = criteria.mandatory.find(
    (r) => r.kind === 'location',
  );
  const remoteOk =
    locationReq != null &&
    typeof locationReq.params?.mode === 'string' &&
    locationReq.params.mode === 'remote_ok';

  const base = criteria.roles.length > 0 ? criteria.roles : ['finance'];
  const rolesExpr = base.map((r) => `"${r}"`).join(' OR ');
  const remote = remoteOk ? ' remote' : '';

  const templates = [
    `${rolesExpr} finance job${remote}`,
    `${rolesExpr} job offer${remote}`,
    `${rolesExpr} vacancy${remote}`,
    `${rolesExpr} hiring${remote}`,
    `${rolesExpr} senior finance${remote}`,
  ];

  return templates.slice(0, MAX_QUERIES);
}

/**
 * Parámetros de tracking que no identifican el recurso y deben eliminarse
 * para deduplicar ofertas (la misma oferta enlazada desde distintas fuentes).
 */
const TRACKING_PARAMS = new Set(['fbclid', 'gclid', 'msclkid']);

/**
 * URL canónica para deduplicar ofertas:
 * - host en minúsculas
 * - sin fragmento (#...)
 * - sin parámetros de tracking (utm_*, fbclid, gclid, msclkid)
 * - sin "/" final salvo en la raíz
 *
 * NUNCA lanza: ante una URL inválida devuelve la entrada tal cual.
 */
export function canonicalUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hostname = u.hostname.toLowerCase();
    u.hash = '';

    for (const key of [...u.searchParams.keys()]) {
      const lower = key.toLowerCase();
      if (lower.startsWith('utm_') || TRACKING_PARAMS.has(lower)) {
        u.searchParams.delete(key);
      }
    }

    if (u.pathname !== '/' && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.replace(/\/+$/, '');
    }

    return u.toString();
  } catch {
    return url;
  }
}
