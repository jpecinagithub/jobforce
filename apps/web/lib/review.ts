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

/** Documento descargable de la candidatura (versión más alta por tipo). */
export interface DocumentSummary {
  id: string;
  kind: string;
  format: string;
  version: number;
}

/** GET /api/review/queue — una tarjeta de la cola. */
export interface ReviewQueueItem {
  id: string;
  portal: string | null;
  documents: DocumentSummary[];
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
  /** Resultado del encadenado aprobación → envío (Fase 7), solo al aprobar. */
  send?: SendChainResult;
}

/** Resultado del encadenado aprobación → envío devuelto por approve (Fase 7). */
export interface SendChainResult {
  send: 'encolado' | 'bloqueado';
  motivo?: string;
}

/** Respuesta de POST /api/applications/:id/approve (Fase 7: con encadenado). */
export interface ApproveResponse {
  ok: boolean;
  application: { id: string; status: string };
  send?: SendChainResult;
}

export interface BatchResponse {
  ok: boolean;
  items: BatchItemResult[];
}

/** Una fila del histórico de candidaturas (GET /api/applications/history). */
export interface HistoryItem {
  id: string;
  status: string;
  portal: string | null;
  /** Canal de envío: 'email', 'portal' o el portal concreto; null si aún no aplica. */
  channel: string | null;
  /** Buzón de destino cuando el envío fue por email. */
  submittedTo: string | null;
  /** Fecha de aplicación (ISO) si ya se envió; null en caso contrario. */
  submittedAt: string | null;
  createdAt: string;
  campaign: string;
  offer: { id: string; title: string | null; company: string | null; url: string };
  score: number | null;
  documents: DocumentSummary[];
}

export interface HistoryResponse {
  history: HistoryItem[];
}

export const APPLICATION_STATUS_LABELS: Record<string, string> = {
  submitted: 'Enviada',
  approved: 'Aprobada',
  ready_for_review: 'En revisión',
  withdrawn: 'Retirada',
  sending: 'Enviando…',
  submission_failed: 'Envío fallido',
};

export function channelLabel(channel: string | null): string {
  if (!channel) return '—';
  const map: Record<string, string> = {
    email: 'Email',
    portal: 'Portal',
    greenhouse: 'Greenhouse',
    lever: 'Lever',
    personio: 'Personio',
    workday: 'Workday',
    otro: 'Portal',
  };
  return map[channel] ?? channel;
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
