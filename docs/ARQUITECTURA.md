# Arquitectura — JOBFORCE (Fase 1)

## Alcance de esta fase

La Fase 1 deja los **cimientos**: repositorio, monorepo pnpm + TypeScript,
modelo de dominio tipado, carga de configuración validada, esquema y migraciones
de PostgreSQL, Docker Compose y Dockerfile del backend. **No incluye** el código
del backend ni del frontend (ola 2), ni el runtime de agente eve, ni integraciones
(LLM, Gmail, Exa, scraping): todo eso se construye encima de esta base.

## Componentes

| Pieza | Ruta | Responsabilidad |
|---|---|---|
| Dominio | `packages/domain` | Tipos de las entidades (AdminUser, UserSession, ProfileVersion, ProfileFact, AnswerMemory, ConfigurationVersion, AuditEvent) y del contrato de la API REST. Sin lógica ni dependencias. |
| Configuración | `packages/config` | Lee variables de entorno y las valida con zod. Falla rápido con un mensaje claro si falta `DATABASE_URL` o hay un valor inválido. |
| Base de datos | `packages/database` | Driver `pg` (pool + helpers tipados), migraciones SQL versionadas y runner propio (`schema_migrations`, una transacción por migración). |
| Backend | `apps/backend` | API REST Node (ola 2). El Dockerfile ya está listo. |
| Frontend | `apps/web` | Next.js (ola 2). |
| Infraestructura | `infra/` | `docker-compose.yml` para el servidor; override de ejemplo para dev local. |

## Datos

- **PostgreSQL es la fuente de verdad**: todo el estado de negocio persistente
  vive en la BD, no en memoria del proceso ni en ficheros.
- Migraciones en `packages/database/migrations/`, nombradas `NNN_descripcion.sql`
  y aplicadas en orden. Cada migración corre dentro de su propia transacción y
  queda registrada en `schema_migrations`.
- Tablas de Fase 1: `admin_users`, `user_sessions`, `profile_versions`,
  `profile_facts`, `answer_memory`, `configuration_versions`, `audit_events`
  (+ `schema_migrations`).

## Despliegue

- `infra/docker-compose.yml` levanta `postgres:16-alpine` y `backend`.
- `postgres` **no publica puertos**: solo es visible dentro de la red de compose.
  Lleva healthcheck (`pg_isready`) y el backend arranca con
  `depends_on: postgres` en estado `healthy`.
- El contenedor `backend` ejecuta `node packages/database/dist/migrate.js`
  antes de arrancar, así el esquema siempre está al día.
- Para desarrollo local, `docker-compose.override.yml.example` publica postgres
  solo en `127.0.0.1:5432` (copiar a `docker-compose.override.yml`; ese fichero
  está en `.gitignore`).
- El `.env` vive en la **raíz del repo**; compose lo consume con
  `env_file: ../.env` y se invoca con `docker compose --env-file ../.env …`
  desde `infra/`.

## Seguridad (principios)

- Monousuario con login propio (tabla `admin_users`); sin registro público:
  `POST /api/auth/setup` solo funciona si aún no existe administrador.
- Sesiones en BD (`user_sessions`) con `token_hash`; cookie `httpOnly`
  (+ `Secure` en producción); las operaciones mutadoras exigen cabecera
  `x-csrf-token`.
- Cero secretos en el repo, en imágenes Docker innecesarias, en logs o en mensajes.

## Decisiones registradas

Ver `docs/DECISIONES.md` (registro cronológico con fecha y motivo).
