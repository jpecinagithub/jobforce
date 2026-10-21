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
  /** Dominios a excluir (p. ej. linkedin.com: devuelve perfiles, no ofertas). */
  excludeDomains?: string[];
  /** Si se da, Exa solo busca en estos dominios (portales de empleo de la campaña). */
  includeDomains?: string[];
}

/**
 * Dominios excluidos por defecto en búsquedas de empleo: no publican
 * ofertas como tales (perfiles personales, agregadores muertos, etc.).
 */
export const DEFAULT_EXCLUDED_DOMAINS = [
  'linkedin.com',
  'exa.ai',
  'rocketreach.co',
  'zoominfo.com',
  'signalhire.com',
  'theorg.com',
  'apollo.io',
  'lusha.com',
];

export interface ExaResult {
  id: string;
  title: string;
  url: string;
  publishedDate?: string;
  author?: string;
  highlights?: string[];
  /** Texto completo de la página según Exa (contents.text). */
  text?: string;
}

export interface ExaSearchResponse {
  results: ExaResult[];
  requestId: string;
  costDollars: number;
}

export interface ExaContentsResponse {
  /** url → texto completo de la página. */
  texts: Map<string, string>;
  costDollars: number;
}

export interface ExaClient {
  search(opts: ExaSearchOptions): Promise<ExaSearchResponse>;
  /** Texto completo de URLs ya conocidas (endpoint /contents de Exa). */
  getContents(urls: string[]): Promise<ExaContentsResponse>;
}

const EXA_SEARCH_URL = 'https://api.exa.ai/search';
const EXA_CONTENTS_URL = 'https://api.exa.ai/contents';
const SEARCH_TIMEOUT_MS = 30_000;

const JOB_TITLE_WORDS =
  /manager|director|officer|coordinador|administrador|responsable|tecnico|finance|finanzas|admin|controller|head|chief|lead|consult|advisor|assistant|asistente|gerente|jefe|analyst|specialist|especialista|coordinator|volunteer|voluntario|ingeniero|developer|engineer|accountant|contable|enfermer|medic|abogad|profesor|teacher|nurse|chef|comercial|ventas|marketing|disen|design|operario|conserje|limpieza|recepcion|empleo|vacante|oferta|job|vacancy|hiring|puesto|plaza|convocatoria/i;

/**
 * ¿Parece el título un PERFIL DE PERSONA en vez de una oferta? Exa, con
 * consultas de cierto tipo, devuelve fichas de personas (su directorio
 * «people» y similares): el «título» es un nombre propio desnudo de 2–4
 * palabras alfabéticas, sin ninguna palabra de puesto o empleo. Visto en
 * producción (campaña ONGs, 20-oct-2026): «Oriol Camí Marnet», «LUZANGELA
 * BERNAL»… Esas filas ensuciaban la tabla de ofertas; se descartan en la
 * ingesta. Conservador: cualquier palabra de rol/empleo, dígito, barra o
 * símbolo salva el resultado.
 */
export function looksLikePersonProfile(title: string | null | undefined): boolean {
  const t = (title ?? '').trim().replace(/\s+/g, ' ');
  if (!t) return false;
  const plain = t.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (JOB_TITLE_WORDS.test(plain)) return false;
  const words = plain.split(' ');
  if (words.length < 2 || words.length > 4) return false;
  return words.every((w) => /^[A-Za-z''-]+$/.test(w));
}

/**
 * Elige las consultas del día: si la campaña guarda más de `max`, rota
 * la ventana por día (con 10 consultas y max 5, se alternan dos bloques
 * y en dos días se cubren todas). Determinista por fecha UTC.
 */
