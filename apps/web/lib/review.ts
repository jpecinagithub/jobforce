/**
 * Contrato del frontal de revisión manual (Fase 6.1) con el backend.
 *
 * La cola lista candidaturas en `ready_for_review` con su resumen de encaje;
 * aprobar/rechazar cambian el estado en un toque (sesión + cabecera CSRF).
 */
import { PREFERENCE_LABELS, VERDICT_LABELS, verdictBadgeClass } from './campaigns';
import type { MandatoryState } from './campaigns';

/** Una dimensión del breakdown en el resumen de encaje (top 3 por peso). */
export interface TopDimension {
  dimension: string;
  peso: number;
  puntos: number;
  explicacion: string;
  /** Nº de hechos del perfil referenciados por esta dimensión. */
  hechos: number;
}

/** GET /api/review/queue — una tarjeta de la cola. */
export interface ReviewQueueItem {
  id: string;
  portal: string | null;
  offer: {
    id: string;
    title: string | null;
    company: string | null;
    url: string;
  };
  score: number | null;
  mandatoryVerdict: MandatoryState;
  resumenEncaje: {
    topDimensiones: TopDimension[];
    hechosVerificados: number;
  };
  createdAt: string;
}

export interface ReviewQueueResponse {
  queue: ReviewQueueItem[];
}

export interface BatchItemResult {
  id: string;
  ok: boolean;
  error?: string;
  status?: string;
}

export interface BatchResponse {
  ok: boolean;
  items: BatchItemResult[];
}

/** Etiqueta legible de una dimensión del breakdown. */
export function dimensionLabel(dimension: string): string {
  return (PREFERENCE_LABELS as Record<string, string>)[dimension] ?? dimension;
}

export { VERDICT_LABELS, verdictBadgeClass };

/** Clase de badge según la puntuación de encaje. */
export function scoreBadgeClass(score: number | null): string {
  if (score === null || score < 70) return 'badge danger';
  if (score >= 75) return 'badge active';
  return 'badge pending';
}
