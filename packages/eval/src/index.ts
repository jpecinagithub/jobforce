/**
 * @jobforce/eval — Motor de evaluación de ofertas (Fase 2).
 *
 * Puntúa ofertas de empleo contra los criterios de una campaña usando reglas
 * 100 % deterministas: sin LLM, sin llamadas de red, sin estado externo.
 *
 * Entrada:  la oferta (título + extractos/highlights de Exa), los criterios
 *            de la campaña y los hechos del perfil (versión activa).
 * Salida:   veredicto de los requisitos obligatorios (peor estado),
 *            puntuación ponderada por dimensión (solo si todo cumple) y
 *            desglose por dimensión con explicación y hechos referenciados.
 */

import type {
  CampaignCriteria,
  MandatoryRequirement,
  MandatoryState,
  PreferenceKey,
} from '@jobforce/domain';

// ---------------------------------------------------------------------------
// Tipos de la API del evaluador (§4 del contrato)
// ---------------------------------------------------------------------------

/** Oferta a evaluar: lo que devuelve Exa (título, URL y extractos). */
export interface EvalOfferInput {
  title: string;
  url: string;
  highlights: string[];
}

/** Hecho del perfil (versión activa) en formato reducido. */
export interface ProfileFactInput {
  category: string;
  key: string;
  value: unknown;
}

/** Estado de un requisito obligatorio con su evidencia textual. */
export interface MandatoryDetail {
  requisito_id: string;
  descripcion: string;
  estado: MandatoryState;
  /** Cita textual (≤200 caracteres) del título/highlight que justifica el
   *  estado; "" cuando no hay evidencia (sin_evidencia). */
  evidencia: string;
}

/** Puntuación de una dimensión de preferencia. */
export interface DimensionScore {
  dimension: PreferenceKey;
  peso: number;
  /** 0..100 según densidad de keywords (ver fórmula en scoreDimension). */
  puntos: number;
  explicacion: string;
  /** "category.key" de hechos del perfil mencionados por esta dimensión. */
  hechos: string[];
}

/** Resultado de evaluar una oferta contra los criterios de una campaña. */
export interface EvaluationResult {
  /** Peor estado entre los requisitos obligatorios
   *  (incumple > sin_evidencia > cumple). */
  mandatory_verdict: MandatoryState;
  mandatory_details: MandatoryDetail[];
  /** Ponderada por peso; null si mandatory_verdict != 'cumple'. */
  score: number | null;
  /** 6 dimensiones en orden: funciones, competencias, seniority,
   *  ubicacion, condiciones, empresa. */
  breakdown: DimensionScore[];
}

// ---------------------------------------------------------------------------
// Normalización y utilidades de texto
// ---------------------------------------------------------------------------

/** Normaliza para comparar: minúsculas + sin tildes. */
export function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** Corpus de búsqueda: título + extractos, normalizado. */
function corpusOf(offer: EvalOfferInput): string {
  return norm([offer.title, ...offer.highlights].join(' '));
}

/** Título normalizado (para detectar menciones "directas" en el título). */
function titleNormOf(offer: EvalOfferInput): string {
  return norm(offer.title);
}

/**
 * Busca la primera fuente (título y luego highlights) que contenga el token
 * y devuelve la cita original recortada a 200 caracteres (espacios
 * colapsados). "" si no hay coincidencia.
 */
function findEvidence(offer: EvalOfferInput, needles: string[]): string {
  const hay = [offer.title, ...offer.highlights];
  for (const n of needles) {
    const needle = norm(n);
    if (!needle) continue;
    for (const h of hay) {
      if (norm(h).includes(needle)) {
        return h.replace(/\s+/g, ' ').trim().slice(0, 200);
      }
    }
  }
  return '';
}

/** Trocea un texto normalizado en tokens alfanuméricos (≥2 letras). */
function tokensOf(s: string): Set<string> {
  return new Set(
    norm(s)
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 2),
  );
}

/** Orden fijo del desglose (§4: "en el orden del plan"). */
export const DIMENSION_ORDER: PreferenceKey[] = [
  'funciones',
  'competencias',
  'seniority',
  'ubicacion',
  'condiciones',
  'empresa',
];

/** Gravedad de los estados para el veredicto (peor estado manda). */
const STATE_SEVERITY: Record<MandatoryState, number> = {
  cumple: 0,
  sin_evidencia: 1,
  incumple: 2,
};

