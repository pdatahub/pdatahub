# syntax=docker/dockerfile:1.7
#
# pdatahub Hub — multi-stage Dockerfile.
#
# Stage 1 (deps): install pnpm + all workspace dependencies
# Stage 2 (build): compile TypeScript for hub-core (and any deps it needs)
# Stage 3 (runtime): minimal Node 20 image with just the build output + plugins
#
# Plugins are mounted as a volume in docker-compose.yml, NOT baked into the image.
# This keeps the image small and lets users hot-swap plugins without rebuilding.

# ─── Stage 1: deps ────────────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /repo

# Enable pnpm via corepack (ships with Node 20)
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

# Copy lockfile + workspace + package.jsons first (cache layer)
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/hub-core/package.json ./packages/hub-core/

RUN pnpm install --frozen-lockfile --filter @pdatahub/hub-core...

# ─── Stage 2: build ───────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /repo

# Copy TypeScript source
COPY packages/hub-core/ ./packages/hub-core/
COPY tsconfig.base.json* ./

RUN pnpm --filter @pdatahub/hub-core run build

# ─── Stage 3: runtime ─────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

# Install curl for HEALTHCHECK + openssl for keyring optional backend.
# bash for the entrypoint script (alpine's /bin/sh is BusyBox, but bash is more familiar).
RUN apk add --no-cache curl bash tini

# Run as the pre-existing `node` user (uid 1000) — no need to create one.
# node:20-alpine ships with this user; using it avoids uid collisions with the host.

WORKDIR /app

# Copy build output. pnpm puts node_modules at /repo/node_modules (hoisted),
# so we copy that as-is for the runtime image.
COPY --from=build --chown=node:node /repo/packages/hub-core/dist ./dist
COPY --from=build --chown=node:node /repo/packages/hub-core/package.json ./package.json
COPY --from=build --chown=node:node /repo/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/packages/hub-core/src ./src

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
    NODE_ENV=production

EXPOSE 8080

# tini = proper signal handling for graceful shutdown
# curl localhost:8080/health = liveness check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://localhost:8080/health || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "dist/index.js"]
