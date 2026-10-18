# JOBFORCE

Asistente privado (monousuario) de búsqueda de empleo y candidaturas: descubre ofertas,
evalúa el encaje, genera CV y cartas adaptados, envía candidaturas y hace seguimiento.

> Estado: **Fase 1 — cimientos**. Este repo contiene el scaffold del monorepo
> (tipos del dominio, configuración validada, migraciones de base de datos,
> Docker Compose y Dockerfile del backend). El código del backend y del frontend
> se implementa en las siguientes olas sobre esta estructura.

## Estructura del monorepo

```
jobforce/
├── apps/
│   ├── web/                  # Frontend (Next.js) — código en la ola 2
│   └── backend/              # API Node — código en la ola 2 (+ Dockerfile)
├── packages/
│   ├── domain/               # Tipos del modelo de negocio + contrato de la API
│   ├── config/               # Carga y validación de configuración (zod)
│   └── database/             # Pool pg, helpers y migraciones SQL
├── infra/
│   ├── docker-compose.yml                # postgres + backend (producción/Oracle)
│   └── docker-compose.override.yml.example  # dev local: postgres en 127.0.0.1:5432
├── docs/
│   ├── ARQUITECTURA.md
│   └── DECISIONES.md
└── .env.example              # Plantilla de variables (nunca commitear el .env real)
```

PostgreSQL es la **fuente de verdad** del negocio: todo el estado persistente vive
en la base de datos, versionado con migraciones en `packages/database/migrations`.

## Requisitos

- Node.js 22 (ver `.nvmrc`)
- pnpm 10.34.7 (`npm i -g pnpm@10`)
- Docker + Docker Compose (solo para la base de datos / despliegue)

Todas las versiones de dependencias están **fijadas exactas** (sin `^`) y
`pnpm-lock.yaml` está commiteado.

## Arranque en desarrollo

```bash
# 1. Variables de entorno (rellenar los valores reales)
cp .env.example .env

# 2. Instalar dependencias
pnpm install

# 3. Compilar y verificar tipos
pnpm build
pnpm typecheck

# 4. Base de datos local (postgres SIN puertos publicados por defecto)
cd infra
cp docker-compose.override.yml.example docker-compose.override.yml  # dev: expone 127.0.0.1:5432
docker compose --env-file ../.env up -d postgres

# 5. Aplicar migraciones (con DATABASE_URL apuntando a la BD local,
#    p. ej. postgres://jobforce:TU_CLAVE@127.0.0.1:5432/jobforce)
cd ..
pnpm migrate
```

En el servidor (Oracle) el despliegue levanta `postgres` + `backend` juntos:

```bash
cd infra
docker compose --env-file ../.env up -d --build
```

El contenedor `backend` ejecuta las migraciones pendientes antes de arrancar
(ver `apps/backend/Dockerfile`).

## Contrato de la API

Los tipos del contrato REST (rutas, cuerpos de petición y respuesta) están en
`packages/domain/src/index.ts`, para que backend y frontend compartan la misma
definición. Resumen:

- `GET /api/health` → `{ ok: true, version }`
- `POST /api/auth/setup` → crea el usuario administrador (solo si no existe)
- `POST /api/auth/login` → cookie de sesión + `csrfToken`
- `POST /api/auth/logout` · `GET /api/auth/me`
- `GET /api/profile` · `POST /api/profile/versions` · `POST /api/profile/versions/:id/facts` · `POST /api/profile/versions/:id/activate` · `GET /api/profile/versions`
- `GET /api/answers` · `POST /api/answers`
- `GET /api/config` (sin secretos)

Rutas privadas: requieren cookie de sesión válida. Las mutadoras
(`POST`/`PUT`/`PATCH`/`DELETE`) requieren además la cabecera `x-csrf-token`.

## Seguridad

- Ningún secreto en el repo, en los logs ni en los mensajes: solo `.env` (gitignoreado).
- Contraseñas con hash; sesiones con token haseado en BD y cookie `httpOnly`.
- El repo es **privado**.
