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
  /** Resultados completos (título, autor, fecha, texto) por URL pedida. */
  results: ExaResult[];
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
    if (urls.length === 0) return { texts, results: [], costDollars: 0 };
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
      results?: Array<{
        id?: string;
        url?: string;
        title?: string | null;
        author?: string | null;
        publishedDate?: string | null;
        text?: string | null;
        highlights?: string[] | null;
      }>;
      costDollars?: { total?: number } | null;
    };
    const results: ExaResult[] = [];
    for (const r of body.results ?? []) {
      if (!r.url) continue;
      if (typeof r.text === 'string' && r.text.trim()) {
        texts.set(r.url, r.text);
      }
      results.push({
        id: r.id ?? r.url,
        title: r.title ?? '',
        url: r.url,
        ...(r.author ? { author: r.author } : {}),
        ...(r.publishedDate ? { publishedDate: r.publishedDate } : {}),
        ...(Array.isArray(r.highlights) ? { highlights: r.highlights } : {}),
        ...(typeof r.text === 'string' ? { text: r.text } : {}),
      });
    }
    return { texts, results, costDollars: body.costDollars?.total ?? 0 };
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
/**
 * Nombres visibles de tenants ATS conocidos (la forma del slug no basta:
 * «jj» es J&J, «gsk» es GSK, «djeholdings» es Edelman/DJE Holdings…).
 */
const TENANT_DISPLAY: Record<string, string> = {
  gsk: 'GSK',
  jj: 'J&J',
  jnj: 'J&J',
  johnsonjohnson: 'Johnson & Johnson',
  dssmith: 'DS Smith',
  scj: 'SC Johnson',
  djeholdings: 'Edelman',
  alsglobal: 'ALS Global',
  cancerresearchuk: 'Cancer Research UK',
  worldvision: 'World Vision',
  livenation: 'Live Nation',
  schreiberfoods: 'Schreiber Foods',
  fluenceenergy: 'Fluence Energy',
};

/** Nombre presentable a partir de un slug de tenant: mapa conocido o Title Case por guiones. */
export function tenantDisplayName(slug: string): string {
  const key = slug.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (TENANT_DISPLAY[key]) return TENANT_DISPLAY[key];
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Sitios que son el PORTAL, no la empresa (nunca son la respuesta). */
const PORTAL_NAMES = new Set([
  'reliefweb', 'myworkdayjobs.com', 'workday', 'linkedin', 'indeed', 'glassdoor',
  'devex', 'unjobs', 'infojobs', 'jobera', 'tealhq', 'greenhouse', 'lever', 'ashby',
]);

/** Palabras de rol (EN+ES): si un segmento del título las contiene, es el puesto, no la empresa. */
const JOB_SEGMENT_RE =
  /(manager|director|analyst|specialist|controller|lead|head|coordinator|officer|accountant|finance|financial|consultant|engineer|developer|assistant|executive|administrator|partner|supervisor|clerk|auditor|planner|strategist|designer|recruiter|intern|chef|nurse|teacher|tecnico|tecnica|contabilidad|responsable|administrativ|coordinador|gerente|jefe|encargado|auxiliar|consultor|analista|gestor|operario|dependiente|comercial|ingeniero|abogado|enfermer|medico|profesor|desarrollador|programador|expatriado|proyectos)/i;

/** Si el candidato (sin espacios ni signos) es un tenant conocido, su nombre visible. */
function polishCompany(candidate: string): string {
  const squash = candidate.toLowerCase().replace(/[^a-z0-9]/g, '');
  return TENANT_DISPLAY[squash] ?? candidate;
}

/** Candidato a empresa válido: sin dominios, sin portales conocidos, longitud razonable. */
function plausibleCompany(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const name = raw.replace(/\s+/g, ' ').replace(/[\s|,–-]+$/g, '').trim();
  if (name.length < 2 || name.length > 60) return null;
  if (/\.(com|org|net|io|hr|jobs|es|int)\b/i.test(name)) return null;
  if (PORTAL_NAMES.has(name.toLowerCase())) return null;
  return name;
}

/** Empresa desde el host cuando es un ATS con tenant: Workday, Breezy, Greenhouse, Lever, Ashby, SmartRecruiters, Teamtailor, Personio. */
function companyFromAtsHost(url: string): string | null {
  let host: string;
  let path: string;
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    path = u.pathname;
  } catch {
    return null;
  }
  const sub = host.split('.')[0];
  if (host.endsWith('.myworkdayjobs.com') && sub) return tenantDisplayName(sub);
  if (host.endsWith('.breezy.hr') && sub) return tenantDisplayName(sub);
  if (host.endsWith('.teamtailor.com') && sub && sub !== 'www') return tenantDisplayName(sub);
  if (host.endsWith('.personio.com') || host.endsWith('.jobs.personio.com')) {
    if (sub && sub !== 'www') return tenantDisplayName(sub);
  }
  const seg = path.split('/').filter(Boolean);
  if (host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io') {
    return seg[0] ? tenantDisplayName(seg[0]) : null;
  }
  if (host === 'jobs.lever.co') return seg[0] ? tenantDisplayName(seg[0]) : null;
  if (host === 'jobs.ashbyhq.com') return seg[0] ? tenantDisplayName(seg[0]) : null;
  if (host === 'jobs.smartrecruiters.com' || host === 'careers.smartrecruiters.com') {
    return seg[0] ? tenantDisplayName(seg[0]) : null;
  }
  return null;
}

