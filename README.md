# pdatahub — Personal Data Hub

[![CI](https://github.com/pdatahub/pdatahub/actions/workflows/ci.yml/badge.svg)](https://github.com/pdatahub/pdatahub/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Version: v0.3.0](https://img.shields.io/badge/version-v0.3.0-blue.svg)](./CHANGELOG.md)
[![Node 20+](https://img.shields.io/badge/node-20%2B-green)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/typescript-5.x-3178C6)](https://www.typescriptlang.org)
[![Tests](https://img.shields.io/badge/tests-697%2F697-brightgreen)](./CHANGELOG.md)
[![Self-hosted](https://img.shields.io/badge/self--hosted-yes-purple)](./docs/self-hosting.md)

> Privacy-first personal data platform with per-action approval, time-bounded grants, auditable AI-agent access, and Federation v2 (cross-user delegation).

**Status (2026-09-08):** Federation v2 complete across all eight phases — two-hub delegation with Ed25519-signed blobs, per-call phone approval, signed audit retention CLI. Hub-core 310/310 tests pass; Android 39/39 pass.

---

## Why pdatahub?

- **Your tokens, your hardware.** OAuth tokens encrypted with AES-256-GCM and HKDF per-plugin keys. Compromise of one plugin ≠ compromise of others. No vendor holds your data.
- **Phone-mediated approval.** Every tool call → push notification → biometric prompt. Sub-second latency. This UX pattern doesn't exist in Composio, LangChain tools, Solid, or EUDI Wallet.
- **Time-bounded grants.** Default 1h, lazy expiration. Old access disappears automatically.
- **Federation v2.** Two trusted hubs can share a single tool with per-call phone approval. The issuer's OAuth token never crosses the hub boundary. Novel primitive — no commercial equivalent.
- **AI-first architecture.** Designed for MCP tool calls from day 1, not retrofitted. Plugin SDK is ~30 lines for a working tool.
- **Self-hostable AND cloud-ready.** Same binary, your laptop or Hetzner VM (Cloud v3). Migrate between with one CLI command.
- **Open source.** MIT. All code public. Security model documented in [docs/threat-model.md](./docs/threat-model.md).

See [docs/advantages.md](./docs/advantages.md) for the full comparison with Composio, LangChain tools, Solid, EUDI Wallet, and Digi.me.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ AI agent (laptop / cloud)                                   │
│   via MCP protocol                                           │
└──────────────┬──────────────────────────────────────────────┘
               │ HTTP
┌──────────────▼──────────────────────────────────────────────┐
│ pdatahub-mcp (laptop, Node.js)       ─── packages/mcp-server│
└──────────────┬──────────────────────────────────────────────┘
               │ HTTP
┌──────────────▼──────────────────────────────────────────────┐
│ pdatahub-hub-core (laptop, Node.js)  ─── packages/hub-core  │
│ • HTTP routes (/v1/plugins/...)                              │
│ • Plugin subprocess manager (realpath-symlink safe)          │
│ • Token vault (AES-256-GCM, HKDF per-plugin key)             │
│ • Grant store (time-bounded, lazy expiration)                │
│ • Audit log (append-only SQLite)                             │
│ • OAuth flow (HUB_PUBLIC_HOSTNAME-aware cross-device)        │
│ • ApprovalStream WebSocket (/approval-stream)                │
│ • Proactive OAuth refresh (5 min before expiry)              │
│ • Federation v2 (Ed25519 signed delegation blobs)            │
│ • BIP-39 encrypted backup (.pdatahub-backup file)            │
└──────┬───────────────────────────┬──────────────────────────┘
       │ JSON-RPC over stdio       │ WebSocket /approval-stream
       │                           │
┌──────▼─────────────┐  ┌──────────▼───────────────────────────┐
│ Plugin subprocess  │  │ Android Hub UI      ─── packages/... │
│ (Node.js, laptop)  │  │ • Approval notifications + Approve  │
│                    │  │ • Biometric prompt (PromptInfo fix)  │
│ Google Calendar    │  │ • Audit log viewer                   │
│ Slack, Notion, etc │  │ • Active grants list                 │
└────────────────────┘  │ • Settings (URL, token, biometric)   │
                       └──────────────────────────────────────┘
```

### Network paths supported

| Setup | Phone URL | Cleartext allowed? |
|-------|-----------|--------------------|
| **Tailscale mesh** (recommended) | `http://<laptop>.tail<hash>.ts.net:8080` | ✅ via `*.ts.net` policy |
| Direct LAN WiFi (no Tailscale) | `http://192.168.x.x:8080` | ✅ via debug base-config |
| adb reverse (USB tether) | `http://127.0.0.1:8080` | ✅ via `127.0.0.1` policy |
| Tailscale direct IP | `http://100.x.y.z:8080` | ✅ via CGNAT policy |
| Cloudflare Worker relay (fallback) | `wss://<relay-url>` | ✅ via TLS |

See [docs/relay-mode.md](./docs/relay-mode.md) for the full relay design.

---

## Verified end-to-end (2026-09-07)

A single AI agent request that touches real Google Calendar data takes ~5 seconds end-to-end:

```
[0.0s] MCP call listEvents → hub-core (Tailscale MagicDNS)
[0.0s] Hub-core → approval request via WebSocket → phone
[~5s]  User taps Approve on phone (biometric or auto)
[~5s]  Hub-core → plugin subprocess → Google Calendar API
[~5s]  Real events → MCP client → user
```

Full timing breakdown in [docs/architecture.md §End-to-end flow](./docs/architecture.md#end-to-end-flow-verified-2026-09-07).

### Federation v2 verified (2026-09-08)

Two-hub delegation flow:

```
A creates ──sign(A)──> delegation blob ──share (out-of-band)──> B imports
                                                              ↓
                                                          verify(A) ──→ stored
                                                              ↓
B's AI invokes ──> B's hub finds delegation ──sign(B)──> A's hub
                                                          ↓
                                                       verify(B) + lookup
                                                          ↓
                                                        approval flow
                                                          ↓
                                                        plugin invoke
                                                          ↓
                                                        result to B
```

See [docs/federation.md](./docs/federation.md) for the user-facing walkthrough and [docs/threat-model.md §Federation inbound security](./docs/threat-model.md#federation-inbound-security-13-steps) for the 13-step inbound security model.

---

## Packages

| Package | What | Status |
|---------|------|--------|
| [`packages/hub-core/`](./packages/hub-core/) | Node.js Hub core (HTTP + plugins + vault + audit + WS + federation) | ✅ v0.1.0 — e2e verified |
| [`packages/mcp-server/`](./packages/mcp-server/) | MCP bridge for AI agents → Hub | ✅ v0.1.0 |
| [`packages/plugin-sdk/`](./packages/plugin-sdk/) | TypeScript SDK for plugin authors (decorators, http client, JSON-RPC) | ✅ v0.1.0 — GitHub Releases |
| [`packages/relay/`](./packages/relay/) | Cloudflare Worker relay (cross-network pairing fallback) | ✅ v0.1.0 — stub |
| [`packages/android-app/`](./packages/android-app/) | Android UI client (approval + audit + biometric) | ✅ v0.1.0 — debug build |
| [`packages/runner/`](./packages/runner/) | Go control-plane daemon (Hetzner VM provisioning + hub-core deploy) | 🚧 Phase 1A skeleton — mocked Hetzner, cloud-init generator, deploy planner |

---

## External repos

- [`pdatahub/pdatahub-plugin-template`](https://github.com/pdatahub/pdatahub-plugin-template) — scaffold template for plugin authors
- [`pdatahub/pdatahub-plugin-google-calendar`](https://github.com/pdatahub/pdatahub-plugin-google-calendar) — reference plugin (e2e verified)

Each lives in its own repo so plugins can be developed, versioned, and released independently.

---

## Quick start

Three paths depending on what you're here for:

### Path A — Docker (fastest, but limited)

```bash
git clone https://github.com/pdatahub/pdatahub
cd pdatahub
docker compose up   # see docker-compose.yml (planned for v3.1; today use Path B)
```

> Docker support is **not yet shipped** (planned for v0.2). Use Path B for now.

### Path B — Self-host (recommended)

Build from source and run hub-core on your laptop:

```bash
git clone https://github.com/pdatahub/pdatahub
cd pdatahub
pnpm install
pnpm build

# Generate secrets
MASTER_KEY=$(openssl rand -hex 32)
HUB_API_TOKEN=$(openssl rand -hex 32)
# ↑ BACK THESE UP — see docs/self-hosting.md §Backup and restore

# Start hub-core
node packages/hub-core/dist/index.js \
  --port 8080 \
  --master-key "$MASTER_KEY" \
  --db-path ~/.local/share/pdatahub/hub.db \
  --oauth-callback-port 8081 \
  --plugins-dir ~/.local/share/pdatahub/plugins
```

Wire your AI agent's MCP config to point at `http://127.0.0.1:8080` with `Authorization: Bearer $HUB_API_TOKEN`.

For Tailscale setup (recommended for phone-mediated approval), see [docs/self-hosting.md §Set up Tailscale](./docs/self-hosting.md#step-by-step-setup).

For plugin installation (Google Calendar, etc), see [docs/self-hosting.md §Install your first plugin](./docs/self-hosting.md#7-install-your-first-plugin).

### Path C — Write a plugin

```bash
gh repo create my-plugin --template pdatahub/pdatahub-plugin-template --public --clone
cd my-plugin
pnpm install
pnpm dev
```

Then read [docs/plugin-author-guide.md](./docs/plugin-author-guide.md) for the end-to-end guide — OAuth, decorators, HTTP client, packaging, distribution via GitHub Releases.

The canonical reference is [`pdatahub-plugin-google-calendar`](https://github.com/pdatahub/pdatahub-plugin-google-calendar).

---

## Roadmap

### Shipped

- ✅ **MVP architecture verified end-to-end (2026-09-07)** — full single-hub path with real Google Calendar data.
- ✅ **Tailscale relay mode** — phone-on-cellular reaches laptop-at-home via WireGuard.
- ✅ **Plugin symlink + spawn fix** — `realpathSync()` resolves identity correctly.
- ✅ **OAuth cross-device via `HUB_PUBLIC_HOSTNAME`** — Tailscale-aware redirect URIs.
- ✅ **Biometric prompt crash fix** — `PromptInfo` flag corrected.
- ✅ **Real Google Calendar data e2e via phone approval** — 4.6s end-to-end.
- ✅ **Federation protocol v2** (2026-09-08) — all eight phases shipped, Momus-reviewed twice.

### In progress

- 🚧 **pdatahub Cloud v3** — Hosted Hub SaaS via Hetzner VMs. Phase 1A (Go skeleton) at [`packages/runner/`](./packages/runner/). Phase 1B wires real Hetzner provisioning + SSH executor + health monitor.

### Future

- ⏳ **V8 isolate plugin sandbox** (v4, 2027+) — memory isolation per plugin.
- ⏳ **Per-tenant encryption keys** (Cloud v3.1) — multi-tenant security.
- ⏳ **Plugin signature verification** (v3.1) — trust by URL → trust by signed package.
- ⏳ **WebAuthn for hub-core admin actions** (v3.5) — physical security key for master key rotation.

---

## Documentation

| Doc | Purpose |
|-----|---------|
| [docs/architecture.md](./docs/architecture.md) | Component-level architecture, end-to-end flow, security model |
| [docs/threat-model.md](./docs/threat-model.md) | Asset/adversary model, mitigations, federation inbound security |
| [docs/federation.md](./docs/federation.md) | Federation v2 user guide (setup, delegation, revoke, audit retention) |
| [docs/self-hosting.md](./docs/self-hosting.md) | Run hub-core on your laptop / server / Pi |
| [docs/plugin-author-guide.md](./docs/plugin-author-guide.md) | Write a plugin — SDK, OAuth, packaging, distribution |
| [docs/advantages.md](./docs/advantages.md) | vs Composio, LangChain, Solid, EUDI Wallet, Digi.me |
| [docs/relay-mode.md](./docs/relay-mode.md) | Phone-laptop connectivity (Tailscale + Cloudflare Worker fallback) |

Per-package READMEs:

- [packages/hub-core/README.md](./packages/hub-core/README.md)
- [packages/mcp-server/README.md](./packages/mcp-server/README.md)
- [packages/plugin-sdk/README.md](./packages/plugin-sdk/README.md)
- [packages/relay/README.md](./packages/relay/README.md)
- [packages/android-app/README.md](./packages/android-app/README.md)
- [packages/runner/README.md](./packages/runner/README.md)

---

## Community

- [CONTRIBUTING.md](./CONTRIBUTING.md) — how to contribute, code style, review process
- [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) — Contributor Covenant v2.1
- [GitHub Discussions](https://github.com/pdatahub/pdatahub/discussions) — design questions and "how do I"
- [Issue templates](./.github/ISSUE_TEMPLATE/) — bug, feature, plugin idea

Momus is our adversarial review tool for significant design changes (federation protocol, crypto, OAuth, schema migrations). See [CONTRIBUTING.md §Momus review](./CONTRIBUTING.md#pull-request-process) for when it triggers.

---

## Security

See [SECURITY.md](./SECURITY.md) for:

- Supported versions (currently `main` and `v0.1.x`)
- Vulnerability disclosure process (90-day window, [security@pdatahub.io](mailto:security@pdatahub.io))
- Threat model summary (full version in [docs/threat-model.md](./docs/threat-model.md))
- Known limitations / out-of-scope
- Audit history (Momus rounds for federation v2 and Cloud v3 design)

For federation-specific threat-model TL;DR, see [docs/federation.md §Threat model](./docs/federation.md#threat-model-tldr).

---

## License

[MIT](./LICENSE) — Copyright (c) 2026 pdatahub contributors.