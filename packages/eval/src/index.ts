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
  /**
   * Texto completo de la página de la oferta, cuando se ha podido
   * descargar (mejora del 20-oct-2026: los extractos de Exa dejaban el
   * 60 % de las ofertas de ONG en «sin evidencia» porque el dato clave
   * —ONG empleadora, destino, idioma— vive en el cuerpo del anuncio).
   * Se suma al corpus y a la búsqueda de evidencias (por frases).
   */
  fullText?: string;
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

/** Corpus de búsqueda: título + extractos + texto completo si lo hay. */
function corpusOf(offer: EvalOfferInput): string {
  return norm([offer.title, ...offer.highlights, offer.fullText ?? ''].join(' '));
}

/** El texto completo troceado en frases/párrafos citables como evidencia. */
function fullTextChunks(offer: EvalOfferInput): string[] {
  if (!offer.fullText) return [];
  return offer.fullText
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 3);
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
  const hay = [offer.title, ...offer.highlights, ...fullTextChunks(offer)];
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
  es: ['la', 'de', 'en', 'el', 'y', 'es', 'un', 'los', 'las', 'una', 'del', 'que', 'con', 'para', 'por', 'como', 'más', 'este', 'esta', 'son', 'sobre', 'también', 'hasta', 'desde', 'donde', 'cuando', 'muy', 'sin', 'sus', 'se', 'al', 'su', 'está', 'nuestra', 'nuestro', 'empresa', 'años', 'equipo', 'trabajo'],
  de: ['der', 'die', 'das', 'und', 'mit', 'für', 'von', 'den', 'ist', 'ein', 'eine', 'im', 'sich', 'auf', 'werden', 'aus', 'wir', 'sie', 'bei', 'einer', 'einem', 'einen', 'als', 'auch', 'nach', 'und', 'unsere', 'unser', 'oder'],
  fr: ['les', 'des', 'une', 'dans', 'pour', 'qui', 'que', 'est', 'sur', 'avec', 'aux', 'par', 'pas', 'vous', 'nous', 'être', 'sont', 'ces', 'au', 'ou', 'être'],
  nl: ['het', 'een', 'van', 'dat', 'die', 'zijn', 'voor', 'met', 'aan', 'tot', 'ook', 'als', 'bij', 'naar', 'je', 'wij', 'er', 'om', 'op'],
  it: ['il', 'lo', 'che', 'una', 'per', 'con', 'del', 'sono', 'delle', 'dei', 'gli', 'nella', 'nel', 'alla', 'come', 'si', 'da', 'su'],
  pt: ['os', 'as', 'em', 'do', 'da', 'dos', 'das', 'para', 'com', 'uma', 'que', 'por', 'ao', 'são', 'como', 'mais', 'na', 'no', 'nas', 'nos'],
  et: ['ja', 'ning', 'on', 'et', 'kui', 'ka', 'ei', 'see', 'seda', 'voi', 'kes', 'mis', 'aga', 'siis', 'vaga', 'sul', 'sind', 'sinu', 'oma', 'selle', 'sellest', 'juures', 'kohta', 'enam', 'veel', 'juba', 'kaasa', 'olema', 'meie', 'teie', 'nende'],
  pl: ['i', 'w', 'z', 'na', 'do', 'sie', 'nie', 'to', 'jest', 'sa', 'dla', 'o', 'po', 'jak', 'ale', 'czy', 'tez', 'przez', 'przy', 'oraz', 'juz', 'tylko', 'bardzo', 'ktory', 'ktora', 'ktore', 'bedzie', 'moze', 'od', 'za', 'ze', 'co', 'tak'],
  cs: ['je', 'se', 'na', 'a', 'v', 'z', 'do', 'pro', 's', 'k', 'o', 'po', 'ale', 'nebo', 'pokud', 'ktery', 'ktera', 'ktere', 'jsme', 'jsou', 'bude', 'byl', 'byla', 'take', 'jiz', 'velmi', 'nase', 'nasi'],
  sk: ['je', 'sa', 'na', 'a', 'v', 'z', 'do', 'pre', 's', 'k', 'o', 'po', 'ale', 'alebo', 'ak', 'ktory', 'ktora', 'ktore', 'sme', 'su', 'bude', 'bol', 'bola', 'tiez', 'velmi', 'nasa'],
  hu: ['hogy', 'nem', 'van', 'es', 'meg', 'el', 'ki', 'csak', 'mint', 'ahol', 'amely', 'nagyon', 'illetve', 'utan', 'kozott', 'amikor', 'akik', 'sajat', 'ezzel', 'azert'],
  ro: ['si', 'in', 'de', 'la', 'un', 'o', 'pe', 'cu', 'pentru', 'care', 'mai', 'din', 'este', 'sunt', 'nu', 'sa', 'cel', 'cea', 'prin', 'dupa', 'foarte', 'noastre', 'nostru'],
  sv: ['och', 'att', 'det', 'som', 'ar', 'en', 'ett', 'med', 'till', 'av', 'den', 'har', 'ska', 'vara', 'inte', 'om', 'pa', 'for', 'nar', 'efter', 'over', 'mycket', 'hos'],
  da: ['og', 'at', 'det', 'som', 'er', 'en', 'et', 'med', 'til', 'af', 'den', 'har', 'skal', 'vaere', 'ikke', 'om', 'pa', 'for', 'nar', 'efter', 'over', 'meget', 'hos'],
  no: ['og', 'at', 'det', 'som', 'er', 'en', 'et', 'med', 'til', 'av', 'den', 'har', 'skal', 'vaere', 'ikke', 'om', 'pa', 'for', 'nar', 'etter', 'over', 'meget', 'hos'],
  fi: ['ja', 'on', 'etta', 'kun', 'myos', 'ei', 'se', 'tama', 'nama', 'ovat', 'olla', 'joka', 'jotka', 'mutta', 'jos', 'niin', 'kuin', 'viela', 'hyvin', 'meidan', 'kanssa', 'varten', 'jalkeen', 'aikana'],
  lt: ['ir', 'yra', 'kad', 'su', 'i', 'is', 'tai', 'ne', 'kaip', 'bet', 'jei', 'taip', 'labai', 'savo', 'musu', 'jusu', 'arba', 'per', 'po', 'prie', 'apie', 'nuo', 'iki', 'del', 'kurie', 'kuris'],
  lv: ['un', 'ir', 'kas', 'ar', 'no', 'uz', 'par', 'bet', 'ne', 'ta', 'tie', 'to', 'lai', 'ari', 'loti', 'musu', 'jusu', 'savu', 'pec', 'pirms'],
  hr: ['i', 'u', 'je', 'se', 'na', 'za', 'od', 'do', 's', 'o', 'po', 'kao', 'ali', 'ili', 'ako', 'koji', 'koja', 'koje', 'smo', 'su', 'ce', 'biti', 'vrlo', 'nase'],
  sl: ['in', 'je', 'se', 'na', 'za', 'od', 'do', 'v', 'o', 'po', 'kot', 'ampak', 'ali', 'ce', 'ki', 'kateri', 'smo', 'so', 'bo', 'biti', 'zelo', 'nase'],
};



