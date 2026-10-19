/**
 * @jobforce/autonomy — Política por defecto y validación (zod).
 *
 * DEFAULT_POLICY_DRAFT es el borrador inicial (versión 1) que Jon debe
 * revisar y autorizar por escrito antes de activar el modo automático.
 * Sin esa autorización, el evaluador bloquea cualquier envío automático
 * (ver evaluate.ts).
 */

import { z } from 'zod';
import type { PoliticaAutonomia, ReglasAutonomia } from './types.js';

// ---------------------------------------------------------------------------
// Esquemas zod (zod 4.x). La validación es manual-tipad… no: usamos zod porque
// está disponible en el monorepo (apps/backend depende de zod 4.6.7).
// ---------------------------------------------------------------------------

const ModoAutonomiaSchema = z.enum(['investigar', 'preparar_para_revision', 'ejecutar_automatico']);

const TratamientoDesconocidosSchema = z.enum(['revision', 'descartar']);

const ReglasAutonomiaSchema = z.object({
  portalesPermitidos: z.array(z.string().min(1)),
  empresasExcluidas: z.array(z.string().min(1)),
  umbralEncajeRevision: z.number().min(0).max(100),
  umbralEncajeAutomatico: z.number().min(0).max(100),
  maxEnviosPorDia: z.number().int().min(0),
  maxEnviosPorSemana: z.number().int().min(0),
  presupuestoMensualUsd: z.number().min(0),
  presupuestoExaMensualUsd: z.number().min(0),
  tratamientoDesconocidos: TratamientoDesconocidosSchema,
  crearCuentasPortales: z.boolean(),
});

const AutorizacionEscritaSchema = z.object({
  autorizadoPor: z.string().min(1),
  autorizadoEn: z.string().min(1),
  declaracion: z.string().min(1),
});

export const PoliticaAutonomiaSchema = z.object({
  version: z.number().int().min(1),
  modoActivo: ModoAutonomiaSchema,
  autorizacionEscrita: AutorizacionEscritaSchema.nullable(),
  paradaGlobal: z.boolean(),
  reglas: ReglasAutonomiaSchema,
});

/** Valida una política desconocida (p. ej. leída de la base de datos). Lanza si es inválida. */
export function parsePolitica(data: unknown): PoliticaAutonomia {
  return PoliticaAutonomiaSchema.parse(data);
}

/** Valida sin lanzar: devuelve ok:false con los mensajes de error en español. */
export function validarPolitica(data: unknown): { ok: true; politica: PoliticaAutonomia } | { ok: false; errores: string[] } {
  const res = PoliticaAutonomiaSchema.safeParse(data);
  if (res.success) return { ok: true, politica: res.data };
  return {
    ok: false,
    errores: res.error.issues.map((i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`),
  };
}

// ---------------------------------------------------------------------------
// Borrador inicial (versión 1)
// ---------------------------------------------------------------------------

/** Reglas por defecto del borrador. */
export const DEFAULT_REGLAS: ReglasAutonomia = {
  // Solo los portales con conector validado en Fase 3 (Greenhouse, Lever,
  // Personio). Los demás (ashby, smartrecruiters, workday…) se añaden cuando
  // su conector esté validado.
  portalesPermitidos: ['greenhouse', 'lever', 'personio'],
  empresasExcluidas: [],
  umbralEncajeRevision: 70,
  umbralEncajeAutomatico: 75,
  maxEnviosPorDia: 5,
  maxEnviosPorSemana: 20,
  presupuestoMensualUsd: 50,
  presupuestoExaMensualUsd: 3,
  tratamientoDesconocidos: 'revision',
  crearCuentasPortales: false,
};

/**
 * Borrador inicial de la política de autonomía (versión 1).
 *
 * Modo por defecto: 'preparar_para_revision' (prepara todo, envía nada).
 * Sin autorizacionEscrita: el modo automático queda bloqueado por el
 * evaluador aunque alguien lo active.
 */
export const DEFAULT_POLICY_DRAFT: PoliticaAutonomia = {
  version: 1,
  modoActivo: 'preparar_para_revision',
  autorizacionEscrita: null,
  paradaGlobal: false,
  reglas: { ...DEFAULT_REGLAS },
};
