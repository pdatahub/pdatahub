# pdatahub — Personal Data Hub

[![CI](https://github.com/pdatahub/pdatahub/actions/workflows/ci.yml/badge.svg)](https://github.com/pdatahub/pdatahub/actions/workflows/ci.yml)

> Privacy-first personal data platform with per-action approval, time-bounded grants, and auditable AI-agent access.

**Status (2026-09-05):** MVP architecture verified end-to-end on Honor CMA-LX1. Hub on Android = UI only. Hub core = Node.js (this repo). Plugin runtime = Node.js subprocess on user's laptop.

## Architecture (revised 2026-09-05)

```
┌─────────────────────────────────────┐
│ AI agent (laptop / cloud)           │
│   via MCP protocol                   │
└──────────────┬──────────────────────┘
               │ HTTP
┌──────────────▼──────────────────────┐
│ pdatahub-mcp (laptop, Node.js)       │  ─── packages/mcp-server/
└──────────────┬──────────────────────┘
               │ HTTP
┌──────────────▼──────────────────────┐
│ pdatahub-hub-core (laptop, Node.js)  │  ─── packages/hub-core/
│ • HTTP routes (/v1/tools/*)         │
│ • Plugin subprocess manager         │
│ • Token vault (AES-256-GCM)         │
│ • Grant store (time-bounded)         │
│ • Audit log (append-only)           │
│ • OAuth flow (loopback redirect)    │
│ • ApprovalStream WebSocket          │
└──────┬───────────────────────┬──────┘
       │ JSON-RPC over stdio   │ WebSocket /approval-stream
       │                       │
┌──────▼─────────────┐  ┌──────▼─────────────────────────┐
│ Plugin subprocess  │  │ Android Hub UI                 │  ─── packages/android-app/
│ (Node.js, laptop)  │  │ • Approval notifications      │
│                    │  │ • Audit log viewer             │
│ Google Calendar    │  │ • Active grants list           │
│ Slack, Trello etc  │  │ • Biometric prompt (TODO)      │
└────────────────────┘  └────────────────────────────────┘
```

**Key invariants (verified 2026-09-05):**
- **Plugin never sees raw OAuth token** — Hub injects via SDK's `this.http`
- **Per-action approval** — each tool call triggers a notification on Android, user taps Approve/Deny with biometric
- **Time-bounded grants** — `expires_at = now + 3600s`, lazy expiration check
- **Instant revoke** — `DELETE FROM grants WHERE grant_id = ?` → next access = 401
- **Audit log** — single source of truth at Hub, append-only SQLite, broadcast back via WebSocket

## Packages

| Package | What | Status |
|---------|------|--------|
| [`packages/hub-core/`](./packages/hub-core/) | Node.js Hub core (HTTP + plugins + vault + audit + WS) | ✅ v0.1.0 — e2e verified |
| [`packages/mcp-server/`](./packages/mcp-server/) | MCP bridge for AI agents → Hub | ✅ v0.1.0 |
| [`packages/plugin-sdk/`](./packages/plugin-sdk/) | TypeScript SDK for plugin authors | ✅ v0.1.0 — published via GH Releases |
| [`packages/relay/`](./packages/relay/) | Cloudflare Worker relay (cross-network pairing) | ✅ v0.1.0 |
| [`packages/android-app/`](./packages/android-app/) | Android UI client (approval + audit) | ✅ UI-only, 47M APK |
| [`packages/docs/`](./packages/docs/) | Additional documentation | 📝 |

## External repos

- [`pdatahub/pdatahub-plugin-template`](https://github.com/pdatahub/pdatahub-plugin-template) — template for plugin authors
- [`pdatahub/pdatahub-plugin-google-calendar`](https://github.com/pdatahub/pdatahub-plugin-google-calendar) — reference plugin (e2e verified)

## Why this project?

AI agents need access to personal data, but today:
- Composio / Apple Health / Google Takeout are closed systems
- No user control over scope, duration, or audit
- No way to selectively share specific data with specific agents

pdatahub solves this with **per-action approval, time-bounded grants, local-first audit, and zero raw-token exposure to plugins**.

## Quick start

```bash
# Install all packages
pnpm install

# Start hub-core (laptop)
node packages/hub-core/dist/index.js \
  --port 8080 \
  --master-key "$(openssl rand -hex 32)"

# In another terminal: start MCP bridge
node packages/mcp-server/dist/index.js \
  --hub-url "http://127.0.0.1:8080" \
  --session-token "<your-token>"

# Build Android Hub
cd packages/android-app
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

See [`packages/hub-core/README.md`](./packages/hub-core/README.md) for full hub-core docs.

## Status

- ✅ **MVP architecture verified** end-to-end on Honor CMA-LX1 (2026-09-05)
- ✅ Plugin SDK distributed via GitHub Releases (npmjs.com closed permanently)
- ✅ All 3 repos CI green (TS lint+test+build, Android assemble+test)
- 🚧 Federation protocol (v2) — design after v1 dogfooding
- 🚧 Biometric prompt in Android UI — TODO in PendingApprovalsCard
- 🚧 Real OAuth flow with hosted credentials — needs Google Cloud Console setup

## License

MIT
