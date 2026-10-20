/**
 * Tipos y helpers compartidos del front de campañas (Fase 2).
 *
 * Programados ESTRICTAMENTE contra el §6 de `fase2/CONTRATO_API.md`.
 * Nada de lo definido aquí inventa endpoints ni campos: son las formas
 * de respuesta del contrato.
 */
import type {
  MandatoryKind,
  MandatoryState,
  PreferenceKey,
} from '@jobforce/domain';

export type { MandatoryKind, MandatoryState, PreferenceKey };

/** Orden de las 6 dimensiones de preferencia (el del plan de Fase 2). */
export const PREFERENCE_ORDER: PreferenceKey[] = [
  'funciones',
  'competencias',
  'seniority',
  'ubicacion',
  'condiciones',
  'empresa',
];

export const PREFERENCE_LABELS: Record<PreferenceKey, string> = {
  funciones: 'Funciones',
  competencias: 'Competencias',
  seniority: 'Seniority',
  ubicacion: 'Ubicación',
  condiciones: 'Condiciones',
  empresa: 'Empresa',
};

export const MANDATORY_KINDS: MandatoryKind[] = [
  'role',
  'language',
  'location',
  'seniority',
  'keyword',
];

export const MANDATORY_KIND_LABELS: Record<MandatoryKind, string> = {
  role: 'Rol',
  language: 'Idioma',
  location: 'Ubicación',
  seniority: 'Nivel',
  keyword: 'Palabra clave',
};

export const VERDICT_LABELS: Record<MandatoryState, string> = {
  cumple: 'Cumple',
  incumple: 'Incumple',
  sin_evidencia: 'Sin evidencia',
};

export function verdictBadgeClass(v: MandatoryState): string {
  if (v === 'cumple') return 'badge active';
  if (v === 'incumple') return 'badge danger';
  return 'badge pending';
}

export type CampaignStatus = 'draft' | 'active' | 'archived';

export const STATUS_LABELS: Record<CampaignStatus, string> = {
  draft: 'Borrador',
  active: 'Activa',
  archived: 'Archivada',
};

export function statusBadgeClass(s: CampaignStatus): string {
  if (s === 'active') return 'badge active';
  if (s === 'archived') return 'badge pending';
  return 'badge';
}

/**
 * Acepta number o string: las columnas numeric(10,4) de Postgres pueden
 * llegar serializadas como string.
 */
