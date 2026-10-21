/**
 * @jobforce/backend — Preparación de candidaturas (Fase 7).
 *
 * Cierra la cadena oferta → candidatura: dada una oferta EVALUADA de una
 * campaña, crea la fila en `applications` con su `offer_snapshot`, genera
 * los documentos (CV + carta en PDF con @jobforce/docs, adaptación
 * DETERMINISTA desde los hechos del perfil activo, sin LLM) y deja la
 * candidatura en `ready_for_review` para que Jon la apruebe en /revision.
 *
 * Reglas:
 *  - Idempotente: la UNIQUE (campaign_id, offer_id) manda; preparar dos
 *    veces no duplica ni pisa estados posteriores a `ready_for_review`.
 *  - Sin perfil activo (o incompleto) no se crea nada: no quedan borradores
 *    huérfanos.
 *  - Si la generación de documentos falla, la candidatura queda en `draft`
 *    con `failure_reason` — NUNCA en `ready_for_review` sin documentos.
 *  - PROHIBIDO inventar datos: CV y carta se construyen solo con hechos
 *    verificados del perfil activo y con el título/empresa de la oferta.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { query } from '@jobforce/database';
import {
  applyRoleProfileEmphasis,
  buildCoverLetterModel,
  buildCvModel,
  countPdfPages,
  renderCoverLetterHtml,
  renderCvHtml,
  renderHtmlToPdfAndPng,
  type CandidateProfile,
  type CvAdaptation,
  type JobPosting,
  type LetterAdaptation,
  type RoleProfileEmphasis,
} from '@jobforce/docs';
import type { ProfileFactInput } from '@jobforce/eval';
import { auditEvent } from './audit.js';
import { solicitarEnviosAutomaticos } from './auto-send.js';
import {
  intentarConfigurarFormulario,
  type InspectorFormulario,
} from './formconfig.js';
import { getEffectivePolicy } from './routes/autonomy.js';
import { workspaceBase } from './workspace.js';

// ---------------------------------------------------------------------------
// Portal detectado desde la URL de la oferta.
// ---------------------------------------------------------------------------

const PORTALES: Array<{ patron: string; portal: string; nombre: string }> = [
  { patron: 'personio', portal: 'personio', nombre: 'Personio' },
  { patron: 'icims.com', portal: 'icims', nombre: 'iCIMS' },
  // Alias verificado en vivo (2026-10-21): la web de empleo de
  // Sightsavers aplica sobre iCIMS (careers-sightsavers.icims.com).
  { patron: 'careers.sightsavers.org', portal: 'icims', nombre: 'iCIMS (Sightsavers)' },
  { patron: 'greenhouse', portal: 'greenhouse', nombre: 'Greenhouse' },
  { patron: 'lever', portal: 'lever', nombre: 'Lever' },
  { patron: 'smartrecruiters', portal: 'smartrecruiters', nombre: 'SmartRecruiters' },
  { patron: 'workday', portal: 'workday', nombre: 'Workday' },
  { patron: 'myworkdayjobs', portal: 'workday', nombre: 'Workday' },
];

export function detectarPortal(url: string | null | undefined): string {
  if (!url) return 'otro';
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 'otro';
  }
  for (const p of PORTALES) {
    if (host.includes(p.patron)) return p.portal;
  }
  return 'otro';
}

export function nombrePortal(portal: string): string {
  return PORTALES.find((p) => p.portal === portal)?.nombre ?? 'the job portal';
}

// ---------------------------------------------------------------------------
// Perfil activo (BD) → CandidateProfile de @jobforce/docs.
// ---------------------------------------------------------------------------

async function cargarHechosPerfilActivo(): Promise<ProfileFactInput[]> {
  const versions = await query<{ id: string }>(
    `SELECT id FROM profile_versions WHERE status = 'active' ORDER BY version_no DESC LIMIT 1`,
  );
  if (versions.length === 0) return [];
  const facts = await query<{ category: string; key: string; value: unknown }>(
    `SELECT category, key, value FROM profile_facts WHERE profile_version_id = $1`,
    [versions[0].id],
  );
  return facts.map((f) => ({ category: f.category, key: f.key, value: f.value }));
}

function asObj(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * Perfil por rol elegido en la campaña (migración 012), como bloque de
 * énfasis para la generación. null si la campaña no tiene perfil por rol
 * (o si el perfil ya no existe): la generación se comporta como siempre.
 */
