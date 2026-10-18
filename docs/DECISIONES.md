# Registro de decisiones — JOBFORCE

Formato: fecha · decisión · motivo. La más reciente arriba.

## 2026-10-18 · Fase 1: scaffold del monorepo

- **eve 0.80.1 pineado como runtime futuro** (decisión de Fase 0; verificado en
  Oracle). En Fase 1 no se instala ni se configura: el scaffold no depende de él.
- **PostgreSQL es la fuente de verdad del negocio.** Todo el estado persistente
  vive en la BD, de modo que el sistema sobrevive aunque el runtime eve falle.
- **Repo privado** `jpecinagithub/jobforce` (app personal con datos sensibles).
- **Monorepo pnpm 10.34.7 + TypeScript 5.9.3.** Se evaluó TypeScript 7.0.2
  (última disponible) y se descartó por ser la rama nueva del compilador nativo:
  se fijó la 5.9.3, madura y ampliamente soportada por el ecosistema.
- **Node 22**: `.nvmrc`, campo `engines` e imagen `node:22-alpine` en el Dockerfile.
- **Versiones exactas en todos los `package.json`** (sin `^` ni rangos) y
  `pnpm-lock.yaml` commiteado: `typescript 5.9.3`, `zod 4.6.7`, `pg 8.23.1`,
  `@types/pg 8.23.1`, `@types/node 22.20.5`, `postgres:16-alpine`.
- **zod** para validar la configuración desde variables de entorno (falla rápido
  con mensajes claros en español).
- **Driver `pg`** y `gen_random_uuid()` (extensión `pgcrypto`) para las claves
  primarias UUID.
- **postgres sin puertos publicados** en el compose base; healthcheck con
  `pg_isready`; `backend` con `depends_on` en estado `healthy`.
- **Runner de migraciones propio y mínimo**: tabla `schema_migrations`,
  migraciones `NNN_*.sql` aplicadas en orden, cada una en su transacción.
- **Puerto en `PORT`** (no `BACKEND_PORT`): el nombre coincide con lo que lee
  `packages/config`; `.env.example` documenta `PORT`.
- **El `.env` vive en la raíz del repo**; los servicios de compose lo consumen
  con `env_file: ../.env` (el ejemplo de la especificación decía `.env`, que
  habría obligado a un segundo `.env` dentro de `infra/`).
- **Orden de compilación explícito** en los scripts raíz
  (`domain` → `config` → resto) en lugar de project references de TypeScript:
  más simple de entender para las siguientes olas.
- **Sin código de backend/web en Fase 1**: solo `package.json` + `tsconfig.json`
  + `README` (+ Dockerfile en backend). El `CMD` del Dockerfile referencia
  `apps/backend/dist/index.js`, que existirá cuando la ola 2 implemente el código.
