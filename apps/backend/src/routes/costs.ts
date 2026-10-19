/**
 * @jobforce/backend — Rutas de costes (Fase 5).
 *
 * - GET  /api/costs/summary?campaign_id=  → presupuestos: diario, mensual y (opcional) de campaña.
 * - GET  /api/costs/events                → eventos recientes (filtros: campaign_id, categoria, limit).
 * - POST /api/costs/events                → registra un evento manual (p. ej. tokens LLM reportados por el runtime).
 * - PUT  /api/costs/budgets               → fija presupuestos diario/mensual (USD).
 * - GET  /api/costs/breakers              → estado de los circuit breakers.
 * - POST /api/costs/breakers/:connector/reset → resetea un breaker manualmente.
 *
 * Todas exigen sesión; las mutadoras además exigen cabecera CSRF.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  COST_CATEGORIES,
  conectorDisponible,
  estimarCosteLlm,
  fijarPresupuesto,
  listarConectores,
  listarCostes,
  registrarCoste,
  resetearConector,
  verificarPresupuestos,
  type CostCategory,
} from '@jobforce/costs';
import { auditEvent } from '../audit.js';
import { requireCsrf, requireSession } from '../auth.js';
import { validateBody } from '../validation.js';

const authOnly = { preHandler: [requireSession] };
const mutating = { preHandler: [requireSession, requireCsrf] };

const CostEventBody = z.object({
  campaign_id: z.string().uuid().optional().nullable(),
  application_id: z.string().uuid().optional().nullable(),
  offer_id: z.string().uuid().optional().nullable(),
  categoria: z.enum(COST_CATEGORIES as unknown as [CostCategory, ...CostCategory[]]),
  cantidad_usd: z.number().min(0).max(1_000_000),
  detalles: z.record(z.string(), z.unknown()).optional(),
  idempotency_key: z.string().max(200).optional(),
});

const BudgetsBody = z.object({
  daily_usd: z.number().min(0).max(1_000_000).optional(),
  monthly_usd: z.number().min(0).max(1_000_000).optional(),
});

export async function registerCostRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/costs/summary — presupuestos y uso.
  app.get('/api/costs/summary', authOnly, async (req) => {
    const q = req.query as { campaign_id?: string };
    return verificarPresupuestos(q.campaign_id);
  });

  // GET /api/costs/events — eventos recientes.
  app.get('/api/costs/events', authOnly, async (req) => {
    const q = req.query as { campaign_id?: string; categoria?: CostCategory; limit?: string };
    const categoria = q.categoria && (COST_CATEGORIES as readonly string[]).includes(q.categoria)
      ? q.categoria
      : undefined;
    return {
      eventos: await listarCostes({
        campaignId: q.campaign_id,
        categoria,
        limite: q.limit ? Number(q.limit) : 100,
      }),
    };
  });

  // POST /api/costs/events — registro manual (p. ej. tokens LLM del runtime).
  app.post('/api/costs/events', mutating, async (req, reply) => {
    const valid = validateBody(CostEventBody, req.body ?? {}, reply);
    if (!valid) return;
    const d = valid.data;
    // Si es llm_tokens y vienen tokens pero no cantidad, estimar con tarifas.
    let cantidad = d.cantidad_usd;
    const detalles: Record<string, unknown> = { ...(d.detalles ?? {}) };
    if (d.categoria === 'llm_tokens' && cantidad === 0) {
      const modelo = String(detalles.modelo ?? '');
      const tin = Number(detalles.tokens_entrada ?? 0);
      const tout = Number(detalles.tokens_salida ?? 0);
      if (modelo && tin + tout > 0) {
        const est = estimarCosteLlm(modelo, tin, tout);
        cantidad = est.costeUsd;
        detalles.tarifa_usada = est.tarifaUsada;
        detalles.estimacion = est.estimacion;
      }
    }
    const { id, duplicado } = await registrarCoste({
      campaignId: d.campaign_id ?? null,
      applicationId: d.application_id ?? null,
      offerId: d.offer_id ?? null,
      categoria: d.categoria,
      cantidadUsd: cantidad,
      detalles,
      idempotencyKey: d.idempotency_key,
    });
    await auditEvent({
      actorId: req.authSession?.userId ?? null,
      action: 'cost_event_registered',
      entityType: 'cost_event',
      entityId: id,
      details: { categoria: d.categoria, cantidad_usd: cantidad },
    });
    return reply.code(duplicado ? 200 : 201).send({ id, duplicado });
  });

  // PUT /api/costs/budgets — fija presupuestos globales.
  app.put('/api/costs/budgets', mutating, async (req, reply) => {
    const valid = validateBody(BudgetsBody, req.body ?? {}, reply);
    if (!valid) return;
    const out: Record<string, number> = {};
    if (valid.data.daily_usd !== undefined) out.daily_usd = await fijarPresupuesto('daily_usd', valid.data.daily_usd);
    if (valid.data.monthly_usd !== undefined) out.monthly_usd = await fijarPresupuesto('monthly_usd', valid.data.monthly_usd);
    await auditEvent({
      actorId: req.authSession?.userId ?? null,
      action: 'budgets_updated',
      entityType: 'budget_config',
      entityId: null,
      details: out,
    });
    return reply.send({ presupuestos: out });
  });

  // GET /api/costs/breakers — estado de los circuit breakers.
  app.get('/api/costs/breakers', authOnly, async () => {
    const conectores = await listarConectores();
    const estados = await Promise.all(
      conectores.map(async (c) => ({ ...c, ...(await conectorDisponible(c.connector)) })),
    );
    return { conectores: estados };
  });

  // POST /api/costs/breakers/:connector/reset — reseteo manual.
  app.post('/api/costs/breakers/:connector/reset', mutating, async (req) => {
    const { connector } = req.params as { connector: string };
    const estado = await resetearConector(connector);
    await auditEvent({
      actorId: req.authSession?.userId ?? null,
      action: 'breaker_reset',
      entityType: 'connector_breaker',
      entityId: estado.connector,
      details: {},
    });
    return { conector: estado };
  });
}
