/**
 * @jobforce/backend — Agente conversacional de aplicación directa.
 *
 * El usuario escribe en el chat «aplica a esta oferta: <url>» y el agente
 * ejecuta la cadena completa reutilizando la maquinaria existente:
 *
 *   1. Ingesta de la URL en la campaña interna «Aplicaciones directas
 *      (Agente)»: Exa getContents (título, texto, empresa) + sonda de
 *      enlace — si está CONFIRMADO roto, se para antes de gastar nada.
 *   2. Evaluación determinista informativa (nunca bloquea por sí sola:
 *      la orden la da el usuario; el suelo duro vive en decidirEnvio).
 *   3. prepararCandidatura → CV + carta en PDF (motor de documentos).
 *   4. Aprobación: la orden explícita del chat ES la aprobación de Jon
 *      (applyDecision + encadenarEnvioTrasAprobacion, como el botón de
 *      Revisión): checks de pre-envío + política + worker.
 *   5. Seguimiento del envío hasta submitted / submission_failed.
 *
 * Canales: Personio (worker) y email (Gmail, con permiso de envío).
 * Si el anuncio deriva a otro portal, se sigue la derivación y el
 * encargo se intenta en el destino. Parada honesta solo cuando el
 * destino no tiene driver verificado (a menudo exige crear cuenta):
 * la candidatura queda preparada en Revisión y el agente dice el
 * motivo concreto, nombrando el portal de destino.
 *
 * Sin LLM: el chat interpreta comandos de forma determinista, igual que
 * el resto del sistema.
 */

import { join, resolve } from 'node:path';
import type { AppConfig } from '@jobforce/config';
import { query } from '@jobforce/database';
import { defaultCriteria, type CampaignCriteria } from '@jobforce/domain';
import { detectNationalityRestriction, evaluateOffer } from '@jobforce/eval';
import {
  canonicalUrl,
  checkUrlStatusDetailed,
  createExaClient,
  extractApplicationContact,
  extractApplyUrl,
  extractCompany,
  extractLocation,
  type ExaResult,
} from '@jobforce/search';
import { auditEvent } from './audit.js';
import {
  gmailSendCapable,
  sendGmailApplication,
  type GmailApplicationInput,
} from './gmail-send.js';
import {
  construirPerfilCandidato,
  detectarPortal,
  prepararCandidatura,
} from './prepare.js';
import { workspaceBase } from './workspace.js';
import { loadActiveProfileFacts } from './routes/campaigns.js';
import { applyDecision, encadenarEnvioTrasAprobacion } from './routes/review.js';

export const DIRECT_CAMPAIGN_NAME = 'Aplicaciones directas (Agente)';

const SEND_POLL_MS = 8_000;
const SEND_POLL_MAX = 30; // ~4 minutos de seguimiento del worker

// ---------------------------------------------------------------------------
// Dependencias inyectables (tests)
// ---------------------------------------------------------------------------

export interface AgentDeps {
  getContents?: (url: string) => Promise<ExaResult | null>;
  checkUrl?: typeof checkUrlStatusDetailed;
  /** Seguimiento del worker de envíos (tests lo acortan). */
  pollMs?: number;
  pollMax?: number;
  /** Canal email (tests): capacidad y envío por Gmail. */
  gmailCanSend?: () => Promise<boolean>;
  sendEmail?: (input: GmailApplicationInput) => Promise<{ messageId: string }>;
}

let testDeps: AgentDeps = {};

export function setAgentTestDeps(deps: AgentDeps): void {
  testDeps = deps;
}

export function resetAgentTestDeps(): void {
  testDeps = {};
}

// ---------------------------------------------------------------------------
// Intérprete de comandos (determinista)
// ---------------------------------------------------------------------------

export type AgentCommand =
  | { type: 'apply'; url: string }
  | { type: 'status' }
  | { type: 'help' }
  | { type: 'unknown' };