// ---------------------------------------------------------------------------
// Heurísticas deterministas para detectar incompatibilidad
// (política conservadora: solo incumple con evidencia POSITIVA)
// ---------------------------------------------------------------------------

/** Señales de nivel junior/becario (para "Junior Accountant" y similares). */
const JUNIOR_TOKENS = [
  'junior',
  'trainee',
  'intern',
  'internship',
  'becario',
  'practicante',
  'aprendiz',
  'entry level',
];

/** Área financiera: junior + área financiera sin rol buscado => incumple. */
const FINANCE_AREA_TOKENS = [
  'accountant',
  'accounting',
  'contable',
  'financ', // finance, financial, finanzas, financiero…
  'controller',
  'controlling',
  'tesorer', // tesorería
  'treasury',
  'audit',
];

/**
 * Disciplinas claramente distintas de finanzas senior. Subcadenas
 * normalizadas; elegidas para minimizar falsos positivos en ofertas reales.
 */
const OTHER_DISCIPLINE_TOKENS = [
  'marketing',
  'sales',
  'ventas',
  'human resources',
  'recursos humanos',
  'talent acquisition',
  'software',
  'developer',
  'desarrollador',
  'devops',
  'data scientist',
  'nurse',
  'enfermer',
  'teacher',
  'docente',
  'profesor',
  'driver',
  'conductor',
  'chef',
  'cocinero',
  'waiter',
  'camarero',
  'lawyer',
  'abogado',
  'journalist',
  'periodista',
  'receptionist',
  'recepcionista',
  'designer',
  'arquitecto',
  'architect',
  'mechanic',
  'mecanico',
  'electricista',
  'doctor',
  'medico',
  'farmaceutico',
  'pharmacist',
  'psicologo',
  'psychologist',
  'fisioterapeuta',
  'physiotherapist',
];

/** Señales de trabajo remoto. */
const REMOTE_TOKENS = ['remote', 'remoto', 'work from home', 'teletrabajo', 'home office'];

/** Señales de presencialidad exigida. */
const ONSITE_REQUIRED_TOKENS = ['presencial', 'onsite', 'on-site', 'in office'];

/**
 * Diccionario compacto de países (normalizados) para detectar si un texto que
 * exige presencialidad menciona un país NO permitido por la campaña. Solo se
 * usa para el caso "presencial en país excluido"; ante la duda no se descarta.
 */
const COUNTRY_TOKENS = [
  'spain', 'espana', 'netherlands', 'holanda', 'germany', 'alemania',
  'france', 'francia', 'portugal', 'ireland', 'irlanda', 'italy', 'italia',
  'belgium', 'belgica', 'austria', 'switzerland', 'suiza', 'poland', 'polonia',
  'sweden', 'suecia', 'norway', 'noruega', 'denmark', 'dinamarca',
  'finland', 'finlandia', 'greece', 'grecia', 'czech', 'chequia',
  'united kingdom', 'reino unido', 'uk', 'england', 'inglaterra',
  'united states', 'estados unidos', 'usa', 'canada', 'mexico',
  'brazil', 'brasil', 'argentina', 'chile', 'colombia', 'peru',
  'costa rica', 'panama', 'australia', 'new zealand', 'nueva zelanda',
  'japan', 'japon', 'china', 'india', 'singapore', 'singapur',
  'south korea', 'corea del sur', 'uae', 'emiratos', 'dubai', 'qatar',
  'saudi arabia', 'arabia saudi', 'arabia', 'israel', 'turkey', 'turquia',
  'egypt', 'egipto', 'morocco', 'marruecos', 'south africa', 'sudafrica',
];

