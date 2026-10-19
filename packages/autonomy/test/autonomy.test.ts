/**
 * Tests unitarios de @jobforce/autonomy (sin red, sin estado externo).
 * Patrón: node --test sobre la salida de tsconfig.test.json.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHECKS_PRE_ENVIO,
  DEFAULT_POLICY_DRAFT,
  checksOk,
  congelarPolitica,
  ejecutarChecks,
  evaluarEnvio,
  parsePolitica,
  validarPolitica,
  versionarEnvio,
  type ContextoEnvio,
  type PoliticaAutonomia,
} from '../src/index.js';

/** Política automática autorizada (caso base para los tests de automático). */
function politicaAutomatica(overrides: Partial<PoliticaAutonomia> = {}): PoliticaAutonomia {
  return {
    ...DEFAULT_POLICY_DRAFT,
    modoActivo: 'ejecutar_automatico',
    autorizacionEscrita: {
      autorizadoPor: 'Jon Peciña Iturbe',
      autorizadoEn: '2026-10-19T14:00:00+02:00',
      declaracion: 'Autorizo el modo automático según las reglas de la política v1.',
    },
    ...overrides,
  };
}

/** Contexto de envío "todo en regla". */
function ctxOk(overrides: Partial<ContextoEnvio> = {}): ContextoEnvio {
  return {
    encaje: 85,
    obligatorios: 'cumple',
    portal: 'greenhouse',
    empresa: 'Acme Corp',
    enviosHoy: 1,
    enviosSemana: 3,
    gastoMesUsd: 12.5,
    duplicado: false,
    ofertaVigente: true,
    ...overrides,
  };
}

describe('DEFAULT_POLICY_DRAFT', () => {
  it('versión 1, modo preparar_para_revision, sin autorización, sin parada', () => {
    assert.equal(DEFAULT_POLICY_DRAFT.version, 1);
    assert.equal(DEFAULT_POLICY_DRAFT.modoActivo, 'preparar_para_revision');
    assert.equal(DEFAULT_POLICY_DRAFT.autorizacionEscrita, null);
    assert.equal(DEFAULT_POLICY_DRAFT.paradaGlobal, false);
  });

  it('valores por defecto de las reglas', () => {
    const r = DEFAULT_POLICY_DRAFT.reglas;
    assert.deepEqual(r.portalesPermitidos, ['greenhouse', 'lever', 'personio']);
    assert.deepEqual(r.empresasExcluidas, []);
    assert.equal(r.umbralEncajeRevision, 70);
    assert.equal(r.umbralEncajeAutomatico, 75);
    assert.equal(r.maxEnviosPorDia, 5);
    assert.equal(r.maxEnviosPorSemana, 20);
    assert.equal(r.presupuestoMensualUsd, 50);
    assert.equal(r.presupuestoExaMensualUsd, 3);
    assert.equal(r.tratamientoDesconocidos, 'revision');
    assert.equal(r.crearCuentasPortales, false);
  });

  it('el borrador por defecto valida con zod', () => {
    const res = validarPolitica(DEFAULT_POLICY_DRAFT);
    assert.equal(res.ok, true);
  });
});

describe('validarPolitica / parsePolitica', () => {
  it('rechaza umbrales fuera de rango y límites negativos', () => {
    const mala = {
      ...DEFAULT_POLICY_DRAFT,
      reglas: { ...DEFAULT_POLICY_DRAFT.reglas, umbralEncajeAutomatico: 120, maxEnviosPorDia: -1 },
    };
    const res = validarPolitica(mala);
    assert.equal(res.ok, false);
    if (!res.ok) assert.ok(res.errores.length >= 2, res.errores.join(' | '));
  });

  it('rechaza modo desconocido y autorización incompleta', () => {
    const res = validarPolitica({ ...DEFAULT_POLICY_DRAFT, modoActivo: 'turbo' });
    assert.equal(res.ok, false);
    const res2 = validarPolitica({
      ...DEFAULT_POLICY_DRAFT,
      autorizacionEscrita: { autorizadoPor: 'Jon' }, // faltan campos
    });
    assert.equal(res2.ok, false);
  });

  it('parsePolitica lanza con política inválida y acepta una válida', () => {
    assert.throws(() => parsePolitica({ version: 0 }));
    assert.equal(parsePolitica(DEFAULT_POLICY_DRAFT).version, 1);
  });
});