/**
 * Empresa de una oferta a partir de lo que trae Exa. La ingesta guardaba
 * `author` como empresa y eso era casi siempre null (92/104) o basura
 * («Publicada el», nombres de personas, «Johnson, Johnson Careers»).
 * Orden de fiabilidad:
 *  1. Campo «Company:»/«Organization:» del texto completo de Exa.
 *  2. Patrón «… at X» al final del título (formato habitual de Exa).
 *  3. Segmento inicial del título «Empresa - Puesto» si no parece un rol.
 *  4. Tenant del ATS en la URL (Workday/Breezy/Greenhouse/…).
 *  5. `author` SOLO si es la página «X Careers» de la empresa.
 * Si nada cuadra, null (mejor «—» que un nombre inventado).
 */
export function extractCompany(input: {
  title?: string | null;
  url: string;
  text?: string | null;
  author?: string | null;
}): string | null {
  // 1) Campo explícito en el texto.
  if (input.text) {
    const m = input.text.match(
      /(?:^|\n)[-\s*]*\*\*(?:Company|Organization|Organisation|Employer|Empresa)\*\*:?\s*\**\s*([^\n*]{2,60})/i,
    );
    const fromField = plausibleCompany(m?.[1]);
    if (fromField) return polishCompany(fromField);
  }
  const title = (input.title ?? '').replace(/\s+/g, ' ').trim();
  // 2) «… at X» final.
  const at = title.match(/\bat\s+([^|–—-]{2,60})$/i);
  const fromAt = plausibleCompany(at?.[1]);
  if (fromAt) {
    // Un token único puede ser el slug del tenant («at Jj», «at Gsk»).
    return polishCompany(fromAt.includes(' ') ? fromAt : tenantDisplayName(fromAt));
  }
  // 3) «Empresa - Puesto …»: primer segmento sin palabras de rol.
  const firstSeg = title.split(/\s+[-–—]\s+/)[0];
  if (firstSeg && firstSeg !== title && !JOB_SEGMENT_RE.test(firstSeg)) {
    const fromSeg = plausibleCompany(firstSeg);
    if (fromSeg && fromSeg.split(' ').length <= 4) return polishCompany(fromSeg);
  }
  // 4) Tenant del ATS.
  const fromHost = companyFromAtsHost(input.url);
  if (fromHost) return plausibleCompany(fromHost) ?? fromHost;
  // 5) Author «X Careers».
  if (input.author && /careers/i.test(input.author)) {
    const cleaned = plausibleCompany(input.author.replace(/\bcareers\b/gi, ''));
    if (cleaned) return polishCompany(cleaned);
  }
  return null;
}

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

