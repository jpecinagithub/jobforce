/**
 * @jobforce/backend — Rutas de campañas de búsqueda (Fase 2).
 *
 * - GET    /api/campaigns                        → lista con contadores.
 * - POST   /api/campaigns                        → crea una campaña (201).
 * - GET    /api/campaigns/:id                    → detalle (404 si no existe).
 * - PUT    /api/campaigns/:id                    → actualización parcial.
 * - POST   /api/campaigns/:id/search             → lanza búsquedas en Exa.
 * - GET    /api/campaigns/:id/offers             → ofertas con su evaluación.
 * - GET    /api/campaigns/:id/offers/:offerId    → detalle de oferta.
 * - POST   /api/campaigns/:id/evaluate           → re-evalúa todas las ofertas.
 * - GET    /api/campaigns/:id/report             → genera y guarda el informe.
 *
 * Todas exigen sesión; las mutadoras además exigen cabecera CSRF.
 * Ver CONTRATO Fase 2 §6 (~/workspace/jobforce/fase2/CONTRATO_API.md).
 *
 * Reglas de dinero: el presupuesto se comprueba ANTES de crear el cliente de
 * Exa; la clave de Exa (`config.exaApiKey`) nunca se loguea ni se audita.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '@jobforce/config';
import type {
  Campaign,
  CampaignCriteria,
  MandatoryRequirement,
  PreferenceDim,
  PreferenceKey,
} from '@jobforce/domain';
import { defaultCriteria } from '@jobforce/domain';
import { query, withTransaction } from '@jobforce/database';
import {
  canonicalUrl,
  checkUrlStatusDetailed,
  createExaClient,
  extractCompany,
  EXA_COST_ESTIMATE_PER_SEARCH_USD,
  generateQueries,
  looksLikePersonProfile,
  extractApplicationContact,
  selectQueries,
  fetchOfferText,
  type ExaClient,
  type UrlCheckDetail,
  type UrlStatus,
} from '@jobforce/search';
import { evaluateOffer, type ProfileFactInput } from '@jobforce/eval';
import { prepararCandidatura, prepararElegibles } from '../prepare.js';
import {
  conectorDisponible,
  presupuestoDisponible,
  registrarCoste,
  registrarExito,
  registrarFallo,
} from '@jobforce/costs';
import { auditEvent } from '../audit.js';
import { requireCsrf, requireSession } from '../auth.js';
import { validateBody } from '../validation.js';

// ---------------------------------------------------------------------------
// Dependencias inyectables (solo tests).
// ---------------------------------------------------------------------------

interface CampaignTestDeps {
  createExaClient?: (apiKey: string) => ExaClient;
  evaluateOffer?: typeof evaluateOffer;
  checkUrlStatus?: (url: string) => Promise<UrlStatus>;
}

let testDeps: CampaignTestDeps = {};

/**
 * Solo para tests: sustituye el cliente de Exa y/o el evaluador por dobles.
 * En producción siempre se usan las implementaciones reales.
 */
export function setCampaignTestDeps(deps: CampaignTestDeps): void {
  testDeps = deps;
}

/** Restaura las dependencias reales tras un test con dobles. */
export function resetCampaignTestDeps(): void {
  testDeps = {};
}

const exaClientFactory = (): ((apiKey: string) => ExaClient) =>
  testDeps.createExaClient ?? createExaClient;
const evaluateOfferFn = (): typeof evaluateOffer => testDeps.evaluateOffer ?? evaluateOffer;
const checkUrlDetailedFn = (): ((url: string) => Promise<UrlCheckDetail>) =>
  testDeps.checkUrlStatus
    ? async (url) => ({ status: await testDeps.checkUrlStatus!(url), via: 'http' as const })
    : checkUrlStatusDetailed;

// ---------------------------------------------------------------------------
// Esquemas zod.
// ---------------------------------------------------------------------------

// Los ids de campaña/oferta son UUID v4; un id malformado nunca puede existir
// en BD, así que se rechaza con 400 antes de tocar la base de datos.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Documentos descargables de una candidatura: la versión más alta de cada
 * tipo (cv / cover_letter) y formato. El panel enlaza a
 * GET /api/documents/:id/download con estos ids.
 */