export function selectQueries(queries: string[], date: Date = new Date(), max = 5): string[] {
  if (queries.length <= max) return queries.slice(0, max);
  const dayIndex = Math.floor(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 86_400_000,
  );
  const start = (dayIndex * max) % queries.length;
  const out: string[] = [];
  for (let i = 0; i < max; i++) out.push(queries[(start + i) % queries.length]);
  return out;
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/**
 * Descarga la página de una oferta y devuelve su texto legible
 * (máx. 8000 caracteres) o null si no se puede (error, no-HTML, vacío).
 * Alimenta la evaluación con texto completo: los extractos de Exa
 * dejaban demasiadas ofertas en «sin evidencia». Nunca lanza.
 */
export async function fetchOfferText(url: string, timeoutMs = 15_000): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        // Cabeceras de navegador: muchos portales rechazan agentes
        // evidentes (406/403). Aun así, los muros anti-bots serios solo
        // los franquea el texto que trae Exa; esto es el último recurso.
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en,es;q=0.8',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('text/html') && !ct.includes('text/plain') && ct !== '') return null;
    const body = await res.text();
    const text = htmlToText(body);
    return text ? text.slice(0, 8000) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const NO_REPLY_RE = /^(no[-_.]?reply|donotreply|mailer-daemon|postmaster)@/i;

export interface ApplicationContact {
  email: string;
  /** La frase del anuncio donde aparece el email (trae el asunto y las instrucciones). */
  notes: string;
}

/**
 * Extrae el email de aplicación de una oferta, si el anuncio lo trae.
 * Muchas convocatorias (ONGs, instituciones) se aplican por correo: el
 * anuncio indica «enviar CV a …». Se descartan buzones no-reply. Las
 * notas son la frase completa donde aparece, truncada a 300 caracteres.
 */
export function extractApplicationContact(
  title: string | null | undefined,
  highlights: readonly string[] | null | undefined,
): ApplicationContact | null {
  const sources = [title ?? '', ...(highlights ?? [])];
  for (const src of sources) {
    if (!src) continue;
    const matches = src.match(EMAIL_RE) ?? [];
    for (const m of matches) {
      const email = m.toLowerCase();
      if (NO_REPLY_RE.test(email)) continue;
      const notes = src.replace(/\s+/g, ' ').trim();
      return { email, notes: notes.length > 300 ? notes.slice(0, 300) : notes };
    }
  }
  return null;
}

/** Ventana de actualidad: solo páginas publicadas en los últimos N días. */
export const RECENCY_WINDOW_DAYS = 30;

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
        // `startPublishedDate`: requisito básico de Jon (20-oct-2026) —
        // solo ofertas recientes; las páginas de empleo caducadas o viejas
        // eran la queja principal de calidad de búsqueda.
        body: JSON.stringify({
          query: opts.query,
          type: 'auto',
          numResults: opts.numResults,
          excludeDomains: opts.excludeDomains ?? DEFAULT_EXCLUDED_DOMAINS,
          ...(opts.includeDomains && opts.includeDomains.length > 0
            ? { includeDomains: opts.includeDomains }
            : {}),
          startPublishedDate: new Date(
            Date.now() - RECENCY_WINDOW_DAYS * 24 * 60 * 60 * 1000,
          ).toISOString(),
          // highlights + texto completo: el texto alimenta la evaluación
          // (mejora 20-oct-2026) porque Exa sí puede leer las páginas que
          // bloquean a nuestro servidor (ReliefWeb devuelve 406/403 a
          // peticiones directas). El coste real viene en costDollars.
          contents: { highlights: true, text: { maxCharacters: 8000 } },
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
        text?: string | null;
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
      ...(typeof r.text === 'string' && r.text.trim() ? { text: r.text } : {}),
    }));

    return {
      results,
      requestId: typeof body.requestId === 'string' ? body.requestId : '',
      costDollars: body.costDollars?.total ?? 0,
    };
  }

  async function getContents(urls: string[]): Promise<ExaContentsResponse> {
    const texts = new Map<string, string>();
    if (urls.length === 0) return { texts, costDollars: 0 };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(EXA_CONTENTS_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({ urls, text: { maxCharacters: 8000 } }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Exa contents: error de red: ${detail}`);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      throw new Error(`Exa contents: HTTP ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as {
      results?: Array<{ url?: string; text?: string | null }>;
      costDollars?: { total?: number } | null;
    };
    for (const r of body.results ?? []) {
      if (r.url && typeof r.text === 'string' && r.text.trim()) {
        texts.set(r.url, r.text);
      }
    }
    return { texts, costDollars: body.costDollars?.total ?? 0 };
  }

  return { search, getContents };
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

const URL_CHECK_TIMEOUT_MS = 10_000;

/**
 * Estado de una URL de oferta tras la sonda de vigencia:
 * - `alive`: respondió con estado < 400 (existe y se puede abrir).
 * - `broken`: CONFIRMADO roto — 404/410 verificado con dos métodos, o el
 *   dominio no existe (DNS ENOTFOUND en ambos intentos). Solo este estado
 *   autoriza a descartar la oferta y a enseñar la etiqueta «enlace roto».
 * - `unknown`: no se puede afirmar nada — el portal bloquea la sonda
 *   (401/403/406/429), error transitorio (5xx, timeout, TLS, conexión
 *   rechazada) o respuesta ambigua. Lo desconocido NUNCA es «roto»:
 *   ReliefWeb, por ejemplo, devuelve 403/404 a agentes no-navegador en
 *   ofertas perfectamente vivas (falsos «enlace roto» del 2026-10-20: la
 *   sonda vieja marcaba rotas 27 de 108 ofertas, casi todas vivas).
 */
export type UrlStatus = 'alive' | 'broken' | 'unknown';

/** Cabeceras de navegador: la sonda se presenta como un navegador más. */
const URL_CHECK_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en,es;q=0.8',
};

/** Códigos de error de red que puede traer la cadena de causas de undici. */
function errorCodes(err: unknown): Set<string> {
  const codes = new Set<string>();
  const visit = (e: unknown, depth: number): void => {
    if (!e || typeof e !== 'object' || depth > 4) return;
    const rec = e as { code?: unknown; cause?: unknown; errors?: unknown };
    if (typeof rec.code === 'string') codes.add(rec.code);
    if (Array.isArray(rec.errors)) for (const sub of rec.errors) visit(sub, depth + 1);
    visit(rec.cause, depth + 1);
  };
  visit(err, 0);
  return codes;
}

type ProbeOutcome = { kind: 'status'; status: number } | { kind: 'error'; err: unknown };

/** Una sonda HTTP con timeout propio. Nunca lanza. */
async function probeUrl(url: string, method: 'HEAD' | 'GET'): Promise<ProbeOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), URL_CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      redirect: 'follow',
      signal: controller.signal,
      headers:
        method === 'GET' ? { ...URL_CHECK_HEADERS, Range: 'bytes=0-1023' } : URL_CHECK_HEADERS,
    });
    // No necesitamos el cuerpo: se cancela para no descargar la página.
    try {
      await res.body?.cancel();
    } catch {
      // Sin efecto: el estado ya se conoce.
    }
    return { kind: 'status', status: res.status };
  } catch (err) {
    return { kind: 'error', err };
  } finally {
    clearTimeout(timer);
  }
}

