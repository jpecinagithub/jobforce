/**
 * Tests unitarios de la promoción por orden directa en decidirEnvio:
 * la orden expresa de Jon en el chat del Agente (sellada como
 * `ordenDirecta` en el offer_snapshot) convierte un «requiere_revision»
 * blando en «permitido» SOLO si la candidatura está aprobada. Los
 * bloqueos duros (checks fallidos, incumple, portal no permitido…)
 * no se ven afectados.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { PoliticaAutonomia } from '@jobforce/domain';
import { decidirEnvio, type ApplicationRow } from '../src/routes/sends.js';

const politica: PoliticaAutonomia = {
  version: 4,
  modoActivo: 'ejecutar_automatico',
  autorizacionEscrita: {
    autorizadoPor: 'Jon Peciña Iturbe',
    autorizadoEn: '2026-10-21T00:00:00.000Z',
    declaracion: 'Autorizo los envíos automáticos según la política.',
  },
  paradaGlobal: false,
  reglas: {
    portalesPermitidos: ['personio', 'icims'],
    empresasExcluidas: [],
    umbralEncajeRevision: 70,
    umbralEncajeAutomatico: 75,
    maxEnviosPorDia: 5,
    maxEnviosPorSemana: 20,
    presupuestoMensualUsd: 50,
    presupuestoExaMensualUsd: 3,
    tratamientoDesconocidos: 'revision',
    crearCuentasPortales: true,
  },
};

function appCon(overrides: Partial<ApplicationRow>): ApplicationRow {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    campaign_id: '00000000-0000-0000-0000-000000000002',
    offer_id: '00000000-0000-0000-0000-000000000003',
    status: 'approved',
    portal: 'icims',
    offer_url: 'https://careers.sightsavers.org/jobs/1669',
    offer_company: 'Sightsavers',
    score: null,
    mandatory_verdict: 'sin_evidencia',
    offer_snapshot: { ordenDirecta: true },
    ...overrides,
  };
}

const checksOk = [
  { check: 'sin_duplicados', ok: true, detalle: 'sin duplicados' },
  { check: 'oferta_vigente', ok: true, detalle: 'vigente' },
] as Parameters<typeof decidirEnvio>[2];

const metricas = { enviosHoy: 0, enviosSemana: 0, gastoMesUsd: 0 };

describe('decidirEnvio — orden directa de Jon', () => {
  it('sin_evidencia + aprobada + ordenDirecta → permitido', () => {
    const r = decidirEnvio(appCon({}), politica, checksOk, metricas);
    assert.equal(r.decision, 'permitido');
    assert.ok(r.motivos.some((m) => m.includes('orden_directa_de_jon')));
  });

  it('sin el sello de orden directa → requiere_revision (como siempre)', () => {
    const r = decidirEnvio(appCon({ offer_snapshot: {} }), politica, checksOk, metricas);
    assert.equal(r.decision, 'requiere_revision');
  });

  it('con orden directa pero SIN aprobar → requiere_revision', () => {
    const r = decidirEnvio(appCon({ status: 'ready_for_review' }), politica, checksOk, metricas);
    assert.equal(r.decision, 'requiere_revision');
  });

  it('los bloqueos duros mandan: incumple sigue bloqueado con orden directa', () => {
    const r = decidirEnvio(
      appCon({ mandatory_verdict: 'incumple', score: '80' }),
      politica,
      checksOk,
      metricas,
    );
    assert.equal(r.decision, 'bloqueado');
  });

  it('los bloqueos duros mandan: un check fallido bloquea con orden directa', () => {
    const checks = [
      { check: 'sin_duplicados', ok: true, detalle: 'ok' },
      { check: 'oferta_vigente', ok: false, detalle: 'la oferta ya no está vigente' },
    ] as Parameters<typeof decidirEnvio>[2];
    const r = decidirEnvio(appCon({}), politica, checks, metricas);
    assert.equal(r.decision, 'bloqueado');
  });

  it('portal no permitido sigue bloqueado con orden directa', () => {
    const r = decidirEnvio(appCon({ portal: 'workday' }), politica, checksOk, metricas);
    assert.equal(r.decision, 'bloqueado');
  });
});
