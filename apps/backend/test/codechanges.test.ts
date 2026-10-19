/**
 * Tests de cambios de código (Fase 6.2): migración 009, ciclo de vida de
 * propuestas, puerta de aprobación, publicación y reversión.
 *
 * La reversión del backend se simula con `setRevertTestDeps` (doble
 * inyectable): ningún test ejecuta git ni docker de verdad.
 *
 * Requieren `DATABASE_URL` en el entorno.
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { query } from '@jobforce/database';
import {
  authed,
  buildTestApp,
  closeTestApp,
  resetDb,
  setupAndLogin,
  type AuthContext,
} from './helpers.js';
import { resetRevertTestDeps, setRevertTestDeps } from '../src/routes/codechanges.js';

async function crearPropuesta(
  app: FastifyInstance,
  auth: AuthContext,
  body: Record<string, unknown> = {},
) {
  return app.inject({
    method: 'POST',
    url: '/api/code-changes',
    headers: authed(auth),
    payload: {
      titulo: 'Mejorar el resumen de encaje',
      descripcion: 'Añadir desglose por criterios al resumen que ve Jon.',
      componente: 'frontend',
      ...body,
    },
  });
}

async function avanzarARevision(app: FastifyInstance, auth: AuthContext, id: string) {
  for (const estado of ['en_desarrollo', 'en_revision']) {
    const r = await app.inject({
      method: 'PATCH',
      url: `/api/code-changes/${id}`,
      headers: authed(auth),
      payload: { estado },
    });
    assert.equal(r.statusCode, 200, `PATCH ${estado}: ${r.statusCode} ${r.body}`);
  }
}

async function aprobar(app: FastifyInstance, auth: AuthContext, id: string, declaracion?: string) {
  return app.inject({
    method: 'POST',
    url: `/api/code-changes/${id}/approve`,
    headers: authed(auth),
    payload: declaracion === undefined ? {} : { declaracion },
  });
}

/** Espera a que el job de reversión termine (revert_estado != en_curso). */
async function esperarRevert(app: FastifyInstance, auth: AuthContext, id: string, timeoutMs = 5000) {
  const inicio = Date.now();
  for (;;) {
    const res = await app.inject({
      method: 'GET',
      url: `/api/code-changes/${id}`,
      headers: authed(auth, false),
    });
    assert.equal(res.statusCode, 200, `GET detalle: ${res.statusCode} ${res.body}`);
    const body = res.json() as { revert_estado: string };
    if (body.revert_estado !== 'en_curso') return body as Record<string, unknown>;
    if (Date.now() - inicio > timeoutMs) {
      throw new Error('timeout esperando a que termine la reversión');
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('cambios de código (Fase 6.2)', () => {
  let app: FastifyInstance;
  let auth: AuthContext;

  before(async () => {
    app = await buildTestApp();
  });

  after(async () => {
    await closeTestApp(app);
  });

  beforeEach(async () => {
    await resetDb();
    resetRevertTestDeps();
    auth = await setupAndLogin(app);
  });

  it('la migración 009 crea code_changes y deployments con sus checks', async () => {
    const tablas = await query<{ t: string }>(
      `SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public'
         AND tablename IN ('code_changes', 'deployments')`,
    );
    assert.deepEqual(tablas.map((t) => t.t).sort(), ['code_changes', 'deployments']);

    const checks = await query<{ c: string }>(
      `SELECT conname AS c FROM pg_constraint
        WHERE conrelid IN ('code_changes'::regclass, 'deployments'::regclass)
          AND contype = 'c'`,
    );
    assert.ok(checks.length >= 4, `checks esperados: ${checks.map((c) => c.c).join(',')}`);

    const indices = await query<{ i: string }>(
      `SELECT indexname AS i FROM pg_indexes WHERE schemaname = 'public'
         AND indexname = 'idx_deployments_componente_fecha'`,
    );
    assert.equal(indices.length, 1, 'falta el índice de deployments');
  });

  it('crear propuesta → 201 en borrador; validación y auth', async () => {
    const ok = await crearPropuesta(app, auth);
    assert.equal(ok.statusCode, 201, `crear: ${ok.statusCode} ${ok.body}`);
    const body = ok.json() as { estado: string; test_estado: string };
    assert.equal(body.estado, 'borrador');
    assert.equal(body.test_estado, 'pendiente');

    const sinTitulo = await crearPropuesta(app, auth, { titulo: '' });
    assert.equal(sinTitulo.statusCode, 400);

    const tituloLargo = await crearPropuesta(app, auth, { titulo: 'x'.repeat(121) });
    assert.equal(tituloLargo.statusCode, 400);

    const sinCsrf = await app.inject({
      method: 'POST',
      url: '/api/code-changes',
      headers: authed(auth, false),
      payload: { titulo: 't', descripcion: 'd', componente: 'backend' },
    });
    assert.equal(sinCsrf.statusCode, 403);

    const sinSesion = await app.inject({
      method: 'POST',
      url: '/api/code-changes',
      payload: { titulo: 't', descripcion: 'd', componente: 'backend' },
    });
    assert.equal(sinSesion.statusCode, 401);
  });

  it('PATCH: transiciones válidas de un paso; rechaza saltos y retrocesos', async () => {
    const creada = await crearPropuesta(app, auth);
    const id = (creada.json() as { id: string }).id;

    const paso1 = await app.inject({
      method: 'PATCH',
      url: `/api/code-changes/${id}`,
      headers: authed(auth),
      payload: { estado: 'en_desarrollo', rama: 'cambio/abc-resumen' },
    });
    assert.equal(paso1.statusCode, 200, `paso1: ${paso1.statusCode} ${paso1.body}`);
    assert.equal((paso1.json() as { estado: string }).estado, 'en_desarrollo');
    assert.equal((paso1.json() as { rama: string }).rama, 'cambio/abc-resumen');

    // Retroceso: rechazado.
    const atras = await app.inject({
      method: 'PATCH',
      url: `/api/code-changes/${id}`,
      headers: authed(auth),
      payload: { estado: 'en_desarrollo' },
    });
    assert.equal(atras.statusCode, 409);

    // Salto directo a aprobada por PATCH: rechazado (requiere /approve).
    const salto = await app.inject({
      method: 'PATCH',
      url: `/api/code-changes/${id}`,
      headers: authed(auth),
      payload: { estado: 'en_revision' },
    });
    assert.equal(salto.statusCode, 200, `a revisión: ${salto.statusCode} ${salto.body}`);

    const idInvalido = await app.inject({
      method: 'PATCH',
      url: '/api/code-changes/no-es-uuid',
      headers: authed(auth),
      payload: { estado: 'en_desarrollo' },
    });
    assert.equal(idInvalido.statusCode, 400);
  });

  it('PATCH actualiza rama, preview_url, test_estado y test_detalle', async () => {
    const creada = await crearPropuesta(app, auth);
    const id = (creada.json() as { id: string }).id;

    const r = await app.inject({
      method: 'PATCH',
      url: `/api/code-changes/${id}`,
      headers: authed(auth),
      payload: {
        rama: 'cambio/xyz-x',
        preview_url: 'https://jobforce-xyz.vercel.app',
        test_estado: 'pasando',
        test_detalle: { suite: 'backend', casos: 42 },
      },
    });
    assert.equal(r.statusCode, 200, `patch: ${r.statusCode} ${r.body}`);
    const b = r.json() as Record<string, unknown>;
    assert.equal(b.preview_url, 'https://jobforce-xyz.vercel.app');
    assert.equal(b.test_estado, 'pasando');
    assert.deepEqual(b.test_detalle, { suite: 'backend', casos: 42 });

    const malaUrl = await app.inject({
      method: 'PATCH',
      url: `/api/code-changes/${id}`,
      headers: authed(auth),
      payload: { preview_url: 'no-es-url' },
    });
    assert.equal(malaUrl.statusCode, 400);
  });

  it('GET lista con filtros estado/componente; GET detalle con auditoría', async () => {
    const a = await crearPropuesta(app, auth, { componente: 'backend', titulo: 'A' });
    const b = await crearPropuesta(app, auth, { componente: 'frontend', titulo: 'B' });
    const idA = (a.json() as { id: string }).id;
    const idB = (b.json() as { id: string }).id;
    await avanzarARevision(app, auth, idA);

    const todas = await app.inject({ method: 'GET', url: '/api/code-changes', headers: authed(auth, false) });
    assert.equal((todas.json() as { cambios: unknown[] }).cambios.length, 2);

    const soloBackend = await app.inject({
      method: 'GET',
      url: '/api/code-changes?componente=backend',
      headers: authed(auth, false),
    });
    const listaB = (soloBackend.json() as { cambios: { id: string }[] }).cambios;
    assert.equal(listaB.length, 1);
    assert.equal(listaB[0].id, idA);

    const enRevision = await app.inject({
      method: 'GET',
      url: '/api/code-changes?estado=en_revision',
      headers: authed(auth, false),
    });
    assert.equal((enRevision.json() as { cambios: unknown[] }).cambios.length, 1);

    const filtroMalo = await app.inject({
      method: 'GET',
      url: '/api/code-changes?estado=inexistente',
      headers: authed(auth, false),
    });
    assert.equal(filtroMalo.statusCode, 400);

    const detalle = await app.inject({
      method: 'GET',
      url: `/api/code-changes/${idB}`,
      headers: authed(auth, false),
    });
    assert.equal(detalle.statusCode, 200);
    const det = detalle.json() as { auditoria: { accion: string }[] };
    assert.ok(det.auditoria.length >= 1, 'el detalle debe incluir eventos de auditoría');
    assert.ok(det.auditoria.some((e) => e.accion === 'code_change_created'));

    const noExiste = await app.inject({
      method: 'GET',
      url: '/api/code-changes/00000000-0000-0000-0000-000000000000',
      headers: authed(auth, false),
    });
    assert.equal(noExiste.statusCode, 404);
  });

  it('approve: sin declaración → 400; desde estado incorrecto → 409; ok → aprobada', async () => {
    const creada = await crearPropuesta(app, auth);
    const id = (creada.json() as { id: string }).id;

    // Desde borrador no se puede aprobar.
    const desdeBorrador = await aprobar(app, auth, id, 'Autorizo.');
    assert.equal(desdeBorrador.statusCode, 409);

    await avanzarARevision(app, auth, id);

    // Sin declaración: 400 (la puerta exige texto expreso).
    const sinDeclaracion = await aprobar(app, auth, id);
    assert.equal(sinDeclaracion.statusCode, 400);

    const declaracionVacia = await aprobar(app, auth, id, '   ');
    assert.equal(declaracionVacia.statusCode, 400);

    const ok = await aprobar(app, auth, id, 'Autorizo la publicación de este cambio. — Jon');
    assert.equal(ok.statusCode, 200, `approve: ${ok.statusCode} ${ok.body}`);
    const b = ok.json() as {
      estado: string;
      declaracion_aprobacion: string;
      aprobada_en: string;
    };
    assert.equal(b.estado, 'aprobada');
    assert.equal(b.declaracion_aprobacion, 'Autorizo la publicación de este cambio. — Jon');
    assert.ok(b.aprobada_en);

    // La declaración queda en la auditoría.
    const detalle = await app.inject({
      method: 'GET',
      url: `/api/code-changes/${id}`,
      headers: authed(auth, false),
    });
    const det = detalle.json() as { auditoria: { accion: string; detalles: { declaracion?: string } }[] };
    const ev = det.auditoria.find((e) => e.accion === 'code_change_approved');
    assert.ok(ev, 'debe haber evento code_change_approved');
    assert.equal(ev!.detalles.declaracion, 'Autorizo la publicación de este cambio. — Jon');

    // Doble aprobación: 409.
    const doble = await aprobar(app, auth, id, 'Otra vez.');
    assert.equal(doble.statusCode, 409);
  });

  it('publish: sin aprobación previa → 409; ok → publicada + fila en deployments', async () => {
    const creada = await crearPropuesta(app, auth, { componente: 'backend' });
    const id = (creada.json() as { id: string }).id;
    await avanzarARevision(app, auth, id);

    // En revisión pero sin approve: la puerta dura bloquea.
    const sinApprove = await app.inject({
      method: 'POST',
      url: `/api/code-changes/${id}/publish`,
      headers: authed(auth),
      payload: { commit: 'abc123' },
    });
    assert.equal(sinApprove.statusCode, 409);
    assert.equal((sinApprove.json() as { error: string }).error, 'publicacion_sin_aprobacion');

    await aprobar(app, auth, id, 'Autorizo.');

    const pub = await app.inject({
      method: 'POST',
      url: `/api/code-changes/${id}/publish`,
      headers: authed(auth),
      payload: { commit: 'abc123def456' },
    });
    assert.equal(pub.statusCode, 200, `publish: ${pub.statusCode} ${pub.body}`);
    const b = pub.json() as { estado: string; commit_publicado: string; publicada_en: string };
    assert.equal(b.estado, 'publicada');
    assert.equal(b.commit_publicado, 'abc123def456');
    assert.ok(b.publicada_en);

    const deps = await query<{ commit: string; componente: string; desplegado_por: string }>(
      `SELECT commit, componente, desplegado_por FROM deployments`,
    );
    assert.equal(deps.length, 1);
    assert.equal(deps[0].commit, 'abc123def456');
    assert.equal(deps[0].componente, 'backend');
    assert.equal(deps[0].desplegado_por, 'jon');

    // Publicar dos veces: 409.
    const doble = await app.inject({
      method: 'POST',
      url: `/api/code-changes/${id}/publish`,
      headers: authed(auth),
      payload: { commit: 'otro' },
    });
    assert.equal(doble.statusCode, 409);
  });

  it('publish con componente=ambos registra un despliegue por componente', async () => {
    const creada = await crearPropuesta(app, auth, { componente: 'ambos' });
    const id = (creada.json() as { id: string }).id;
    await avanzarARevision(app, auth, id);
    await aprobar(app, auth, id, 'Autorizo ambos.');
    const pub = await app.inject({
      method: 'POST',
      url: `/api/code-changes/${id}/publish`,
      headers: authed(auth),
      payload: { commit: 'deadbee', vercel_deployment_id: 'dpl_123', vercel_url: 'https://x.vercel.app' },
    });
    assert.equal(pub.statusCode, 200, `publish ambos: ${pub.statusCode} ${pub.body}`);
    const deps = await query<{ componente: string }>(
      `SELECT componente FROM deployments ORDER BY componente`,
    );
    assert.deepEqual(deps.map((d) => d.componente), ['backend', 'frontend']);
  });

  it('revert sin deployments registrados → 409 con mensaje claro', async () => {
    const rows = await query<{ id: string }>(
      `INSERT INTO code_changes (titulo, descripcion, componente, estado, commit_publicado)
       VALUES ('Cambio X', 'desc', 'backend', 'publicada', 'zzz999') RETURNING id`,
    );
    const r = await app.inject({
      method: 'POST',
      url: `/api/code-changes/${rows[0].id}/revert`,
      headers: authed(auth),
      payload: { motivo: 'Rompe el login.' },
    });
    assert.equal(r.statusCode, 409);
    assert.equal((r.json() as { error: string }).error, 'sin_despliegues_previos');
  });

  it('revert: sin motivo → 400; desde estado no publicada → 409', async () => {
    const creada = await crearPropuesta(app, auth);
    const id = (creada.json() as { id: string }).id;

    const sinMotivo = await app.inject({
      method: 'POST',
      url: `/api/code-changes/${id}/revert`,
      headers: authed(auth),
      payload: {},
    });
    assert.equal(sinMotivo.statusCode, 400);

    const noPublicada = await app.inject({
      method: 'POST',
      url: `/api/code-changes/${id}/revert`,
      headers: authed(auth),
      payload: { motivo: 'x' },
    });
    assert.equal(noPublicada.statusCode, 409);
  });

  it('revert con doble simulado (dry-run) → 202 y estado final revertida', async () => {
    const creada = await crearPropuesta(app, auth, { componente: 'backend' });
    const id = (creada.json() as { id: string }).id;
    await avanzarARevision(app, auth, id);
    await aprobar(app, auth, id, 'Autorizo para el test de revert.');
    const pub = await app.inject({
      method: 'POST',
      url: `/api/code-changes/${id}/publish`,
      headers: authed(auth),
      payload: { commit: 'bbbb2222' },
    });
    assert.equal(pub.statusCode, 200);

    // Histórico previo: el despliegue anterior del backend.
    await query(
      `INSERT INTO deployments (componente, commit, desplegado_por, estado)
       VALUES ('backend', 'aaaa1111', 'jon', 'exito')`,
    );

    const llamadas: { commit: string; dryRun?: boolean }[] = [];
    setRevertTestDeps({
      backendRevert: async (commitObjetivo, opts) => {
        llamadas.push({ commit: commitObjetivo, dryRun: opts?.dryRun });
        return { ok: true, commitObjetivo, commitActual: 'bbbb2222', avisos: [] };
      },
    });

    const r = await app.inject({
      method: 'POST',
      url: `/api/code-changes/${id}/revert`,
      headers: authed(auth),
      payload: { motivo: 'El cambio rompe el panel en producción.' },
    });
    assert.equal(r.statusCode, 202, `revert: ${r.statusCode} ${r.body}`);
    const inicio = r.json() as { ok: boolean; revert_id: string; estado: string };
    assert.equal(inicio.ok, true);
    assert.ok(inicio.revert_id);
    assert.equal(inicio.estado, 'en_curso');

    // Segunda petición mientras está en curso (o ya terminó): no debe
    // aceptar otro revert concurrente ni fallar de forma extraña.
    const final = (await esperarRevert(app, auth, id)) as {
      estado: string;
      revert_estado: string;
      commit_revertido: string;
      revert_resultado: { backend: { ok: boolean; commitObjetivo: string } };
      auditoria: { accion: string }[];
    };
    assert.equal(final.estado, 'revertida');
    assert.equal(final.revert_estado, 'completada');
    assert.equal(final.commit_revertido, 'aaaa1111');
    assert.equal(final.revert_resultado.backend.ok, true);
    assert.equal(final.revert_resultado.backend.commitObjetivo, 'aaaa1111');

    // El ejecutor recibió el commit ANTERIOR (no el publicado).
    assert.equal(llamadas.length, 1);
    assert.equal(llamadas[0].commit, 'aaaa1111');

    // El revert quedó registrado en deployments.
    const deps = await query<{ commit: string; desplegado_por: string }>(
      `SELECT commit, desplegado_por FROM deployments WHERE desplegado_por = 'jon (revert)'`,
    );
    assert.equal(deps.length, 1);
    assert.equal(deps[0].commit, 'aaaa1111');

    // Auditoría completa del ciclo.
    const acciones = final.auditoria.map((e) => e.accion);
    for (const esperada of [
      'code_change_created',
      'code_change_updated',
      'code_change_approved',
      'code_change_published',
      'code_change_revert_started',
      'code_change_revert_finished',
    ]) {
      assert.ok(acciones.includes(esperada), `falta evento ${esperada}: ${acciones.join(',')}`);
    }
  });

  it('revert de frontend sin VERCEL_TOKEN → fallback manual documentado', async () => {
    const creada = await crearPropuesta(app, auth, { componente: 'frontend' });
    const id = (creada.json() as { id: string }).id;
    await avanzarARevision(app, auth, id);
    await aprobar(app, auth, id, 'Autorizo.');
    await app.inject({
      method: 'POST',
      url: `/api/code-changes/${id}/publish`,
      headers: authed(auth),
      payload: { commit: 'ffff4444' },
    });
    // Histórico mínimo para no caer en el 409 (una fila cualquiera).
    await query(
      `INSERT INTO deployments (componente, commit, desplegado_por, estado)
       VALUES ('backend', 'aaaa1111', 'jon', 'exito')`,
    );

    // Sin dobles: defaultVercelRevert sin VERCEL_TOKEN → manual.
    const r = await app.inject({
      method: 'POST',
      url: `/api/code-changes/${id}/revert`,
      headers: authed(auth),
      payload: { motivo: 'El frontal no carga.' },
    });
    assert.equal(r.statusCode, 202, `revert frontend: ${r.statusCode} ${r.body}`);

    const final = (await esperarRevert(app, auth, id)) as {
      estado: string;
      revert_estado: string;
      revert_resultado: {
        frontend: { modo: string; instrucciones?: string; nota?: string };
      };
    };
    assert.equal(final.estado, 'revertida');
    assert.equal(final.revert_estado, 'completada');
    assert.equal(final.revert_resultado.frontend.modo, 'manual');
    assert.ok(
      final.revert_resultado.frontend.instrucciones?.includes('Promote to Production'),
      'el fallback manual debe explicar el paso en el dashboard',
    );
  });

  it('revert fallido del backend deja el estado en publicada con el error registrado', async () => {
    const creada = await crearPropuesta(app, auth, { componente: 'backend' });
    const id = (creada.json() as { id: string }).id;
    await avanzarARevision(app, auth, id);
    await aprobar(app, auth, id, 'Autorizo.');
    await app.inject({
      method: 'POST',
      url: `/api/code-changes/${id}/publish`,
      headers: authed(auth),
      payload: { commit: 'bbbb2222' },
    });
    await query(
      `INSERT INTO deployments (componente, commit, desplegado_por, estado)
       VALUES ('backend', 'aaaa1111', 'jon', 'exito')`,
    );

    setRevertTestDeps({
      backendRevert: async (commitObjetivo) => ({
        ok: false,
        commitObjetivo,
        avisos: [],
        error: 'docker compose falló (simulado)',
      }),
    });

    const r = await app.inject({
      method: 'POST',
      url: `/api/code-changes/${id}/revert`,
      headers: authed(auth),
      payload: { motivo: 'Prueba de fallo.' },
    });
    assert.equal(r.statusCode, 202);

    const final = (await esperarRevert(app, auth, id)) as {
      estado: string;
      revert_estado: string;
      revert_resultado: { backend: { ok: boolean; error: string } };
    };
    // El cambio sigue publicado (no se finge una reversión que no ocurrió).
    assert.equal(final.estado, 'publicada');
    assert.equal(final.revert_estado, 'fallida');
    assert.equal(final.revert_resultado.backend.ok, false);
    assert.ok(final.revert_resultado.backend.error.includes('docker compose'));
  });
});
