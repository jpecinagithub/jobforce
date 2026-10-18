# @jobforce/backend

API REST de JOBFORCE (Node 22 + TypeScript).

> **Fase 1 (scaffold):** solo está la estructura (`package.json`, `tsconfig.json`,
> `Dockerfile`). El código se implementa en la ola 2 siguiendo el contrato
> tipado en `packages/domain/src/index.ts`.

## Dependencias del workspace

- `@jobforce/domain` — tipos de entidades y del contrato de la API.
- `@jobforce/config` — `loadConfig()` para validar las variables de entorno.
- `@jobforce/database` — `getPool()`, `query()`, `withTransaction()`.

## Docker

La imagen de producción está en `Dockerfile` (multi-stage, `node:22-alpine`,
usuario no-root). Al arrancar:

1. ejecuta las migraciones pendientes (`packages/database/dist/migrate.js`),
2. arranca el servidor (`apps/backend/dist/index.js`, puerto `PORT`, defecto 3001).

Se construye desde `infra/` con:

```bash
docker compose --env-file ../.env up -d --build
```