const URL_RE = /https?:\/\/[^\s<>"')\]]+/i;

/** Extrae la primera URL de un texto, limpiando puntuación final típica. */
export function extractUrl(text: string): string | null {
  const m = text.match(URL_RE);
  if (!m) return null;
  return m[0].replace(/[.,;:!?]+$/g, '');
}

export function parseAgentCommand(text: string): AgentCommand {
  const url = extractUrl(text);
  const t = text.toLowerCase();
  if (url && /(aplica|aplicar|apply|postula|inscribe)/.test(t)) return { type: 'apply', url };
  if (url) return { type: 'apply', url };
  if (/(estado|status|progreso|cómo va|como va)/.test(t)) return { type: 'status' };
  if (/(ayuda|help|qué puedes|que puedes|comandos)/.test(t)) return { type: 'help' };
  return { type: 'unknown' };
}

export const AGENT_HELP =
  'Puedo aplicar por ti a una oferta concreta. Escríbeme «aplica a esta oferta: <url>» (o pega directamente el enlace) y me encargo de todo: compruebo el enlace, sigo la derivación al portal real si el anuncio aplica en otro sitio, genero el CV y la carta, y envío la candidatura (Personio e iCIMS automáticamente —en iCIMS creo tu cuenta si hace falta—; por correo si el anuncio lo pide y Gmail tiene permiso de envío). Si un portal no me deja aplicar solo, te digo el motivo concreto y te dejo todo preparado. Con «estado» te digo cómo va el último encargo.';

// ---------------------------------------------------------------------------
// Mensajes y jobs
// ---------------------------------------------------------------------------

export async function addAgentMessage(
  jobId: string | null,
  role: 'user' | 'agent',
  content: string,
): Promise<void> {
  await query(`INSERT INTO agent_messages (job_id, role, content) VALUES ($1, $2, $3)`, [
    jobId,
    role,
    content,
  ]);
}

async function setJobState(
  jobId: string,
  patch: { status?: string; step?: string; offerId?: string; applicationId?: string },
): Promise<void> {
  const sets: string[] = ['updated_at = now()'];
  const params: unknown[] = [jobId];
  if (patch.status) {
    params.push(patch.status);
    sets.push(`status = $${params.length}`);
    if (patch.status !== 'running') sets.push('finished_at = now()');
  }
  if (patch.step) {
    params.push(patch.step);
    sets.push(`step = $${params.length}`);
  }
  if (patch.offerId) {
    params.push(patch.offerId);
    sets.push(`offer_id = $${params.length}`);
  }
  if (patch.applicationId) {
    params.push(patch.applicationId);
    sets.push(`application_id = $${params.length}`);
  }
  await query(`UPDATE agent_jobs SET ${sets.join(', ')} WHERE id = $1`, params);
}

// ---------------------------------------------------------------------------
// Campaña interna de aplicaciones directas
// ---------------------------------------------------------------------------

export async function getOrCreateDirectCampaign(actorId: string | null): Promise<{
  id: string;
  criteria: CampaignCriteria;
}> {
  const rows = await query<{ id: string; criteria: CampaignCriteria }>(
    `SELECT id, criteria FROM campaigns WHERE name = $1 ORDER BY created_at ASC LIMIT 1`,
    [DIRECT_CAMPAIGN_NAME],
  );
  if (rows.length > 0) return { id: rows[0].id, criteria: rows[0].criteria };
  const criteria = defaultCriteria();
  const inserted = await query<{ id: string }>(
    `INSERT INTO campaigns (name, criteria, status, created_by)
     VALUES ($1, $2::jsonb, 'active', $3) RETURNING id`,
    [DIRECT_CAMPAIGN_NAME, JSON.stringify(criteria), actorId],
  );
  return { id: inserted[0].id, criteria };
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

async function defaultGetContents(apiKey: string | null, url: string): Promise<ExaResult | null> {
  if (!apiKey) return null;
  const client = createExaClient(apiKey);
  const resp = await client.getContents([url]);
  const first = resp.results[0];
  if (first) return first;
  const text = resp.texts.get(url);
  return text ? { id: url, title: '', url, text } : null;
}

export interface AgentJobContext {
  config: AppConfig;
  actorId: string | null;
}

/**
 * Ejecuta el encargo completo. Pensada para correr en segundo plano
 * (fire-and-forget desde la ruta): cada paso deja un mensaje en el chat
 * y el estado en agent_jobs. Nunca lanza: los fallos se convierten en
 * mensaje + job failed/blocked.
 */
export async function runAgentJob(jobId: string, rawUrl: string, ctx: AgentJobContext): Promise<void> {
  const say = async (text: string): Promise<void> => {
    await addAgentMessage(jobId, 'agent', text);
  };
  try {
    const url = rawUrl.trim();
    await setJobState(jobId, { step: 'ingesta' });
    const { id: campaignId, criteria } = await getOrCreateDirectCampaign(ctx.actorId);

    await processOfferUrl(jobId, url, ctx, campaignId, criteria, 0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'error desconocido';
    try {
      await say(`❌ Algo ha fallado en el proceso: ${msg.slice(0, 300)}`);
      await setJobState(jobId, { status: 'failed', step: 'error' });
    } catch {
      // La BD no responde: nada más que hacer aquí.
    }
  }
}

/**
 * Procesa UNA URL de oferta hasta dejar la candidatura enviada o con
 * un motivo concreto. Si el anuncio deriva la aplicación a otro portal
 * («How to apply … link below»), se sigue UNA vez: el encargo se
 * cumple en el portal de destino, no en el agregador.
 */
async function processOfferUrl(
  jobId: string,
  url: string,
  ctx: AgentJobContext,
  campaignId: string,
  criteria: CampaignCriteria,
  depth: number,
): Promise<void> {
  const say = async (text: string): Promise<void> => {
    await addAgentMessage(jobId, 'agent', text);
  };

  // 1) Sonda de enlace ANTES de gastar en contenidos/documentos.
  const check = testDeps.checkUrl ?? checkUrlStatusDetailed;
  const link = await check(url);
  if (link.status === 'broken') {
    await say(
      `⛔ No sigo: el enlace está confirmado como roto (${url}). La oferta ya no existe, así que no genero documentos ni aplico.`,
    );
    await setJobState(jobId, { status: 'blocked', step: 'enlace_roto' });
    return;
  }

  // 2) Contenidos de la oferta (Exa renderiza la página, JS incluido).
  const result = testDeps.getContents
    ? await testDeps.getContents(url)
    : await defaultGetContents(ctx.config.exaApiKey, url);
  if (!result || (!result.title && !result.text)) {
    await say(
      '⛔ No he podido leer la oferta (la página no devuelve contenido legible). No aplico a ciegas: revisa el enlace o aplica manualmente.',
    );
    await setJobState(jobId, { status: 'blocked', step: 'sin_contenido' });
    return;
  }
  // Elegibilidad dura: restringida a nacionales de otro país = nunca
  // podrás aplicar; no se registra ni se generan documentos.
  const nat = detectNationalityRestriction({
    title: result.title,
    url,
    highlights: result.highlights ?? [],
    fullText: result.text,
  });
  if (nat.restricted) {
    await say(
      `⛔ Esta oferta está restringida a nacionales del país («${nat.phrase ?? 'restricción de nacionalidad'}»). Nunca podrías aplicar a ella, así que no la registro ni genero documentos.`,
    );
    await setJobState(jobId, { status: 'blocked', step: 'restriccion_nacionalidad' });
    return;
  }

  // 2b) Seguir el canal: si el anuncio deriva a un portal externo para
  // aplicar, el encargo se cumple ALLÍ (y la oferta que se registra es
  // la del destino, no la del agregador).
  const applyUrl = extractApplyUrl(result.text, url);
  if (applyUrl && depth === 0) {
    let host = applyUrl;
    try {
      host = new URL(applyUrl).hostname;
    } catch {
      // se muestra la URL tal cual
    }
    await say(
      `↪️ Esta oferta no se aplica en esta página: sus instrucciones derivan al portal de la organización (${host}). Sigo el encargo allí.`,
    );
    return processOfferUrl(jobId, applyUrl, ctx, campaignId, criteria, depth + 1);
  }

  const title = result.title ?? 'Oferta sin título';
  const company = extractCompany({
    title: result.title,
    url,
    text: result.text,
    author: result.author,
  });

  // 3) Alta de la oferta en la campaña interna (dedupe por URL canónica).
  const canon = canonicalUrl(url);
  let offerId: string;
  const existing = await query<{ id: string }>(
    `SELECT id FROM offers WHERE campaign_id = $1 AND canonical_url = $2`,
    [campaignId, canon],
  );
  if (existing.length > 0) {
    offerId = existing[0].id;
  } else {
    const contact = extractApplicationContact(result.title, [
      ...(result.highlights ?? []),
      result.text ?? '',
    ]);
    const inserted = await query<{ id: string }>(
      `INSERT INTO offers
         (campaign_id, search_id, canonical_url, url, title, company,
          published_date, highlights, raw, application_email, application_notes,
          url_ok, url_checked_at, location)
       VALUES ($1, NULL, $2, $3, $4, $5, $6::date, $7::jsonb, $8::jsonb, $9, $10,
               $11, now(), $12)
       RETURNING id`,
      [
        campaignId,
        canon,
        url,
        result.title ?? null,
        company,
        result.publishedDate ?? null,
        JSON.stringify(result.highlights ?? []),
        JSON.stringify(result),
        contact?.email ?? null,
        contact?.notes ?? null,
        link.status === 'alive' ? true : null,
        extractLocation({ title: result.title, url, text: result.text }),
      ],
    );
    offerId = inserted[0].id;

    // Evaluación informativa con los hechos del perfil activo.
    const { facts, versionId } = await loadActiveProfileFacts();
    const ev = evaluateOffer(
      { title: result.title, url, highlights: result.highlights ?? [], fullText: result.text },
      criteria,
      facts,
    );
    await query(
      `INSERT INTO evaluations
         (offer_id, campaign_id, profile_version_id, mandatory_verdict,
          mandatory_details, score, breakdown)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb)
       ON CONFLICT (offer_id, campaign_id) DO NOTHING`,
      [
        offerId,
        campaignId,
        versionId,
        ev.mandatory_verdict,
        JSON.stringify(ev.mandatory_details),
        ev.score,
        JSON.stringify(ev.breakdown),
      ],
    );
    await say(
      `📋 Oferta registrada: «${title}»${company ? ` — ${company}` : ''}. ` +
        `Evaluación: ${ev.mandatory_verdict}${ev.score !== null ? ` (encaje ${ev.score.toFixed(2)})` : ''}. ` +
        (link.status === 'alive'
          ? 'Enlace verificado: sigue viva.'
          : 'El enlace no se ha podido verificar del todo, pero la oferta se ha leído bien.'),
    );
  }
  await setJobState(jobId, { offerId, step: 'preparacion' });

  // 4) Documentos: CV + carta (motor determinista existente).
  const prep = await prepararCandidatura(campaignId, offerId, { actorId: ctx.actorId });
  if (!prep.applicationId) {
    await say(
      `⛔ No se ha podido preparar la candidatura (motivo: ${prep.motivo ?? 'desconocido'}). ` +
        (prep.motivo === 'sin_perfil_activo_o_incompleto'
          ? 'Falta el perfil activo completo en la sección Perfil.'
          : 'Lo dejo aquí; puedes revisarlo en el panel.'),
    );
    await setJobState(jobId, { status: 'blocked', step: 'sin_candidatura' });
    return;
  }
  await setJobState(jobId, { applicationId: prep.applicationId, step: 'documentos' });
  let yaAprobada = false;
  if (prep.motivo === 'ya_en_curso_o_finalizada') {
    const st = await query<{ status: string }>(
      `SELECT status FROM applications WHERE id = $1`,
      [prep.applicationId],
    );
    const estado = st[0]?.status ?? prep.status;
    const envios = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM sends WHERE application_id = $1`,
      [prep.applicationId],
    );
    // Reanudable: preparada sin enviar, o aprobada en un encargo
    // anterior cuyo envío nunca llegó a encolarse (p. ej. bloqueado
    // entonces por un portal aún sin driver).
    const reanudable =
      estado === 'ready_for_review' || (estado === 'approved' && envios[0].n === 0);
    if (!reanudable) {
      await say(
        `ℹ️ Ya existe una candidatura para esta oferta en estado «${estado}». No duplico: puedes seguirla en Revisión/Histórico.`,
      );
      await setJobState(jobId, { status: 'done', step: 'ya_existia' });
      return;
    }
    yaAprobada = estado === 'approved';
    await say('↩️ Retomo la candidatura que ya estaba preparada: sigo con el envío.');
  } else {
    const docs = await query<{ kind: string }>(
      `SELECT DISTINCT kind FROM documents WHERE application_id = $1`,
      [prep.applicationId],
    );
    await say(
      `📄 Documentos generados: ${docs.map((d) => d.kind).join(' + ') || 'CV y carta'}. ` +
        'Tu orden en este chat cuenta como aprobación expresa: sigo con el envío.',
    );
  }

  // Reclasificación del portal con el detector vigente: la fila pudo
  // crearse cuando el portal aún no tenía driver (p. ej. «otro» antes
  // de existir iCIMS) y decidirEnvio usa el portal GUARDADO.
  await query(
    `UPDATE applications SET portal = $2, updated_at = now() WHERE id = $1 AND portal <> $2`,
    [prep.applicationId, detectarPortal(url)],
  );

  // 5) Canal de envío.
  const offerRow = await query<{
    application_email: string | null;
    application_notes: string | null;
  }>(`SELECT application_email, application_notes FROM offers WHERE id = $1`, [offerId]);
  const portal = detectarPortal(url);

  if (portal === 'personio' || portal === 'icims' || portal === 'workable' || portal === 'workday' || portal === 'ashby') {
    // 5a) Portal con driver: aprobación (la orden del chat) + worker.
    // La orden queda sellada en el snapshot: es la revisión favorable
    // de Jon para ESTA candidatura (decidirEnvio la reconoce).
    await query(
      `UPDATE applications
          SET offer_snapshot = offer_snapshot || $2::jsonb, updated_at = now()
        WHERE id = $1`,
      [prep.applicationId, JSON.stringify({ ordenDirecta: true, ordenDirectaJobId: jobId })],
    );
    await setJobState(jobId, { step: 'aprobacion_envio' });
    if (!yaAprobada) {
      await applyDecision(prep.applicationId, 'approve', undefined, ctx.actorId);
    }
    await auditEvent({
      actorId: ctx.actorId,
      action: 'agent_application_approved',
      entityType: 'application',
      entityId: prep.applicationId,
      details: { job_id: jobId, url, origen: 'chat_agente' },
    });
    const chain = await encadenarEnvioTrasAprobacion(prep.applicationId, ctx.actorId);
    if (!chain || chain.send === 'bloqueado') {
      await say(
        `⚠️ Candidatura aprobada, pero el envío ha quedado bloqueado por la política/checks${chain?.motivo ? `: ${chain.motivo}` : ''}. Queda en Revisión con el motivo registrado; no se ha enviado nada.`,
      );
      await setJobState(jobId, { status: 'blocked', step: 'envio_bloqueado' });
      return;
    }
    await say(
      portal === 'icims'
        ? '🚀 Envío encolado: el trabajador va a entrar en iCIMS (creando tu cuenta si aún no existe), rellenar la candidatura y enviarla…'
        : portal === 'workable'
          ? '🚀 Envío encolado: el trabajador va a rellenar el formulario de Workable y enviar la candidatura…'
          : portal === 'workday'
            ? '🚀 Envío encolado: el trabajador va a entrar en Workday (creando tu cuenta con tus credenciales si aún no existe), rellenar la candidatura paso a paso y enviarla…'
            : portal === 'ashby'
              ? '🚀 Envío encolado: el trabajador va a rellenar el formulario de Ashby y enviar la candidatura…'
              : '🚀 Envío encolado: el trabajador está rellenando la candidatura en Personio…',
    );

    // Seguimiento del worker hasta el resultado.
    const pollMs = testDeps.pollMs ?? SEND_POLL_MS;
    const pollMax = testDeps.pollMax ?? SEND_POLL_MAX;
    for (let i = 0; i < pollMax; i++) {
      await new Promise((r) => setTimeout(r, pollMs));
      const rows = await query<{ status: string; failure_reason: string | null }>(
        `SELECT status, failure_reason FROM applications WHERE id = $1`,
        [prep.applicationId],
      );
      const st = rows[0]?.status;
      if (st === 'submitted') {
        await say('✅ Candidatura enviada. La verás en Histórico con la evidencia del envío.');
        await setJobState(jobId, { status: 'done', step: 'enviada' });
        return;
      }
      if (st === 'submission_failed') {
        await say(
          `❌ El envío ha fallado${rows[0]?.failure_reason ? `: ${rows[0].failure_reason}` : ''}. La candidatura queda registrada con el fallo (y la intervención correspondiente) para que puedas revisarla.`,
        );
        await setJobState(jobId, { status: 'failed', step: 'envio_fallido' });
        return;
      }
    }
    await say(
      '⏳ El envío sigue en curso en el trabajador (tarda más de lo habitual). La candidatura está aprobada y encolada: el resultado aparecerá en Histórico.',
    );
    await setJobState(jobId, { status: 'done', step: 'envio_en_curso' });
    return;
  }

  const email = offerRow[0]?.application_email;
  if (email) {
    // 5b) Canal email: se envía por Gmail con CV y carta adjuntos.
    await setJobState(jobId, { step: 'envio_email' });
    const canSend = testDeps.gmailCanSend
      ? await testDeps.gmailCanSend()
      : await gmailSendCapable();
    if (!canSend) {
      await say(
        `✉️ Esta oferta se aplica por correo a ${email}, pero el Gmail del sistema todavía no tiene permiso de envío (solo lectura). La dejo preparada en Revisión con el CV y la carta listos. Para que la próxima vez la envíe yo solo, reconecta Gmail en Configuración: pedirá el permiso de envío una única vez.`,
      );
      await setJobState(jobId, { status: 'done', step: 'email_sin_permiso_envio' });
      return;
    }
    await applyDecision(prep.applicationId, 'approve', undefined, ctx.actorId);
    await auditEvent({
      actorId: ctx.actorId,
      action: 'agent_application_approved',
      entityType: 'application',
      entityId: prep.applicationId,
      details: { job_id: jobId, url, origen: 'chat_agente', canal: 'email' },
    });
    const { facts } = await loadActiveProfileFacts();
    const candidate = construirPerfilCandidato(facts);
    const docRows = await query<{ kind: string; file_path: string }>(
      `SELECT kind, file_path FROM documents
        WHERE application_id = $1 AND format = 'pdf' ORDER BY kind`,
      [prep.applicationId],
    );
    const attachments = docRows.map((d) => resolve(join(workspaceBase(), d.file_path)));
    const notesText = offerRow[0]?.application_notes ?? '';
    const subjectMatch = notesText.match(/(?:subject|asunto)\s*[:\-–]\s*([^\n]{3,90})/i);
    const subject = subjectMatch
      ? subjectMatch[1].trim()
      : `Application: ${title}${candidate ? ` — ${candidate.identity.fullName}` : ''}`;
    const bodyText = [
      'Dear Sir or Madam,',
      '',
      `I am writing to apply for the position of ${title}${company ? ` at ${company}` : ''}. ` +
        'Please find attached my CV and cover letter for your consideration.',
      '',
      'Kind regards,',
      candidate?.identity.fullName ?? '',
      candidate?.identity.email ?? '',
    ]
      .filter((l) => l !== '')
      .join('\n');
    try {
      const send =
        testDeps.sendEmail ?? ((input: GmailApplicationInput) => sendGmailApplication(ctx.config, input));
      const { messageId } = await send({ to: email, subject, bodyText, attachments });
      await query(
        `UPDATE applications
            SET status = 'submitted', submitted_at = now(),
                submission_evidence = $2::jsonb, updated_at = now()
          WHERE id = $1`,
        [
          prep.applicationId,
          JSON.stringify({ channel: 'email', to: email, gmail_message_id: messageId }),
        ],
      );
      await auditEvent({
        actorId: ctx.actorId,
        action: 'agent_email_sent',
        entityType: 'application',
        entityId: prep.applicationId,
        details: { job_id: jobId, to: email, gmail_message_id: messageId },
      });
      await say(
        `✅ Candidatura enviada por correo a ${email} con el CV y la carta adjuntos (asunto: «${subject}»). Queda registrada en Histórico con la evidencia del envío.`,
      );
      await setJobState(jobId, { status: 'done', step: 'enviada_email' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'error de envío';
      await query(
        `UPDATE applications
            SET status = 'submission_failed', failure_reason = $2, updated_at = now()
          WHERE id = $1`,
        [prep.applicationId, `email: ${msg}`.slice(0, 500)],
      );
      await say(
        `❌ He intentado enviar la candidatura por correo a ${email} y Gmail ha fallado: ${msg.slice(0, 200)}. La candidatura queda registrada con el fallo en Revisión.`,
      );
      await setJobState(jobId, { status: 'failed', step: 'envio_email_fallido' });
    }
    return;
  }

  // 5c) Portal sin driver: motivo concreto (qué portal y por qué).
  let host = portal;
  try {
    host = new URL(url).hostname;
  } catch {
    // se usa la etiqueta del portal
  }
  await say(
    `ℹ️ Hasta aquí llego yo solo: el destino final es ${host} (portal «${portal}»), que exige aplicar dentro de su propio sistema — a menudo creando una cuenta — y no tengo un driver de envío verificado para él. La candidatura queda preparada en Revisión con el CV y la carta listos; el paso que falta es aplicar en: ${url}`,
  );
  await setJobState(jobId, { status: 'done', step: 'preparada_sin_driver' });
}


// ---------------------------------------------------------------------------
// Estado para el comando «estado»
// ---------------------------------------------------------------------------

export async function latestJobSummary(): Promise<string> {
  const rows = await query<{
    status: string;
    step: string | null;
    url: string;
    created_at: Date;
  }>(`SELECT status, step, url, created_at FROM agent_jobs ORDER BY created_at DESC LIMIT 1`);
  if (rows.length === 0) return 'Todavía no me has encargado ninguna aplicación.';
  const j = rows[0];
  const estado =
    j.status === 'running'
      ? `sigue en curso (paso: ${j.step ?? '…'})`
      : j.status === 'done'
        ? `terminó bien (resultado: ${j.step ?? 'completado'})`
        : j.status === 'blocked'
          ? `se detuvo (motivo: ${j.step ?? 'bloqueado'})`
          : `falló (paso: ${j.step ?? 'error'})`;
  return `El último encargo (${j.url}) ${estado}.`;
}
