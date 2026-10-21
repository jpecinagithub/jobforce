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
 * Paradas honestas: portal sin driver de envío probado (hoy solo
 * Personio aplica solo; el canal email aún no tiene ejecutor — Gmail
 * del backend es de solo lectura) → la candidatura queda preparada en
 * Revisión y el agente lo dice, con el destino y las instrucciones si
 * la oferta se aplica por correo.
 *
 * Sin LLM: el chat interpreta comandos de forma determinista, igual que
 * el resto del sistema.
 */

import { query } from '@jobforce/database';
import { defaultCriteria, type CampaignCriteria } from '@jobforce/domain';
import { detectNationalityRestriction, evaluateOffer } from '@jobforce/eval';
import {
  canonicalUrl,
  checkUrlStatusDetailed,
  createExaClient,
  extractApplicationContact,
  extractCompany,
  type ExaResult,
} from '@jobforce/search';
import { auditEvent } from './audit.js';
import { detectarPortal, prepararCandidatura } from './prepare.js';
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
  'Puedo aplicar por ti a una oferta concreta. Escríbeme «aplica a esta oferta: <url>» (o pega directamente el enlace) y me encargo de todo: descargo la oferta, compruebo que el enlace sigue vivo, genero el CV y la carta, y envío la candidatura si el portal lo permite (hoy aplica solo Personio; el resto queda preparado en Revisión y te aviso). Con «estado» te digo cómo va el último encargo.';

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
  exaApiKey: string | null;
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
      : await defaultGetContents(ctx.exaApiKey, url);
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
            url_ok, url_checked_at)
         VALUES ($1, NULL, $2, $3, $4, $5, $6::date, $7::jsonb, $8::jsonb, $9, $10,
                 $11, now())
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
    if (prep.motivo === 'ya_en_curso_o_finalizada') {
      const st = await query<{ status: string }>(
        `SELECT status FROM applications WHERE id = $1`,
        [prep.applicationId],
      );
      await say(
        `ℹ️ Ya existe una candidatura para esta oferta en estado «${st[0]?.status ?? prep.status}». No duplico: puedes seguirla en Revisión/Histórico.`,
      );
      await setJobState(jobId, { status: 'done', step: 'ya_existia' });
      return;
    }
    const docs = await query<{ kind: string }>(
      `SELECT DISTINCT kind FROM documents WHERE application_id = $1`,
      [prep.applicationId],
    );
    await say(
      `📄 Documentos generados: ${docs.map((d) => d.kind).join(' + ') || 'CV y carta'}. ` +
        'Tu orden en este chat cuenta como aprobación expresa: sigo con el envío.',
    );

    // 5) Canal de envío: solo Personio aplica de forma autónoma hoy.
    const offerRow = await query<{ application_email: string | null; application_notes: string | null }>(
      `SELECT application_email, application_notes FROM offers WHERE id = $1`,
      [offerId],
    );
    const portal = detectarPortal(url);
    if (portal !== 'personio') {
      const email = offerRow[0]?.application_email;
      await say(
        email
          ? `✉️ Esta oferta se aplica por correo a ${email} (instrucciones del anuncio: «${(offerRow[0]?.application_notes ?? '').slice(0, 200)}»). El envío por email aún no está automatizado (el Gmail del sistema es de solo lectura), así que la dejo preparada en Revisión con los documentos listos para enviar.`
          : `ℹ️ El portal de esta oferta (${portal}) no tiene driver de envío automático (hoy solo Personio aplica solo). La candidatura queda preparada en Revisión con CV y carta listos; el último paso es manual desde la propia oferta: ${url}`,
      );
      await setJobState(jobId, { status: 'done', step: 'preparada_sin_driver' });
      return;
    }

    // 6) Aprobación (la orden del chat) + encadenado de envío.
    await setJobState(jobId, { step: 'aprobacion_envio' });
    await applyDecision(prep.applicationId, 'approve', undefined, ctx.actorId);
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
    await say('🚀 Envío encolado: el trabajador está rellenando la candidatura en Personio…');

    // 7) Seguimiento del worker hasta el resultado.
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
