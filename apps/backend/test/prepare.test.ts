/**
 * Tests de la Fase 7 (preparación de candidaturas y documentos).
 *
 * - prepararCandidatura: crea la candidatura en ready_for_review con
 *   snapshot y portal detectado; genera CV + carta PDF reales (Chromium
 *   local) y registra documents con sha256 verificable.
 * - Idempotencia, estados intocables, sin perfil → no crea nada, fallo de
 *   generación → draft con failure_reason.
 * - prepararElegibles: umbral de la política activa + veredicto cumple.
 * - Endpoint manual POST /api/campaigns/:id/offers/:offerId/prepare.
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { prepararCandidatura, prepararElegibles } from '../src/prepare.js';

let baseTmp = '';

/** Siembra una versión de perfil ACTIVA con hechos mínimos pero completos. */
async function seedPerfilActivo(): Promise<void> {
  const v = await query<{ id: string }>(
    `INSERT INTO profile_versions (status, source) VALUES ('active', 'test') RETURNING id`,
  );
  const vid = v[0].id;
  const facts: Array<[string, string, unknown]> = [
    ['identity', 'full_name', 'Jon Peciña Iturbe'],
    ['identity', 'email', 'jpecina@gmail.com'],
    ['identity', 'linkedin', 'linkedin.com/in/jpecina'],
    ['identity', 'location', { city: 'Logroño', country: 'España' }],
    ['identity', 'phone', '+34 600000000'],
    ['experience', 'experience_summary_claim', { text: 'over 15 years of experience', note: 'literal' }],
    [
      'experience',
      'exp_surexport',
      { start: '2023-11', end: '2026-06', title: 'CFO', company: 'SurExport Peru Berries SAC', location: 'Lima, Perú' },
    ],
    [
      'experience',
      'exp_dufry',
      { start: '2021-04', end: '2023-09', title: 'Financial Accountant', company: 'DUFRY SSC', location: 'Eindhoven, Países Bajos', context: 'entorno multinacional' },
    ],
    [
      'education',
      'edu_industrial',
      { start: '1997', end: '2003', degree: 'Ingeniero Industrial', institution: 'Universidad de Navarra', official: true, issued: 'Pamplona, 28 de junio de 2003' },
    ],
    [
      'education',
      'edu_emba',
      { start: '2012', end: '2013', degree: 'Master in Business Administration-Executive', institution: 'ICADE Business School', official: false, warning: 'Título propio, carente de carácter oficial (consta en el propio documento). NO presentar nunca como máster oficial.' },
    ],
    ['skills', 'skills_core', ['conciliación financiera', 'liderazgo de equipos globales', 'IFRS e informes financieros']],
    ['skills', 'skills_erp', ['SAP', 'Oracle', 'NetSuite']],
    ['languages', 'lang_es', { language: 'español', level: 'nativo' }],
    ['languages', 'lang_en', { language: 'inglés', level: 'avanzado' }],
    [
      'certifications',
      'cert_accounting',
      { date: '2023-04-17', name: 'Accounting Analysis I', issuer: 'University of Illinois (Coursera)', verify_url: 'https://coursera.org/verify/XXXX' },
    ],
  ];
  for (const [category, key, value] of facts) {
    await query(
      `INSERT INTO profile_facts (profile_version_id, category, key, value, source)
       VALUES ($1, $2, $3, $4::jsonb, 'test')`,
      [vid, category, key, JSON.stringify(value)],
    );
  }
}

interface SeedOpts {
  verdict?: string;
  score?: number | null;
  url?: string;
  evaluada?: boolean;
}

/** Campaña + oferta + (opcional) evaluación. Devuelve los ids. */
async function seedOferta(opts: SeedOpts = {}): Promise<{ campaignId: string; offerId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const url = opts.url ?? `https://acme.jobs.personio.com/job/${suffix}`;
  const c = await query<{ id: string }>(
    `INSERT INTO campaigns (name, criteria) VALUES ('camp-f7', '{}'::jsonb) RETURNING id`,
  );
  const o = await query<{ id: string }>(
    `INSERT INTO offers (campaign_id, canonical_url, url, title, company)
     VALUES ($1, $2, $2, 'Finance Manager', 'Acme Corp') RETURNING id`,
    [c[0].id, url],
  );
  if (opts.evaluada !== false) {
    await query(
      `INSERT INTO evaluations (offer_id, campaign_id, mandatory_verdict, mandatory_details, score, breakdown)
       VALUES ($1, $2, $3, '[]'::jsonb, $4, '[]'::jsonb)`,
      [o[0].id, c[0].id, opts.verdict ?? 'cumple', opts.score === undefined ? 85 : opts.score],
    );
  }
  return { campaignId: c[0].id, offerId: o[0].id };
}

