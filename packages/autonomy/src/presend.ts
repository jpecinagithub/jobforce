/**
 * @jobforce/autonomy — Checklist pre-envío (9 checks).
 *
 * Se ejecuta justo antes de pulsar "enviar", incluso en modo automático.
 * Los checks que requieren E/S real (re-verificar la oferta, consultar el
 * presupuesto, comprobar duplicados) reciben las funciones de lectura
 * INYECTADAS en el contexto: nada ficticio. Si un check no tiene su probe
 * configurada, devuelve ok:false con el detalle "sin probe configurado".
 */

import type { PoliticaAutonomia } from './types.js';

/** Contexto del checklist pre-envío. */
export interface PresendCtx {
  politica: PoliticaAutonomia;
  /** Identificador del portal, p. ej. 'greenhouse'. */
  portal: string;
  /** Nombre de la empresa. */
  empresa: string;
  /** ¿Están completos los datos obligatorios del formulario? */
  datosObligatoriosCompletos: boolean;
  /** ¿CV y carta generados y validados (38/38 checks de @jobforce/docs)? */
  documentosValidos: boolean;
  /** Probe: re-verifica que la oferta sigue abierta. */
  verificarOfertaVigente?: () => Promise<boolean>;
  /** Probe: gasto acumulado del mes en USD. */
  obtenerGastoMesUsd?: () => Promise<number>;
  /** Probe: ¿ya existe una candidatura enviada para esta oferta? */
  esDuplicado?: () => Promise<boolean>;
}

/** Resultado individual de un check. */
export interface ResultadoCheck {
  id: string;
  etiqueta: string;
  ok: boolean;
  detalle: string;
}

/** Un check del checklist pre-envío. */
export interface CheckPresend {
  id: string;
  etiqueta: string;
  ejecutar(ctx: PresendCtx): Promise<{ ok: boolean; detalle: string }>;
}

function normaliza(s: string): string {
  return s.trim().toLowerCase();
}

