# Running pdatahub Hub in Docker

The fastest way to try pdatahub locally. Single command, no Node.js install required.

## Quickstart

```bash
git clone https://github.com/pdatahub/pdatahub
cd pdatahub
docker compose up
```

Open http://localhost:8080/health — should return `{"status":"ok","service":"pdatahub-hub"}`.

On first run, the entrypoint script:

1. Generates a fresh `HUB_API_TOKEN` (saved to `hub-data` volume at `/data/.env`)
2. Generates a fresh `master_key` for the vault (saved to the same file)
3. Prints the master_key **fingerprint** (first 4 bytes only — never the full key) and a loud warning to back up `/data/.env`

```text
[pdatahub] Generated new HUB_API_TOKEN (saved to /data/.env)
[pdatahub WARN] ═══════════════════════════════════════════════════════════════════
[pdatahub WARN]   FIRST RUN: Generated new master_key for the vault encryption.
[pdatahub WARN]   Stored at: /data/.env
[pdatahub WARN]   Backup this file — losing it = losing access to all OAuth
[pdatahub WARN]   tokens stored in the vault.
[pdatahub WARN] ═══════════════════════════════════════════════════════════════════
[pdatahub] master_key fingerprint: F9 2A 24 FF (first 4 bytes only)
[pdatahub] ────────────────────────────────────────────────────────────────
[pdatahub]  pdatahub Hub starting
[pdatahub]    data dir:      /data
[pdatahub]    plugins dir:   /plugins
[pdatahub]    API token:     a1b2c3d4e5...(truncated)
[pdatahub]    Health check:  http://localhost:8080/health
[pdatahub] ────────────────────────────────────────────────────────────────
```

## Adding plugins

The Docker image ships **zero plugins**. You choose what to install.

### Option A: Pre-built plugins from GitHub Releases

```bash
# Create plugins dir if needed (compose mounts ./plugins already)
mkdir -p plugins

# Download a pre-built plugin tarball
curl -L https://github.com/pdatahub/pdatahub-plugin-google-calendar/releases/latest/download/pdatahub-plugin-google-calendar-*.tgz \
  | tar -xz -C plugins/google-calendar

# Restart the hub to pick it up
docker compose restart hub
```

Available plugins (2026-09):