describe('preparación de candidaturas (Fase 7)', () => {
  let app: FastifyInstance;
  let auth: AuthContext;

  before(async () => {
    baseTmp = mkdtempSync(join(tmpdir(), 'jf7-docs-'));
    process.env.JOBFORCE_WORKSPACE_BASE = baseTmp;
    app = await buildTestApp();
  });

  after(async () => {
    delete process.env.JOBFORCE_WORKSPACE_BASE;
    await closeTestApp(app);
  });

  beforeEach(async () => {
    await resetDb();
    auth = await setupAndLogin(app);
  });

  it('prepara una candidatura: ready_for_review, snapshot y portal personio', async () => {
    await seedPerfilActivo();
    const { campaignId, offerId } = await seedOferta({ score: 85 });

    const res = await prepararCandidatura(campaignId, offerId, {});
    assert.equal(res.status, 'ready_for_review');
    assert.equal(res.creada, true);
    assert.ok(res.applicationId);

    const rows = await query<{
      status: string;
      portal: string;
      offer_snapshot: { titulo: string; empresa: string; portal: string; score: number; mandatory_verdict: string };
    }>(`SELECT status, portal, offer_snapshot FROM applications WHERE id = $1`, [res.applicationId]);
    assert.equal(rows[0].status, 'ready_for_review');
    assert.equal(rows[0].portal, 'personio');
    assert.equal(rows[0].offer_snapshot.titulo, 'Finance Manager');
    assert.equal(rows[0].offer_snapshot.empresa, 'Acme Corp');
    assert.equal(rows[0].offer_snapshot.portal, 'personio');
    assert.equal(rows[0].offer_snapshot.score, 85);
    assert.equal(rows[0].offer_snapshot.mandatory_verdict, 'cumple');
  });

  it('genera CV y carta PDF reales y registra documents con sha256 correcto', async () => {
    await seedPerfilActivo();
    const { campaignId, offerId } = await seedOferta({});

    const res = await prepararCandidatura(campaignId, offerId, {});
    assert.equal(res.status, 'ready_for_review');

    const docs = await query<{
      kind: string;
      format: string;
      version: number;
      file_path: string;
      bytes: number;
      sha256: string;
    }>(
      `SELECT kind, format, version, file_path, bytes, sha256 FROM documents
        WHERE application_id = $1 ORDER BY kind`,
      [res.applicationId],
    );
    assert.equal(docs.length, 2);
    assert.deepEqual(
      docs.map((d) => d.kind).sort(),
      ['cover_letter', 'cv'],
    );
    for (const d of docs) {
      assert.equal(d.format, 'pdf');
      assert.equal(d.version, 1);
      assert.ok(d.file_path.startsWith(`jobforce/documents/${res.applicationId}/`), d.file_path);
      const abs = join(baseTmp, d.file_path);
      assert.ok(existsSync(abs), `debe existir ${abs}`);
      const buf = readFileSync(abs);
      assert.equal(buf.length, d.bytes);
      assert.equal(createHash('sha256').update(buf).digest('hex'), d.sha256);
      assert.ok(buf.subarray(0, 4).toString('latin1') === '%PDF', 'es un PDF real');
    }
  });

  it('es idempotente: la segunda preparación no duplica ni regenera', async () => {
    await seedPerfilActivo();
    const { campaignId, offerId } = await seedOferta({});

    const primera = await prepararCandidatura(campaignId, offerId, {});
    const segunda = await prepararCandidatura(campaignId, offerId, {});
    assert.equal(segunda.applicationId, primera.applicationId);
    assert.equal(segunda.creada, false);
    assert.equal(segunda.status, 'ready_for_review');
    assert.equal(segunda.motivo, 'ya_preparada');

    const apps = await query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM applications`);
    assert.equal(apps[0].n, '1');
    const docs = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM documents WHERE application_id = $1`,
      [primera.applicationId],
    );
    assert.equal(docs[0].n, '2');
  });

  it('sin perfil activo no crea ninguna candidatura', async () => {
    const { campaignId, offerId } = await seedOferta({});
    const res = await prepararCandidatura(campaignId, offerId, {});
    assert.equal(res.applicationId, null);
    assert.equal(res.motivo, 'sin_perfil_activo_o_incompleto');
    const apps = await query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM applications`);
    assert.equal(apps[0].n, '0');
  });

  it('con perfil por rol en la campaña, CV y carta abren con el bloque del rol; sin rol, no', async () => {
    await seedPerfilActivo();
    const perfiles = await query<{ id: string }>(
      `SELECT id FROM role_profiles WHERE name = 'Finance Manager / CFO'`,
    );
    assert.equal(perfiles.length, 1, 'la semilla de perfiles por rol debe existir');
    const roleId = perfiles[0].id;

    const capturar = () => {
      const htmls: string[] = [];
      return {
        htmls,
        render: async (html: string, pdfPath: string) => {
          htmls.push(html);
          writeFileSync(pdfPath, Buffer.from('%PDF-ficticio'));
        },
      };
    };

    // Con rol: ambos documentos (CV y carta) abren con el bloque del rol.
    const conRol = await seedOferta({});
    await query(`UPDATE campaigns SET role_profile_id = $2 WHERE id = $1`, [
      conRol.campaignId,
      roleId,
    ]);
    const cap1 = capturar();
    const res1 = await prepararCandidatura(conRol.campaignId, conRol.offerId, {
      deps: { render: cap1.render },
    });
    assert.equal(res1.status, 'ready_for_review');
    assert.equal(cap1.htmls.length, 2);
    for (const html of cap1.htmls) {
      assert.match(html, /Profesional de finanzas con más de 15 años entre España/);
      assert.match(html, /Role focus skills: IFRS, SAP, Oracle/);
    }

    // Sin rol: ningún documento contiene el bloque del rol.
    const sinRol = await seedOferta({});
    const cap2 = capturar();
    const res2 = await prepararCandidatura(sinRol.campaignId, sinRol.offerId, {
      deps: { render: cap2.render },
    });
    assert.equal(res2.status, 'ready_for_review');
    assert.equal(cap2.htmls.length, 2);
    for (const html of cap2.htmls) {
      assert.doesNotMatch(html, /Role focus skills/);
    }
  });

  it('si la generación falla, queda en draft con failure_reason y se puede reintentar', async () => {
    await seedPerfilActivo();
    const { campaignId, offerId } = await seedOferta({});

    const fallida = await prepararCandidatura(campaignId, offerId, {
      deps: {
        render: async () => {
          throw new Error('chromium de test explotó');
        },
      },
    });
    assert.equal(fallida.status, 'draft');
    assert.match(fallida.motivo ?? '', /error_generando_documentos/);

    const rows = await query<{ status: string; failure_reason: string }>(
      `SELECT status, failure_reason FROM applications WHERE id = $1`,
      [fallida.applicationId],
    );
    assert.equal(rows[0].status, 'draft');
    assert.match(rows[0].failure_reason, /chromium de test/);

    const reintento = await prepararCandidatura(campaignId, offerId, {});
    assert.equal(reintento.status, 'ready_for_review');
  });

  it('no toca candidaturas en estados posteriores a ready_for_review', async () => {
    await seedPerfilActivo();
    const { campaignId, offerId } = await seedOferta({});
    await query(
      `INSERT INTO applications (campaign_id, offer_id, status, portal)
       VALUES ($1, $2, 'approved', 'personio')`,
      [campaignId, offerId],
    );
    const res = await prepararCandidatura(campaignId, offerId, {});
    assert.equal(res.status, 'approved');
    assert.equal(res.motivo, 'ya_en_curso_o_finalizada');
    const docs = await query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM documents`);
    assert.equal(docs[0].n, '0');
  });

  it('prepararElegibles respeta veredicto y umbral de la política activa (70)', async () => {
    await seedPerfilActivo();
    const ok = await seedOferta({ verdict: 'cumple', score: 72 });
    const bajo = await seedOferta({ verdict: 'cumple', score: 65 });
    const incumple = await seedOferta({ verdict: 'incumple', score: 95 });
    const sinEv = await seedOferta({ verdict: 'sin_evidencia', score: 95 });

    const sweep = await prepararElegibles(ok.campaignId, null);
    // La primera campaña solo contiene su propia oferta.
    assert.equal(sweep.candidatas, 1);
    assert.equal(sweep.preparadas, 1);

    const apps = await query<{ offer_id: string; status: string }>(
      `SELECT offer_id, status FROM applications`,
    );
    assert.equal(apps.length, 1);
    assert.equal(apps[0].offer_id, ok.offerId);
    assert.equal(apps[0].status, 'ready_for_review');

    // Las demás campañas no se ven afectadas por el barrido de otra.
    for (const otra of [bajo, incumple, sinEv]) {
      const s = await prepararElegibles(otra.campaignId, null);
      assert.equal(s.preparadas, 0, `campaña ${otra.campaignId} no debía preparar`);
    }
    const total = await query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM applications`);
    assert.equal(total[0].n, '1');
  });

  it('endpoint manual: prepara por debajo del umbral y 409 sin evaluación', async () => {
    await seedPerfilActivo();
    const baja = await seedOferta({ verdict: 'cumple', score: 50 });
    const res = await app.inject({
      method: 'POST',
      url: `/api/campaigns/${baja.campaignId}/offers/${baja.offerId}/prepare`,
      headers: authed(auth),
    });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json<{ application: { status: string }; creada: boolean }>();
    assert.equal(body.application.status, 'ready_for_review');
    assert.equal(body.creada, true);

    const sinEval = await seedOferta({ evaluada: false });
    const res409 = await app.inject({
      method: 'POST',
      url: `/api/campaigns/${sinEval.campaignId}/offers/${sinEval.offerId}/prepare`,
      headers: authed(auth),
    });
    assert.equal(res409.statusCode, 409);
    assert.deepEqual(res409.json(), { error: 'oferta_sin_evaluacion' });

    // Sin sesión → 401.
    const anon = await app.inject({
      method: 'POST',
      url: `/api/campaigns/${baja.campaignId}/offers/${baja.offerId}/prepare`,
    });
    assert.equal(anon.statusCode, 401);
  });
});
