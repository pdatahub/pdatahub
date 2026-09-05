# @pdatahub/hub-core

Hub core for pdatahub — approval engine, token vault, audit log, and plugin subprocess manager.

Replaces the Kotlin `McpHttpServer.kt` + `PluginManager.kt` from the original Android Hub APK. Now runs as a standalone Node.js process on the user's laptop (or home server). The Android APK becomes a thin UI client (approval notifications + audit log viewer).

## Verified end-to-end (2026-09-05)

Full e2e tested on Honor CMA-LX1:
- ✅ AI agent (`curl`) → hub-core → WebSocket broadcast → Android phone UI
- ✅ User tapped Approve on phone → hub-core processed decision → grant created → audit log persisted
- ✅ Plugin subprocess spawned (Calendar plugin, 4 tools loaded)
- ✅ Timeout (60s) → auto-deny works
- ✅ Audit log queryable via `/v1/audit`

Audit log entry from successful run:
```json
{
  "agent_id": "phone-ui-test",
  "decision": "approved",
  "grant_id": "478dbd06-...",
  "duration_ms": 8460
}
```

## Install

```bash
pnpm install
pnpm build
```

## Usage

```bash
# Generate a master key (32 bytes hex)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Start Hub core
node dist/index.js --port 8080 --db-path ./pdatahub-hub.db --master-key <hex>

# Or with passphrase (key derived via scrypt)
node dist/index.js --passphrase "your-strong-passphrase"
```

## Plugin config

Plugins live in `./plugins/<plugin-name>/dist/index.js`. Hub core auto-loads on startup.

For plugins that require OAuth, set credentials via env:

```bash
export HUB_CLIENT_GOOGLE_CALENDAR_ID="xxx.apps.googleusercontent.com"
export HUB_CLIENT_GOOGLE_CALENDAR_SECRET="GOCSPX-xxx"
```

## API

All endpoints under `/v1`. Auth: `Authorization: Bearer <HUB_API_TOKEN>` (if env var set).

| Method | Path | Description |
|--------|------|-------------|
| GET    | `/v1/tools`                | List available tools |
| POST   | `/v1/tools/:name/call`     | Invoke tool (triggers approval) |
| GET    | `/v1/audit?agent_id=&tool_name=&limit=` | Query audit log |
| GET    | `/v1/grants`               | List active grants |
| POST   | `/v1/grants/:id/revoke`    | Revoke grant |
| GET    | `/v1/plugins`              | List installed plugins |
| POST   | `/v1/plugins/install`      | Install plugin from path |
| POST   | `/v1/plugins/:name/authenticate` | Start OAuth flow |
| GET    | `/v1/tokens`               | List plugins with tokens (no secrets) |
| DELETE | `/v1/tokens/:plugin`       | Delete stored tokens |
| GET    | `/health`                  | Health check |
| WS     | `/approval-stream`         | WebSocket for Android UI |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Android APK (UI only — no plugin runtime, no MCP server)   │
│  - QR pairing                                              │
│  - Approval notifications (WebSocket)                      │
│  - Audit log viewer                                        │
│  - Active grants list                                      │
└─────────────────────────────────────────────────────────────┘
              ▲ WebSocket (approval stream)
              │
┌──────────────┴──────────────────────────────────────────────┐
│ Hub core (Node.js) — this package                          │
│  - HTTP server (Ktor-style routes)                         │
│  - Plugin registry (subprocess manager)                    │
│  - Token vault (AES-256-GCM per-plugin keys)               │
│  - Grant store (SQLite, time-bounded)                      │
│  - Audit log (SQLite, append-only)                         │
│  - OAuth flow (loopback redirect)                          │
│  - Approval stream (WebSocket bridge to Android)           │
└─────────────────────────────────────────────────────────────┘
              ▲ JSON-RPC over stdio
              │
┌──────────────┴──────────────────────────────────────────────┐
│ Plugin subprocess (Node.js)                                │
│  - Spawned by Hub core                                     │
│  - Communicates via JSON-RPC over stdio                    │
│  - Uses @pdatahub/plugin-sdk                                │
│  - Calls external API with token injected via httpClient   │
└─────────────────────────────────────────────────────────────┘
```

## Trust boundaries

- **Hub (trusted)**: holds OAuth tokens, applies scope policy, logs everything
- **Plugin (semi-trusted)**: receives scoped data via SDK's `this.http`; never sees raw token
- **External service (trusted by user)**: sees only Bearer token; doesn't know about Hub/Plugin chain

## Development

```bash
pnpm dev          # TypeScript watch mode
pnpm test         # vitest run
pnpm lint         # TBD
```

## License

MIT