- [`pdatahub-plugin-google-calendar`](https://github.com/pdatahub/pdatahub-plugin-google-calendar) — Google Calendar read/write
- [`pdatahub-plugin-google-gmail`](https://github.com/pdatahub/pdatahub-plugin-google-gmail) — Gmail read/send
- [`pdatahub-plugin-template`](https://github.com/pdatahub/pdatahub-plugin-template) — scaffold for your own

### Option B: Custom plugin from local source

```bash
# In your plugin's repo:
pnpm build

# Mount it into the hub
docker compose run --rm hub \
  cp -r /local-plugin/* /plugins/my-plugin/
```

Or just `docker cp` it in:

```bash
docker cp ./my-plugin pdatahub-hub:/plugins/my-plugin
docker compose restart hub
```

## OAuth callback URLs

OAuth providers require you to register a **redirect URI** for the hub. For Docker Compose on `localhost`, the URLs are:

| Provider | Redirect URI |
|----------|--------------|
| Google | `http://localhost:8080/oauth/callback` |
| Slack | `https://<your-tunnel>.trycloudflare.com/oauth/callback` (Slack blocks `http://` for non-dev apps) |
| Notion | `http://localhost:8080/oauth/callback` |
| Microsoft | `http://localhost:8080/oauth/callback` |
| GitHub | `http://localhost:8080/oauth/callback` |

For **Slack** (and any provider that blocks HTTP redirects for production apps), use a tunnel. Two options:

### Option 1: Cloudflare Tunnel (recommended)

The `docker-compose.yml` has a commented `tunnel` sidecar. To enable:

1. Create a tunnel at https://one.dash.cloudflare.com → Zero Trust → Tunnels
2. Copy the token to `.env`: `CLOUDFLARE_TUNNEL_TOKEN=...`
3. Uncomment the `tunnel` service in `docker-compose.yml`
4. `docker compose up -d`
5. Use the tunnel URL as your OAuth redirect URI

### Option 2: ngrok (simpler but external dep)

```bash
ngrok http 8080
# → https://abc123.ngrok.io
```

Use the ngrok URL for Slack OAuth.

## Persistent state

| What | Where |
|------|-------|
| SQLite database | `hub-data` named volume (mounted at `/data`) |
| Vault + master_key | `/data/.env` inside the same volume |
| Plugins | `./plugins` on host (mounted at `/plugins`) |
| Audit logs | `hub-data` volume (rotates with `pdatahub-hub audit purge`) |

**To reset everything** (lose all OAuth tokens, fresh start):

```bash
docker compose down -v
rm -rf ./plugins
docker compose up
```

## Configuration via env vars

Edit `.env` or pass to `docker compose`:

| Variable | Default | Description |
|----------|---------|-------------|
| `HUB_API_TOKEN` | auto-generated | Bearer token for HTTP API. Persisted to `/data/.env` |
| `HUB_MASTER_KEY` | auto-generated | 32-byte hex. Persisted to `/data/.env`. Override for production. |
| `HUB_HOST` | `0.0.0.0` | Bind address |
| `HUB_PORT` | `8080` | Bind port |
| `HUB_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `HUB_PLUGINS_DIR` | `/plugins` | Plugin directory inside container |

For production, **always override** `HUB_MASTER_KEY` and `HUB_API_TOKEN` via secrets manager (Docker Swarm secrets, Kubernetes Secret, HashiCorp Vault, 1Password CLI, etc.). Never commit to `.env` in production.

## Verifying the install

```bash
# Health check (no auth)
curl http://localhost:8080/health
# {"status":"ok","service":"pdatahub-hub"}

# Identity (public, no auth)
curl http://localhost:8080/v1/identity
# {"hub_name":"...", "verify_key":"ed25519:..."}

# Tools (requires bearer token from /data/.env or env)
TOKEN=$(grep HUB_API_TOKEN hub-data/_data/.env 2>/dev/null | cut -d= -f2- || echo "your-token")
curl -H "Authorization: Bearer $TOKEN" http://localhost:8080/v1/tools
```

## Architecture

```
┌─────────────────────────────────────────────────┐
│  pdatahub-hub container                         │
│  ┌───────────────────────────────────────────┐  │
│  │ Node 20 (non-root user "pdatahub")       │  │
│  │                                           │  │
│  │  dist/src/index.js  ── pdatahub-hub      │  │
│  │  ↑                                        │  │
│  │  /data (volume)                           │  │
│  │   └─ pdatahub-hub.db  (SQLite, WAL)       │  │
│  │   └─ .env             (master_key + API)  │  │
│  │                                           │  │
│  │  Plugins (subprocesses, spawned on demand)│  │
│  │  /plugins/<name>/dist/                    │  │
│  └───────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
         ↑                              ↑
    :8080 (HTTP + WS)              ./plugins (volume)
```

## Troubleshooting

### "Address already in use" on port 8080

Edit `docker-compose.yml` → `ports: - "127.0.0.1:9090:8080"` (use any free port).

### Container restarts every few seconds

Check logs: `docker compose logs hub`. Likely:

- `/data` volume is full → `docker volume inspect pdatahub-hub-data`
- `HUB_MASTER_KEY` was set to invalid hex
- Port 8080 already bound on host

### OAuth callback fails with "redirect_uri_mismatch"

Your OAuth client (Google/Slack/Notion/...) has a different redirect URI registered than what the hub is using. Check:

```bash
# What the hub expects:
docker compose exec hub printenv | grep OAUTH
# Compare to the URI registered in your OAuth app's dashboard
```

The URI must match exactly (including trailing slash and case).

### Reset the master_key without losing OAuth tokens

You can't. If you change `HUB_MASTER_KEY`, the vault is unreadable. Either:
- Backup `/data/.env` BEFORE doing anything
- Or re-do OAuth setup from scratch (all plugin authentications need to be redone)

This is by design — T-PERSISTENT-001 mitigation #1 (master_key in keyring) would let you recover from the keyring backup if you used that instead.

## See also

- [README.md](../README.md) — project overview
- [architecture.md](./architecture.md) — hub internals
- [threat-model.md](./threat-model.md) — security model (T-PERSISTENT-001, MIT-005, MIT-006)
- [plugin-author-guide.md](./plugin-author-guide.md) — write your own plugin
- [cli-reference.md](./cli-reference.md) — pdatahub-hub commands
