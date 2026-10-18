# @jobforce/backend

API REST de JOBFORCE (Node 22 + TypeScript, Fastify 5). Implementa el contrato
tipado de `packages/domain/src/index.ts`.

## Rutas

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | `/api/health` | no | `{ok:true, version}` |
| POST | `/api/auth/setup` | no | Alta del admin (solo si no existe; 409 `admin_exists`) |
| POST | `/api/auth/login` | no | Login; rate limit 10 intentos / 5 min por IP |
| POST | `/api/auth/logout` | sesión + CSRF | Cierra la sesión actual |
| GET | `/api/auth/me` | sesión | Usuario de la sesión |
| GET | `/api/profile` | sesión | Versión activa con sus facts (404 `no_profile`) |
| GET | `/api/profile/versions` | sesión | Lista de versiones |
| GET | `/api/profile/questionnaire` | sesión | Cuestionario estático de la Fase 1 |
| POST | `/api/profile/versions` | sesión + CSRF | Crea una versión (nace en `draft`) |
| POST | `/api/profile/versions/:id/facts` | sesión + CSRF | Añade un fact |
| POST | `/api/profile/versions/:id/activate` | sesión + CSRF | Activa la versión (transacción) |
| POST | `/api/profile/import-cv` | sesión + CSRF | 501 `not_implemented` (la v1 va por semilla SQL) |
| GET | `/api/answers` | sesión | Memoria de respuestas |
| POST | `/api/answers` | sesión + CSRF | Guarda una respuesta |
| GET | `/api/config` | sesión | Última configuración no secreta |

Sesiones: el token crudo viaja solo en la cookie `jobforce_session`
(HttpOnly, `Secure` según config, `SameSite=Lax`); en la BD solo se guarda su
sha256. Toda ruta mutadora (salvo `setup` y `login`) exige la cabecera
`x-csrf-token` igual al token CSRF de la sesión (comparación timing-safe).
Las acciones relevantes se auditan en `audit_events` sin secretos jamás.

Al arrancar, el backend ejecuta automáticamente las migraciones pendientes
(`runMigrations()` de `@jobforce/database`) antes de escuchar.

## Scripts

```bash
pnpm --filter @jobforce/backend build      # compila a dist/
pnpm --filter @jobforce/backend typecheck  # tsc --noEmit (src + test)
pnpm --filter @jobforce/backend test       # suite completa (ver abajo)
pnpm --filter @jobforce/backend start      # node dist/index.js
```

## Tests

Suite con `node:test` + `fastify.inject` contra **PostgreSQL real**
(`test/`: `auth`, `auth-ratelimit`, `profile`, `answers-config`).

Requisitos:

- PostgreSQL accesible y `DATABASE_URL` definida en el entorno, p. ej.:

  ```bash
  export DATABASE_URL=postgres://jobforce:jobforce@localhost:5432/jobforce
  ```

- Los tests aplican las migraciones y vacían las tablas entre casos; usan una
  base de datos dedicada (no la de producción).

Ejecución (desde la raíz del repo):

```bash
pnpm --filter @jobforce/backend test
```

El script primero compila el workspace (`pnpm -w run build`), luego los tests
a `.test-dist/` y los ejecuta con `node --test --test-concurrency=1`.

## Dependencias del workspace

- `@jobforce/domain` — tipos del modelo y del contrato API; también
  `SESSION_COOKIE_NAME` y `CSRF_HEADER_NAME` (no se hardcodean).
- `@jobforce/config` — `loadConfig()` para validar las variables de entorno.
- `@jobforce/database` — `getPool()`, `query()`, `withTransaction()`,
  `runMigrations()`.

## Docker

La imagen de producción está en `Dockerfile` (multi-stage, `node:22-alpine`,
usuario no-root). Al arrancar:

1. ejecuta las migraciones pendientes (`packages/database/dist/migrate.js`),
2. arranca el servidor (`apps/backend/dist/index.js`, puerto `PORT`, defecto 3001).

Se construye desde `infra/` con:

```bash
docker compose --env-file ../.env up -d --build
```
