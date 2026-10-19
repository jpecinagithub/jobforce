/**
 * Tests de revisión manual (Fase 6.1): cola con resumen de encaje,
 * aprobar/rechazar en un toque, lote mixto y nota opcional al resolver
 * intervenciones (corrección de auditoría).
 *
 * Requieren `DATABASE_URL` en el entorno (PostgreSQL real).
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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

interface CandidaturaOpts {
  company?: string;
  title?: string;
  score?: number | null;
  verdict?: 'cumple' | 'incumple' | 'sin_evidencia';
  appStatus?: string;
  breakdown?: unknown;
}

const BREAKDOWN_BASE = [
  { dimension: 'funciones', peso: 30, puntos: 75, explicacion: 'Menciona finanzas y controlling.', hechos: ['experiencia.cfo'] },
  { dimension: 'competencias', peso: 25, puntos: 50, explicacion: 'Excel y reporting.', hechos: ['skills.excel', 'skills.powerbi'] },
  { dimension: 'seniority', peso: 15, puntos: 100, explicacion: 'Nivel senior claro.', hechos: [] },
  { dimension: 'ubicacion', peso: 10, puntos: 0, explicacion: 'Sin menciones.', hechos: [] },
  { dimension: 'condiciones', peso: 10, puntos: 50, explicacion: 'Salario en rango.', hechos: ['idiomas.ingles'] },
  { dimension: 'empresa', peso: 10, puntos: 25, explicacion: 'Empresa mediana.', hechos: [] },
];

/** Crea campaña + oferta + evaluación + candidatura directamente en BD. */
async function crearCandidatura(opts: CandidaturaOpts = {}): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const score = opts.score === undefined ? 82.5 : opts.score;

  const c = await query<{ id: string }>(
    `INSERT INTO campaigns (name, criteria) VALUES ('camp-test', '{}'::jsonb) RETURNING id`,
  );
  const o = await query<{ id: string }>(
    `INSERT INTO offers (campaign_id, canonical_url, url, title, company)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      c[0].id,
      `https://empleo.example/oferta/${suffix}`,
      `https://empleo.example/oferta/${suffix}`,
      opts.title ?? 'Finance Manager',
      opts.company ?? 'Acme Corp',
    ],
  );
  if (score !== null) {
    await query(
      `INSERT INTO evaluations (offer_id, campaign_id, mandatory_verdict, mandatory_details, score, breakdown)
       VALUES ($1, $2, $3, '[]'::jsonb, $4, $5::jsonb)`,
      [o[0].id, c[0].id, opts.verdict ?? 'cumple', score, JSON.stringify(opts.breakdown ?? BREAKDOWN_BASE)],
    );
  }
  const a = await query<{ id: string }>(
    `INSERT INTO applications (campaign_id, offer_id, status, portal)
     VALUES ($1, $2, $3, 'greenhouse') RETURNING id`,
    [c[0].id, o[0].id, opts.appStatus ?? 'ready_for_review'],
  );
  return a[0].id;
}