/**
 * Palabras funcionales DISTINTIVAS de cada idioma: las que aparecen en
 * una sola lista. Las compartidas («en», «a», «con»…) no discriminan y
 * no cuentan para nadie; así un boilerplate en inglés no tapa el cuerpo
 * del anuncio cuando está en otra lengua.
 */
const DISTINCTIVE_STOPWORDS: Record<string, string[]> = (() => {
  const counts = new Map<string, number>();
  for (const words of Object.values(STOPWORDS)) {
    for (const w of new Set(words.map((x) => norm(x).trim()).filter(Boolean))) {
      counts.set(w, (counts.get(w) ?? 0) + 1);
    }
  }
  const out: Record<string, string[]> = {};
  for (const [lang, words] of Object.entries(STOPWORDS)) {
    out[lang] = [...new Set(words.map((x) => norm(x).trim()).filter(Boolean))].filter(
      (w) => counts.get(w) === 1,
    );
  }
  return out;
})();

/** Apariciones (con repetición) de las palabras distintivas de un idioma. */
function distinctiveOccurrences(chunkNorm: string, lang: string): number {
  const set = new Set(DISTINCTIVE_STOPWORDS[lang]);
  let n = 0;
  for (const tok of chunkNorm.split(/[^a-z]+/)) if (tok && set.has(tok)) n++;
  return n;
}

