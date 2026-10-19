/**
 * @jobforce/autonomy — Evaluador de envíos contra la política vigente.
 *
 * LÍMITE DURO: ningún envío automático hasta que Jon dé su autorización
 * escrita (politica.autorizacionEscrita != null). El evaluador lo bloquea.
 *
 * Orden de evaluación (primera condición que bloquea o exige revisión manda):
 *   1. paradaGlobal → bloqueado
 *   2. modo 'investigar' → bloqueado (no envía)
 *   3. modo 'preparar_para_revision' → siempre requiere_revision
 *   4. modo 'ejecutar_automatico' sin autorización escrita → bloqueado
 *   5. en automático: duplicado, oferta no vigente, empresa excluida, portal
 *      no permitido, límites de envíos, presupuesto, requisitos obligatorios,
 *      encaje → bloqueado o requiere_revision según la regla.
 */

import type { EvaluacionEnvio, PoliticaAutonomia } from './types.js';

/** Contexto necesario para evaluar un posible envío. */
export interface ContextoEnvio {
  /** Puntuación de encaje (0-100) o null si no se pudo calcular. */
  encaje: number | null;
  /** Veredicto de los requisitos obligatorios de la campaña. */
  obligatorios: 'cumple' | 'sin_evidencia' | 'incumple';
  /** Identificador del portal, p. ej. 'greenhouse'. */
  portal: string;
  /** Nombre de la empresa. */
  empresa: string;
  /** Envíos ya realizados hoy (UTC). */
  enviosHoy: number;
  /** Envíos ya realizados esta semana (UTC). */
  enviosSemana: number;
  /** Gasto acumulado del mes en USD (todas las fuentes). */
  gastoMesUsd: number;
  /** ¿Ya se envió una candidatura a esta oferta? */
  duplicado: boolean;
  /** ¿La oferta sigue abierta? */
  ofertaVigente: boolean;
}

function normaliza(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Evalúa si un envío está permitido, requiere revisión de Jon o está
 * bloqueado, según la política vigente.
 */
export function evaluarEnvio(politica: PoliticaAutonomia, ctx: ContextoEnvio): EvaluacionEnvio {
  const motivos: string[] = [];
  const versionPolitica = politica.version;
  const bloqueado = (motivo: string): EvaluacionEnvio => ({ decision: 'bloqueado', motivos: [...motivos, motivo], versionPolitica });

  // 1. Parada global: bloquea todo, en cualquier modo.
  if (politica.paradaGlobal) {
    return bloqueado('Parada global activa: ningún envío permitido.');
  }

  // 2. Modo investigar: no envía.
  if (politica.modoActivo === 'investigar') {
    return bloqueado('El modo "investigar" no envía (solo investiga y recopila ofertas).');
  }

  // 3. Modo preparar_para_revision: siempre requiere revisión de Jon.
  if (politica.modoActivo === 'preparar_para_revision') {
    return {
      decision: 'requiere_revision',
      motivos: ['Modo "preparar_para_revision": el envío requiere revisión y aprobación de Jon antes de enviarse.'],
      versionPolitica,
    };
  }

  // 4. Modo automático: LÍMITE DURO sin autorización escrita.
  if (politica.autorizacionEscrita === null) {
    return bloqueado('El modo automático requiere autorización escrita de Jon (autorizacionEscrita es null).');
  }

  const reglas = politica.reglas;

  // 5. Condiciones que bloquean en modo automático.
  if (ctx.duplicado) {
    return bloqueado('Ya existe una candidatura enviada para esta oferta (duplicado).');
  }
  if (!ctx.ofertaVigente) {
    return bloqueado('La oferta no está vigente (cerrada o retirada).');
  }
  const empresaNorm = normaliza(ctx.empresa);
  if (reglas.empresasExcluidas.some((e) => normaliza(e) === empresaNorm)) {
    return bloqueado(`La empresa "${ctx.empresa}" está en la lista de exclusiones.`);
  }
  const portalNorm = normaliza(ctx.portal);
  if (!reglas.portalesPermitidos.some((p) => normaliza(p) === portalNorm)) {
    return bloqueado(
      `El portal "${ctx.portal}" no está permitido (permitidos: ${reglas.portalesPermitidos.join(', ') || 'ninguno'}).`,
    );
  }
  if (ctx.enviosHoy >= reglas.maxEnviosPorDia) {
    return bloqueado(`Límite diario de envíos alcanzado (${ctx.enviosHoy}/${reglas.maxEnviosPorDia}).`);
  }
  if (ctx.enviosSemana >= reglas.maxEnviosPorSemana) {
    return bloqueado(`Límite semanal de envíos alcanzado (${ctx.enviosSemana}/${reglas.maxEnviosPorSemana}).`);
  }
  if (ctx.gastoMesUsd >= reglas.presupuestoMensualUsd) {
    return bloqueado(`Presupuesto mensual agotado (${ctx.gastoMesUsd.toFixed(2)}/${reglas.presupuestoMensualUsd} USD).`);
  }

  // 6. Requisitos obligatorios: incumple bloquea; sin_evidencia exige revisión.
  if (ctx.obligatorios === 'incumple') {
    return bloqueado('La oferta incumple requisitos obligatorios de la campaña.');
  }
  if (ctx.obligatorios === 'sin_evidencia') {
    motivos.push('Requisitos obligatorios sin evidencia suficiente: se requiere revisión.');
    return { decision: 'requiere_revision', motivos, versionPolitica };
  }

  // 7. Encaje: null o por debajo del umbral automático → según tratamientoDesconocidos.
  const encajeOk = ctx.encaje !== null && ctx.encaje >= reglas.umbralEncajeAutomatico;
  if (!encajeOk) {
    const motivo =
      ctx.encaje === null
        ? 'Encaje desconocido (sin puntuación calculada).'
        : `Encaje ${ctx.encaje} por debajo del umbral automático (${reglas.umbralEncajeAutomatico}).`;
    if (reglas.tratamientoDesconocidos === 'descartar') {
      return bloqueado(`${motivo} La política descarta los casos desconocidos.`);
    }
    return {
      decision: 'requiere_revision',
      motivos: [`${motivo} La política envía estos casos a revisión.`],
      versionPolitica,
    };
  }

  // 8. Todo en regla.
  return {
    decision: 'permitido',
    motivos: [
      `Modo automático autorizado por ${politica.autorizacionEscrita.autorizadoPor}; encaje ${ctx.encaje} ≥ ${reglas.umbralEncajeAutomatico}; límites y presupuesto dentro de margen.`,
    ],
    versionPolitica,
  };
}