describe('evaluarEnvio — LÍMITE DURO', () => {
  it('automático SIN autorización escrita → bloqueado (aunque todo lo demás esté bien)', () => {
    const politica = { ...DEFAULT_POLICY_DRAFT, modoActivo: 'ejecutar_automatico' as const };
    const ev = evaluarEnvio(politica, ctxOk());
    assert.equal(ev.decision, 'bloqueado');
    assert.ok(ev.motivos.some((m) => m.includes('autorización escrita')), ev.motivos.join(' | '));
    assert.equal(ev.versionPolitica, 1);
  });

  it('parada global bloquea todo, incluso en automático autorizado', () => {
    const politica = politicaAutomatica({ paradaGlobal: true });
    const ev = evaluarEnvio(politica, ctxOk());
    assert.equal(ev.decision, 'bloqueado');
    assert.ok(ev.motivos.some((m) => m.includes('Parada global')), ev.motivos.join(' | '));
  });

  it('modo investigar → bloqueado', () => {
    const politica = { ...DEFAULT_POLICY_DRAFT, modoActivo: 'investigar' as const };
    const ev = evaluarEnvio(politica, ctxOk());
    assert.equal(ev.decision, 'bloqueado');
    assert.ok(ev.motivos.some((m) => m.includes('investigar')), ev.motivos.join(' | '));
  });
});

describe('evaluarEnvio — modos', () => {
  it('preparar_para_revision siempre requiere revisión (caso perfecto)', () => {
    const ev = evaluarEnvio(DEFAULT_POLICY_DRAFT, ctxOk());
    assert.equal(ev.decision, 'requiere_revision');
    assert.ok(ev.motivos.length > 0);
  });

  it('automático autorizado con todo en regla → permitido', () => {
    const ev = evaluarEnvio(politicaAutomatica(), ctxOk());
    assert.equal(ev.decision, 'permitido');
    assert.equal(ev.versionPolitica, 1);
  });
});

describe('evaluarEnvio — umbrales y desconocidos', () => {
  it('encaje por debajo del umbral automático → requiere_revision por defecto', () => {
    const ev = evaluarEnvio(politicaAutomatica(), ctxOk({ encaje: 72 }));
    assert.equal(ev.decision, 'requiere_revision');
    assert.ok(ev.motivos.some((m) => m.includes('72')), ev.motivos.join(' | '));
  });

  it('encaje null → requiere_revision por defecto (tratamientoDesconocidos=revision)', () => {
    const ev = evaluarEnvio(politicaAutomatica(), ctxOk({ encaje: null }));
    assert.equal(ev.decision, 'requiere_revision');
  });

  it('tratamientoDesconocidos=descartar + encaje null → bloqueado', () => {
    const politica = politicaAutomatica({
      reglas: { ...DEFAULT_POLICY_DRAFT.reglas, tratamientoDesconocidos: 'descartar' },
    });
    const ev = evaluarEnvio(politica, ctxOk({ encaje: null }));
    assert.equal(ev.decision, 'bloqueado');
  });

  it('encaje exactamente en el umbral → permitido', () => {
    const ev = evaluarEnvio(politicaAutomatica(), ctxOk({ encaje: 75 }));
    assert.equal(ev.decision, 'permitido');
  });
});

describe('evaluarEnvio — condiciones de bloqueo', () => {
  it('duplicado → bloqueado', () => {
    const ev = evaluarEnvio(politicaAutomatica(), ctxOk({ duplicado: true }));
    assert.equal(ev.decision, 'bloqueado');
  });

  it('oferta no vigente → bloqueado', () => {
    const ev = evaluarEnvio(politicaAutomatica(), ctxOk({ ofertaVigente: false }));
    assert.equal(ev.decision, 'bloqueado');
  });

  it('portal no permitido → bloqueado', () => {
    const ev = evaluarEnvio(politicaAutomatica(), ctxOk({ portal: 'workday' }));
    assert.equal(ev.decision, 'bloqueado');
    assert.ok(ev.motivos.some((m) => m.includes('workday')), ev.motivos.join(' | '));
  });

  it('empresa excluida → bloqueado (insensible a mayúsculas)', () => {
    const politica = politicaAutomatica({
      reglas: { ...DEFAULT_POLICY_DRAFT.reglas, empresasExcluidas: ['Evil Corp'] },
    });
    const ev = evaluarEnvio(politica, ctxOk({ empresa: 'EVIL CORP' }));
    assert.equal(ev.decision, 'bloqueado');
  });

  it('límite diario alcanzado → bloqueado', () => {
    const ev = evaluarEnvio(politicaAutomatica(), ctxOk({ enviosHoy: 5 }));
    assert.equal(ev.decision, 'bloqueado');
  });

  it('límite semanal alcanzado → bloqueado', () => {
    const ev = evaluarEnvio(politicaAutomatica(), ctxOk({ enviosSemana: 20 }));
    assert.equal(ev.decision, 'bloqueado');
  });

  it('presupuesto mensual agotado → bloqueado', () => {
    const ev = evaluarEnvio(politicaAutomatica(), ctxOk({ gastoMesUsd: 50 }));
    assert.equal(ev.decision, 'bloqueado');
  });

  it('obligatorios incumple → bloqueado; sin_evidencia → requiere_revision', () => {
    const politica = politicaAutomatica();
    assert.equal(evaluarEnvio(politica, ctxOk({ obligatorios: 'incumple' })).decision, 'bloqueado');
    assert.equal(
      evaluarEnvio(politica, ctxOk({ obligatorios: 'sin_evidencia' })).decision,
      'requiere_revision',
    );
  });
});