/** Idioma de un fragmento, o null si no hay señal clara (≥2 distintivas y dominio sobre el segundo). */
function chunkLanguage(chunkNorm: string): string | null {
  let best: string | null = null;
  let bestN = 0;
  let secondN = 0;
  for (const lang of Object.keys(DISTINCTIVE_STOPWORDS)) {
    const n = distinctiveOccurrences(chunkNorm, lang);
    if (n > bestN) {
      secondN = bestN;
      bestN = n;
      best = lang;
    } else if (n > secondN) {
      secondN = n;
    }
  }
  if (!best || bestN < 2 || bestN < 1.5 * secondN) return null;
  return best;
}

/**
 * Idioma en que está REDACTADA la oferta, o null si no se puede afirmar.
 * Voto por fragmentos (título, extractos y frases del texto completo)
 * ponderado por caracteres: el cuerpo del anuncio pesa más que un
 * boilerplate corporativo en inglés. Hace falta un mínimo de texto
 * clasificado (120 caracteres) y que el ganador supere el 55 %.
 *
 * Regla de Jon (20-oct-2026, reforzada el 21-oct-2026): sus idiomas de
 * trabajo son inglés y castellano; una oferta escrita en cualquier otro
 * idioma NO cumple, aunque mencione el inglés de pasada. Caso real:
 * DS Smith (Tallinn) con el cuerpo íntegro en estonio y boilerplate en
 * inglés salía «cumple» porque el detector viejo solo reconocía en/es
 * y devolvía «sin evidencia» ante cualquier otra lengua.
 */
function detectOfferLanguage(offer: EvalOfferInput): string | null {
  const chunks = [offer.title, ...offer.highlights, ...fullTextChunks(offer)];
  const charsByLang = new Map<string, number>();
  let total = 0;
  for (const chunk of chunks) {
    const lang = chunkLanguage(norm(chunk));
    if (!lang) continue;
    charsByLang.set(lang, (charsByLang.get(lang) ?? 0) + chunk.length);
    total += chunk.length;
  }
  if (total < 120) return null;
  let winner: string | null = null;
  let winnerChars = 0;
  for (const [lang, chars] of charsByLang) {
    if (chars > winnerChars) {
      winnerChars = chars;
      winner = lang;
    }
  }
  if (!winner || winnerChars < 0.55 * total) return null;
  return winner;
}

