/**
 * Tests del backend (node:test + fastify.inject contra PostgreSQL real).
 *
 * Requieren `DATABASE_URL` en el entorno. Cada fichero de test levanta su
 * propia instancia de la app (con migraciones aplicadas) y limpia todas las
 * tablas antes de cada caso.
 */

import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@jobforce/config';
import { closePool, query, runMigrations } from '@jobforce/database';
import { CSRF_HEADER_NAME } from '@jobforce/domain';
import { buildServer } from '../src/server.js';

/** Crea la app de test con las migraciones aplicadas. */
export async function buildTestApp(
  overrides: Record<string, string> = {},
): Promise<FastifyInstance> {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL es obligatoria para ejecutar los tests del backend.');
  }
  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    SESSION_COOKIE_SECURE: 'false',
    // Por defecto, rate limit holgado en tests: los ficheros hacen login en
    // cada beforeEach y el límite estricto (10/5min) los tumbaría. El fichero
    // auth-ratelimit.test.ts fija los valores estrictos explícitamente.
    LOGIN_RATE_LIMIT_MAX: '1000',
    ...overrides,
  });
  process.env.DATABASE_URL = config.databaseUrl;
  await runMigrations(config.databaseUrl);
  const app = buildServer(config);
  await app.ready();
  return app;
}

/** Vacía todas las tablas de negocio (las secuencias IDENTITY se reinician). */
export async function resetDb(): Promise<void> {
  await query(
    `TRUNCATE admin_users, user_sessions, profile_versions, profile_facts,
              role_profiles,
              answer_memory, configuration_versions, audit_events,
              campaigns, searches, offers, evaluations, campaign_reports,
              applications, documents, gmail_sync_state, gmail_messages,
              autonomy_policies, sends, send_locks, outbox, interventions,
              portal_accounts, application_outcomes,
              cost_events, connector_breakers,
              gmail_oauth_states, gmail_tokens, protected_settings,
              code_changes, deployments,
              etiquetas_ofertas, etiquetas_correos
     RESTART IDENTITY CASCADE`,
  );
  // La migración 006 siembra los presupuestos; los tests parten de valores
  // conocidos (se re-siembran tras el TRUNCATE).
  await query(
    `INSERT INTO budget_config (clave, valor_usd) VALUES
       ('daily_usd', 5.0000), ('monthly_usd', 50.0000)
     ON CONFLICT (clave) DO UPDATE
       SET valor_usd = EXCLUDED.valor_usd, actualizado_en = now()`,
  );
  // La migración 004 siembra la política v1 como borrador; los tests parten
  // de ese estado inicial conocido.
  await query(
    `INSERT INTO autonomy_policies (version, policy, authorized_by, authorized_at, global_stop, notes)
     VALUES (
       1,
       '{
         "version": 1,
         "modoActivo": "preparar_para_revision",
         "autorizacionEscrita": null,
         "paradaGlobal": false,
         "reglas": {
           "portalesPermitidos": ["greenhouse", "lever", "personio"],
           "empresasExcluidas": [],
           "umbralEncajeRevision": 70,
           "umbralEncajeAutomatico": 75,
           "maxEnviosPorDia": 5,
           "maxEnviosPorSemana": 20,
           "presupuestoMensualUsd": 50,
           "presupuestoExaMensualUsd": 3,
           "tratamientoDesconocidos": "revision",
           "crearCuentasPortales": false
         }
       }'::jsonb,
       NULL, NULL, false,
       'Borrador inicial de la política de autonomía (Fase 4).'
     )`,
  );
  // La migración 012 siembra los tres perfiles por rol aprobados; los tests
  // parten de ese estado inicial conocido (se re-siembran tras el TRUNCATE).
  await query(
    `INSERT INTO role_profiles (name, headline, summary, featured, skills, education_note, is_default) VALUES
       (
         'Finance Manager / CFO',
         'Finance Manager / CFO · 15+ years · IFRS · International role with relocation',
         'Finance professional with over 15 years of experience across Spain, the Netherlands and Peru. CFO of an agro-export company, financial accountant in a multinational shared services centre and accounting team leader for seven years. Seeking his next international challenge.',
         '[
           {"title": "CFO — SurExport Peru Berries SAC", "subtitle": "Lima, Peru · 2023 – 2026", "description": ""},
           {"title": "Financial Accountant — Dufry SSC", "subtitle": "Eindhoven, Netherlands · 2021 – 2023", "description": ""},
           {"title": "General Accountant Team Leader — Bexiflon SL", "subtitle": "Logroño · 2014 – 2021", "description": ""}
         ]'::jsonb,
         '["IFRS", "SAP", "Oracle", "NetSuite", "SQL", "Advanced Excel", "Power BI", "Team management"]'::jsonb,
         'Industrial Engineering — Universidad de Navarra · Executive MBA — ICADE',
         true
       ),
       (
         'AI Engineer',
         'AI Engineer · Design and build of AI applications and agents',
         'AI product builder with more than 50 real applications deployed: autonomous agents, software generation studios and tools that combine language models with cloud services. Designs the product, builds it and leaves it running in production.',
         '[
           {"title": "AppForge AI Studio", "subtitle": "", "description": "Studio that generates complete applications from a description: agent, automatic build and deployment"},
           {"title": "JOBFORCE", "subtitle": "", "description": "Agent that automates job search: discovers offers, tailors CVs and cover letters and tracks replies"},
           {"title": "Atlas de Proyectos", "subtitle": "", "description": "Visual, interactive catalogue of his AI application ecosystem"}
         ]'::jsonb,
         '["LLM agents", "OpenRouter · Groq · Mistral", "TypeScript", "AI APIs", "Web automation", "Docker"]'::jsonb,
         NULL,
         false
       ),
       (
         'Full Stack Developer',
         'Full Stack Developer · React · Node.js · MySQL',
         'Full-stack developer with real published projects: web applications with React and TypeScript, Node.js backends and databases, and original 3D browser games. Complete training in React, Node.js + Express and MySQL, applied across dozens of his own deployments.',
         '[
           {"title": "3D browser games (Three.js)", "subtitle": "", "description": "Open city, football and military FPS, original and playable"},
           {"title": "More than 50 web applications", "subtitle": "", "description": "Deployed on Vercel, with repositories on GitHub"},
           {"title": "Own web ERP", "subtitle": "", "description": "Running in production on his server"}
         ]'::jsonb,
         '["React", "TypeScript", "Node.js + Express", "MySQL", "Vite", "Git / GitHub", "Vercel"]'::jsonb,
         NULL,
         false
       )
     ON CONFLICT (name) DO NOTHING`,
  );
}