export async function latestDocuments(
  applicationId: string,
): Promise<Array<{ id: string; kind: string; format: string; version: number }>> {
  const docs = await query<{
    id: string;
    kind: string;
    format: string;
    version: number;
  }>(
    `SELECT id, kind, format, version FROM documents
      WHERE application_id = $1
      ORDER BY kind, format, version DESC`,
    [applicationId],
  );
  const seen = new Set<string>();
  const out: Array<{ id: string; kind: string; format: string; version: number }> = [];
  for (const d of docs) {
    const key = `${d.kind}|${d.format}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

const CampaignStatusSchema = z.enum(['draft', 'active', 'archived']);

const MandatoryRequirementSchema: z.ZodType<MandatoryRequirement> = z.object({
  id: z.string().min(1).max(100),
  kind: z.enum(['role', 'language', 'location', 'seniority', 'keyword']),
  description: z.string().min(1).max(1000),
  params: z.record(z.string(), z.unknown()),
});

const PreferenceDimSchema: z.ZodType<PreferenceDim> = z.object({
  weight: z.number().min(0).max(100),
  description: z.string().min(1).max(1000),
  keywords: z.array(z.string().min(1).max(200)),
});

const PreferenceKeySchema = z.enum([
  'funciones',
  'competencias',
  'seniority',
  'ubicacion',
  'condiciones',
  'empresa',
]) satisfies z.ZodType<PreferenceKey>;

const CampaignCriteriaSchema: z.ZodType<CampaignCriteria> = z.object({
  roles: z.array(z.string().min(1).max(200)).min(1, 'se necesita al menos un rol'),
  mandatory: z.array(MandatoryRequirementSchema),
  preferences: z.record(PreferenceKeySchema, PreferenceDimSchema),
  queries: z.array(z.string().min(1).max(500)),
  unknown_policy: z.literal('conservative'),
  include_domains: z.array(z.string().min(3).max(120)).max(30).optional(),
});

const CreateCampaignBody = z.object({
  name: z.string().trim().min(1, 'el nombre es obligatorio').max(120),
  criteria: CampaignCriteriaSchema.optional(),
  // Perfil por rol de la campaña (migración 012). Si se omite, se asigna el
  // perfil marcado «por defecto»; null explícito = sin énfasis de rol.
  role_profile_id: z
    .string()
    .regex(UUID_RE, 'el perfil por rol debe ser un UUID')
    .nullable()
    .optional(),
  exa_budget_cap_usd: z
    .number()
    .positive('el límite de presupuesto debe ser mayor que 0')
    .max(100, 'el límite de presupuesto no puede superar 100 $')
    .optional(),
});

const UpdateCampaignBody = z.object({
  name: z.string().trim().min(1, 'el nombre no puede estar vacío').max(120).optional(),
  criteria: CampaignCriteriaSchema.optional(),
  role_profile_id: z
    .string()
    .regex(UUID_RE, 'el perfil por rol debe ser un UUID')
    .nullable()
    .optional(),
  exa_budget_cap_usd: z
    .number()
    .positive('el límite de presupuesto debe ser mayor que 0')
    .max(100, 'el límite de presupuesto no puede superar 100 $')
    .optional(),
  total_budget_cap_usd: z
    .number()
    .positive('el límite total debe ser mayor que 0')
    .max(1000, 'el límite total no puede superar 1000 $')
    .nullable()
    .optional(),
  status: CampaignStatusSchema.optional(),
});

const LaunchSearchBody = z.object({
  queries: z
    .array(z.string().trim().min(1, 'la consulta no puede estar vacía').max(500))
    .max(5, 'máximo 5 consultas por lanzamiento')
    .optional(),
  num_results: z.number().int().min(1).max(10).default(10),
});

const authOnly = { preHandler: [requireSession] };
const mutating = { preHandler: [requireSession, requireCsrf] };

// ---------------------------------------------------------------------------
// Filas de BD y mapeos.
// ---------------------------------------------------------------------------

interface CampaignRow {
  id: string;
  name: string;
  criteria: CampaignCriteria;
  role_profile_id: string | null;
  exa_budget_cap_usd: string;
  exa_spent_usd: string;
  total_budget_cap_usd: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
  searches_count?: string;
  offers_count?: string;
}

interface SearchRow {
  id: string;
  campaign_id: string;
  query: string;
  num_results: number;
  status: string;
  exa_request_id: string | null;
  cost_usd: string;
  results_count: number;
  duplicates_count: number;
  error: string | null;
  started_at: Date | null;
  finished_at: Date;
}

interface OfferRow {
  id: string;
  campaign_id: string;
  search_id: string | null;
  canonical_url: string;
  url: string;
  title: string | null;
  company: string | null;
  published_date: string | null;
  retrieved_at: Date;
  highlights: unknown;
  raw: unknown;
  url_ok: boolean | null;
  url_checked_at: Date | null;
  application_email?: string | null;
  application_notes?: string | null;
  mandatory_verdict: string | null;
  score: string | null;
  breakdown: unknown;
  mandatory_details?: unknown;
  application_id?: string | null;
  application_status?: string | null;
}

function toIso(d: Date): string {
  return new Date(d).toISOString();
}

function mapCampaign(row: CampaignRow): Campaign {
  const campaign: Campaign = {
    id: row.id,
    name: row.name,
    criteria: row.criteria,
    role_profile_id: row.role_profile_id ?? null,
    exa_budget_cap_usd: Number(row.exa_budget_cap_usd),
    exa_spent_usd: Number(row.exa_spent_usd),
    total_budget_cap_usd: row.total_budget_cap_usd === null ? null : Number(row.total_budget_cap_usd),
    status: row.status as Campaign['status'],
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
  if (row.searches_count !== undefined) campaign.searches_count = Number(row.searches_count);
  if (row.offers_count !== undefined) campaign.offers_count = Number(row.offers_count);
  return campaign;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Hechos del perfil de la versión ACTIVA (vacío si no hay versión activa). */
export async function loadActiveProfileFacts(): Promise<{
  facts: ProfileFactInput[];
  versionId: string | null;
}> {
  const versions = await query<{ id: string }>(
    `SELECT id FROM profile_versions WHERE status = 'active' ORDER BY version_no DESC LIMIT 1`,
  );
  if (versions.length === 0) return { facts: [], versionId: null };
  const versionId = versions[0].id;
  const facts = await query<{ category: string; key: string; value: unknown }>(
    `SELECT category, key, value FROM profile_facts WHERE profile_version_id = $1`,
    [versionId],
  );
  return {
    facts: facts.map((f) => ({ category: f.category, key: f.key, value: f.value })),
    versionId,
  };
}

async function getCampaignOr404(id: string): Promise<CampaignRow | null> {
  const rows = await query<CampaignRow>(
    `SELECT id, name, criteria, role_profile_id, exa_budget_cap_usd, exa_spent_usd,
            total_budget_cap_usd, status, created_at, updated_at
       FROM campaigns WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/** ¿Existe el perfil por rol indicado? */
async function roleProfileExists(roleProfileId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(`SELECT id FROM role_profiles WHERE id = $1`, [
    roleProfileId,
  ]);
  return rows.length > 0;
}

/** Id del perfil por rol marcado «por defecto» (null si no hay ninguno). */
async function defaultRoleProfileId(): Promise<string | null> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM role_profiles WHERE is_default ORDER BY created_at ASC LIMIT 1`,
  );
  return rows[0]?.id ?? null;
}

function checkCampaignId(id: unknown): id is string {
  return typeof id === 'string' && UUID_RE.test(id);
}

// ---------------------------------------------------------------------------
// Rutas.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Ejecución de una búsqueda de campaña. La comparten el botón «Buscar» del
// panel (POST /api/campaigns/:id/search) y el scheduler diario (Fase 8.2):
// MISMA lógica de presupuesto, circuit breaker, evaluación, validación de
// enlaces, libro de costes y preparación automática.
// ---------------------------------------------------------------------------

export interface BusquedaResumen {
  id: string;
  query: string;
  results_count: number;
  duplicates_count: number;
  /** Resultados descartados por parecer perfiles de personas, no ofertas. */
  filtered_count: number;
  /** Ofertas descartadas por enlace CONFIRMADO roto (no entran al pool). */
  broken_count: number;
  cost_usd: number;
  error?: string;
}

export type ResultadoBusqueda =
  | { ok: true; searches: BusquedaResumen[]; total_cost_usd: number }
  | { ok: false; status: number; error: string; extra?: Record<string, unknown> };

export async function ejecutarBusquedaCampana(
  config: AppConfig,
  campaignId: string,
  opts: { queries?: string[]; numResults?: number; actorId: string | null },
): Promise<ResultadoBusqueda> {
    const id = campaignId;
    const campaignRow = await getCampaignOr404(id);
    if (!campaignRow) {
      return { ok: false, status: 404, error: 'campana_no_encontrada' };
    }
    const criteria = campaignRow.criteria as CampaignCriteria;

    // 2) Consultas (máx 5 por tirada): las del cuerpo; si no, las de la
    // campaña ROTADAS por día (puede guardar más de 5 y se van alternando);
    // si la campaña no define ninguna, las plantillas de generateQueries.
    const bodyQueries = (opts.queries ?? []).slice(0, 5);
    const resolvedQueries =
      bodyQueries.length > 0
        ? bodyQueries
        : criteria.queries.length > 0
          ? selectQueries(criteria.queries, new Date(), 5)
          : generateQueries(criteria).slice(0, 5);
    if (resolvedQueries.length === 0) {
      return { ok: false, status: 400, error: 'sin_consultas' };
    }
    const numResults = opts.numResults ?? 10;

    // 3) Presupuesto: estimación conservadora ANTES de tocar Exa (tope de
    //    campaña heredado de Fase 2) + presupuestos globales diario/mensual
    //    y tope total de la campaña (Fase 5, libro de costes).
    const spent = Number(campaignRow.exa_spent_usd);
    const cap = Number(campaignRow.exa_budget_cap_usd);
    const estimate = resolvedQueries.length * EXA_COST_ESTIMATE_PER_SEARCH_USD;
    if (spent + estimate > cap) {
      return { ok: false, status: 409, error: 'presupuesto_exa_agotado', extra: { gastado: spent, limite: cap } };
    }
    const disp = await presupuestoDisponible(id);
    if (!disp.ok) {
      return { ok: false, status: 409, error: disp.codigo, extra: { motivo: disp.motivo } };
    }

    // 3b) Circuit breaker de Exa: si está abierto, no se llama.
    const exaDisp = await conectorDisponible('exa');
    if (!exaDisp.disponible) {
      return { ok: false, status: 503, error: 'conector_deshabilitado_temporalmente', extra: { motivo: exaDisp.motivo } };
    }

    // 4) Clave de Exa configurada. El valor nunca se loguea.
    const apiKey = config.exaApiKey;
    if (!apiKey) {
      return { ok: false, status: 503, error: 'exa_no_configurado' };
    }

    const client = exaClientFactory()(apiKey);
    const evaluate = evaluateOfferFn();
    const { facts: profileFacts, versionId: profileVersionId } = await loadActiveProfileFacts();

    const summaries: Array<{
      id: string;
      query: string;
      results_count: number;
      duplicates_count: number;
      filtered_count: number;
      broken_count: number;
      cost_usd: number;
      error?: string;
    }> = [];
    let totalCost = 0;
    let totalBroken = 0;

    // 5) Una búsqueda por consulta; los fallos no tumban el resto.
    for (const searchQuery of resolvedQueries) {
      const inserted = await query<{ id: string }>(
        `INSERT INTO searches (campaign_id, query, num_results, status, started_at)
         VALUES ($1, $2, $3, 'running', now()) RETURNING id`,
        [id, searchQuery, numResults],
      );
      const searchId = inserted[0].id;
      try {
        const resp = await client.search({
          query: searchQuery,
          numResults,
          ...(criteria.include_domains && criteria.include_domains.length > 0
            ? { includeDomains: criteria.include_domains }
            : {}),
        });
        const cost = Number(resp.costDollars ?? 0);

        let insertedCount = 0;
        let filteredCount = 0;
        let brokenCount = 0;
        const newOffers: Array<{
          id: string;
          title: string;
          url: string;
          highlights: string[];
          exaText?: string;
        }> = [];
        for (const result of resp.results) {
          // Calidad de búsqueda: Exa a veces devuelve PERFILES de personas
          // (su directorio «people») como si fueran ofertas; se descartan
          // en la ingesta y no llegan a la tabla de ofertas.
          if (looksLikePersonProfile(result.title)) {
            filteredCount += 1;
            continue;
          }
          const canon = canonicalUrl(result.url);
          // Canal de aplicación por email: si el anuncio trae el correo al
          // que enviar la candidatura, se guarda con su frase (instrucciones).
          const contact = extractApplicationContact(result.title, result.highlights);
          const rows = await query<{ id: string; title: string | null; url: string; highlights: unknown }>(
            `INSERT INTO offers
               (campaign_id, search_id, canonical_url, url, title, company,
                published_date, highlights, raw, application_email, application_notes)
             VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8::jsonb, $9::jsonb, $10, $11)
             ON CONFLICT (campaign_id, canonical_url) DO NOTHING
             RETURNING id, title, url, highlights`,
            [
              id,
              searchId,
              canon,
              result.url,
              result.title ?? null,
              // Empresa: extracción real (campo del texto, «… at X» del
              // título, tenant del ATS). El `author` de Exa era casi
              // siempre null o basura («Publicada el») — ver extractCompany.
              extractCompany({
                title: result.title,
                url: result.url,
                text: result.text,
                author: result.author,
              }),
              result.publishedDate ?? null,
              JSON.stringify(result.highlights ?? []),
              JSON.stringify(result),
              contact?.email ?? null,
              contact?.notes ?? null,
            ],
          );
          if (rows.length > 0) {
            insertedCount += 1;
            const row = rows[0];
            newOffers.push({
              id: row.id,
              title: row.title ?? '',
              url: row.url,
              highlights: asStringArray(row.highlights),
              exaText: result.text,
            });
          }
        }
        const duplicatesCount = resp.results.length - insertedCount - filteredCount;

        // Validación de enlaces (calidad de búsqueda, corrección
        // 2026-10-21): se comprueban las URLs de las ofertas nuevas ANTES
        // de evaluarlas. Solo lo CONFIRMADO roto (404/410 verificado con
        // HEAD+GET de navegador, o dominio inexistente) se descarta: la
        // fila se borra y la oferta no entra en el pool de la campaña.
        // Lo dudoso (el portal bloquea la sonda: 403/429/5xx/timeout)
        // se conserva con url_ok = null (sin confirmar); lo vivo queda
        // url_ok = true. La sonda vieja marcaba «roto» cualquier
        // respuesta >= 400 o error de red: 27 de 108 ofertas llevaban la
        // etiqueta y casi todas estaban vivas (ReliefWeb y otros portales
        // bloquean agentes no-navegador). Un fallo de la validación no
        // bloquea la búsqueda: las ofertas quedan sin comprobar.
        try {
          const check = checkUrlDetailedFn();
          const rawChecks = await Promise.all(
            newOffers.map(async (offer) => ({ id: offer.id, ...(await check(offer.url)) })),
          );
          // Guarda anti-bloqueo por IP: si Exa trae el texto completo de
          // la página, la página EXISTE (Exa la acaba de leer); un 404
          // desde la IP del servidor es entonces el portal bloqueando
          // IPs de datacenter (caso real Jobera, 2026-10-21: 404 desde
          // Oracle, 200 desde una conexión normal). Se degrada a
          // «unknown»: se conserva, sin etiqueta. La guarda NO se aplica
          // si el veredicto viene del propio portal (API CXS de Workday
          // o plantilla de cierre de Breezy): esa evidencia la firma el
          // ATS, no un cortafuegos.
          const checks = rawChecks.map((c) => {
            if (c.status !== 'broken' || c.via !== 'http') return c;
            const offer = newOffers.find((o) => o.id === c.id);
            return offer?.exaText && offer.exaText.trim().length > 0
              ? { ...c, status: 'unknown' as UrlStatus }
              : c;
          });
          const brokenIds = new Set(
            checks.filter((c) => c.status === 'broken').map((c) => c.id),
          );
          if (brokenIds.size > 0) {
            await query(`DELETE FROM offers WHERE id = ANY($1::uuid[])`, [[...brokenIds]]);
            brokenCount = brokenIds.size;
            totalBroken += brokenCount;
            for (let i = newOffers.length - 1; i >= 0; i--) {
              if (brokenIds.has(newOffers[i].id)) newOffers.splice(i, 1);
            }
          }
          for (const c of checks) {
            if (c.status === 'alive') {
              await query(
                `UPDATE offers SET url_ok = true, url_checked_at = now() WHERE id = $1`,
                [c.id],
              );
            } else if (c.status === 'unknown') {
              await query(`UPDATE offers SET url_checked_at = now() WHERE id = $1`, [c.id]);
            }
          }
        } catch {
          // La validación es informativa; un fallo no invalida la búsqueda.
        }

        // Texto completo de las ofertas nuevas (mejora 20-oct-2026): los
        // extractos de Exa dejaban demasiadas ofertas en «sin evidencia».
        // Fuente principal: el texto que trae la propia respuesta de Exa
        // (sus servidores sí leen las páginas que bloquean al nuestro:
        // ReliefWeb devuelve 406/403 a peticiones directas). Respaldo: la
        // descarga directa. El texto se guarda en offers.raw (la fila ya
        // guarda la respuesta de Exa, texto incluido) y en full_text.
        // Un fallo no bloquea: se evalúa solo con los extractos.
        const fullTexts = new Map<string, string>();
        try {
          const fetched = await Promise.all(
            newOffers.map(async (o) => ({
              id: o.id,
              text: o.exaText ?? (await fetchOfferText(o.url)),
            })),
          );
          for (const f of fetched) {
            if (f.text) {
              fullTexts.set(f.id, f.text);
              await query(`UPDATE offers SET raw = raw || $2::jsonb WHERE id = $1`, [
                f.id,
                JSON.stringify({ full_text: f.text }),
              ]);
            }
          }
        } catch {
          // Sin texto completo se evalúa como antes; nunca bloquea la búsqueda.
        }

        for (const offer of newOffers) {
          const ev = evaluate(
            {
              title: offer.title,
              url: offer.url,
              highlights: offer.highlights,
              fullText: fullTexts.get(offer.id),
            },
            criteria,
            profileFacts,
          );
          await query(
            `INSERT INTO evaluations
               (offer_id, campaign_id, profile_version_id, mandatory_verdict,
                mandatory_details, score, breakdown)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb)
             ON CONFLICT (offer_id, campaign_id) DO NOTHING`,
            [
              offer.id,
              id,
              profileVersionId,
              ev.mandatory_verdict,
              JSON.stringify(ev.mandatory_details),
              ev.score,
              JSON.stringify(ev.breakdown),
            ],
          );
        }

        await query(
          `UPDATE searches
              SET status = 'done', exa_request_id = $2, cost_usd = $3,
                  results_count = $4, duplicates_count = $5, finished_at = now()
            WHERE id = $1`,
          [searchId, resp.requestId ?? null, cost, resp.results.length, duplicatesCount],
        );
        await query(
          `UPDATE campaigns SET exa_spent_usd = exa_spent_usd + $2, updated_at = now() WHERE id = $1`,
          [id, cost],
        );
        // Libro de costes (Fase 5): evento inmutable por búsqueda. La clave
        // de idempotencia evita duplicar el gasto si se reintenta.
        await registrarCoste({
          campaignId: id,
          categoria: 'exa_search',
          cantidadUsd: cost,
          detalles: { search_id: searchId, query: searchQuery, resultados: resp.results.length },
          idempotencyKey: `exa:${searchId}`,
        });
        await registrarExito('exa');
        totalCost += cost;
        summaries.push({
          id: searchId,
          query: searchQuery,
          results_count: resp.results.length,
          duplicates_count: duplicatesCount,
          filtered_count: filteredCount,
          broken_count: brokenCount,
          cost_usd: cost,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'error desconocido';
        await query(`UPDATE searches SET status = 'error', error = $2, finished_at = now() WHERE id = $1`, [
          searchId,
          message,
        ]);
        // El fallo alimenta el circuit breaker de Exa (Fase 5).
        await registrarFallo('exa', message);
        summaries.push({
          id: searchId,
          query: searchQuery,
          results_count: 0,
          duplicates_count: 0,
          filtered_count: 0,
          broken_count: 0,
          cost_usd: 0,
          error: message,
        });
      }
    }

    // Preparación automática (Fase 7): las ofertas que cumplen los
    // obligatorios y alcanzan el umbral de revisión de la política activa
    // quedan preparadas como candidaturas en la cola de revisión. Aislado:
    // un fallo aquí nunca tumba la búsqueda.
    let preparadas = 0;
    try {
      const sweep = await prepararElegibles(id, opts.actorId);
      preparadas = sweep.preparadas;
    } catch {
      // La preparación se reintenta con el disparo manual o la re-evaluación.
    }

    await auditEvent({
      actorId: opts.actorId,
      action: 'search_launched',
      entityType: 'campaign',
      entityId: id,
      details: {
        queries: resolvedQueries,
        total_cost_usd: totalCost,
        candidaturas_preparadas: preparadas,
        enlaces_rotos_descartados: totalBroken,
      },
    });
    return { ok: true, searches: summaries, total_cost_usd: totalCost };
}

export async function registerCampaignRoutes(
  app: FastifyInstance,
  config: AppConfig,
): Promise<void> {
  // GET /api/campaigns — lista con contadores de búsquedas y ofertas.
  app.get('/api/campaigns', authOnly, async () => {
    const rows = await query<CampaignRow>(
      `SELECT c.id, c.name, c.criteria, c.role_profile_id, c.exa_budget_cap_usd, c.exa_spent_usd,
              c.total_budget_cap_usd, c.status, c.created_at, c.updated_at,
              (SELECT COUNT(*) FROM searches s WHERE s.campaign_id = c.id) AS searches_count,
              (SELECT COUNT(*) FROM offers o WHERE o.campaign_id = c.id) AS offers_count
         FROM campaigns c ORDER BY c.created_at DESC`,
    );
    return { campaigns: rows.map(mapCampaign) };
  });

  // POST /api/campaigns — crea una campaña (criterios por defecto si no se dan).
  app.post('/api/campaigns', mutating, async (req, reply) => {
    const valid = validateBody(CreateCampaignBody, req.body, reply);
    if (!valid) return;
    const criteria = valid.data.criteria ?? defaultCriteria();
    // Perfil por rol: explícito (con existencia comprobada), null explícito
    // (sin énfasis) u omitido (se asigna el perfil «por defecto» si existe).
    let roleProfileId: string | null;
    if (valid.data.role_profile_id === undefined) {
      roleProfileId = await defaultRoleProfileId();
    } else if (valid.data.role_profile_id === null) {
      roleProfileId = null;
    } else {
      if (!(await roleProfileExists(valid.data.role_profile_id))) {
        return reply.code(400).send({ error: 'perfil_rol_no_encontrado' });
      }
      roleProfileId = valid.data.role_profile_id;
    }
    const rows = await query<{ id: string; name: string; exa_budget_cap_usd: string }>(
      `INSERT INTO campaigns (name, criteria, exa_budget_cap_usd, role_profile_id, created_by)
       VALUES ($1, $2::jsonb, COALESCE($3::numeric, 3.0000), $4, $5)
       RETURNING id, name, exa_budget_cap_usd`,
      [
        valid.data.name,
        JSON.stringify(criteria),
        valid.data.exa_budget_cap_usd ?? null,
        roleProfileId,
        req.authSession?.userId ?? null,
      ],
    );
    const created = rows[0];
    await auditEvent({
      actorId: req.authSession?.userId ?? null,
      action: 'campaign_created',
      entityType: 'campaign',
      entityId: created.id,
      details: {
        name: created.name,
        exa_budget_cap_usd: Number(created.exa_budget_cap_usd),
        role_profile_id: roleProfileId,
      },
    });
    return reply.code(201).send({ id: created.id, name: created.name, role_profile_id: roleProfileId });
  });

  // GET /api/campaigns/:id — detalle.
  app.get('/api/campaigns/:id', authOnly, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!checkCampaignId(id)) {
      return reply.code(400).send({ error: 'campana_invalida' });
    }
    const campaign = await getCampaignOr404(id);
    if (!campaign) {
      return reply.code(404).send({ error: 'campana_no_encontrada' });
    }
    return { campaign: mapCampaign(campaign) };
  });

  // PUT /api/campaigns/:id — actualización parcial.
  app.put('/api/campaigns/:id', mutating, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!checkCampaignId(id)) {
      return reply.code(400).send({ error: 'campana_invalida' });
    }
    const valid = validateBody(UpdateCampaignBody, req.body ?? {}, reply);
    if (!valid) return;

    const sets: string[] = [];
    const params: unknown[] = [];
    const changed: string[] = [];
    if (valid.data.name !== undefined) {
      params.push(valid.data.name);
      sets.push(`name = $${params.length}`);
      changed.push('name');
    }
    if (valid.data.criteria !== undefined) {
      params.push(JSON.stringify(valid.data.criteria));
      sets.push(`criteria = $${params.length}::jsonb`);
      changed.push('criteria');
    }
    if (valid.data.role_profile_id !== undefined) {
      if (
        valid.data.role_profile_id !== null &&
        !(await roleProfileExists(valid.data.role_profile_id))
      ) {
        return reply.code(400).send({ error: 'perfil_rol_no_encontrado' });
      }
      params.push(valid.data.role_profile_id);
      sets.push(`role_profile_id = $${params.length}`);
      changed.push('role_profile_id');
    }
    if (valid.data.exa_budget_cap_usd !== undefined) {
      params.push(valid.data.exa_budget_cap_usd);
      sets.push(`exa_budget_cap_usd = $${params.length}`);
      changed.push('exa_budget_cap_usd');
    }
    if (valid.data.total_budget_cap_usd !== undefined) {
      params.push(valid.data.total_budget_cap_usd);
      sets.push(`total_budget_cap_usd = $${params.length}`);
      changed.push('total_budget_cap_usd');
    }
    if (valid.data.status !== undefined) {
      params.push(valid.data.status);
      sets.push(`status = $${params.length}`);
      changed.push('status');
    }
    if (sets.length === 0) {
      return reply.code(400).send({ error: 'datos_invalidos', detalles: ['cuerpo: sin cambios'] });
    }
    sets.push('updated_at = now()');
    params.push(id);
    const updated = await query<{ id: string }>(
      `UPDATE campaigns SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id`,
      params,
    );
    if (updated.length === 0) {
      return reply.code(404).send({ error: 'campana_no_encontrada' });
    }
    await auditEvent({
      actorId: req.authSession?.userId ?? null,
      action: 'campaign_updated',
      entityType: 'campaign',
      entityId: id,
      details: { cambios: changed },
    });
    return reply.send({ ok: true });
  });

  // POST /api/campaigns/:id/search — lanza búsquedas en Exa (la lógica vive
  // en ejecutarBusquedaCampana, compartida con el scheduler diario).
  app.post('/api/campaigns/:id/search', mutating, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!checkCampaignId(id)) {
      return reply.code(400).send({ error: 'campana_invalida' });
    }
    const valid = validateBody(LaunchSearchBody, req.body ?? {}, reply);
    if (!valid) return;
    const res = await ejecutarBusquedaCampana(config, id, {
      queries: valid.data.queries,
      numResults: valid.data.num_results,
      actorId: req.authSession?.userId ?? null,
    });
    if (!res.ok) {
      return reply.code(res.status).send({ error: res.error, ...(res.extra ?? {}) });
    }
    return reply.send({ searches: res.searches, total_cost_usd: res.total_cost_usd });
  });

  // GET /api/campaigns/:id/offers — ofertas con su evaluación (si existe).
  app.get('/api/campaigns/:id/offers', authOnly, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!checkCampaignId(id)) {
      return reply.code(400).send({ error: 'campana_invalida' });
    }
    const campaign = await getCampaignOr404(id);
    if (!campaign) {
      return reply.code(404).send({ error: 'campana_no_encontrada' });
    }
    const rows = await query<OfferRow>(
      `SELECT o.id, o.campaign_id, o.search_id, o.canonical_url, o.url, o.title,
              o.company, o.published_date, o.retrieved_at, o.highlights, o.raw,
              o.url_ok, o.url_checked_at, o.application_email, o.application_notes,
              e.mandatory_verdict, e.score, e.breakdown,
              a.id AS application_id, a.status AS application_status
         FROM offers o
         LEFT JOIN evaluations e
           ON e.offer_id = o.id AND e.campaign_id = o.campaign_id
         LEFT JOIN applications a
           ON a.offer_id = o.id AND a.campaign_id = o.campaign_id
        WHERE o.campaign_id = $1
        ORDER BY o.retrieved_at DESC`,
      [id],
    );
    // Documentos descargables de cada candidatura (versión más alta por
    // tipo/formato): el panel enlaza su descarga desde la tabla.
    const docsByApp = new Map<
      string,
      Array<{ id: string; kind: string; format: string; version: number }>
    >();
    const appIds = rows.map((o) => o.application_id).filter((x): x is string => !!x);
    if (appIds.length > 0) {
      const docs = await query<{
        id: string;
        application_id: string;
        kind: string;
        format: string;
        version: number;
      }>(
        `SELECT id, application_id, kind, format, version
           FROM documents
          WHERE application_id = ANY($1::uuid[])
          ORDER BY application_id, kind, format, version DESC`,
        [appIds],
      );
      const seen = new Set<string>();
      for (const d of docs) {
        const key = `${d.application_id}|${d.kind}|${d.format}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const list = docsByApp.get(d.application_id) ?? [];
        list.push({ id: d.id, kind: d.kind, format: d.format, version: d.version });
        docsByApp.set(d.application_id, list);
      }
    }
    return {
      offers: rows.map((o) => ({
        id: o.id,
        title: o.title,
        company: o.company,
        url: o.url,
        url_ok: o.url_ok,
        application_email: o.application_email ?? null,
        application: o.application_id
          ? {
              id: o.application_id,
              status: o.application_status,
              documents: docsByApp.get(o.application_id) ?? [],
            }
          : null,
        canonical_url: o.canonical_url,
        published_date: o.published_date,
        retrieved_at: toIso(o.retrieved_at),
        evaluation:
          o.mandatory_verdict === null
            ? null
            : {
                mandatory_verdict: o.mandatory_verdict,
                score: o.score === null ? null : Number(o.score),
                breakdown: o.breakdown,
              },
      })),
    };
  });

  // GET /api/campaigns/:id/offers/:offerId — detalle de una oferta.
  app.get('/api/campaigns/:id/offers/:offerId', authOnly, async (req, reply) => {
    const { id, offerId } = req.params as { id: string; offerId: string };
    if (!checkCampaignId(id) || !checkCampaignId(offerId)) {
      return reply.code(400).send({ error: 'campana_invalida' });
    }
    const rows = await query<OfferRow>(
      `SELECT o.id, o.campaign_id, o.search_id, o.canonical_url, o.url, o.title,
              o.company, o.published_date, o.retrieved_at, o.highlights, o.raw,
              e.mandatory_verdict, e.score, e.breakdown, e.mandatory_details,
              a.id AS application_id, a.status AS application_status
         FROM offers o
         LEFT JOIN evaluations e
           ON e.offer_id = o.id AND e.campaign_id = o.campaign_id
         LEFT JOIN applications a
           ON a.offer_id = o.id AND a.campaign_id = o.campaign_id
        WHERE o.id = $1 AND o.campaign_id = $2`,
      [offerId, id],
    );
    const offer = rows[0];
    if (!offer) {
      return reply.code(404).send({ error: 'oferta_no_encontrada' });
    }
    return {
      offer: {
        id: offer.id,
        title: offer.title,
        company: offer.company,
        url: offer.url,
        canonical_url: offer.canonical_url,
        published_date: offer.published_date,
        retrieved_at: toIso(offer.retrieved_at),
        highlights: offer.highlights,
        application: offer.application_id
          ? {
              id: offer.application_id,
              status: offer.application_status,
              documents: await latestDocuments(offer.application_id),
            }
          : null,
      },
      evaluation:
        offer.mandatory_verdict === null
          ? null
          : {
              mandatory_verdict: offer.mandatory_verdict,
              mandatory_details: offer.mandatory_details,
              score: offer.score === null ? null : Number(offer.score),
              breakdown: offer.breakdown,
            },
    };
  });

  // POST /api/campaigns/:id/offers/:offerId/prepare — preparación manual
  // (Fase 7): acción expresa de Jon. Prepara la candidatura de una oferta
  // evaluada AUNQUE no supere el umbral automático. Idempotente.
  app.post('/api/campaigns/:id/offers/:offerId/prepare', mutating, async (req, reply) => {
    const { id, offerId } = req.params as { id: string; offerId: string };
    if (!checkCampaignId(id) || !checkCampaignId(offerId)) {
      return reply.code(400).send({ error: 'campana_invalida' });
    }
    const campaign = await getCampaignOr404(id);
    if (!campaign) {
      return reply.code(404).send({ error: 'campana_no_encontrada' });
    }
    const res = await prepararCandidatura(id, offerId, {
      actorId: req.authSession?.userId ?? null,
    });
    if (res.motivo === 'oferta_no_encontrada') {
      return reply.code(404).send({ error: 'oferta_no_encontrada' });
    }
    if (res.motivo === 'oferta_sin_evaluacion') {
      return reply.code(409).send({ error: 'oferta_sin_evaluacion' });
    }
    if (res.motivo === 'sin_perfil_activo_o_incompleto') {
      return reply.code(409).send({ error: 'sin_perfil_activo' });
    }
    const rows = await query<{ id: string; status: string; portal: string | null; failure_reason: string | null }>(
      `SELECT id, status, portal, failure_reason FROM applications WHERE id = $1`,
      [res.applicationId],
    );
    const appRow = rows[0];
    return reply.code(res.creada ? 201 : 200).send({
      application: {
        id: appRow.id,
        status: appRow.status,
        portal: appRow.portal,
        failureReason: appRow.failure_reason,
      },
      creada: res.creada,
      ...(res.motivo ? { motivo: res.motivo } : {}),
    });
  });

  // POST /api/campaigns/:id/evaluate — re-evalúa todas las ofertas de la campaña.
  app.post('/api/campaigns/:id/evaluate', mutating, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!checkCampaignId(id)) {
      return reply.code(400).send({ error: 'campana_invalida' });
    }
    const campaign = await getCampaignOr404(id);
    if (!campaign) {
      return reply.code(404).send({ error: 'campana_no_encontrada' });
    }
    const criteria = campaign.criteria as CampaignCriteria;
    const evaluate = evaluateOfferFn();
    const { facts: profileFacts, versionId: profileVersionId } = await loadActiveProfileFacts();

    const offers = await query<{ id: string; title: string | null; url: string; highlights: unknown }>(
      `SELECT id, title, url, highlights FROM offers WHERE campaign_id = $1`,
      [id],
    );
    for (const offer of offers) {
      const ev = evaluate(
        {
          title: offer.title ?? '',
          url: offer.url,
          highlights: asStringArray(offer.highlights),
        },
        criteria,
        profileFacts,
      );
      await query(
        `INSERT INTO evaluations
           (offer_id, campaign_id, profile_version_id, mandatory_verdict,
            mandatory_details, score, breakdown)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb)
         ON CONFLICT (offer_id, campaign_id) DO UPDATE SET
           profile_version_id = EXCLUDED.profile_version_id,
           mandatory_verdict = EXCLUDED.mandatory_verdict,
           mandatory_details = EXCLUDED.mandatory_details,
           score = EXCLUDED.score,
           breakdown = EXCLUDED.breakdown,
           created_at = now()`,
        [
          offer.id,
          id,
          profileVersionId,
          ev.mandatory_verdict,
          JSON.stringify(ev.mandatory_details),
          ev.score,
          JSON.stringify(ev.breakdown),
        ],
      );
    }
    // Preparación automática (Fase 7): tras re-evaluar, las que cumplen y
    // alcanzan el umbral quedan preparadas. Aislado como en la búsqueda.
    try {
      await prepararElegibles(id, req.authSession?.userId ?? null);
    } catch {
      // Sin efectos sobre la respuesta de la re-evaluación.
    }
    return reply.send({ evaluated: offers.length });
  });

  // GET /api/campaigns/:id/report — genera, guarda y devuelve el informe.
  app.get('/api/campaigns/:id/report', authOnly, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!checkCampaignId(id)) {
      return reply.code(400).send({ error: 'campana_invalida' });
    }
    const campaignRow = await getCampaignOr404(id);
    if (!campaignRow) {
      return reply.code(404).send({ error: 'campana_no_encontrada' });
    }

    const searches = await query<SearchRow>(
      `SELECT id, campaign_id, query, num_results, status, exa_request_id, cost_usd,
              results_count, duplicates_count, error, started_at, finished_at
         FROM searches WHERE campaign_id = $1 ORDER BY finished_at ASC`,
      [id],
    );
    const offers = await query<OfferRow>(
      `SELECT o.id, o.campaign_id, o.search_id, o.canonical_url, o.url, o.title,
              o.company, o.published_date, o.retrieved_at, o.highlights, o.raw,
              e.mandatory_verdict, e.score, e.breakdown, e.mandatory_details
         FROM offers o
         LEFT JOIN evaluations e
           ON e.offer_id = o.id AND e.campaign_id = o.campaign_id
        WHERE o.campaign_id = $1
        ORDER BY o.retrieved_at DESC`,
      [id],
    );

    // Fuentes intentadas: dominios distintos de las ofertas leídas.
    const hosts = new Set<string>();
    for (const offer of offers) {
      try {
        hosts.add(new URL(offer.canonical_url).hostname);
      } catch {
        // URL no parseable: no es una fuente identificable.
      }
    }
    const erroredSearches = searches.filter((s) => s.status === 'error');
    // Si alguna búsqueda falló, la fuente inaccesible es la propia API de Exa.
    const fuentesInaccesibles = erroredSearches.length > 0 ? ['api.exa.ai'] : [];

    const cumple = offers.filter((o) => o.mandatory_verdict === 'cumple');
    const descartadas = offers.filter((o) => o.mandatory_verdict !== 'cumple');

    const descartes = descartadas.map((o) => {
      const details = Array.isArray(o.mandatory_details)
        ? (o.mandatory_details as Array<{
            requisito_id: string;
            descripcion: string;
            estado: string;
            evidencia: string;
          }>)
        : [];
      const fallidos = details.filter((d) => d.estado === 'incumple');
      const sinEvidencia = details.filter((d) => d.estado === 'sin_evidencia');
      let motivo: string;
      if (fallidos.length > 0) {
        motivo = `no cumple: ${fallidos.map((d) => d.descripcion).join('; ')}`;
      } else if (sinEvidencia.length > 0) {
        motivo = `sin evidencia de: ${sinEvidencia.map((d) => d.requisito_id).join(', ')}`;
      } else if (o.mandatory_verdict === null) {
        motivo = 'pendiente de evaluación';
      } else {
        motivo = `veredicto: ${o.mandatory_verdict}`;
      }
      const evidencia =
        details.map((d) => d.evidencia).find((e) => e && e.length > 0) ?? '';
      return { titulo: o.title ?? '', motivo, evidencia };
    });

    const report = {
      campana: { id: campaignRow.id, nombre: campaignRow.name, estado: campaignRow.status },
      generado_en: new Date().toISOString(),
      busquedas: searches.map((s) => ({
        query: s.query,
        estado: s.status,
        resultados: s.results_count,
        duplicados: s.duplicates_count,
        coste_usd: Number(s.cost_usd),
        ...(s.error ? { error: s.error } : {}),
      })),
      fuentes_intentadas: [...hosts].sort(),
      fuentes_inaccesibles: fuentesInaccesibles,
      vacantes_leidas: offers.length,
      duplicados_descartados: searches.reduce((acc, s) => acc + s.duplicates_count, 0),
      ofertas: cumple.map((o) => ({
        titulo: o.title ?? '',
        empresa: o.company ?? '',
        url: o.url,
        veredicto: o.mandatory_verdict,
        puntuacion: o.score === null ? null : Number(o.score),
      })),
      descartes,
      nuevas_coincidencias: cumple.length,
      gasto_total_usd: Number(campaignRow.exa_spent_usd),
      presupuesto_usd: Number(campaignRow.exa_budget_cap_usd),
    };

    await query(`INSERT INTO campaign_reports (campaign_id, report) VALUES ($1, $2::jsonb)`, [
      id,
      JSON.stringify(report),
    ]);
    await auditEvent({
      actorId: req.authSession?.userId ?? null,
      action: 'report_generated',
      entityType: 'campaign',
      entityId: id,
      details: { ofertas: cumple.length, descartes: descartes.length },
    });
    return reply.send({ report });
  });

  // DELETE /api/campaigns/:id — borrado definitivo a petición de Jon
  // (20-oct-2026). La cascada de la BD elimina ofertas, búsquedas,
  // evaluaciones, candidaturas y documentos. El libro de costes se conserva
  // desvinculado (el gasto ocurrió y su registro es inmutable); los
  // mensajes de Gmail y las intervenciones también se desvinculan.
  app.delete('/api/campaigns/:id', mutating, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!checkCampaignId(id)) {
      return reply.code(400).send({ error: 'campana_invalida' });
    }
    const campaign = await getCampaignOr404(id);
    if (!campaign) {
      return reply.code(404).send({ error: 'campana_no_encontrada' });
    }
    // Protección: una campaña con envíos reales (en curso o ya enviados) no
    // se borra: es el historial de candidaturas reales de Jon.
    const enviadas = await query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM applications
        WHERE campaign_id = $1 AND status IN ('submitting', 'submitted')`,
      [id],
    );
    if (Number(enviadas[0].count) > 0) {
      return reply.code(409).send({ error: 'campana_con_envios_reales' });
    }
    const conteos = await withTransaction(async (client) => {
      await client.query(
        `UPDATE cost_events SET offer_id = NULL
          WHERE offer_id IN (SELECT id FROM offers WHERE campaign_id = $1)`,
        [id],
      );
      await client.query(
        `UPDATE cost_events SET application_id = NULL
          WHERE application_id IN (SELECT id FROM applications WHERE campaign_id = $1)`,
        [id],
      );
      await client.query(`UPDATE cost_events SET campaign_id = NULL WHERE campaign_id = $1`, [id]);
      await client.query(
        `UPDATE gmail_messages SET application_id = NULL
          WHERE application_id IN (SELECT id FROM applications WHERE campaign_id = $1)`,
        [id],
      );
      await client.query(
        `UPDATE interventions SET application_id = NULL
          WHERE application_id IN (SELECT id FROM applications WHERE campaign_id = $1)`,
        [id],
      );
      const prev = await client.query<{ offers: string; searches: string; applications: string }>(
        `SELECT (SELECT COUNT(*) FROM offers WHERE campaign_id = $1) AS offers,
                (SELECT COUNT(*) FROM searches WHERE campaign_id = $1) AS searches,
                (SELECT COUNT(*) FROM applications WHERE campaign_id = $1) AS applications`,
        [id],
      );
      await client.query(`DELETE FROM campaigns WHERE id = $1`, [id]);
      return prev.rows[0];
    });
    await auditEvent({
      actorId: req.authSession?.userId ?? null,
      action: 'campaign_deleted',
      entityType: 'campaign',
      entityId: id,
      details: {
        name: campaign.name,
        offers: Number(conteos.offers),
        searches: Number(conteos.searches),
        applications: Number(conteos.applications),
      },
    });
    return reply.send({ ok: true });
  });
}