/** Vía que produjo el veredicto: API del portal, sitio del empleador, contenido o sonda HTTP genérica. */
export type UrlCheckVia = 'workday_api' | 'breezy_content' | 'jnj_careers' | 'http';

export interface UrlCheckDetail {
  status: UrlStatus;
  via: UrlCheckVia;
}

/**
 * URL de la API CXS de Workday para una oferta pública, o null si la URL
 * no es de Workday. La página pública de Workday es una SPA que devuelve
 * HTTP 200 SIEMPRE (oferta viva o muerta: el «muerto» se pinta con JS);
 * el veredicto real está en su API — documentado en @jobforce/connectors:
 * job inexistente → 404 JSON `{"errorCode":"HTTP_404"}`; job vivo → 200
 * con `jobPostingInfo`. Caso real (2026-10-21): Finance Manager en GSK,
 * muerta según su API y «viva» según la sonda HTML (25 ofertas de
 * Workday del pool estaban «verificadas» con ese 200 vacío).
 *
 * URL pública: https://{tenant}.wd{N}.myworkdayjobs.com/{locale?}/{site}/job/{path}
 * API CXS:     https://{tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/job/{path}
 */
export function workdayCxsJobUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith('.myworkdayjobs.com')) return null;
    const tenant = u.hostname.split('.')[0];
    const segs = u.pathname.split('/').filter(Boolean);
    const jobIdx = segs.indexOf('job');
    if (!tenant || jobIdx < 1) return null;
    const site = segs[jobIdx - 1];
    const path = segs.slice(jobIdx + 1).join('/');
    if (!site || !path) return null;
    return `${u.origin}/wday/cxs/${tenant}/${site}/job/${path}`;
  } catch {
    return null;
  }
}

/** Lee el cuerpo de una respuesta con tope de bytes (para inspección de contenido). */
async function readBodyCapped(res: Response, cap: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
      if (total >= cap) break;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Sin efecto: ya se leyó lo necesario.
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/**
 * Breezy HR: una posición cerrada devuelve HTTP 200 con la plantilla
 * «Position Closed — Sorry, this position is no longer accepting
 * candidates.» renderizada en el HTML (caso real, 2026-10-21: Finance
 * Manager Latam de Immersive Technologies, cerrada y «viva» para la
 * sonda por estado). El veredicto sale del CONTENIDO, no del estado.
 */
const BREEZY_CLOSED_MARKERS = [
  'position is no longer accepting candidates',
  '<h1>position closed</h1>',
];

async function checkBreezyStatus(url: string): Promise<UrlCheckDetail> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), URL_CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: URL_CHECK_HEADERS,
    });
    if (isGoneStatus(res.status)) return { status: 'broken', via: 'breezy_content' };
    if (res.status >= 400) return { status: 'unknown', via: 'breezy_content' };
    const html = (await readBodyCapped(res, 256_000)).toLowerCase();
    if (BREEZY_CLOSED_MARKERS.some((m) => html.includes(m))) {
      return { status: 'broken', via: 'breezy_content' };
    }
    return { status: 'alive', via: 'breezy_content' };
  } catch {
    return { status: 'unknown', via: 'breezy_content' };
  } finally {
    clearTimeout(timer);
  }
}

/** ¿Es una URL de Breezy HR ({empresa}.breezy.hr)? */
function isBreezyUrl(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith('.breezy.hr');
  } catch {
    return false;
  }
}