async function cargarPerfilRol(campaignId: string): Promise<RoleProfileEmphasis | null> {
  const camps = await query<{ role_profile_id: string | null }>(
    `SELECT role_profile_id FROM campaigns WHERE id = $1`,
    [campaignId],
  );
  const roleProfileId = camps[0]?.role_profile_id;
  if (!roleProfileId) return null;
  const rows = await query<{ name: string; headline: string; summary: string; skills: unknown }>(
    `SELECT name, headline, summary, skills FROM role_profiles WHERE id = $1`,
    [roleProfileId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    name: row.name,
    headline: row.headline,
    summary: row.summary,
    skills: Array.isArray(row.skills)
      ? row.skills.filter((s): s is string => typeof s === 'string')
      : [],
  };
}

function asStr(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function capitalizar(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** '2023-11' → '11/2023'; '2005' → '2005'. */
function fmtPeriodo(v: string | null): string {
  if (!v) return '';
  const m = /^(\d{4})-(\d{2})/.exec(v);
  return m ? `${m[2]}/${m[1]}` : v;
}

const MESES_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2023-04-17' → '17-Apr-2023'; cualquier otro formato se devuelve tal cual. */
function fmtFechaCert(v: string | null): string {
  if (!v) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (!m) return v;
  return `${Number(m[3])}-${MESES_EN[Number(m[2]) - 1]}-${m[1]}`;
}

/** Primera frase de un texto (para la nota de educación: la parte factual del aviso). */
function primeraFrase(v: string): string {
  const corte = v.indexOf('. ');
  const s = corte > 0 ? v.slice(0, corte + 1) : v;
  return s.endsWith('.') ? s : `${s}.`;
}

/**
 * Construye el CandidateProfile SOLO con hechos del perfil activo.
 * Devuelve null si faltan los esenciales (nombre o email): sin ellos no
 * se genera ningún documento.
 */
export function construirPerfilCandidato(facts: ProfileFactInput[]): CandidateProfile | null {
  const porClave = new Map<string, unknown>();
  for (const f of facts) porClave.set(`${f.category}.${f.key}`, f.value);
  const get = (category: string, key: string) => porClave.get(`${category}.${key}`);
  const porCategoria = (category: string) =>
    facts.filter((f) => f.category === category);

  const fullName = asStr(get('identity', 'full_name'));
  const email = asStr(get('identity', 'email'));
  if (!fullName || !email) return null;

  const locRaw = get('identity', 'location');
  const locObj = asObj(locRaw);
  const location = locObj
    ? [asStr(locObj.city), asStr(locObj.country)].filter(Boolean).join(', ')
    : (asStr(locRaw) ?? '');

  const claimObj = asObj(get('experience', 'experience_summary_claim'));
  const experienceClaim = claimObj ? (asStr(claimObj.text) ?? '') : '';

  const experience = porCategoria('experience')
    .filter((f) => f.key.startsWith('exp_'))
    .map((f) => ({ key: f.key, v: asObj(f.value) }))
    .filter((e): e is { key: string; v: Record<string, unknown> } => e.v !== null)
    .sort((a, b) => String(b.v.start ?? '').localeCompare(String(a.v.start ?? '')))
    .map((e) => {
      const context = asStr(e.v.context);
      // Bullets ricos del CV de Jon (hechos `bullets` por puesto): si el
      // hecho los trae, son el cuerpo de la experiencia; si no, la frase
      // de contexto como hasta ahora.
      const rawBullets = Array.isArray(e.v.bullets)
        ? e.v.bullets.filter((b): b is string => typeof b === 'string' && b.trim() !== '')
        : [];
      return {
        key: `experience.${e.key.replace(/^exp_/, '')}`,
        title: asStr(e.v.title) ?? '',
        company: asStr(e.v.company) ?? '',
        location: asStr(e.v.location) ?? '',
        start: fmtPeriodo(asStr(e.v.start)),
        end: fmtPeriodo(asStr(e.v.end)),
        bullets: rawBullets.length > 0 ? rawBullets : context ? [`${capitalizar(context)}.`] : [],
      };
    });

  const education = porCategoria('education')
    .map((f) => ({ key: f.key, v: asObj(f.value) }))
    .filter((e): e is { key: string; v: Record<string, unknown> } => e.v !== null)
    .map((e) => {
      const warning = asStr(e.v.warning);
      const issued = asStr(e.v.issued);
      const note = warning
        ? primeraFrase(warning)
        : e.v.official === true
          ? `Official degree${issued ? `. Issued: ${issued}` : ''}.`
          : issued
            ? `Issued: ${issued}`
            : '';
      const start = asStr(e.v.start);
      const end = asStr(e.v.end);
      return {
        key: `education.${e.key.replace(/^edu_/, '')}`,
        title: asStr(e.v.degree) ?? '',
        institution: asStr(e.v.institution) ?? '',
        period: start || end ? `${start ?? ''}–${end ?? ''}` : '',
        note,
      };
    });

  const skills: Array<{ key: string; label: string }> = [];
  const vistos = new Set<string>();
  for (const f of porCategoria('skills')) {
    if (!Array.isArray(f.value)) continue;
    f.value.forEach((raw, i) => {
      const label = asStr(raw);
      if (!label || vistos.has(label)) return;
      vistos.add(label);
      skills.push({ key: `skills.${f.key}.${i}`, label });
    });
  }

  const languages = porCategoria('languages')
    .map((f) => ({ key: f.key, v: asObj(f.value) }))
    .filter((e): e is { key: string; v: Record<string, unknown> } => e.v !== null)
    .map((e) => ({
      key: `languages.${e.key.replace(/^lang_/, '')}`,
      label: `${capitalizar(asStr(e.v.language) ?? '')} — ${capitalizar(asStr(e.v.level) ?? '')}`,
    }));

  const certifications = porCategoria('certifications')
    .map((f) => ({ key: f.key, v: asObj(f.value) }))
    .filter((e): e is { key: string; v: Record<string, unknown> } => e.v !== null)
    .map((e) => ({
      key: `certifications.${e.key.replace(/^cert_/, '')}`,
      title: asStr(e.v.name) ?? '',
      issuer: asStr(e.v.issuer) ?? '',
      date: fmtFechaCert(asStr(e.v.date)),
      verifyUrl: asStr(e.v.verify_url) ?? '',
    }));

  return {
    identity: {
      fullName,
      email,
      phone: asStr(get('identity', 'phone')),
      linkedIn: asStr(get('identity', 'linkedin')) ?? '',
      location,
    },
    experienceClaim,
    experience,
    education,
    skills,
    languages,
    certifications,
  };
}

// ---------------------------------------------------------------------------
// Adaptaciones deterministas (sin LLM): solo hechos del perfil + la oferta.
// ---------------------------------------------------------------------------

export interface OfertaInfo {
  title: string | null;
  company: string | null;
  url: string;
  portal: string;
}

function construirAdaptaciones(
  candidato: CandidateProfile,
  oferta: OfertaInfo,
  rolPerfil: RoleProfileEmphasis | null = null,
): { cv: CvAdaptation; carta: LetterAdaptation; job: JobPosting } {
  const rol = oferta.title ?? 'Senior Finance Professional';
  const reciente = candidato.experience[0];
  const claim = candidato.experienceClaim;

  const summary: string[] = [];
  summary.push(
    `Finance professional${claim ? ` with ${claim}` : ''}.` +
      (reciente
        ? ` Most recently ${reciente.title} at ${reciente.company}${reciente.location ? ` (${reciente.location})` : ''}.`
        : ''),
  );
  if (candidato.experience.length > 1) {
    summary.push(
      `Previous experience includes ${candidato.experience
        .slice(1)
        .map((e) => `${e.title} at ${e.company}${e.location ? ` (${e.location})` : ''}`)
        .join('; ')}.`,
    );
  }
  if (candidato.skills.length > 0) {
    summary.push(
      `Core skills include ${candidato.skills.slice(0, 8).map((s) => s.label).join(', ')}.`,
    );
  }

  const body: string[] = [];
  body.push(
    `I am writing to apply for the position of ${rol}${oferta.company ? ` at ${oferta.company}` : ''}.` +
      (reciente
        ? ` As ${reciente.title} at ${reciente.company}, I bring ${claim || 'extensive experience'} in financial accounting, controlling and management.`
        : ''),
  );
  const resto = candidato.experience.slice(1, 3);
  if (resto.length > 0 || candidato.skills.length > 0) {
    body.push(
      (resto.length > 0
        ? `My background also includes ${resto.map((e) => `${e.title} at ${e.company}`).join(' and ')}. `
        : '') +
        (candidato.skills.length > 0
          ? `Core skills: ${candidato.skills.slice(0, 8).map((s) => s.label).join(', ')}.`
          : ''),
    );
  }
  if (candidato.education.length > 0 || candidato.languages.length > 0) {
    body.push(
      (candidato.education.length > 0
        ? `I hold ${candidato.education.map((e) => `${e.title} (${e.institution})`).join(' and ')}. `
        : '') +
        (candidato.languages.length > 0
          ? `Languages: ${candidato.languages.map((l) => l.label).join(', ')}.`
          : ''),
    );
  }

  const job: JobPosting = {
    title: rol,
    location: '',
    sourceName: nombrePortal(oferta.portal),
    sourceUrl: oferta.url,
    employerNote: oferta.company ?? 'employer not named in the posting',
  };

  // Énfasis del perfil por rol de la campaña: su bloque (titular, resumen,
  // skills) se antepone al contexto de hechos. Sin rol, salida idéntica.
  const baseCv: CvAdaptation = { headline: rol, summary };
  const baseCarta: LetterAdaptation = {
    body,
    closing: 'Thank you for your time and consideration. I look forward to hearing from you.',
  };
  const { cv, carta } = applyRoleProfileEmphasis(baseCv, baseCarta, rolPerfil);
  return { cv, carta, job };
}

const MESES_LARGOS_EN = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function fechaCarta(hoy: Date): string {
  return `${hoy.getUTCDate()} ${MESES_LARGOS_EN[hoy.getUTCMonth()]} ${hoy.getUTCFullYear()}`;
}

// ---------------------------------------------------------------------------
// Generación de documentos PDF.
// ---------------------------------------------------------------------------

export interface GenerarDocumentosDeps {
  /**
   * Render HTML→PDF+PNG. Por defecto, el de @jobforce/docs (Playwright).
   * El 4º argumento es la escala del PDF (garantía de carta de una hoja).
   */
  render?: (
    html: string,
    pdfPath: string,
    pngPath: string,
    opts?: { scale?: number },
  ) => Promise<void>;
  /** Base del workspace. Por defecto, `workspaceBase()`. */
  base?: string;
  /** Inspector de formularios (Fase 8.1). Solo para tests. */
  formConfigInspector?: InspectorFormulario;
}

/**
 * Variantes de renderizado de la CARTA, de más holgada a más compacta.
 * Regla de Jon (20-oct-2026): la carta nunca supera una hoja. Se prueba
 * cada variante y se acepta la primera que quepa en 1 página; la última
 * (escala 0.78) se acepta siempre como red final.
 */
const CARTA_VARIANTES: Array<{ compact: number; scale?: number }> = [
  { compact: 0 },
  { compact: 1 },
  { compact: 2 },
  { compact: 2, scale: 0.92 },
  { compact: 2, scale: 0.85 },
  { compact: 2, scale: 0.78 },
];

async function generarDocumentosPdf(
  applicationId: string,
  candidato: CandidateProfile,
  oferta: OfertaInfo,
  rolPerfil: RoleProfileEmphasis | null = null,
  deps: GenerarDocumentosDeps = {},
): Promise<void> {
  const base = deps.base ?? workspaceBase();
  const render =
    deps.render ??
    (async (html: string, pdfPath: string, pngPath: string, opts?: { scale?: number }) => {
      await renderHtmlToPdfAndPng(html, {
        pdfPath,
        pngPath,
        ...(opts?.scale ? { scale: opts.scale } : {}),
      });
    });

  const previas = await query<{ v: string }>(
    `SELECT COALESCE(MAX(version), 0)::text AS v FROM documents
      WHERE application_id = $1 AND format = 'pdf'`,
    [applicationId],
  );
  const version = Number(previas[0].v) + 1;

  const dirRel = `jobforce/documents/${applicationId}`;
  const dirAbs = join(base, dirRel);
  mkdirSync(dirAbs, { recursive: true });

  const { cv, carta, job } = construirAdaptaciones(candidato, oferta, rolPerfil);
  const cvModel = buildCvModel(candidato, cv);
  const letterModel = buildCoverLetterModel(candidato, job, carta, fechaCarta(new Date()));

  const ficheros: Array<{
    kind: 'cv' | 'cover_letter';
    nombre: string;
    html: (compact: number) => string;
    template: string;
  }> = [
    {
      kind: 'cv',
      nombre: `cv-v${version}.pdf`,
      html: () => renderCvHtml(cvModel),
      template: cvModel.templateVersion,
    },
    {
      kind: 'cover_letter',
      nombre: `carta-v${version}.pdf`,
      html: (compact) => renderCoverLetterHtml(letterModel, { compact }),
      template: letterModel.templateVersion,
    },
  ];
  for (const f of ficheros) {
    const pdfPath = join(dirAbs, f.nombre);
    const previo = f.kind === 'cv' ? 'preview-cv.png' : 'preview-carta.png';
    if (f.kind === 'cover_letter') {
      // Garantía de una hoja: se acepta la primera variante que quepa en
      // una página. Si el nº de páginas no se puede medir (render falso
      // en tests), se acepta la primera variante sin más.
      for (const v of CARTA_VARIANTES) {
        await render(f.html(v.compact), pdfPath, join(dirAbs, previo), v.scale ? { scale: v.scale } : undefined);
        let pages: number | null = null;
        try {
          pages = countPdfPages(pdfPath);
        } catch {
          pages = null;
        }
        if (pages === null || pages <= 1) break;
      }
    } else {
      await render(f.html(0), pdfPath, join(dirAbs, previo));
    }
    const buf = readFileSync(pdfPath);
    const sha256 = createHash('sha256').update(buf).digest('hex');
    await query(
      `INSERT INTO documents
         (application_id, kind, format, version, file_path, bytes, sha256,
          template_version, generator, model_used, notes)
       VALUES ($1, $2, 'pdf', $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (application_id, kind, format, version) DO UPDATE
          SET file_path = EXCLUDED.file_path, bytes = EXCLUDED.bytes,
              sha256 = EXCLUDED.sha256`,
      [
        applicationId,
        f.kind,
        version,
        `${dirRel}/${f.nombre}`,
        buf.length,
        sha256,
        f.template,
        '@jobforce/docs',
        'determinista-sin-llm',
        'Generado en la preparación de la candidatura (Fase 7).',
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Preparación de una candidatura.
// ---------------------------------------------------------------------------

export interface PrepararOpts {
  actorId?: string | null;
  deps?: GenerarDocumentosDeps;
}

export interface PrepararResultado {
  applicationId: string | null;
  status: string | null;
  creada: boolean;
  /** Motivo cuando no se crea o no queda lista para revisión. */
  motivo?: string;
}

interface OfferRow {
  id: string;
  title: string | null;
  company: string | null;
  url: string;
}

interface EvaluationRow {
  mandatory_verdict: string;
  score: string | null;
  breakdown: unknown;
}

const ESTADOS_INTACABLES = new Set([
  'approved',
  'submitting',
  'submitted',
  'submission_failed',
  'withdrawn',
]);

export async function prepararCandidatura(
  campaignId: string,
  offerId: string,
  opts: PrepararOpts = {},
): Promise<PrepararResultado> {
  const offers = await query<OfferRow>(
    `SELECT id, title, company, url FROM offers WHERE id = $1 AND campaign_id = $2`,
    [offerId, campaignId],
  );
  const offer = offers[0];
  if (!offer) {
    return { applicationId: null, status: null, creada: false, motivo: 'oferta_no_encontrada' };
  }
  const evals = await query<EvaluationRow>(
    `SELECT mandatory_verdict, score::text AS score, breakdown FROM evaluations
      WHERE offer_id = $1 AND campaign_id = $2
      ORDER BY created_at DESC LIMIT 1`,
    [offerId, campaignId],
  );
  const ev = evals[0];
  if (!ev) {
    return { applicationId: null, status: null, creada: false, motivo: 'oferta_sin_evaluacion' };
  }

  // Sin perfil activo completo no se crea nada (sin borradores huérfanos).
  const candidato = construirPerfilCandidato(await cargarHechosPerfilActivo());
  if (!candidato) {
    return {
      applicationId: null,
      status: null,
      creada: false,
      motivo: 'sin_perfil_activo_o_incompleto',
    };
  }

  const portal = detectarPortal(offer.url);
  const snapshot = {
    titulo: offer.title,
    empresa: offer.company,
    url: offer.url,
    portal,
    score: ev.score === null ? null : Number(ev.score),
    mandatory_verdict: ev.mandatory_verdict,
    breakdown: ev.breakdown,
  };

  const inserted = await query<{ id: string; status: string }>(
    `INSERT INTO applications (campaign_id, offer_id, status, offer_snapshot, portal, created_by)
     VALUES ($1, $2, 'draft', $3::jsonb, $4, $5)
     ON CONFLICT (campaign_id, offer_id) DO NOTHING
     RETURNING id, status`,
    [campaignId, offerId, JSON.stringify(snapshot), portal, opts.actorId ?? null],
  );

  let applicationId: string;
  let creada = false;
  if (inserted.length > 0) {
    applicationId = inserted[0].id;
    creada = true;
  } else {
    const existing = await query<{ id: string; status: string }>(
      `SELECT id, status FROM applications WHERE campaign_id = $1 AND offer_id = $2`,
      [campaignId, offerId],
    );
    const row = existing[0];
    applicationId = row.id;
    if (ESTADOS_INTACABLES.has(row.status)) {
      return { applicationId, status: row.status, creada, motivo: 'ya_en_curso_o_finalizada' };
    }
    if (row.status === 'ready_for_review') {
      const docs = await query<{ kind: string }>(
        `SELECT DISTINCT kind FROM documents
          WHERE application_id = $1 AND format = 'pdf' AND kind IN ('cv','cover_letter')`,
        [applicationId],
      );
      if (docs.length >= 2) {
        return { applicationId, status: row.status, creada, motivo: 'ya_preparada' };
      }
      // ready_for_review sin documentos completos: se regeneran abajo.
    }
  }

  try {
    const rolPerfil = await cargarPerfilRol(campaignId);
    await generarDocumentosPdf(
      applicationId,
      candidato,
      { title: offer.title, company: offer.company, url: offer.url, portal },
      rolPerfil,
      opts.deps,
    );
    await query(
      `UPDATE applications
          SET status = 'ready_for_review', failure_reason = NULL, updated_at = now()
        WHERE id = $1`,
      [applicationId],
    );
    await auditEvent({
      actorId: opts.actorId ?? null,
      action: 'application_prepared',
      entityType: 'application',
      entityId: applicationId,
      details: { campaign_id: campaignId, offer_id: offerId, creada },
    });
    // Fase 8.1: intento de configuración automática del formulario del
    // portal (solo Personio). Aislado: su resultado queda en el snapshot
    // (`formConfig` o `formConfigPendiente`) y NUNCA tumba la preparación.
    try {
      await intentarConfigurarFormulario(applicationId, {
        ...(opts.deps?.formConfigInspector
          ? { inspector: opts.deps.formConfigInspector }
          : {}),
      });
    } catch {
      // intentarConfigurarFormulario ya no lanza por diseño; doble red.
    }
    return { applicationId, status: 'ready_for_review', creada };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'error desconocido';
    await query(
      `UPDATE applications SET status = 'draft', failure_reason = $2, updated_at = now() WHERE id = $1`,
      [applicationId, `error_generando_documentos: ${msg}`.slice(0, 500)],
    );
    await auditEvent({
      actorId: opts.actorId ?? null,
      action: 'application_prepare_failed',
      entityType: 'application',
      entityId: applicationId,
      details: { campaign_id: campaignId, offer_id: offerId, error: msg.slice(0, 500) },
    });
    return {
      applicationId,
      status: 'draft',
      creada,
      motivo: `error_generando_documentos: ${msg}`,
    };
  }
}

/**
 * Regenera los documentos (CV + carta, versión nueva) de una candidatura
 * existente SIN tocar su estado: es la vía para refrescar los PDFs cuando
 * cambia el perfil activo (p. ej. la traducción a inglés de los hechos,
 * decisión de Jon de 20-oct-2026: los documentos van siempre en inglés).
 * A diferencia de `prepararCandidatura`, también actúa sobre candidaturas
 * en estados intocables (approved…): solo añade documentos nuevos.
 */
export async function regenerarDocumentos(
  applicationId: string,
  opts: PrepararOpts = {},
): Promise<{ ok: boolean; motivo?: string }> {
  const apps = await query<{ campaign_id: string; portal: string | null }>(
    `SELECT campaign_id, portal FROM applications WHERE id = $1`,
    [applicationId],
  );
  const app = apps[0];
  if (!app) return { ok: false, motivo: 'candidatura_no_encontrada' };
  const offers = await query<OfferRow>(
    `SELECT o.id, o.title, o.company, o.url FROM offers o
       JOIN applications a ON a.offer_id = o.id WHERE a.id = $1`,
    [applicationId],
  );
  const offer = offers[0];
  if (!offer) return { ok: false, motivo: 'oferta_no_encontrada' };
  const candidato = construirPerfilCandidato(await cargarHechosPerfilActivo());
  if (!candidato) return { ok: false, motivo: 'sin_perfil_activo_o_incompleto' };
  const rolPerfil = await cargarPerfilRol(app.campaign_id);
  await generarDocumentosPdf(
    applicationId,
    candidato,
    {
      title: offer.title,
      company: offer.company,
      url: offer.url,
      portal: app.portal ?? detectarPortal(offer.url),
    },
    rolPerfil,
    opts.deps,
  );
  await auditEvent({
    actorId: opts.actorId ?? null,
    action: 'application_documents_regenerated',
    entityType: 'application',
    entityId: applicationId,
    details: { campaign_id: app.campaign_id, offer_id: offer.id },
  });
  return { ok: true };
}

/**
 * Disparo automático: prepara las ofertas de la campaña con veredicto
 * `cumple` y score >= umbralEncajeRevision de la política ACTIVA.
 * Nunca lanza: cada preparación va aislada (un fallo no tumba la búsqueda).
 *
 * Fase 8.3: tras preparar, en modo `ejecutar_automatico` autorizado se
 * solicitan solos los envíos que la política permite (ver auto-send.ts);
 * en cualquier otro modo ese barrido no hace nada.
 */
export async function prepararElegibles(
  campaignId: string,
  actorId: string | null,
): Promise<{ preparadas: number; candidatas: number; enviosSolicitados: number }> {
  const policy = await getEffectivePolicy();
  if (!policy) return { preparadas: 0, candidatas: 0, enviosSolicitados: 0 };
  const umbral = policy.policy.reglas.umbralEncajeRevision;
  const rows = await query<{ offer_id: string }>(
    `SELECT offer_id FROM evaluations
      WHERE campaign_id = $1 AND mandatory_verdict = 'cumple'
        AND score IS NOT NULL AND score >= $2`,
    [campaignId, umbral],
  );
  let preparadas = 0;
  for (const r of rows) {
    try {
      const res = await prepararCandidatura(campaignId, r.offer_id, { actorId });
      if (res.status === 'ready_for_review') preparadas += 1;
    } catch {
      // Aislado a propósito: la preparación automática no rompe el flujo
      // que la disparó (búsqueda o re-evaluación).
    }
  }
  let enviosSolicitados = 0;
  try {
    const barrido = await solicitarEnviosAutomaticos(campaignId, actorId);
    enviosSolicitados = barrido.encolados;
  } catch {
    // El barrido automático tampoco puede tumbar el flujo que lo disparó.
  }
  return { preparadas, candidatas: rows.length, enviosSolicitados };
}
