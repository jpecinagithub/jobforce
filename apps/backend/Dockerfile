# JOBFORCE · backend (Fase 1)
# Imagen de producción: Node 22 Alpine, usuario no-root.
#
# Estructura en dos etapas:
#  - build: instala dependencias (con toolchain para argon2) y compila TypeScript.
#  - runtime: copia lo compilado + node_modules, con usuario no-root.
#
# Nota: la instalación se hace con el código fuente presente (no solo los
# package.json), porque pnpm aísla node_modules por paquete: copiar solo el
# node_modules raíz rompería la resolución de módulos (p. ej. 'zod' en
# packages/config). Se pierde algo de caché de capas a cambio de corrección.

# ---------- build ----------
FROM node:22-alpine AS build
WORKDIR /app
# argon2 compila un módulo nativo con node-gyp: necesita toolchain de C y python3.
RUN apk add --no-cache python3 make g++ && npm install -g pnpm@10.34.7
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile && pnpm build

# ---------- runtime ----------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S -G app app
COPY --from=build --chown=app:app /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/packages ./packages
COPY --from=build --chown=app:app /app/apps ./apps
USER app
EXPOSE 3001
# 1) aplica las migraciones pendientes  2) arranca el backend
CMD ["sh", "-c", "node packages/database/dist/migrate.js && node apps/backend/dist/index.js"]