export function toNumber(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

export function fmtUsd(v: number | string | null | undefined, decimals = 2): string {
  const n = toNumber(v);
  return n === null ? '—' : `${n.toFixed(decimals)} USD`;
}

/** Puntuación de una dimensión (contrato §4). */
export interface DimensionScore {
  dimension: PreferenceKey;
  peso: number;
  puntos: number; // 0..100
  explicacion: string;
  hechos: string[]; // "category.key" del perfil referenciados
}

/** Detalle de un requisito obligatorio evaluado (contrato §4). */
export interface MandatoryDetail {
  requisito_id: string;
  descripcion: string;
  estado: MandatoryState;
  evidencia: string; // cita textual o "" si sin_evidencia
}

/** Evaluación de una oferta (contrato §4). */
export interface EvaluationResult {
  mandatory_verdict: MandatoryState;
  mandatory_details: MandatoryDetail[];
  score: number | null; // null si mandatory_verdict != 'cumple'
  breakdown: DimensionScore[]; // 6 dimensiones
}

/** Fila de oferta de GET /api/campaigns/:id/offers (contrato §6). */
export interface OfferSummary {
  id: string;
  title: string | null;
  company: string | null;
  url: string;
  /** null = sin comprobar; true = viva; false = rota. */
  url_ok: boolean | null;
  /** Email de aplicación si el anuncio lo trae (canal de envío por correo). */
  application_email?: string | null;
  /** Candidatura enlazada (Fase 7), si ya se preparó una para esta oferta. */
  application: {
    id: string;
    status: string;
    /** Documentos descargables (versión más alta por tipo/formato). */
    documents?: Array<{ id: string; kind: string; format: string; version: number }>;
  } | null;
  canonical_url: string;
  published_date: string | null;
  retrieved_at: string;
  evaluation: {
    mandatory_verdict: MandatoryState;
    score: number | null;
    breakdown: DimensionScore[];
  } | null;
}

/** Etiquetas legibles del estado de una candidatura (Fase 7). */
export const APPLICATION_STATUS_LABELS: Record<string, string> = {
  draft: 'Borrador',
  documents_ready: 'Documentos listos',
  form_prepared: 'Formulario preparado',
  ready_for_review: 'En revisión',
  approved: 'Aprobada',
  submitting: 'Enviando…',
  submitted: 'Enviada',
  submission_failed: 'Envío fallido',
  withdrawn: 'Retirada',
};

/** Clase de badge según el estado de la candidatura. */
export function applicationBadgeClass(status: string): string {
  if (status === 'submitted') return 'badge active';
  if (status === 'submission_failed') return 'badge danger';
  if (status === 'approved' || status === 'ready_for_review' || status === 'submitting') {
    return 'badge pending';
  }
  return 'badge';
}

/** Oferta completa de GET /api/campaigns/:id/offers/:offerId (contrato §6). */
export interface OfferDetail extends OfferSummary {
  highlights: string[];
}

/** Resumen de POST /api/campaigns/:id/search (contrato §6). */
export interface SearchSummary {
  searches: {
    id: string;
    query: string;
    results_count: number;
    duplicates_count: number;
    cost_usd: number | string;
  }[];
  total_cost_usd: number | string;
}

/** Informe de GET /api/campaigns/:id/report (contrato §6).
 * Nota: el contrato deja `campana` ambiguo; el backend la devuelve como
 * objeto { id, nombre, estado }. Se aceptan ambas formas. */
export interface CampaignReport {
  campana: string | { id: string; nombre: string; estado: string };
  generado_en: string;
  busquedas: {
    query: string;
    estado: string;
    resultados: number;
    duplicados: number;
    coste_usd: number | string;
    error?: string;
  }[];
  fuentes_intentadas: string[];
  fuentes_inaccesibles: string[];
  vacantes_leidas: number;
  duplicados_descartados: number;
  ofertas: {
    titulo: string;
    empresa: string;
    url: string;
    veredicto: string;
    puntuacion: number | string | null;
  }[];
  descartes: { titulo: string; motivo: string; evidencia: string }[];
  nuevas_coincidencias: number;
  gasto_total_usd: number | string;
  presupuesto_usd: number | string;
}

/** Cuerpo de error del backend en la búsqueda (contrato §6). */
export interface SearchErrorBody {
  error?: string;
  gastado?: number | string;
  limite?: number | string;
}

/** Traduce los códigos de error del contrato a mensajes legibles. */
export function mensajeErrorBusqueda(body: SearchErrorBody): string {
  switch (body.error) {
    case 'presupuesto_exa_agotado':
      return (
        'Presupuesto de Exa agotado: ya se han gastado ' +
        `${body.gastado ?? '?'} USD de un límite de ${body.limite ?? '?'} USD. ` +
        'Sube el límite de la campaña o archívala; la búsqueda no se ha lanzado.'
      );
    case 'exa_no_configurado':
      return (
        'Exa no está configurado en el backend (falta la variable EXA_API_KEY). ' +
        'La búsqueda no se ha lanzado.'
      );
    default:
      return body.error ? `Error en la búsqueda: ${body.error}.` : 'Error desconocido en la búsqueda.';
  }
}

/** Extrae un mensaje de error legible de una respuesta HTTP del backend. */
export async function parseApiError(res: Response): Promise<string> {
  let detail = '';
  try {
    const body = (await res.json()) as { error?: string };
    if (body?.error) detail = `: ${body.error}`;
  } catch {
    /* el cuerpo no es JSON; se usa el mensaje genérico */
  }
  return `El backend respondió ${res.status}${detail}.`;
}
