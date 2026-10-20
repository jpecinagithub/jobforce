/**
 * Tests de perfiles por rol (fase «Perfiles por rol»):
 * CRUD completo, validación, unicidad de nombre y de «por defecto»,
 * semilla de los tres perfiles aprobados, enlace con campañas
 * (role_profile_id) y garantía de que el perfil base (hechos) no se altera.
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { RoleProfile } from '@jobforce/domain';
import {
  authed,
  buildTestApp,
  closeTestApp,
  resetDb,
  setupAndLogin,
  type AuthContext,
} from './helpers.js';

describe('perfiles por rol', () => {
  let app: FastifyInstance;
  let auth: AuthContext;

  before(async () => {
    app = await buildTestApp();
  });
  beforeEach(async () => {
    await resetDb();
    auth = await setupAndLogin(app);
  });
  after(async () => {
    await closeTestApp(app);
  });

  async function listProfiles(): Promise<RoleProfile[]> {
    const res = await app.inject({
      method: 'GET',
      url: '/api/role-profiles',
      headers: authed(auth, false),
    });
    assert.equal(res.statusCode, 200);
    return res.json<RoleProfile[]>();
  }

  it('GET /api/role-profiles sin sesión → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/role-profiles' });
    assert.equal(res.statusCode, 401);
  });

  it('la semilla trae los 3 perfiles aprobados, con Finanzas por defecto y primero', async () => {
    const profiles = await listProfiles();
    assert.equal(profiles.length, 3);
    assert.deepEqual(
      profiles.map((p) => p.name),
      ['Finance Manager / CFO', 'AI Engineer', 'Full Stack Developer'],
    );
    const fin = profiles[0];
    assert.equal(fin.isDefault, true);
    assert.equal(
      fin.headline,
      'Finance Manager / CFO · 15+ años · IFRS · Rol internacional con reubicación',
    );
    assert.match(fin.summary, /más de 15 años entre España, Países Bajos y Perú/);
    assert.equal(fin.featured.length, 3);
    assert.equal(fin.featured[0].title, 'CFO — SurExport Peru Berries SAC');
    assert.equal(fin.featured[0].subtitle, 'Lima, Perú · 2023 – 2026');
    assert.deepEqual(fin.skills.slice(0, 3), ['IFRS', 'SAP', 'Oracle']);
    assert.equal(
      fin.educationNote,
      'Ingeniero Industrial — Universidad de Navarra · Executive MBA — ICADE',
    );
    const ai = profiles[1];
    assert.equal(ai.isDefault, false);
    assert.equal(ai.featured[0].title, 'AppForge AI Studio');
    assert.match(ai.featured[0].description, /genera aplicaciones completas/);
    assert.equal(profiles.filter((p) => p.isDefault).length, 1);
  });

  it('POST crea un perfil completo (201) y GET :id lo devuelve', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/role-profiles',
      headers: authed(auth),
      payload: {
        name: 'Data Analyst',
        headline: 'Data Analyst · SQL · Power BI',
        summary: 'Resumen de prueba.',
        featured: [{ title: 'Proyecto X', subtitle: '2024', description: 'Desc.' }],
        skills: ['SQL', 'Power BI'],
        educationNote: 'Nota de formación.',
      },
    });
    assert.equal(res.statusCode, 201, res.body);
    const created = res.json<RoleProfile>();
    assert.equal(created.name, 'Data Analyst');
    assert.equal(created.isDefault, false);
    assert.equal(created.featured[0].title, 'Proyecto X');

    const detail = await app.inject({
      method: 'GET',
      url: `/api/role-profiles/${created.id}`,
      headers: authed(auth, false),
    });
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json<RoleProfile>().summary, 'Resumen de prueba.');
  });

  it('POST solo con nombre crea un borrador vacío editable', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/role-profiles',
      headers: authed(auth),
      payload: { name: 'Product Manager' },
    });
    assert.equal(res.statusCode, 201, res.body);
    const created = res.json<RoleProfile>();
    assert.equal(created.headline, '');
    assert.equal(created.summary, '');
    assert.deepEqual(created.featured, []);
    assert.deepEqual(created.skills, []);
    assert.equal(created.educationNote, null);
  });

  it('POST exige CSRF (403 sin cabecera)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/role-profiles',
      headers: authed(auth, false),
      payload: { name: 'Sin CSRF' },
    });
    assert.equal(res.statusCode, 403);
  });

  it('POST valida: nombre vacío → 400; bloque sin título → 400', async () => {
    const sinNombre = await app.inject({
      method: 'POST',
      url: '/api/role-profiles',
      headers: authed(auth),
      payload: { name: '   ' },
    });
    assert.equal(sinNombre.statusCode, 400);

    const bloqueMalo = await app.inject({
      method: 'POST',
      url: '/api/role-profiles',
      headers: authed(auth),
      payload: { name: 'Válido', featured: [{ title: '', subtitle: 'x', description: '' }] },
    });
    assert.equal(bloqueMalo.statusCode, 400);
  });

  it('POST con nombre duplicado → 409', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/role-profiles',
      headers: authed(auth),
      payload: { name: 'AI Engineer' },
    });
    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.json(), { error: 'perfil_rol_ya_existe' });
  });

  it('PUT actualiza campos y GET :id lo refleja; sin cambios → 400', async () => {
    const profiles = await listProfiles();
    const ai = profiles.find((p) => p.name === 'AI Engineer')!;
    const res = await app.inject({
      method: 'PUT',
      url: `/api/role-profiles/${ai.id}`,
      headers: authed(auth),
      payload: { headline: 'AI Engineer · Agentes y datos', skills: ['Agentes LLM', 'Python'] },
    });
    assert.equal(res.statusCode, 200, res.body);
    const detail = await app.inject({
      method: 'GET',
      url: `/api/role-profiles/${ai.id}`,
      headers: authed(auth, false),
    });
    const updated = detail.json<RoleProfile>();
    assert.equal(updated.headline, 'AI Engineer · Agentes y datos');
    assert.deepEqual(updated.skills, ['Agentes LLM', 'Python']);
    // Lo no enviado no se toca.
    assert.match(updated.summary, /Constructor de productos de IA/);

    const sinCambios = await app.inject({
      method: 'PUT',
      url: `/api/role-profiles/${ai.id}`,
      headers: authed(auth),
      payload: {},
    });
    assert.equal(sinCambios.statusCode, 400);
  });

  it('PUT/GET/DELETE con id malformado → 400; id inexistente → 404', async () => {
    const malformed = await app.inject({
      method: 'GET',
      url: '/api/role-profiles/no-es-un-uuid',
      headers: authed(auth, false),
    });
    assert.equal(malformed.statusCode, 400);

    const missing = randomUUID();
    const getMissing = await app.inject({
      method: 'GET',
      url: `/api/role-profiles/${missing}`,
      headers: authed(auth, false),
    });
    assert.equal(getMissing.statusCode, 404);
    const putMissing = await app.inject({
      method: 'PUT',
      url: `/api/role-profiles/${missing}`,
      headers: authed(auth),
      payload: { headline: 'x' },
    });
    assert.equal(putMissing.statusCode, 404);
    const delMissing = await app.inject({
      method: 'DELETE',
      url: `/api/role-profiles/${missing}`,
      headers: authed(auth),
    });
    assert.equal(delMissing.statusCode, 404);
  });

  it('marcar otro perfil como «por defecto» desmarca el anterior (solo uno)', async () => {
    const profiles = await listProfiles();
    const fs = profiles.find((p) => p.name === 'Full Stack Developer')!;
    const res = await app.inject({
      method: 'PUT',
      url: `/api/role-profiles/${fs.id}`,
      headers: authed(auth),
      payload: { isDefault: true },
    });
    assert.equal(res.statusCode, 200, res.body);
    const after = await listProfiles();
    assert.equal(after.filter((p) => p.isDefault).length, 1);
    assert.equal(after.find((p) => p.isDefault)?.name, 'Full Stack Developer');
    assert.equal(after[0].name, 'Full Stack Developer', 'el por defecto va primero');
  });

  it('DELETE borra el perfil y la campaña que lo usaba queda con role_profile_id null', async () => {
    const profiles = await listProfiles();
    const ai = profiles.find((p) => p.name === 'AI Engineer')!;

    const camp = await app.inject({
      method: 'POST',
      url: '/api/campaigns',
      headers: authed(auth),
      payload: { name: 'Campaña IA', role_profile_id: ai.id },
    });
    assert.equal(camp.statusCode, 201, camp.body);
    const campaignId = camp.json<{ id: string }>().id;

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/role-profiles/${ai.id}`,
      headers: authed(auth),
    });
    assert.equal(del.statusCode, 200, del.body);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${campaignId}`,
      headers: authed(auth, false),
    });
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json<{ campaign: { role_profile_id: string | null } }>().campaign.role_profile_id, null);

    const gone = await app.inject({
      method: 'GET',
      url: `/api/role-profiles/${ai.id}`,
      headers: authed(auth, false),
    });
    assert.equal(gone.statusCode, 404);
  });

  it('campañas: role_profile_id explícito se expone en el detalle', async () => {
    const profiles = await listProfiles();
    const fs = profiles.find((p) => p.name === 'Full Stack Developer')!;
    const camp = await app.inject({
      method: 'POST',
      url: '/api/campaigns',
      headers: authed(auth),
      payload: { name: 'Campaña FS', role_profile_id: fs.id },
    });
    assert.equal(camp.statusCode, 201, camp.body);
    assert.equal(camp.json<{ role_profile_id: string | null }>().role_profile_id, fs.id);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${camp.json<{ id: string }>().id}`,
      headers: authed(auth, false),
    });
    assert.equal(
      detail.json<{ campaign: { role_profile_id: string | null } }>().campaign.role_profile_id,
      fs.id,
    );
  });

  it('campañas: sin role_profile_id se asigna el perfil por defecto; null explícito = ninguno', async () => {
    const profiles = await listProfiles();
    const fin = profiles.find((p) => p.isDefault)!;

    const sinPerfil = await app.inject({
      method: 'POST',
      url: '/api/campaigns',
      headers: authed(auth),
      payload: { name: 'Campaña por defecto' },
    });
    assert.equal(sinPerfil.statusCode, 201, sinPerfil.body);
    assert.equal(sinPerfil.json<{ role_profile_id: string | null }>().role_profile_id, fin.id);

    const conNull = await app.inject({
      method: 'POST',
      url: '/api/campaigns',
      headers: authed(auth),
      payload: { name: 'Campaña sin rol', role_profile_id: null },
    });
    assert.equal(conNull.statusCode, 201, conNull.body);
    assert.equal(conNull.json<{ role_profile_id: string | null }>().role_profile_id, null);
  });

  it('campañas: role_profile_id inexistente → 400; malformado → 400', async () => {
    const inexistente = await app.inject({
      method: 'POST',
      url: '/api/campaigns',
      headers: authed(auth),
      payload: { name: 'Campaña mala', role_profile_id: randomUUID() },
    });
    assert.equal(inexistente.statusCode, 400);
    assert.deepEqual(inexistente.json(), { error: 'perfil_rol_no_encontrado' });

    const malformado = await app.inject({
      method: 'POST',
      url: '/api/campaigns',
      headers: authed(auth),
      payload: { name: 'Campaña mala 2', role_profile_id: 'no-uuid' },
    });
    assert.equal(malformado.statusCode, 400);
  });

  it('el perfil base (hechos) no se altera con el CRUD de perfiles por rol', async () => {
    // Versión activa con dos hechos vía la API de siempre.
    const version = await app.inject({
      method: 'POST',
      url: '/api/profile/versions',
      headers: authed(auth),
      payload: { source: 'test' },
    });
    assert.equal(version.statusCode, 201, version.body);
    const versionId = version.json<{ id: string }>().id;
    for (const fact of [
      { category: 'identity', key: 'full_name', value: 'Jon Peciña Iturbe', source: 'test' },
      { category: 'identity', key: 'email', value: 'jpecina@gmail.com', source: 'test' },
    ]) {
      const f = await app.inject({
        method: 'POST',
        url: `/api/profile/versions/${versionId}/facts`,
        headers: authed(auth),
        payload: fact,
      });
      assert.equal(f.statusCode, 201, f.body);
    }
    const activate = await app.inject({
      method: 'POST',
      url: `/api/profile/versions/${versionId}/activate`,
      headers: authed(auth),
    });
    assert.equal(activate.statusCode, 200, activate.body);

    const antes = await app.inject({
      method: 'GET',
      url: '/api/profile',
      headers: authed(auth, false),
    });
    assert.equal(antes.statusCode, 200);
    const factsAntes = antes.json<{ facts: unknown[] }>().facts;
    assert.equal(factsAntes.length, 2);

    // CRUD completo de perfiles por rol.
    const creado = await app.inject({
      method: 'POST',
      url: '/api/role-profiles',
      headers: authed(auth),
      payload: { name: 'Temporal', headline: 'x' },
    });
    const creadoId = creado.json<RoleProfile>().id;
    await app.inject({
      method: 'PUT',
      url: `/api/role-profiles/${creadoId}`,
      headers: authed(auth),
      payload: { summary: 'cambiado' },
    });
    await app.inject({
      method: 'DELETE',
      url: `/api/role-profiles/${creadoId}`,
      headers: authed(auth),
    });

    const despues = await app.inject({
      method: 'GET',
      url: '/api/profile',
      headers: authed(auth, false),
    });
    assert.equal(despues.statusCode, 200);
    assert.deepEqual(despues.json<{ facts: unknown[] }>().facts, factsAntes);
  });
});