/**
 * Sonda de vigencia con veredicto y vía. Para Workday manda su API CXS
 * (la sonda HTML no puede distinguir nada ahí: siempre 200); si la API
 * no es concluyente, el resultado es `unknown`, nunca el 200 de la SPA.
 * Para el resto, sonda HTTP en dos pasos (HEAD y, si no es concluyente,
 * GET parcial, ambos con cabeceras de navegador): «roto» exige
 * evidencia doble y del mismo signo; cualquier bloqueo anti-bots o
 * fallo transitorio queda en `unknown`. Nunca lanza.
 */
/**
 * URL del sitio de empleo de Johnson & Johnson (Phenom) para una oferta
 * de su tenant de Workday, o null si no aplica. El tenant «jj» tiene la
 * CXS cerrada (403 S22 a todo el mundo) en ALGUNAS ofertas, pero su
 * sitio público sí discrimina: /en/jobs/r-{req}/ devuelve 404 «Page Not
 * Found» si la oferta ya no existe y 302/200 si sigue viva (verificado
 * 2026-10-21 con R-101032, muerta, frente a R-105619, viva).
 */
export function jnjCareersJobUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (!u.hostname.startsWith('jj.') || !u.hostname.endsWith('.myworkdayjobs.com')) return null;
    const m = u.pathname.match(/_R-(\d+)/i);
    if (!m) return null;
    return `https://www.careers.jnj.com/en/jobs/r-${m[1]}/`;
  } catch {
    return null;
  }
}

export async function checkUrlStatusDetailed(url: string): Promise<UrlCheckDetail> {
  if (isBreezyUrl(url)) return checkBreezyStatus(url);
  const cxs = workdayCxsJobUrl(url);
  if (cxs) {
    const api = await probeUrl(cxs, 'GET');
    if (api.kind === 'status') {
      if (isGoneStatus(api.status)) return { status: 'broken', via: 'workday_api' };
      if (api.status < 400) return { status: 'alive', via: 'workday_api' };
    }
    // CXS no concluyente (p. ej. el 403 del tenant de JnJ): para JnJ
    // manda su sitio de empleo, que sí distingue vivas de cerradas.
    const jnj = jnjCareersJobUrl(url);
    if (jnj) {
      const site = await probeUrl(jnj, 'GET');
      if (site.kind === 'status') {
        if (isGoneStatus(site.status)) return { status: 'broken', via: 'jnj_careers' };
        if (site.status < 400) return { status: 'alive', via: 'jnj_careers' };
      }
      return { status: 'unknown', via: 'jnj_careers' };
    }
    return { status: 'unknown', via: 'workday_api' };
  }

  const head = await probeUrl(url, 'HEAD');
  if (head.kind === 'status' && head.status < 400) return { status: 'alive', via: 'http' };
  if (head.kind === 'error' && !isDnsGone(head.err)) {
    // Fallo transitorio (timeout/TLS/red): sin evidencia de que la
    // página no exista; un segundo intento no lo convertiría en prueba.
    // Solo el DNS «no existe» merece confirmación con el segundo método.
    return { status: 'unknown', via: 'http' };
  }

  const get = await probeUrl(url, 'GET');
  if (get.kind === 'status') {
    if (get.status < 400) return { status: 'alive', via: 'http' };
    // Roto confirmado solo si AMBOS métodos dicen «no existe».
    if (isGoneStatus(get.status) && head.kind === 'status' && isGoneStatus(head.status)) {
      return { status: 'broken', via: 'http' };
    }
    if (isGoneStatus(get.status) && head.kind === 'error' && isDnsGone(head.err)) {
      return { status: 'broken', via: 'http' };
    }
    return { status: 'unknown', via: 'http' };
  }
  // Ambos intentos sin respuesta: roto solo si el dominio no existe.
  return { status: isDnsGone(get.err) ? 'broken' : 'unknown', via: 'http' };
}

/** Sonda de vigencia: solo el estado (ver `checkUrlStatusDetailed`). */
export async function checkUrlStatus(url: string): Promise<UrlStatus> {
  return (await checkUrlStatusDetailed(url)).status;
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