/** La frase de la oferta con más señal del idioma dado (como evidencia). */
function languageEvidence(offer: EvalOfferInput, lang: string): string {
  const sources = [offer.title, ...offer.highlights, ...fullTextChunks(offer)];
  let best = '';
  let bestScore = -1;
  for (const s of sources) {
    const score = distinctiveOccurrences(norm(s), lang);
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  const clean = best.replace(/\s+/g, ' ').trim();
  return clean.length > 200 ? clean.slice(0, 200) : clean;
}

/** Alias aceptados por idioma al declarar el requisito. */
const LANGUAGE_ALIASES: Record<string, string[]> = {
  en: ['english', 'inglés', 'ingles', 'en'],
  es: ['spanish', 'español', 'espanol', 'castellano', 'es'],
  de: ['german', 'alemán', 'aleman', 'deutsch', 'de'],
  fr: ['french', 'francés', 'frances', 'français', 'fr'],
  it: ['italian', 'italiano', 'it'],
  pt: ['portuguese', 'portugués', 'portugues', 'português', 'pt'],
  nl: ['dutch', 'holandés', 'holandes', 'nederlands', 'nl'],
  et: ['estonian', 'estonio', 'eesti', 'et'],
  pl: ['polish', 'polaco', 'polski', 'pl'],
  cs: ['czech', 'checo', 'cs'],
  sk: ['slovak', 'eslovaco', 'sk'],
  hu: ['hungarian', 'húngaro', 'hungaro', 'magyar', 'hu'],
  ro: ['romanian', 'rumano', 'romana', 'ro'],
  sv: ['swedish', 'sueco', 'svenska', 'sv'],
  da: ['danish', 'danés', 'danes', 'dansk', 'da'],
  no: ['norwegian', 'noruego', 'norsk', 'no'],
  fi: ['finnish', 'finlandés', 'finlandes', 'suomi', 'fi'],
  lt: ['lithuanian', 'lituano', 'lietuviu', 'lt'],
  lv: ['latvian', 'letón', 'leton', 'latviesu', 'lv'],
  hr: ['croatian', 'croata', 'hrvatski', 'hr'],
  sl: ['slovenian', 'esloveno', 'slovenscina', 'sl'],
};

function matchLanguage(req: MandatoryRequirement, offer: EvalOfferInput, corpus: string): MandatoryDetail {
  const languages = (req.params['languages'] as string[] | undefined) ?? [];
  const base: Omit<MandatoryDetail, 'estado' | 'evidencia'> = {
    requisito_id: req.id,
    descripcion: req.description,
  };
  // 1) Idioma de REDACCIÓN: manda sobre cualquier mención de pasada.
  //    Escrita en un idioma pedido → cumple. Escrita en un TERCER
  //    idioma (ni inglés ni castellano, los de trabajo de Jon) →
  //    incumple: una oferta en estonio «menciona» el inglés en su
  //    boilerplate y aun así no es una oferta en inglés. Si está en
  //    inglés o castellano pero la campaña pide el otro, no se suspende
  //    automáticamente: se cae a la mención literal de siempre.
  const detected = detectOfferLanguage(offer);
  if (detected) {
    const requested = languages.map((l) => norm(l));
    const aliases = (LANGUAGE_ALIASES[detected] ?? [detected]).map((a) => norm(a));
    const accepted = aliases.some((a) => requested.includes(a));
    if (accepted) {
      return { ...base, estado: 'cumple', evidencia: languageEvidence(offer, detected) };
    }
    if (detected !== 'en' && detected !== 'es') {
      return { ...base, estado: 'incumple', evidencia: languageEvidence(offer, detected) };
    }
  }
  // 2) Sin detección fiable (texto corto o muy mezclado): mención literal.
  const found = includesAny(corpus, languages);
  if (found.length > 0) {
    return { ...base, estado: 'cumple', evidencia: findEvidence(offer, found) };
  }
  return { ...base, estado: 'sin_evidencia', evidencia: '' };
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

// ---------------------------------------------------------------------------
// Elegibilidad: restricción de nacionalidad (puerta dura de ingesta)
// ---------------------------------------------------------------------------

/**
 * Frases de restricción EXPLÍCITA a nacionales/locales (texto ya
 * normalizado: minúsculas y sin diacríticos). Deliberadamente estrechas:
 * solo formas que excluyen a un candidato internacional («nationals
 * only», «national position», «local hire», «ressortissants de…»,
 * «solo nacionales»…). Una mención a personal nacional SIN exclusión
 * («national and international candidates are welcome») no casa.
 */
const NATIONALITY_RESTRICTION_RES: RegExp[] = [
  /\bnationals?\s+only\b/,
  /\bnational\s+position\b/,
  /\bnational\s+staff\s+only\b/,
  /\bcitizens?\s+only\b/,
  /\blocal\s+hire\b/,
  /\blocally\s+recruited\b/,
  /\bmust\s+be\s+a\s+(?:\w+\s+){0,2}?(?:citizen|national)\s+of\b/,
  /\bmust\s+be\s+a\s+(?:\w+\s+){0,2}?(?:citizen|national)\b/,
  // Clase ALS (decisión de Jon, 2026-10-21): exigir ya la ciudadanía o
  // la residencia permanente del país —o el visado por tu cuenta—
  // también excluye: sin derecho de trabajo allí no puede aplicar.
  /\bcitizens?\s+or\s+permanent\s+residents?\b/,
  /\bmust\s+be\s+a\s+permanent\s+resident\b/,
  /\bonly\s+(?:open\s+to|for)\s+(?:\w+\s+){0,2}?(?:nationals|citizens)\b/,
  /\bposte\s+national\b/,
  /\bressortissants?\b/,
  /\bsolo\s+(?:para\s+)?(?:ciudadanos|nacionales)\b/,
  /\bnacionales\s+del\s+pais\b/,
  /\bde\s+nacionalidad\s+\w+\b[^.]{0,40}\b(?:requerida|obligatoria|exigida|excluyente)\b/,
  // Familia «derecho de trabajo ya vigente y sin patrocinio» (caso
  // real NRC Líbano, 2026-10-21): exigir ser ya elegible para trabajar
  // en el país, o negar permisos/visado, excluye igual que la
  // nacionalidad — Jon no tiene ese derecho fuera de España/UE.
  /\blegally\s+eligible\s+to\s+work\s+in\b/,
  /\beligible\s+to\s+work\s+in\s+(?!(?:a|an)\s+(?:fast|dynamic|multicultural|diverse|international|collaborative|supportive|challenging)\b)/,
  /\bmust\s+be\s+eligible\s+to\s+work\b/,
  /\bunable\s+to\s+provide\b[^.]{0,60}\b(?:work\s+permits?|visa)\b/,
  /\bunable\s+to\s+sponsor\b/,
  /\bwill\s+not\s+sponsor\b/,
  /\bcannot\s+sponsor\b/,
  /\bno\s+(?:visa\s+)?sponsorship\s+(?:is\s+)?(?:available|provided|offered)\b/,
  /\bcandidates?\s+must\s+have\s+(?:the\s+)?right\s+to\s+work\b/,
  /\bexisting\s+right\s+to\s+work\b/,
  /\bmust\s+have\s+(?:a\s+)?valid\s+(?:work\s+permit|working\s+visa)\b/,
];

/** Zona de elegibilidad de Jon (ciudadano español/UE): si la frase de la
 * restricción se refiere a España o a la UE, NO es una exclusión para él.
 * Los acrónimos se buscan en el texto ORIGINAL (en francés «eu» es el
 * participio de avoir y «ue» saldría en falso en el texto normalizado). */
const ELIGIBILITY_ZONE_RE =
  /\b(spain|espana|spanish|espanol|european|europe|europeen|europeenne|schengen|madrid|barcelona|valencia|sevilla|bilbao|zaragoza|malaga|granada|logrono|germany|france|italy|portugal|netherlands|belgium|ireland|austria|poland|romania|greece|croatia|sweden|denmark|finland|czechia|czech\s+republic|hungary|slovakia|slovenia|estonia|latvia|lithuania|bulgaria|cyprus|malta|luxembourg|alemania|francia|italia|paises\s+bajos|belgica|irlanda|austria|polonia|rumania|grecia|croacia|suecia|dinamarca|finlandia|chequia|hungria|eslovaquia|eslovenia|letonia|lituania|chipre|luxemburgo)\b/;
const ELIGIBILITY_ACRONYM_RE = /\b(EU|UE|EEA|EEE)\b/;

export interface NationalityRestriction {
  restricted: boolean;
  /** La frase que lo excluye (para auditoría y mensajes), o null. */
  phrase: string | null;
}

/**
 * ¿La oferta está restringida a nacionales de otro país (o a contratación
 * local) de forma que Jon NUNCA podría aplicar? Se busca en título,
 * extractos y texto completo; la frase se devuelve tal cual aparece en la
 * frase-oración que la contiene. Es una puerta de INGESTA (la oferta ni
 * entra en el pool), no un criterio más de la evaluación.
 */
export function detectNationalityRestriction(offer: EvalOfferInput): NationalityRestriction {
  const parts = [offer.title ?? '', ...(offer.highlights ?? []), offer.fullText ?? ''];
  for (const part of parts) {
    if (!part) continue;
    const sentences = part.split(/(?<=[.!?;])\s+|\n+/);
    for (const original of sentences) {
      const sentence = norm(original);
      for (const re of NATIONALITY_RESTRICTION_RES) {
        const m = sentence.match(re);
        if (!m) continue;
        if (ELIGIBILITY_ZONE_RE.test(sentence) || ELIGIBILITY_ACRONYM_RE.test(original)) continue;
        return { restricted: true, phrase: original.trim().slice(0, 220) };
      }
    }
  }
  return { restricted: false, phrase: null };
}