/** Devuelve los tokens que aparecen (como subcadena normalizada) en el corpus. */
function includesAny(corpus: string, tokens: string[]): string[] {
  const found: string[] = [];
  for (const t of tokens) {
    const n = norm(t);
    if (n && corpus.includes(n)) found.push(t);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Matchers por kind
// ---------------------------------------------------------------------------

function matchRole(req: MandatoryRequirement, offer: EvalOfferInput, corpus: string): MandatoryDetail {
  const roles = (req.params['roles'] as string[] | undefined) ?? [];
  const wanted = includesAny(corpus, roles);
  if (wanted.length > 0) {
    return {
      requisito_id: req.id,
      descripcion: req.description,
      estado: 'cumple',
      evidencia: findEvidence(offer, wanted),
    };
  }
  // Sin rol buscado: buscar evidencia POSITIVA de incompatibilidad.
  const junior = includesAny(corpus, JUNIOR_TOKENS);
  const finance = includesAny(corpus, FINANCE_AREA_TOKENS);
  if (junior.length > 0 && finance.length > 0) {
    return {
      requisito_id: req.id,
      descripcion: req.description,
      estado: 'incumple',
      evidencia: findEvidence(offer, junior),
    };
  }
  const other = includesAny(corpus, OTHER_DISCIPLINE_TOKENS);
  if (other.length > 0) {
    return {
      requisito_id: req.id,
      descripcion: req.description,
      estado: 'incumple',
      evidencia: findEvidence(offer, other),
    };
  }
  // Política conservadora: ante la duda, no descartar.
  return { requisito_id: req.id, descripcion: req.description, estado: 'sin_evidencia', evidencia: '' };
}

/**
 * Palabras funcionales por idioma para detectar en qué lengua está
 * redactada una oferta. Se cuentan palabras DISTINTAS presentes en el
 * corpus (título + extractos, ya normalizado).
 */
const STOPWORDS: Record<string, string[]> = {
  en: ['the', 'and', 'with', 'for', 'you', 'your', 'our', 'will', 'are', 'this', 'that', 'have', 'has', 'who', 'what', 'when', 'where', 'they', 'their', 'from', 'about', 'into', 'over', 'after', 'before', 'between', 'through', 'working', 'experience', 'responsibilities', 'requirements', 'opportunity', 'looking', 'join', 'team', 'role', 'work'],
  es: ['los', 'las', 'una', 'del', 'que', 'con', 'para', 'por', 'como', 'más', 'este', 'esta', 'son', 'sobre', 'también', 'hasta', 'desde', 'donde', 'cuando', 'muy', 'sin', 'sus', 'empresa', 'años', 'equipo', 'trabajo'],
  de: ['der', 'die', 'das', 'und', 'mit', 'für', 'von', 'den', 'ist', 'ein', 'eine', 'im', 'sich', 'auf', 'werden', 'aus', 'wir', 'sie', 'bei', 'einer', 'einem', 'einen', 'als', 'auch', 'nach', 'und', 'unsere', 'unser', 'oder'],
  fr: ['les', 'des', 'une', 'dans', 'pour', 'qui', 'que', 'est', 'sur', 'avec', 'aux', 'par', 'pas', 'vous', 'nous', 'être', 'sont', 'ces', 'au', 'ou', 'être'],
  nl: ['het', 'een', 'van', 'dat', 'die', 'zijn', 'voor', 'met', 'aan', 'tot', 'ook', 'als', 'bij', 'naar', 'je', 'wij', 'er', 'om', 'op'],
  it: ['il', 'lo', 'che', 'una', 'per', 'con', 'del', 'sono', 'delle', 'dei', 'gli', 'nella', 'nel', 'alla', 'come', 'si', 'da', 'su'],
  pt: ['os', 'as', 'em', 'do', 'da', 'dos', 'das', 'para', 'com', 'uma', 'que', 'por', 'ao', 'são', 'como', 'mais', 'na', 'no', 'nas', 'nos'],
};

function distinctStopwords(corpus: string, words: string[]): number {
  const tokens = new Set(corpus.split(/[^a-z]+/).filter(Boolean));
  let n = 0;
  for (const w of words) if (tokens.has(w)) n++;
  return n;
}

/**
 * ¿Está el texto redactado en inglés? Regla de Jon (20-oct-2026): «todas
 * las ofertas en las que aplico están en inglés» — si el anuncio está
 * escrito en inglés, el idioma de trabajo es inglés aunque nunca nombre
 * la palabra «English». Detección conservadora: muchas palabras
 * funcionales inglesas distintas y dominio claro (más del doble que
 * cualquier otro idioma detectado).
 */
function corpusIsEnglish(corpus: string): boolean {
  const en = distinctStopwords(corpus, STOPWORDS['en']);
  if (en < 8) return false;
  let maxOther = 0;
  for (const lang of Object.keys(STOPWORDS)) {
    if (lang === 'en') continue;
    maxOther = Math.max(maxOther, distinctStopwords(corpus, STOPWORDS[lang]));
  }
  return en > 2 * maxOther;
}

/** La frase de la oferta con más señal de inglés (para citarla como evidencia). */
function englishEvidence(offer: EvalOfferInput): string {
  const sources = [offer.title, ...offer.highlights];
  let best = '';
  let bestScore = -1;
  for (const s of sources) {
    const score = distinctStopwords(norm(s), STOPWORDS['en']);
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  const clean = best.replace(/\s+/g, ' ').trim();
  return clean.length > 200 ? clean.slice(0, 200) : clean;
}

function matchLanguage(req: MandatoryRequirement, offer: EvalOfferInput, corpus: string): MandatoryDetail {
  const languages = (req.params['languages'] as string[] | undefined) ?? [];
  const found = includesAny(corpus, languages);
  if (found.length > 0) {
    return {
      requisito_id: req.id,
      descripcion: req.description,
      estado: 'cumple',
      evidencia: findEvidence(offer, found),
    };
  }
  // Sin mención literal: si se pide inglés y la oferta ESTÁ REDACTADA en
  // inglés, el requisito se cumple (decisión expresa de Jon, 20-oct-2026).
  const wantsEnglish = languages.some((l) => ['english', 'inglés', 'ingles', 'en'].includes(norm(l)));
  if (wantsEnglish && corpusIsEnglish(corpus)) {
    return {
      requisito_id: req.id,
      descripcion: req.description,
      estado: 'cumple',
      evidencia: englishEvidence(offer),
    };
  }
  return { requisito_id: req.id, descripcion: req.description, estado: 'sin_evidencia', evidencia: '' };
}

function matchLocation(req: MandatoryRequirement, offer: EvalOfferInput, corpus: string): MandatoryDetail {
  const mode = (req.params['mode'] as string | undefined) ?? 'any';
  const countries = (req.params['countries'] as string[] | undefined) ?? [];
  const base: Omit<MandatoryDetail, 'estado' | 'evidencia'> = {
    requisito_id: req.id,
    descripcion: req.description,
  };

  const allowed = includesAny(corpus, countries);
  const remote = includesAny(corpus, REMOTE_TOKENS);
  const onsiteReq = includesAny(corpus, ONSITE_REQUIRED_TOKENS);

  // mode 'exclude': vale cualquier ubicación EXCEPTO las listadas en
  // `countries` (p. ej. «cualquier parte del mundo menos España», requisito
  // básico de Jon, 20-oct-2026). La presencia de un país excluido descarta;
  // su ausencia cumple, aunque no haya evidencia positiva de ubicación.
  if (mode === 'exclude') {
    if (allowed.length > 0) {
      return { ...base, estado: 'incumple', evidencia: findEvidence(offer, allowed) };
    }
    return { ...base, estado: 'cumple', evidencia: '' };
  }

  if (mode === 'remote_ok') {
    if (remote.length > 0 || allowed.length > 0) {
      return { ...base, estado: 'cumple', evidencia: findEvidence(offer, [...remote, ...allowed]) };
    }
    const excluded = excludedCountryEvidence(corpus, countries);
    if (onsiteReq.length > 0 && excluded) {
      return { ...base, estado: 'incumple', evidencia: findEvidence(offer, [excluded, ...onsiteReq]) };
    }
    return { ...base, estado: 'sin_evidencia', evidencia: '' };
  }

  if (mode === 'onsite') {
    if (allowed.length > 0) {
      return { ...base, estado: 'cumple', evidencia: findEvidence(offer, allowed) };
    }
    if (remote.length > 0) {
      // Oferta 100 % remota cuando la campaña exige presencialidad.
      return { ...base, estado: 'incumple', evidencia: findEvidence(offer, remote) };
    }
    const excluded = excludedCountryEvidence(corpus, countries);
    if (onsiteReq.length > 0 && excluded) {
      return { ...base, estado: 'incumple', evidencia: findEvidence(offer, [excluded, ...onsiteReq]) };
    }
    return { ...base, estado: 'sin_evidencia', evidencia: '' };
  }

  // mode 'any': cualquier ubicación vale; solo importa si hay evidencia.
  if (remote.length > 0 || allowed.length > 0 || onsiteReq.length > 0) {
    return {
      ...base,
      estado: 'cumple',
      evidencia: findEvidence(offer, [...remote, ...allowed, ...onsiteReq]),
    };
  }
  return { ...base, estado: 'sin_evidencia', evidencia: '' };
}

/**
 * Devuelve el primer país mencionado en el corpus que NO está en la lista de
 * permitidos, o null si no hay ninguno. Requiere que el país aparezca como
 * token del diccionario (evita inventar ubicaciones).
 */
function excludedCountryEvidence(corpus: string, allowedCountries: string[]): string | null {
  const allowed = new Set(allowedCountries.map(norm));
  for (const c of COUNTRY_TOKENS) {
    const n = norm(c);
    if (!allowed.has(n) && corpus.includes(n)) return c;
  }
  return null;
}

function matchSeniority(req: MandatoryRequirement, offer: EvalOfferInput, corpus: string): MandatoryDetail {
  const levels = (req.params['levels'] as string[] | undefined) ?? [];
  const found = includesAny(corpus, levels);
  if (found.length > 0) {
    return {
      requisito_id: req.id,
      descripcion: req.description,
      estado: 'cumple',
      evidencia: findEvidence(offer, found),
    };
  }
  return { requisito_id: req.id, descripcion: req.description, estado: 'sin_evidencia', evidencia: '' };
}

function matchKeyword(req: MandatoryRequirement, offer: EvalOfferInput, corpus: string): MandatoryDetail {
  const anyOf = (req.params['any_of'] as string[] | undefined) ?? [];
  const noneOf = (req.params['none_of'] as string[] | undefined) ?? [];
  // none_of tiene prioridad: su presencia descarta aunque haya any_of.
  const forbidden = includesAny(corpus, noneOf);
  if (forbidden.length > 0) {
    return {
      requisito_id: req.id,
      descripcion: req.description,
      estado: 'incumple',
      evidencia: findEvidence(offer, forbidden),
    };
  }
  const found = includesAny(corpus, anyOf);
  if (found.length > 0) {
    return {
      requisito_id: req.id,
      descripcion: req.description,
      estado: 'cumple',
      evidencia: findEvidence(offer, found),
    };
  }
  // Regla de exclusión pura (sin any_of): se cumple por AUSENCIA de lo
  // prohibido — p. ej. «sin requisito de un tercer idioma» o «sin ofertas de
  // EE. UU. que nieguen el sponsorship» (campaña internacional de Jon,
  // 20-oct-2026). Sin esta rama, toda guarda de exclusión bloquearía el
  // 100 % de las ofertas por falta de evidencia positiva.
  if (anyOf.length === 0 && noneOf.length > 0) {
    return { requisito_id: req.id, descripcion: req.description, estado: 'cumple', evidencia: '' };
  }
  return { requisito_id: req.id, descripcion: req.description, estado: 'sin_evidencia', evidencia: '' };
}

function matchMandatory(req: MandatoryRequirement, offer: EvalOfferInput, corpus: string): MandatoryDetail {
  switch (req.kind) {
    case 'role': return matchRole(req, offer, corpus);
    case 'language': return matchLanguage(req, offer, corpus);
    case 'location': return matchLocation(req, offer, corpus);
    case 'seniority': return matchSeniority(req, offer, corpus);
    case 'keyword': return matchKeyword(req, offer, corpus);
    default:
      throw new Error(`Requisito obligatorio con kind desconocido: ${String(req.kind)}`);
  }
}

// ---------------------------------------------------------------------------
// Scoring por dimensión
//
// Fórmula (determinista): para cada dimensión se cuentan las keywords
// DISTINTAS que aparecen en el corpus (título + highlights, normalizados) y
// si alguna aparece en el TÍTULO.
//
//   m = nº de keywords distintas encontradas; t = ¿alguna en el título?
//   m = 0                        →   0 puntos  (sin menciones)
//   m = 1                        →  50 puntos  (mención simple)
//   m ≥ 3  o  t                 →  75 puntos  (varias menciones o mención directa en el título)
//   m ≥ 5  o  (t y m ≥ 2)       → 100 puntos  (cobertura amplia o mención en título + texto)
//
// score = Σ(peso × puntos) / Σ(pesos), redondeado a 2 decimales.
// Si Σ(pesos) = 0 se devuelve 0 (caso degenerado, sin dimensiones ponderadas).
// ---------------------------------------------------------------------------

function scoreDimension(
  dimension: PreferenceKey,
  weight: number,
  description: string,
  keywords: string[],
  offer: EvalOfferInput,
  corpus: string,
  titleNorm: string,
  profileFacts: ProfileFactInput[],
): DimensionScore {
  const matched = includesAny(corpus, keywords);
  const inTitle = includesAny(titleNorm, keywords);
  const m = matched.length;
  const t = inTitle.length > 0;

  let puntos = 0;
  if (m >= 5 || (t && m >= 2)) puntos = 100;
  else if (m >= 3 || t) puntos = 75;
  else if (m >= 1) puntos = 50;

  let explicacion: string;
  if (m === 0) {
    explicacion = 'Sin menciones de las palabras clave de la dimensión.';
  } else {
    const shown = matched.slice(0, 5).join(', ');
    const resto = m > 5 ? ` (+${m - 5} más)` : '';
    explicacion =
      `${m} mención${m === 1 ? '' : 'es'}: ${shown}${resto}` +
      (t ? ' (mención directa en el título).' : '.');
  }

  // Hechos del perfil: "category.key" cuando algún token de la categoría o la
  // clave del hecho aparece en los tokens de las keywords/descripción de la
  // dimensión. Búsqueda simple por tokens normalizados; no se inventan
  // relaciones semánticas.
  const dimTokens = new Set<string>();
  for (const k of keywords) for (const tok of tokensOf(k)) dimTokens.add(tok);
  for (const tok of tokensOf(description)) dimTokens.add(tok);

  const hechos: string[] = [];
  for (const f of profileFacts) {
    const factTokens = tokensOf(`${f.category} ${f.key.replace(/_/g, ' ')}`);
    for (const tok of factTokens) {
      if (dimTokens.has(tok)) {
        hechos.push(`${f.category}.${f.key}`);
        break;
      }
    }
  }

  return { dimension, peso: weight, puntos, explicacion, hechos };
}

// ---------------------------------------------------------------------------
// Entrada principal
// ---------------------------------------------------------------------------

/**
 * Evalúa una oferta contra los criterios de una campaña.
 *
 * 1. Evalúa cada requisito obligatorio (matchers por kind).
 * 2. mandatory_verdict = peor estado (incumple > sin_evidencia > cumple).
 * 3. Si verdict == 'cumple': puntúa las 6 dimensiones y calcula la media
 *    ponderada; si no, score = null y breakdown con 0 puntos (los hechos se
 *    calculan igual, para explicar el descarte en el informe).
 */
export function evaluateOffer(
  offer: EvalOfferInput,
  criteria: CampaignCriteria,
  profileFacts: ProfileFactInput[],
): EvaluationResult {
  const corpus = corpusOf(offer);
  const titleNorm = titleNormOf(offer);

  const mandatory_details = criteria.mandatory.map((req) => matchMandatory(req, offer, corpus));

  let mandatory_verdict: MandatoryState = 'cumple';
  for (const d of mandatory_details) {
    if (STATE_SEVERITY[d.estado] > STATE_SEVERITY[mandatory_verdict]) {
      mandatory_verdict = d.estado;
    }
  }

  let score: number | null = null;
  const breakdown: DimensionScore[] = DIMENSION_ORDER.map((dimension) => {
    const pref = criteria.preferences[dimension];
    const weight = pref?.weight ?? 0;
    const description = pref?.description ?? '';
    const keywords = pref?.keywords ?? [];
    if (mandatory_verdict !== 'cumple') {
      const zero: DimensionScore = {
        ...scoreDimension(dimension, weight, description, keywords, offer, corpus, titleNorm, profileFacts),
        puntos: 0,
        explicacion: 'Sin puntuación: la oferta no supera los requisitos obligatorios.',
      };
      return zero;
    }
    return scoreDimension(dimension, weight, description, keywords, offer, corpus, titleNorm, profileFacts);
  });

  if (mandatory_verdict === 'cumple') {
    let num = 0;
    let den = 0;
    for (const b of breakdown) {
      num += b.peso * b.puntos;
      den += b.peso;
    }
    score = den === 0 ? 0 : Math.round((num / den) * 100) / 100;
  }

  return { mandatory_verdict, mandatory_details, score, breakdown };
}