const isGoneStatus = (status: number): boolean => status === 404 || status === 410;
const isDnsGone = (err: unknown): boolean => errorCodes(err).has('ENOTFOUND');

/**
 * Sonda de vigencia en dos pasos (HEAD y, si no es concluyente, GET
 * parcial, ambos con cabeceras de navegador). «Roto» exige evidencia
 * doble y del mismo signo; cualquier bloqueo anti-bots o fallo
 * transitorio queda en `unknown`. Nunca lanza.
 */
export async function checkUrlStatus(url: string): Promise<UrlStatus> {
  const head = await probeUrl(url, 'HEAD');
  if (head.kind === 'status' && head.status < 400) return 'alive';
  if (head.kind === 'error' && !isDnsGone(head.err)) {
    // Fallo transitorio (timeout/TLS/red): sin evidencia de que la
    // página no exista; un segundo intento no lo convertiría en prueba.
    // Solo el DNS «no existe» merece confirmación con el segundo método.
    return 'unknown';
  }

  const get = await probeUrl(url, 'GET');
  if (get.kind === 'status') {
    if (get.status < 400) return 'alive';
    // Roto confirmado solo si AMBOS métodos dicen «no existe».
    if (isGoneStatus(get.status) && head.kind === 'status' && isGoneStatus(head.status)) {
      return 'broken';
    }
    if (isGoneStatus(get.status) && head.kind === 'error' && isDnsGone(head.err)) {
      return 'broken';
    }
    return 'unknown';
  }
  // Ambos intentos sin respuesta: roto solo si el dominio no existe.
  return isDnsGone(get.err) ? 'broken' : 'unknown';
}

/**
 * Compatibilidad: «viva» solo con evidencia positiva (estado < 400).
 * `broken` y `unknown` devuelven false (la sonda de pre-envío sigue
 * siendo conservadora), pero quien necesite distinguir el roto
 * confirmado de lo no comprobado debe usar `checkUrlStatus`.
 */
export async function checkUrlAlive(url: string): Promise<boolean> {
  return (await checkUrlStatus(url)) === 'alive';
}
