/**
 * Tests del Agente conversacional (aplicación directa por URL).
 *
 * - El intérprete de comandos es determinista (sin LLM).
 * - Flujo completo con Personio: ingesta (Exa simulado) → evaluación →
 *   documentos → aprobación por orden del chat → envío encolado.
 * - Enlace confirmado roto: se para antes de crear nada.
 * - Portal sin driver (Workday): queda preparada, sin aprobar ni enviar.
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { parseAgentCommand, resetAgentTestDeps, setAgentTestDeps } from '../src/agent.js';
import { resetSendTestDeps, setSendTestDeps } from '../src/routes/sends.js';

const PERSONIO_URL = 'https://acme.jobs.personio.com/job/1234567';
const WORKDAY_URL =
  'https://acme.wd5.myworkdayjobs.com/en-US/Acme/job/Finance-Manager_R-9001';

const EXA_TEXT = [
  '# Finance Manager at Acme Corp',
  '',
  'We are looking for a Senior Finance Manager to lead our accounting and',
  'reporting team. You will own IFRS reporting, consolidation, treasury and',
  'controlling, working with SAP, Oracle and advanced Excel. English is our',
  'working language. This is a remote position based in Spain with a',
  'permanent contract and a competitive salary. Join a multinational,',
  'global group with a senior leadership role and relocation support.',
].join('\n');

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
      'education',
      'edu_industrial',
      { start: '1997', end: '2003', degree: 'Ingeniero Industrial', institution: 'Universidad de Navarra', official: true, issued: 'Pamplona, 28 de junio de 2003' },
    ],
    ['skills', 'skills_core', ['conciliación financiera', 'IFRS e informes financieros']],
    ['skills', 'skills_erp', ['SAP', 'Oracle', 'NetSuite']],
    ['languages', 'lang_es', { language: 'español', level: 'nativo' }],
    ['languages', 'lang_en', { language: 'inglés', level: 'avanzado' }],
  ];
  for (const [category, key, value] of facts) {
    await query(
      `INSERT INTO profile_facts (profile_version_id, category, key, value, source)
       VALUES ($1, $2, $3, $4::jsonb, 'test')`,
      [vid, category, key, JSON.stringify(value)],
    );
  }
}

async function waitForJob(jobId: string, timeoutMs = 90_000): Promise<{ status: string; step: string | null }> {
  const start = Date.now();
  for (;;) {
    const rows = await query<{ status: string; step: string | null }>(
      `SELECT status, step FROM agent_jobs WHERE id = $1`,
      [jobId],
    );
    if (rows[0] && rows[0].status !== 'running') return rows[0];
    if (Date.now() - start > timeoutMs) throw new Error('timeout esperando al job del agente');
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe('agente conversacional', () => {
  let app: FastifyInstance;
  let auth: AuthContext;

  before(async () => {
    process.env.JOBFORCE_WORKSPACE_BASE = mkdtempSync(join(tmpdir(), 'jf-agent-docs-'));
    app = await buildTestApp();
  });

  after(async () => {
    delete process.env.JOBFORCE_WORKSPACE_BASE;
    resetAgentTestDeps();
    resetSendTestDeps();
    await closeTestApp(app);
  });

  beforeEach(async () => {
    await resetDb();
    resetAgentTestDeps();
    resetSendTestDeps();
    auth = await setupAndLogin(app);
    // Política autorizada (el modo sembrado, preparar_para_revision, ya
    // encadena el envío tras la aprobación).
    await query(
      `UPDATE autonomy_policies SET authorized_by = $1, authorized_at = now()`,
      [auth.userId],
    );
    await seedPerfilActivo();
  });

  it('parseAgentCommand: aplica/estado/ayuda/desconocido', () => {
    assert.deepEqual(parseAgentCommand(`aplica a esta oferta: ${PERSONIO_URL}`), {
      type: 'apply',
      url: PERSONIO_URL,
    });
    assert.deepEqual(parseAgentCommand(PERSONIO_URL), { type: 'apply', url: PERSONIO_URL });
    assert.deepEqual(parseAgentCommand('¿cómo va el estado?'), { type: 'status' });
    assert.deepEqual(parseAgentCommand('ayuda'), { type: 'help' });
    assert.deepEqual(parseAgentCommand('buenos días'), { type: 'unknown' });
  });

  it('flujo completo Personio: ingesta → documentos → aprobada → envío encolado', async () => {
    setAgentTestDeps({
      getContents: async () => ({
        title: 'Finance Manager at Acme Corp',
        url: PERSONIO_URL,
        text: EXA_TEXT,
        highlights: ['Senior Finance Manager — IFRS reporting, SAP, remote, English.'],
      }),
      checkUrl: async () => ({ status: 'alive', via: 'http' }),
      pollMs: 5,
      pollMax: 2,
    });
    setSendTestDeps({ offerProbe: async () => ({ ok: true, detalle: 'viva (fake)' }) });

    const res = await authed(app, auth, {
      method: 'POST',
      url: '/api/agent/messages',
      payload: { text: `aplica a esta oferta: ${PERSONIO_URL}` },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { accepted: boolean; jobId: string };
    assert.equal(body.accepted, true);

    const job = await waitForJob(body.jobId);
    // El worker no corre en tests: el envío queda encolado y el job
    // termina informando de que sigue en curso.
    assert.equal(job.status, 'done');
    assert.equal(job.step, 'envio_en_curso');

    const apps = await query<{ status: string; portal: string }>(
      `SELECT status, portal FROM applications`,
    );
    assert.equal(apps.length, 1);
    assert.equal(apps[0].status, 'approved');
    assert.equal(apps[0].portal, 'personio');
    const sends = await query<{ id: string }>(`SELECT id FROM sends`);
    assert.equal(sends.length, 1);
    const msgs = await query<{ content: string }>(
      `SELECT content FROM agent_messages WHERE role = 'agent' ORDER BY created_at`,
    );
    const all = msgs.map((m) => m.content).join('\n');
    assert.ok(all.includes('Oferta registrada'), 'mensaje de registro');
    assert.ok(all.includes('Envío encolado'), 'mensaje de encolado');
  });

  it('enlace confirmado roto: se para sin crear oferta ni candidatura', async () => {
    setAgentTestDeps({
      getContents: async () => {
        throw new Error('getContents no debe llamarse si el enlace está roto');
      },
      checkUrl: async () => ({ status: 'broken', via: 'workday_api' }),
    });
    const res = await authed(app, auth, {
      method: 'POST',
      url: '/api/agent/messages',
      payload: { text: `aplica a ${WORKDAY_URL}` },
    });
    const body = res.json() as { jobId: string };
    const job = await waitForJob(body.jobId);
    assert.equal(job.status, 'blocked');
    assert.equal(job.step, 'enlace_roto');
    assert.equal((await query(`SELECT id FROM offers`)).length, 0);
    assert.equal((await query(`SELECT id FROM applications`)).length, 0);
  });

  it('portal sin driver (Workday): queda preparada en Revisión, sin aprobar', async () => {
    setAgentTestDeps({
      getContents: async () => ({
        title: 'Finance Manager at Acme Corp',
        url: WORKDAY_URL,
        text: EXA_TEXT,
        highlights: ['Finance Manager — IFRS, SAP, remote, English.'],
      }),
      checkUrl: async () => ({ status: 'alive', via: 'workday_api' }),
    });
    const res = await authed(app, auth, {
      method: 'POST',
      url: '/api/agent/messages',
      payload: { text: `aplica a esta oferta: ${WORKDAY_URL}` },
    });
    const body = res.json() as { jobId: string };
    const job = await waitForJob(body.jobId);
    assert.equal(job.status, 'done');
    assert.equal(job.step, 'preparada_sin_driver');
    const apps = await query<{ status: string }>(`SELECT status FROM applications`);
    assert.equal(apps.length, 1);
    assert.equal(apps[0].status, 'ready_for_review');
    assert.equal((await query(`SELECT id FROM sends`)).length, 0);
  });
});
