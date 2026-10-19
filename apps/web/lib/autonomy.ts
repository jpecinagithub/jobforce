/**
 * Contrato del frontal de autonomía (fase 4) con el backend.
 *
 * Programa contra el contrato del Worker 2; el backend puede aún no
 * exponerlo: los componentes manejan el 404 mostrando un aviso claro en
 * vez de inventar datos.
 */

/** Modos de autonomía del motor (mismo contrato que el motor). */
export type ModoAutonomia = 'investigar' | 'preparar_para_revision' | 'ejecutar_automatico';

/** Reglas de la política (mismo contrato que el motor). */
export interface ReglasAutonomia {
  portalesPermitidos: string[];
  empresasExcluidas: string[];
  umbralEncajeRevision: number;
  umbralEncajeAutomatico: number;
  maxEnviosPorDia: number;
  maxEnviosPorSemana: number;
  presupuestoMensualUsd: number;
  presupuestoExaMensualUsd: number;
  tratamientoDesconocidos: 'revision' | 'descartar';
  crearCuentasPortales: boolean;
}

/** GET /api/autonomy/status */
export interface AutonomyStatus {
  modo: ModoAutonomia | null;
  paradaGlobal: boolean;
  autorizada: boolean;
  versionPolitica: number | null;
  enviosHoy: number;
  gastoMesUsd: number;
}

/** Autorización escrita vigente (si la hay). */
export interface AutorizacionEscrita {
  autorizadoPor: string;
  fecha: string;
  declaracion: string;
}

/** GET /api/autonomy/policy */
export interface PolicyResponse {
  version: number;
  modoActivo: ModoAutonomia;
  autorizacionEscrita: AutorizacionEscrita | null;
  paradaGlobal: boolean;
  reglas: ReglasAutonomia;
  /** Puede existir si la última versión guardada es un borrador pendiente de autorizar. */
  esBorrador?: boolean;
}

/**
 * Fila de política tal como la devuelve de verdad GET /api/autonomy/policy:
 * `{ borrador, activa }`, donde cada una es la fila de `autonomy_policies`
 * (con la política completa en `policy` como JSONB).
 */
export interface BackendPolicyRow {
  id: string;
  version: number;
  policy: {
    modoActivo: ModoAutonomia;
    reglas: ReglasAutonomia;
    paradaGlobal?: boolean;
    autorizacionEscrita?: {
      autorizadoPor: string;
      autorizadoEn: string;
      declaracion: string;
    } | null;
  };
  created_at: string;
  created_by: string | null;
  authorized_by: string | null;
  authorized_at: string | null;
  revoked_at: string | null;
  global_stop: boolean;
  notes: string | null;
}

export interface PolicyEnvelope {
  borrador: BackendPolicyRow | null;
  activa: BackendPolicyRow | null;
}

/**
 * Adapta la respuesta real del backend (`{ borrador, activa }`) al
 * `PolicyResponse` que consume el frontal. El borrador manda sobre la activa
 * para precargar el editor; si no hay ninguna, devuelve null.
 */
export function toPolicyResponse(data: PolicyEnvelope | null | undefined): PolicyResponse | null {
  const src = data?.borrador ?? data?.activa ?? null;
  if (!src || !src.policy) return null;
  const p = src.policy;
  return {
    version: src.version,
    modoActivo: p.modoActivo,
    reglas: p.reglas,
    paradaGlobal: src.global_stop ?? p.paradaGlobal ?? false,
    autorizacionEscrita: src.authorized_by
      ? {
          autorizadoPor: src.authorized_by,
          fecha: src.authorized_at ?? '',
          declaracion: p.autorizacionEscrita?.declaracion ?? '',
        }
      : null,
    esBorrador: data?.borrador != null,
  };
}

/** GET /api/interventions */
export type InterventionKind =
  | 'datos_desconocidos'
  | 'pregunta_ambigua'
  | 'captcha_mfa'
  | 'fuera_de_politica'
  | 'envio_incierto'
  | 'error_tecnico';

export type InterventionStatus = 'abierta' | 'resuelta' | 'descartada';

export interface Intervention {
  id: string;
  kind: InterventionKind | string;
  applicationId: string | null;
  context: unknown;
  status: InterventionStatus | string;
  createdAt: string;
}

export const MODE_LABELS: Record<ModoAutonomia, string> = {
  investigar: 'Investigar',
  preparar_para_revision: 'Preparar para revisión',
  ejecutar_automatico: 'Ejecutar automático',
};

export const MODE_DESCRIPTIONS: Record<ModoAutonomia, string> = {
  investigar:
    'Solo busca y evalúa ofertas. No rellena formularios ni envía nada. Es el modo más seguro.',
  preparar_para_revision:
    'Busca, evalúa y prepara candidaturas completas (CV y carta adaptados, formulario rellenado) ' +
    'pero NUNCA envía sin tu aprobación explícita. Es el modo por defecto.',
  ejecutar_automatico:
    'Envía candidaturas automáticamente dentro de los límites de la política. ' +
    'Requiere la autorización escrita de abajo; sin ella queda bloqueado.',
};

export const KIND_LABELS: Record<string, string> = {
  datos_desconocidos: 'Datos desconocidos',
  pregunta_ambigua: 'Pregunta ambigua',
  captcha_mfa: 'CAPTCHA / MFA',
  fuera_de_politica: 'Fuera de política',
  envio_incierto: 'Envío incierto',
  error_tecnico: 'Error técnico',
};

export const INTERVENTION_STATUS_LABELS: Record<string, string> = {
  abierta: 'Abierta',
  resuelta: 'Resuelta',
  descartada: 'Descartada',
};

/** Borrador por defecto: el modo más conservador, sin envío automático. */
export function defaultReglas(): ReglasAutonomia {
  return {
    portalesPermitidos: ['personio.com', 'workable.com', 'ashbyhq.com'],
    empresasExcluidas: [],
    umbralEncajeRevision: 70,
    umbralEncajeAutomatico: 75,
    maxEnviosPorDia: 5,
    maxEnviosPorSemana: 20,
    presupuestoMensualUsd: 10,
    presupuestoExaMensualUsd: 10,
    tratamientoDesconocidos: 'revision',
    crearCuentasPortales: false,
  };
}

export async function parseApiError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; message?: string };
    return body.error ?? body.message ?? `El backend respondió ${res.status}`;
  } catch {
    return `El backend respondió ${res.status}`;
  }
}
