# JOBFORCE · backend (Fase 1)
# Imagen de producción: Node 22 Alpine, usuario no-root.
#
# NOTA: apps/backend/dist/index.js existirá cuando la ola 2 implemente el código
# del backend (este scaffold solo deja package.json + tsconfig.json + Dockerfile).

# ---------- dependencias ----------
FROM node:22-alpine AS deps
WORKDIR /app
RUN npm install -g pnpm@10.34.7
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/database/package.json packages/database/package.json
RUN pnpm install --frozen-lockfile

# ---------- compilación ----------
FROM node:22-alpine AS build
WORKDIR /app
RUN npm install -g pnpm@10.34.7
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

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
