# syntax=docker/dockerfile:1.7
#
# pdatahub Hub — multi-stage Dockerfile.
#
# Stages:
#   1. web-deps  — install web UI dependencies (SvelteKit needs Vite + Svelte)
#   2. web-build — build the SvelteKit SPA to packages/web/build/
#   3. deps      — install hub-core workspace dependencies
#   4. build     — compile TypeScript for hub-core
#   5. runtime   — minimal Node 20 image with hub-core dist + web build
#
# Plugins are mounted as a volume in docker-compose.yml, NOT baked into the image.
# The web UI IS baked in — it's the dashboard every user sees on first connect.
#
# Static serving: at runtime hub-core reads HUB_WEB_ROOT=/app/web and serves
# the SPA shell before auth (so /settings is reachable without a token).
# See packages/hub-core/src/static.ts for the SPA fallback rules.

# ─── Stage 1: web-deps ─────────────────────────────────────────────────────
FROM node:20-alpine AS web-deps
WORKDIR /repo

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

# Copy only what's needed for the web filter — package.json + lockfile +
# .npmrc. Vite will fail if the workspace declaration is wrong, so we
# also copy the root manifest.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/web/package.json ./packages/web/

RUN pnpm install --frozen-lockfile --filter @pdatahub/web...

# ─── Stage 2: web-build ────────────────────────────────────────────────────
FROM web-deps AS web-build
WORKDIR /repo

# Copy SvelteKit source + svelte.config.js (which references adapter-static).
COPY packages/web/ ./packages/web/

RUN pnpm --filter @pdatahub/web run build

# ─── Stage 3: deps ────────────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /repo

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

# Copy lockfile + workspace + package.jsons first (cache layer)
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/hub-core/package.json ./packages/hub-core/

RUN pnpm install --frozen-lockfile --filter @pdatahub/hub-core...

# ─── Stage 4: build ───────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /repo

# Copy TypeScript source
COPY packages/hub-core/ ./packages/hub-core/
COPY tsconfig.base.json* ./

RUN pnpm --filter @pdatahub/hub-core run build

# ─── Stage 5: runtime ─────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

# Install curl for HEALTHCHECK + openssl for keyring optional backend.
# bash for the entrypoint script (alpine's /bin/sh is BusyBox, but bash is more familiar).
RUN apk add --no-cache curl bash tini

# Run as the pre-existing `node` user (uid 1000) — no need to create one.
# node:20-alpine ships with this user; using it avoids uid collisions with the host.

WORKDIR /app

# Copy hub-core build output. pnpm puts node_modules at /repo/node_modules (hoisted),
# so we copy that as-is for the runtime image.
COPY --from=build --chown=node:node /repo/packages/hub-core/dist ./dist
COPY --from=build --chown=node:node /repo/packages/hub-core/package.json ./package.json
COPY --from=build --chown=node:node /repo/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/packages/hub-core/src ./src

# Copy the built web UI. hub-core serves it at / via packages/hub-core/src/static.ts.
COPY --from=web-build --chown=node:node /repo/packages/web/build ./web

# Copy entrypoint script
COPY --chown=node:node scripts/docker-entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Persistent data dir for SQLite + vault
RUN mkdir -p /data /plugins && chown -R node:node /data /plugins

USER node

ENV HUB_HOST=0.0.0.0 \
    HUB_PORT=8080 \
    HUB_DB_PATH=/data/pdatahub-hub.db \
    HUB_PLUGINS_DIR=/plugins \
    HUB_WEB_ROOT=/app/web \
    NODE_ENV=production

EXPOSE 8080

# tini = proper signal handling for graceful shutdown
# curl localhost:8080/health = liveness check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://localhost:8080/health || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "dist/index.js"]
