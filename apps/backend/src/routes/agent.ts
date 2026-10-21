/**
 * @jobforce/backend — Rutas del chat del Agente (aplicación directa).
 *
 * - POST /api/agent/messages → el usuario escribe; si el mensaje trae
 *   una orden de aplicación, se crea un agent_job y el pipeline corre en
 *   segundo plano (los pasos llegan como mensajes del agente). Los
 *   comandos «estado»/«ayuda» se responden al momento.
 * - GET  /api/agent/conversation → últimos mensajes + jobs recientes
 *   (la pantalla hace polling mientras haya un job en curso).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '@jobforce/config';
import { query } from '@jobforce/database';
import {
  AGENT_HELP,
  addAgentMessage,
  latestJobSummary,
  parseAgentCommand,
  runAgentJob,
} from '../agent.js';
import { requireCsrf, requireSession } from '../auth.js';
import { validateBody } from '../validation.js';

const authOnly = { preHandler: [requireSession] };
const mutating = { preHandler: [requireSession, requireCsrf] };

const MessageBody = z.object({
  text: z.string().min(1).max(2000),
});

interface MessageRow {
  id: string;
  job_id: string | null;
  role: string;
  content: string;
  created_at: Date;
}

interface JobRow {
  id: string;
  url: string;
  status: string;
  step: string | null;
  application_id: string | null;
  created_at: Date;
  finished_at: Date | null;
}

const toIso = (d: Date | string): string => (d instanceof Date ? d.toISOString() : String(d));

export async function registerAgentRoutes(
  app: FastifyInstance,
  config: AppConfig,
): Promise<void> {
  app.get('/api/agent/conversation', authOnly, async () => {
    const messages = await query<MessageRow>(
      `SELECT id, job_id, role, content, created_at
         FROM agent_messages ORDER BY created_at DESC LIMIT 120`,
    );
    const jobs = await query<JobRow>(
      `SELECT id, url, status, step, application_id, created_at, finished_at
         FROM agent_jobs ORDER BY created_at DESC LIMIT 10`,
    );
    return {
      messages: messages.reverse().map((m) => ({
        id: m.id,
        jobId: m.job_id,
        role: m.role,
        content: m.content,
        createdAt: toIso(m.created_at),
      })),
      jobs: jobs.map((j) => ({
        id: j.id,
        url: j.url,
        status: j.status,
        step: j.step,
        applicationId: j.application_id,
        createdAt: toIso(j.created_at),
        finishedAt: j.finished_at ? toIso(j.finished_at) : null,
      })),
      running: jobs.some((j) => j.status === 'running'),
    };
  });

  app.post('/api/agent/messages', mutating, async (req, reply) => {
    const valid = validateBody(MessageBody, req.body ?? {}, reply);
    if (!valid) return;
    const text = valid.data.text.trim();
    const actorId = req.authSession?.userId ?? null;
    await addAgentMessage(null, 'user', text);

    const cmd = parseAgentCommand(text);
    if (cmd.type === 'apply') {
      // Un solo encargo en curso: el pipeline comparte worker y política.
      const running = await query<{ id: string }>(
        `SELECT id FROM agent_jobs WHERE status = 'running' LIMIT 1`,
      );
      if (running.length > 0) {
        await addAgentMessage(
          null,
          'agent',
          '⏳ Ya tengo una aplicación en curso. Espera a que termine (puedes pedirme «estado») y me encargas la siguiente.',
        );
        return reply.send({ ok: true, accepted: false, reason: 'job_en_curso' });
      }
      const inserted = await query<{ id: string }>(
        `INSERT INTO agent_jobs (url, created_by) VALUES ($1, $2) RETURNING id`,
        [cmd.url, actorId],
      );
      const jobId = inserted[0].id;
      await addAgentMessage(jobId, 'agent', `🤖 Encargo aceptado: voy a aplicar a ${cmd.url}`);
      // En segundo plano: los pasos se publican como mensajes del chat.
      void runAgentJob(jobId, cmd.url, { config, actorId }).catch(
        () => undefined,
      );
      return reply.send({ ok: true, accepted: true, jobId });
    }
    if (cmd.type === 'status') {
      await addAgentMessage(null, 'agent', await latestJobSummary());
      return reply.send({ ok: true, accepted: false });
    }
    if (cmd.type === 'help') {
      await addAgentMessage(null, 'agent', AGENT_HELP);
      return reply.send({ ok: true, accepted: false });
    }
    await addAgentMessage(
      null,
      'agent',
      'No te he entendido. ' + AGENT_HELP,
    );
    return reply.send({ ok: true, accepted: false });
  });
}