describe('presend — checklist', () => {
  it('los 9 checks existen en orden', () => {
    assert.deepEqual(
      CHECKS_PRE_ENVIO.map((c) => c.id),
      [
        'modo_activo',
        'oferta_vigente',
        'exclusiones',
        'datos_obligatorios',
        'documentos_validos',
        'portal_compatible',
        'presupuesto',
        'duplicados',
        'autorizacion_vigente',
      ],
    );
  });

  it('sin probes: oferta/duplicados/presupuesto fallan con "sin probe configurado"', () => {
    return ejecutarChecks({
      politica: politicaAutomatica(),
      portal: 'greenhouse',
      empresa: 'Acme',
      datosObligatoriosCompletos: true,
      documentosValidos: true,
    }).then((res) => {
      assert.equal(res.length, 9);
      for (const id of ['oferta_vigente', 'presupuesto', 'duplicados']) {
        const r = res.find((x) => x.id === id)!;
        assert.equal(r.ok, false, id);
        assert.ok(r.detalle.toLowerCase().includes('sin probe configurado'), `${id}: ${r.detalle}`);
      }
      assert.equal(checksOk(res), false);
    });
  });

  it('con probes y todo en regla: los 9 checks pasan', () => {
    return ejecutarChecks({
      politica: politicaAutomatica(),
      portal: 'lever',
      empresa: 'Acme',
      datosObligatoriosCompletos: true,
      documentosValidos: true,
      verificarOfertaVigente: async () => true,
      obtenerGastoMesUsd: async () => 12.5,
      esDuplicado: async () => false,
    }).then((res) => {
      assert.equal(res.length, 9);
      assert.equal(checksOk(res), true);
      for (const r of res) assert.equal(r.ok, true, r.id);
    });
  });

  it('detecta oferta cerrada, duplicado, documentos inválidos y datos incompletos', () => {
    return ejecutarChecks({
      politica: politicaAutomatica(),
      portal: 'greenhouse',
      empresa: 'Acme',
      datosObligatoriosCompletos: false,
      documentosValidos: false,
      verificarOfertaVigente: async () => false,
      obtenerGastoMesUsd: async () => 99,
      esDuplicado: async () => true,
    }).then((res) => {
      const porId = Object.fromEntries(res.map((r) => [r.id, r]));
      assert.equal(porId['oferta_vigente'].ok, false);
      assert.equal(porId['duplicados'].ok, false);
      assert.equal(porId['presupuesto'].ok, false);
      assert.equal(porId['documentos_validos'].ok, false);
      assert.equal(porId['datos_obligatorios'].ok, false);
      assert.equal(checksOk(res), false);
    });
  });

  it('autorizacion_vigente falla en automático sin autorización escrita', () => {
    return ejecutarChecks({
      politica: { ...DEFAULT_POLICY_DRAFT, modoActivo: 'ejecutar_automatico' },
      portal: 'greenhouse',
      empresa: 'Acme',
      datosObligatoriosCompletos: true,
      documentosValidos: true,
    }).then((res) => {
      const r = res.find((x) => x.id === 'autorizacion_vigente')!;
      assert.equal(r.ok, false);
      assert.ok(r.detalle.includes('autorización escrita'), r.detalle);
    });
  });

  it('parada global hace fallar modo_activo', () => {
    return ejecutarChecks({
      politica: politicaAutomatica({ paradaGlobal: true }),
      portal: 'greenhouse',
      empresa: 'Acme',
      datosObligatoriosCompletos: true,
      documentosValidos: true,
    }).then((res) => {
      const r = res.find((x) => x.id === 'modo_activo')!;
      assert.equal(r.ok, false);
    });
  });
});

describe('versioning', () => {
  it('versionarEnvio fija la versión vigente', () => {
    assert.equal(versionarEnvio(DEFAULT_POLICY_DRAFT), 1);
    assert.equal(versionarEnvio({ ...DEFAULT_POLICY_DRAFT, version: 3 }), 3);
  });

  it('congelarPolitica aísla la copia de mutaciones posteriores', () => {
    const viva: PoliticaAutonomia = politicaAutomatica();
    const congelada = congelarPolitica(viva);
    viva.paradaGlobal = true;
    viva.reglas.portalesPermitidos.push('workday');
    assert.equal(congelada.paradaGlobal, false);
    assert.deepEqual(congelada.reglas.portalesPermitidos, ['greenhouse', 'lever', 'personio']);
  });
});
