/**
 * @jobforce/autonomy — Contrato de tipos del motor de política de autonomía.
 *
 * Este contrato lo usan el Worker 1 (motor) y el Worker 2 (persistencia).
 * No se puede cambiar sin coordinar ambos trabajadores.
 */

/** Modos de autonomía de JOBFORCE. */
export type ModoAutonomia = 'investigar' | 'preparar_para_revision' | 'ejecutar_automatico';

/** Reglas numéricas y de alcance que gobiernan los envíos. */
export interface ReglasAutonomia {
  /** Identificadores de portal permitidos, p. ej. 'greenhouse', 'lever', 'ashby',
   *  'personio', 'smartrecruiters', 'workday'. */
  portalesPermitidos: string[];
  /** Nombres de empresa excluidos (comparación insensible a mayúsculas). */
  empresasExcluidas: string[];
  /** default 70 */
  umbralEncajeRevision: number;
  /** default 75 */
  umbralEncajeAutomatico: number;
  /** default 5 */
  maxEnviosPorDia: number;
  /** default 20 */
  maxEnviosPorSemana: number;
  /** default 50 */
  presupuestoMensualUsd: number;
  /** default 3 (dentro de los 10 $/trimestre de Exa) */
  presupuestoExaMensualUsd: number;
  /** Cómo tratar ofertas con encaje desconocido; default 'revision' */
  tratamientoDesconocidos: 'revision' | 'descartar';
  /** default false */
  crearCuentasPortales: boolean;
}

/** Política de autonomía vigente. */
export interface PoliticaAutonomia {
  version: number;
  /** default 'preparar_para_revision' */
  modoActivo: ModoAutonomia;
  /**
   * Autorización escrita de Jon para el modo automático.
   * null = no autorizada (LÍMITE DURO: sin esto no hay envíos automáticos).
   */
  autorizacionEscrita: {
    autorizadoPor: string;
    /** ISO 8601, p. ej. '2026-10-19T13:44:00+02:00' */
    autorizadoEn: string;
    declaracion: string;
  } | null;
  /** default false; true bloquea todo envío */
  paradaGlobal: boolean;
  reglas: ReglasAutonomia;
}

/** Posibles decisiones del evaluador de envío. */
export type DecisionEnvio = 'permitido' | 'requiere_revision' | 'bloqueado';

/** Resultado de evaluar un posible envío contra la política vigente. */
export interface EvaluacionEnvio {
  decision: DecisionEnvio;
  /** Motivos en español, en orden de evaluación. */
  motivos: string[];
  versionPolitica: number;
}