/** Los 9 checks del plan, en orden de ejecución. */
export const CHECKS_PRE_ENVIO: CheckPresend[] = [
  {
    id: 'modo_activo',
    etiqueta: 'Modo activo permite envíos',
    async ejecutar(ctx) {
      if (ctx.politica.paradaGlobal) return { ok: false, detalle: 'Parada global activa.' };
      if (ctx.politica.modoActivo === 'investigar')
        return { ok: false, detalle: 'El modo "investigar" no envía.' };
      return { ok: true, detalle: `Modo "${ctx.politica.modoActivo}" permite preparar/enviar.` };
    },
  },
  {
    id: 'oferta_vigente',
    etiqueta: 'Oferta vigente (re-verificada)',
    async ejecutar(ctx) {
      if (!ctx.verificarOfertaVigente)
        return { ok: false, detalle: 'Sin probe configurado: no se puede re-verificar la oferta.' };
      const vigente = await ctx.verificarOfertaVigente();
      return vigente
        ? { ok: true, detalle: 'La oferta sigue abierta (verificación justo antes del envío).' }
        : { ok: false, detalle: 'La oferta ya no está vigente.' };
    },
  },
  {
    id: 'exclusiones',
    etiqueta: 'Empresa no excluida',
    async ejecutar(ctx) {
      const empresaNorm = normaliza(ctx.empresa);
      const excluida = ctx.politica.reglas.empresasExcluidas.some((e) => normaliza(e) === empresaNorm);
      return excluida
        ? { ok: false, detalle: `La empresa "${ctx.empresa}" está en la lista de exclusiones.` }
        : { ok: true, detalle: `La empresa "${ctx.empresa}" no está excluida.` };
    },
  },
  {
    id: 'datos_obligatorios',
    etiqueta: 'Datos obligatorios del formulario completos',
    async ejecutar(ctx) {
      return ctx.datosObligatoriosCompletos
        ? { ok: true, detalle: 'Todos los campos obligatorios del formulario tienen valor.' }
        : { ok: false, detalle: 'Faltan datos obligatorios del formulario (p. ej. salario esperado o disponibilidad).' };
    },
  },
  {
    id: 'documentos_validos',
    etiqueta: 'Documentos válidos (CV + carta)',
    async ejecutar(ctx) {
      return ctx.documentosValidos
        ? { ok: true, detalle: 'CV y carta generados y validados (38/38 checks de @jobforce/docs).' }
        : { ok: false, detalle: 'CV o carta sin generar o sin validar.' };
    },
  },
  {
    id: 'portal_compatible',
    etiqueta: 'Portal permitido por la política',
    async ejecutar(ctx) {
      const portalNorm = normaliza(ctx.portal);
      const permitido = ctx.politica.reglas.portalesPermitidos.some((p) => normaliza(p) === portalNorm);
      return permitido
        ? { ok: true, detalle: `Portal "${ctx.portal}" permitido por la política.` }
        : {
            ok: false,
            detalle: `Portal "${ctx.portal}" no permitido (permitidos: ${ctx.politica.reglas.portalesPermitidos.join(', ') || 'ninguno'}).`,
          };
    },
  },
  {
    id: 'presupuesto',
    etiqueta: 'Presupuesto mensual con margen',
    async ejecutar(ctx) {
      if (!ctx.obtenerGastoMesUsd)
        return { ok: false, detalle: 'Sin probe configurado: no se puede consultar el gasto del mes.' };
      const gasto = await ctx.obtenerGastoMesUsd();
      const limite = ctx.politica.reglas.presupuestoMensualUsd;
      return gasto < limite
        ? { ok: true, detalle: `Gasto del mes ${gasto.toFixed(2)} USD < ${limite} USD.` }
        : { ok: false, detalle: `Presupuesto mensual agotado (${gasto.toFixed(2)}/${limite} USD).` };
    },
  },
  {
    id: 'duplicados',
    etiqueta: 'Sin candidatura duplicada',
    async ejecutar(ctx) {
      if (!ctx.esDuplicado)
        return { ok: false, detalle: 'Sin probe configurado: no se puede comprobar duplicados.' };
      const duplicado = await ctx.esDuplicado();
      return duplicado
        ? { ok: false, detalle: 'Ya existe una candidatura enviada para esta oferta.' }
        : { ok: true, detalle: 'No hay candidaturas previas para esta oferta.' };
    },
  },
  {
    id: 'autorizacion_vigente',
    etiqueta: 'Autorización vigente para el modo activo',
    async ejecutar(ctx) {
      const { modoActivo, autorizacionEscrita } = ctx.politica;
      if (modoActivo === 'investigar')
        return { ok: false, detalle: 'El modo "investigar" no autoriza envíos.' };
      if (modoActivo === 'ejecutar_automatico' && autorizacionEscrita === null)
        return { ok: false, detalle: 'El modo automático requiere autorización escrita de Jon.' };
      if (modoActivo === 'preparar_para_revision')
        return {
          ok: true,
          detalle: 'Modo con revisión: la autorización la da Jon al aprobar el envío preparado.',
        };
      return {
        ok: true,
        detalle: `Autorización escrita de ${autorizacionEscrita?.autorizadoPor} (${autorizacionEscrita?.autorizadoEn}).`,
      };
    },
  },
];

/** Ejecuta los 9 checks en orden y devuelve sus resultados. */
export async function ejecutarChecks(ctx: PresendCtx): Promise<ResultadoCheck[]> {
  const resultados: ResultadoCheck[] = [];
  for (const check of CHECKS_PRE_ENVIO) {
    const { ok, detalle } = await check.ejecutar(ctx);
    resultados.push({ id: check.id, etiqueta: check.etiqueta, ok, detalle });
  }
  return resultados;
}

/** true si todos los checks pasaron. */
export function checksOk(resultados: ResultadoCheck[]): boolean {
  return resultados.every((r) => r.ok);
}