export async function closeTestApp(app: FastifyInstance): Promise<void> {
  await app.close();
  await closePool();
}

export interface AuthContext {
  cookie: string;
  csrfToken: string;
  username: string;
}

/** Alta del admin + login. Devuelve la cookie de sesión y el token CSRF. */
export async function setupAndLogin(
  app: FastifyInstance,
  username = 'admin',
  password = 'contrasena-muy-segura-123',
): Promise<AuthContext> {
  const setup = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    payload: { username, password },
  });
  assert.equal(setup.statusCode, 201, `setup inesperado: ${setup.statusCode} ${setup.body}`);

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
  assert.equal(login.statusCode, 200, `login inesperado: ${login.statusCode} ${login.body}`);

  const setCookie = login.headers['set-cookie'];
  assert.ok(setCookie, 'el login debe devolver Set-Cookie');
  const raw = Array.isArray(setCookie) ? setCookie[0] : String(setCookie);
  const cookie = raw.split(';')[0];
  const body = login.json<{ csrfToken: string }>();
  assert.ok(body.csrfToken, 'el login debe devolver csrfToken');
  return { cookie, csrfToken: body.csrfToken, username };
}

/** Cabeceras de autenticación (+ CSRF opcional) para las peticiones. */
export function authed(auth: AuthContext, withCsrf = true): Record<string, string> {
  const headers: Record<string, string> = { cookie: auth.cookie };
  if (withCsrf) headers[CSRF_HEADER_NAME] = auth.csrfToken;
  return headers;
}
