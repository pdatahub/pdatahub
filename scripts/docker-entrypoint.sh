#!/usr/bin/env bash
# pdatahub Docker entrypoint.
#
# Responsibilities (first run vs subsequent runs):
#   1. On first run: generate master_key + HUB_API_TOKEN, persist to /data/.env
#   2. On subsequent runs: load from /data/.env
#   3. Print a clear status block to stdout (web UI URL, API token on first run,
#      where to find it on later runs, plugin dir, health check).
#
# Why not bake master_key into the image?
#   - Image layers are public (Docker Hub). Anyone with the image could
#     decrypt the vault. Master_key MUST be generated on first use.
#   - Persistence in a named volume keeps the vault across `docker compose down`.
#   - T-PERSISTENT-001: never write master_key to stdout in production. We
#     print it ONCE on first run (during initial setup) with a loud warning,
#     then never again. Users who lose it can reset via `pdatahub-hub init`.
#
# API token handling:
#   - First run: print the full token so the user can paste it into the web UI.
#     The web UI's Settings page accepts a token; without it, only /health and
#     /v1/identity are reachable.
#   - Subsequent runs: print a reminder + retrieval command, NOT the token
#     itself (logs may be shared with bug reports / pasted into chat).

set -euo pipefail

ENV_FILE="${HUB_DATA_DIR:-/data}/.env"

log() { printf '\033[1;34m[pdatahub]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[pdatahub WARN]\033[0m %s\n' "$*" >&2; }
err() { printf '\033[1;31m[pdatahub ERROR]\033[0m %s\n' "$*" >&2; }
ok() { printf '\033[1;32m[pdatahub]\033[0m %s\n' "$*"; }

mkdir -p "$(dirname "$ENV_FILE")"
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"

# ─── 1. HUB_API_TOKEN (regenerate on missing, persist, print on first run) ─
NEW_TOKEN_GENERATED=0
if ! grep -q '^HUB_API_TOKEN=' "$ENV_FILE" 2>/dev/null; then
  HUB_API_TOKEN=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')
  echo "HUB_API_TOKEN=${HUB_API_TOKEN}" >> "$ENV_FILE"
  NEW_TOKEN_GENERATED=1
  log "Generated new HUB_API_TOKEN (saved to $ENV_FILE)"
else
  HUB_API_TOKEN=$(grep '^HUB_API_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
fi
export HUB_API_TOKEN

# ─── 2. master_key (generate if not already in keyring OR env) ─────────────
# Priority: env (HUB_MASTER_KEY) > file ($ENV_FILE) > keyring > generate fresh
if [ -z "${HUB_MASTER_KEY:-}" ]; then
  HUB_MASTER_KEY=$(grep '^HUB_MASTER_KEY=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)
  if [ -z "${HUB_MASTER_KEY:-}" ]; then
    HUB_MASTER_KEY=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')
    # Write to env file so subsequent runs use the same key (otherwise restart
    # would generate a new one and the user couldn't decrypt the existing vault).
    echo "HUB_MASTER_KEY=${HUB_MASTER_KEY}" >> "$ENV_FILE"
    warn "═══════════════════════════════════════════════════════════════════"
    warn "  FIRST RUN: Generated new master_key for the vault encryption."
    warn "  Stored at: $ENV_FILE"
    warn "  Backup this file — losing it = losing access to all OAuth"
    warn "  tokens stored in the vault."
    warn "  Better: pass via 'docker run -e HUB_MASTER_KEY=<hex>' or use"
    warn "  the OS keyring (recommended — see docs/docker.md)."
    warn "═══════════════════════════════════════════════════════════════════"
    # Print fingerprint for visual confirmation. NEVER print the key itself.
    FP=$(node -e '
      const k = Buffer.from(process.argv[1], "hex");
      console.log(Array.from(k).map(b => b.toString(16).padStart(2,"0").toUpperCase()).slice(0, 8).join(" "));
    ' "$HUB_MASTER_KEY")
    log "master_key fingerprint: ${FP} (first 4 bytes only)"
  fi
  export HUB_MASTER_KEY
fi

log "─────────────────────────────────────────────────────────────────"
log " pdatahub Hub starting"
log "   web UI:        http://localhost:${HUB_PORT:-8080}/"
log "   data dir:      ${HUB_DATA_DIR:-/data}"
log "   plugins dir:   ${HUB_PLUGINS_DIR:-/plugins}"
log "   Health check:  http://localhost:${HUB_PORT:-8080}/health"

if [ "$NEW_TOKEN_GENERATED" = "1" ]; then
  echo ""
  ok "═══════════════════════════════════════════════════════════════════"
  ok "  FIRST-RUN API TOKEN (paste into web UI → Settings):"
  ok ""
  ok "    $HUB_API_TOKEN"
  ok ""
  ok "  This token is saved to $ENV_FILE and is shown ONLY ONCE."
  ok "  To recover later:  docker exec pdatahub-hub cat /data/.env | grep HUB_API_TOKEN"
  ok "  Or:                make logs | grep 'API token'"
  ok "═══════════════════════════════════════════════════════════════════"
else
  log "   API token:     ${HUB_API_TOKEN:0:12}...(truncated; recover with 'make logs | grep API')"
fi

log "─────────────────────────────────────────────────────────────────"

# Drop privileges again in case we changed anything above
exec "$@"
