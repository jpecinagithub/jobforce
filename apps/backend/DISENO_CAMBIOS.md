# Diseño: cambios de código desde el panel (Fase 6.2)

## Modelo operativo

La implementación de un cambio la ejecuta **el agente (Muse) en una rama
`cambio/<id>-<slug>`**, usando el token de Jon de forma transitoria. El panel
NO escribe código: es la capa de **seguimiento + autorización + auditoría +
ejecución de reversión**.

Flujo:

1. **Propuesta**: Jon (o el agente, dictado por Jon) describe el cambio en
   `/cambios` → estado `borrador`.
2. **Desarrollo**: el agente implementa en la rama; el panel registra rama,
   URL de vista previa y resultado de tests (`en_desarrollo` → `en_revision`).
3. **Aprobación**: Jon firma una **declaración expresa** de autorización.
   Sin este paso, la publicación es imposible (límite duro en código).
4. **Publicación**: el agente hace merge a `main` y empuja; el panel
   **registra** el commit publicado y lo anota en el histórico `deployments`.
5. **Reversión**: un clic. El backend vuelve al último despliegue anterior;
   el frontal, al despliegue de producción anterior de Vercel.

## Endpoints (`apps/backend/src/routes/codechanges.ts`)

| Método | Ruta | Qué hace |
|---|---|---|
| POST | `/api/code-changes` | Crea propuesta (`titulo` 1-120, `descripcion` 1-5000, `componente`). Estado inicial `borrador`. |
| GET | `/api/code-changes` | Lista ordenada por `updated_at` DESC. Filtros `?estado=` y `?componente=`. |
| GET | `/api/code-changes/:id` | Detalle + últimos 20 eventos de auditoría de la entidad. |
| PATCH | `/api/code-changes/:id` | Actualiza `rama`, `preview_url`, `test_estado`, `test_detalle` y avanza **un solo paso** hacia adelante (`borrador→en_desarrollo→en_revision`). Rechaza saltos, retrocesos y los estados que requieren puerta dedicada. |
| POST | `/api/code-changes/:id/approve` | **Puerta de autorización.** Solo desde `en_revision`. Requiere `declaracion` (1-500): el texto expreso de Jon autorizando la publicación. Guarda `aprobada_por/en` + declaración; la declaración queda en `auditEvent`. |
| POST | `/api/code-changes/:id/publish` | Solo desde `aprobada` (**límite duro**: sin aprobación previa responde 409 `publicacion_sin_aprobacion`). Registra `commit_publicado`/`publicada_en` e inserta una fila en `deployments` por componente (`ambos` → dos filas). El merge+push a `main` lo ejecuta el agente. |
| POST | `/api/code-changes/:id/revert` | Solo desde `publicada`. Responde **202** al instante con `{ revert_id }` y ejecuta en segundo plano; el progreso se consulta con GET (`revert_estado`: `en_curso` → `completada`/`fallida`, más `revert_resultado` JSON). Sin histórico en `deployments` → 409 `sin_despliegues_previos`. |

Todos exigen sesión; los mutadores además exigen cabecera CSRF.

## Reversión: cómo funciona

**Backend** (componente `backend`/`ambos`):
1. Busca en `deployments` el último despliegue `exito` de backend con commit distinto al publicado.
2. Lee el HEAD actual (`git -C ~/jobforce-verify rev-parse HEAD`).
3. Comprueba si entre el objetivo y el actual se añadieron migraciones (`git diff --name-only … -- packages/database/migrations/`): si las hay, lo anota como **aviso** en el resultado, **sin bloquear y sin tocar la BD**.
4. `git checkout <commit anterior>` y `docker compose --env-file ../.env up -d --build backend` en `~/jobforce-verify/infra` (timeout 15 min).
5. El ejecutor es inyectable (`setRevertTestDeps` / `revertBackend(commit, { dryRun })`) para testear sin Docker.

**Frontend** (componente `frontend`/`ambos`):
- Con `VERCEL_TOKEN` (+ `VERCEL_PROJECT_ID`) en el entorno, localiza el despliegue de producción anterior vía `GET /v6/deployments?projectId=…&target=production&state=READY` (preferencia: el registrado en nuestro histórico).
- **Vercel no expone ningún endpoint REST documentado para "promote to production" / instant rollback** (verificado en la documentación oficial, oct-2026; solo existe un endpoint interno no documentado). Por eso el comportamiento por defecto es el **fallback manual**: devuelve `{ modo: 'manual', deploymentId, deploymentUrl, dashboardUrl, instrucciones }` con los 4 pasos del dashboard. Nunca falla en silencio.
- Opt-in experimental: con `VERCEL_AUTO_ROLLBACK=true` se intenta `POST /v9/projects/{id}/rollback/{deploymentId}` (no documentado); si falla, se devuelve el fallback manual con el error anotado.

Al terminar: estado `revertida`, `commit_revertido`, `revertida_en`, fila en `deployments` y auditoría completa. Si una parte falla, el estado queda en `publicada` con `revert_estado='fallida'` y el error registrado (no se finge una reversión que no ocurrió).

## Limitaciones conocidas

1. **La base de datos nunca se revierte.** Las migraciones son solo hacia adelante; si el código antiguo no es compatible con el esquema actual, el resultado lo advierte pero no lo impide.
2. **El revert del frontal es manual por defecto** (un clic en el dashboard de Vercel con las instrucciones que entrega el endpoint). El rollback automático vía API es experimental y requiere opt-in explícito.
3. El backend asume el layout del servidor Oracle (`~/jobforce-verify`, `infra/`); configurable con `JOBFORCE_REPO_DIR` / `JOBFORCE_INFRA_DIR`.
4. La publicación registra el commit que el agente indica; el panel no verifica que el merge a `main` haya ocurrido (confía en el flujo del agente).
5. Un cambio `revertida` es inmutable: para reintentarlo se crea una propuesta nueva.