describe('revisión manual (Fase 6.1)', () => {
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
    auth = await setupAndLogin(app);
  });

  it('la migración 008 añade reviewed_at y reviewed_by a applications', async () => {
    const cols = await query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'applications'
          AND column_name IN ('reviewed_at', 'reviewed_by')
        ORDER BY column_name`,
    );
    assert.equal(cols.length, 2);
    assert.equal(cols[0].column_name, 'reviewed_at');
    assert.equal(cols[1].column_name, 'reviewed_by');
  });

  it('las rutas exigen sesión y las mutaciones exigen CSRF', async () => {
    const queue = await app.inject({ method: 'GET', url: '/api/review/queue' });
    assert.equal(queue.statusCode, 401);

    const id = await crearCandidatura();
    const sinCsrf = await app.inject({
      method: 'POST',
      url: `/api/applications/${id}/approve`,
      headers: authed(auth, false),
    });
    assert.equal(sinCsrf.statusCode, 403);
  });

  it('la cola vacía devuelve una lista vacía', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/review/queue',
      headers: authed(auth, false),
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { queue: [] });
  });

  it('la cola ordena por score descendente y trae el resumen de encaje', async () => {
    await crearCandidatura({ company: 'Beta SA', score: 70.0 });
    const alta = await crearCandidatura({ company: 'Alta SL', score: 95.5 });

    const res = await app.inject({
      method: 'GET',
      url: '/api/review/queue',
      headers: authed(auth, false),
    });
    assert.equal(res.statusCode, 200);
    const body = res.json<{
      queue: Array<{
        id: string;
        offer: { title: string; company: string; url: string };
        score: number;
        mandatoryVerdict: string;
        resumenEncaje: {
          topDimensiones: Array<{ dimension: string; peso: number; puntos: number; explicacion: string; hechos: number }>;
          hechosVerificados: number;
        };
      }>;
    }>();
    assert.equal(body.queue.length, 2);
    assert.equal(body.queue[0].id, alta);
    assert.equal(body.queue[1].offer.company, 'Beta SA');
    assert.equal(body.queue[0].score, 95.5);
    assert.equal(body.queue[0].offer.title, 'Finance Manager');

    const resumen = body.queue[0].resumenEncaje;
    assert.equal(resumen.topDimensiones.length, 3);
    // Top 3 por peso: funciones(30), competencias(25), seniority(15).
    assert.deepEqual(
      resumen.topDimensiones.map((d) => d.dimension),
      ['funciones', 'competencias', 'seniority'],
    );
    assert.equal(resumen.topDimensiones[0].puntos, 75);
    assert.equal(resumen.topDimensiones[0].explicacion, 'Menciona finanzas y controlling.');
    assert.equal(resumen.topDimensiones[1].hechos, 2);
    assert.equal(resumen.hechosVerificados, 3); // 1 + 2 + 0
    assert.equal(body.queue[0].mandatoryVerdict, 'cumple');
  });

  it('la cola ignora candidaturas en otros estados y sin evaluación', async () => {
    await crearCandidatura({ appStatus: 'approved' });
    await crearCandidatura({ appStatus: 'draft' });
    const id = await crearCandidatura({ score: null, company: 'SinEval SL' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/review/queue',
      headers: authed(auth, false),
    });
    const body = res.json<{ queue: Array<{ id: string; score: number | null; resumenEncaje: { topDimensiones: unknown[]; hechosVerificados: number } }> }>();
    assert.equal(body.queue.length, 1);
    assert.equal(body.queue[0].id, id);
    assert.equal(body.queue[0].score, null);
    assert.deepEqual(body.queue[0].resumenEncaje.topDimensiones, []);
    assert.equal(body.queue[0].resumenEncaje.hechosVerificados, 0);
  });

  it('approve: ready_for_review → approved, marca revisión y audita', async () => {
    const id = await crearCandidatura();

    const res = await app.inject({
      method: 'POST',
      url: `/api/applications/${id}/approve`,
      headers: authed(auth),
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json<{ application: { status: string; reviewedAt: string; reviewedBy: string } }>();
    assert.equal(body.application.status, 'approved');
    assert.ok(body.application.reviewedAt);
    assert.ok(typeof body.application.reviewedBy === 'string' && body.application.reviewedBy.length > 0);

    const fila = await query<{ status: string; reviewed_at: Date | null; reviewed_by: string | null }>(
      `SELECT status, reviewed_at, reviewed_by FROM applications WHERE id = $1`,
      [id],
    );
    assert.equal(fila[0].status, 'approved');
    assert.ok(fila[0].reviewed_at);
    assert.ok(fila[0].reviewed_by);

    const audit = await query<{ action: string; entity_id: string }>(
      `SELECT action, entity_id FROM audit_events WHERE action = 'application_approved'`,
    );
    assert.equal(audit.length, 1);
    assert.equal(audit[0].entity_id, id);
  });

  it('approve: 409 si no está en revisión y 404 si no existe', async () => {
    const id = await crearCandidatura({ appStatus: 'draft' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/applications/${id}/approve`,
      headers: authed(auth),
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json<{ error: string; status: string }>().error, 'candidatura_no_en_revision');
    assert.equal(res.json<{ error: string; status: string }>().status, 'draft');

    const inexistente = await app.inject({
      method: 'POST',
      url: `/api/applications/${randomUUID()}/approve`,
      headers: authed(auth),
    });
    assert.equal(inexistente.statusCode, 404);

    const malformado = await app.inject({
      method: 'POST',
      url: '/api/applications/no-es-uuid/approve',
      headers: authed(auth),
    });
    assert.equal(malformado.statusCode, 400);
  });

  it('reject: ready_for_review → withdrawn con motivo', async () => {
    const id = await crearCandidatura();

    const res = await app.inject({
      method: 'POST',
      url: `/api/applications/${id}/reject`,
      headers: authed(auth),
      payload: { reason: 'La ubicación no encaja con el plan de Jon.' },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json<{ application: { status: string } }>().application.status, 'withdrawn');

    const fila = await query<{ status: string; failure_reason: string }>(
      `SELECT status, failure_reason FROM applications WHERE id = $1`,
      [id],
    );
    assert.equal(fila[0].status, 'withdrawn');
    assert.equal(fila[0].failure_reason, 'La ubicación no encaja con el plan de Jon.');

    const audit = await query<{ details: { reason: string } }>(
      `SELECT details FROM audit_events WHERE action = 'application_rejected'`,
    );
    assert.equal(audit.length, 1);
    assert.equal(audit[0].details.reason, 'La ubicación no encaja con el plan de Jon.');
  });

  it('reject: motivo obligatorio (400) y 409 en estado incorrecto', async () => {
    const id = await crearCandidatura();

    const sinMotivo = await app.inject({
      method: 'POST',
      url: `/api/applications/${id}/reject`,
      headers: authed(auth),
      payload: {},
    });
    assert.equal(sinMotivo.statusCode, 400);

    const aprobada = await crearCandidatura({ appStatus: 'approved' });
    const mal = await app.inject({
      method: 'POST',
      url: `/api/applications/${aprobada}/reject`,
      headers: authed(auth),
      payload: { reason: 'x' },
    });
    assert.equal(mal.statusCode, 409);
  });

  it('batch: aprueba por lote y devuelve resultado por item (mixto ok + inexistente)', async () => {
    const ok1 = await crearCandidatura();
    const ok2 = await crearCandidatura();
    const fantasma = randomUUID();

    const res = await app.inject({
      method: 'POST',
      url: '/api/applications/review-batch',
      headers: authed(auth),
      payload: { ids: [ok1, fantasma, ok2], action: 'approve' },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json<{
      ok: boolean;
      items: Array<{ id: string; ok: boolean; error?: string }>;
    }>();
    assert.equal(body.ok, false);
    assert.deepEqual(
      body.items.map((i) => [i.id, i.ok]),
      [
        [ok1, true],
        [fantasma, false],
        [ok2, true],
      ],
    );
    assert.equal(body.items[1].error, 'candidatura_no_encontrada');

    const estados = await query<{ id: string; status: string }>(
      `SELECT id, status FROM applications WHERE id = ANY($1)`,
      [[ok1, ok2]],
    );
    assert.deepEqual(estados.map((r) => r.status).sort(), ['approved', 'approved']);
  });

  it('batch: rechaza en lote con motivo y exige el motivo', async () => {
    const a = await crearCandidatura();
    const b = await crearCandidatura();

    const sinMotivo = await app.inject({
      method: 'POST',
      url: '/api/applications/review-batch',
      headers: authed(auth),
      payload: { ids: [a, b], action: 'reject' },
    });
    assert.equal(sinMotivo.statusCode, 400);

    const res = await app.inject({
      method: 'POST',
      url: '/api/applications/review-batch',
      headers: authed(auth),
      payload: { ids: [a, b], action: 'reject', reason: 'No encaja.' },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json<{ ok: boolean }>();
    assert.equal(body.ok, true);
    const n = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM applications WHERE id = ANY($1) AND status = 'withdrawn'`,
      [[a, b]],
    );
    assert.equal(n[0].n, '2');
  });

  it('batch: valida ids (máximo 50, UUID válido)', async () => {
    const demasiados = await app.inject({
      method: 'POST',
      url: '/api/applications/review-batch',
      headers: authed(auth),
      payload: { ids: Array.from({ length: 51 }, () => randomUUID()), action: 'approve' },
    });
    assert.equal(demasiados.statusCode, 400);

    const malUuid = await app.inject({
      method: 'POST',
      url: '/api/applications/review-batch',
      headers: authed(auth),
      payload: { ids: ['no-es-uuid'], action: 'approve' },
    });
    assert.equal(malUuid.statusCode, 400);
  });

  it('resolver una intervención ya no exige nota (corrección de auditoría)', async () => {
    const appId = await crearCandidatura({ appStatus: 'approved' });
    const ins = await query<{ id: string }>(
      `INSERT INTO interventions (kind, application_id, context)
       VALUES ('datos_desconocidos', $1, '{}'::jsonb) RETURNING id`,
      [appId],
    );

    const res = await app.inject({
      method: 'POST',
      url: `/api/interventions/${ins[0].id}/resolve`,
      headers: authed(auth),
      payload: { resolution: 'resuelta' },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json<{ intervention: { status: string } }>().intervention.status, 'resuelta');
  });
});
