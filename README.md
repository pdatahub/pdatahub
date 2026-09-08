# pdatahub — Personal Data Hub

[![CI](https://github.com/pdatahub/pdatahub/actions/workflows/ci.yml/badge.svg)](https://github.com/pdatahub/pdatahub/actions/workflows/ci.yml)

> Privacy-first personal data platform with per-action approval, time-bounded grants, and auditable AI-agent access.

**Status (2026-09-08):** Federation v2 complete across all eight phases — two-hub delegation, signed federation calls, audit retention CLI. See [docs/federation.md](./docs/federation.md) for the walkthrough.

**Federation v2 (shipped 2026-09-08):** Two trusted hubs can now share a single plugin tool with per-call phone approval, while the issuer's OAuth token never crosses the hub boundary. Ed25519-signed delegation blobs travel out-of-band; every federated call is recorded in both hubs' audit logs with `delegated_by` / `delegated_to` populated. See [docs/federation.md](./docs/federation.md) for setup and [docs/architecture.md §Federation v2](./docs/architecture.md#federation-v2) for the architecture.

**Pre-federation e2e (2026-09-07):** Full single-hub path verified — MCP client → hub-core → phone biometric approval → plugin → Google Calendar API → real events, in 4.6 seconds.

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
│ • ApprovalStream WebSocket (/approval-stream)               │
│ • Proactive OAuth refresh (5 min before expiry)              │
│ • BIP-39 encrypted backup (.pdatahub-backup file)            │
└──────┬───────────────────────────┬──────────────────────────┘
       │ JSON-RPC over stdio       │ WebSocket /approval-stream
       │                           │
┌──────▼─────────────┐  ┌──────────▼───────────────────────────┐
│ Plugin subprocess  │  │ Android Hub UI      ─── packages/... │
│ (Node.js, laptop)  │  │ • Approval notifications + Approve  │
│                    │  │ • Biometric prompt (PromptInfo fix)  │
│ Google Calendar    │  │ • Audit log viewer                   │
│ Slack, Trello etc  │  │ • Active grants list                 │
└────────────────────┘  │ • Settings (URL, token, biometric)   │
                       └──────────────────────────────────────┘
```

### Network paths supported

| Setup | Phone URL | Cleartext allowed? |
|-------|-----------|--------------------|
| **Tailscale mesh** (recommended) | `http://<laptop>.tailXXXXXX.ts.net:8080` | ✅ via `*.ts.net` policy |
| Direct LAN WiFi (no Tailscale) | `http://192.168.x.x:8080` | ✅ via debug base-config |
| adb reverse (USB tether) | `http://127.0.0.1:8080` | ✅ via `127.0.0.1` policy |
| Tailscale direct IP | `http://100.79.x.x:8080` | ✅ via CGNAT policy |

## Verified end-to-end (2026-09-07)

```
[0.0s] MCP call listEvents → hub-core (Tailscale MagicDNS)
[0.0s] Hub-core → approval request via WebSocket → phone
[4.6s] User taps Approve on phone (biometric or auto)
[4.6s] Hub-core → plugin subprocess → Google Calendar API
[4.6s] Real events → MCP client → user
```

## Key invariants

- **Plugin never sees raw OAuth token** — Hub injects via SDK's `this.http` after decrypting from vault
- **Per-plugin encryption key** — `HKDF(master_key, plugin_name, "pdatahub-token-vault-v1")` → 32-byte AES-256 key (no cross-plugin token leak if one plugin is compromised)
- **Per-action approval** — each tool call triggers notification, user taps Approve/Deny
- **Time-bounded grants** — `expires_at = now + 3600s`, lazy expiration via `GrantStore.isValid()`
- **Instant revoke** — `UPDATE grants SET revoked=1 WHERE grant_id=?` → next access = 401
- **Proactive OAuth refresh** — `TokenVault.isExpiringSoon(plugin)` checked before each tool call, refresh via `refresh_token` if < 5 min remain
- **Audit log** — single source of truth at Hub, append-only SQLite, broadcast via WebSocket for live UI

## Packages

| Package | What | Status |
|---------|------|--------|
| [`packages/hub-core/`](./packages/hub-core/) | Node.js Hub core (HTTP + plugins + vault + audit + WS) | ✅ v0.1.0 — e2e verified |
| [`packages/mcp-server/`](./packages/mcp-server/) | MCP bridge for AI agents → Hub | ✅ v0.1.0 |
| [`packages/plugin-sdk/`](./packages/plugin-sdk/) | TypeScript SDK for plugin authors | ✅ v0.1.0 — GitHub Releases |
| [`packages/relay/`](./packages/relay/) | Cloudflare Worker relay (cross-network pairing) | ✅ v0.1.0 |
| [`packages/android-app/`](./packages/android-app/) | Android UI client (approval + audit) | ✅ v0.1.0 — debug build on Honor CMA-LX1 |
| [`packages/runner/`](./packages/runner/) | Go control-plane daemon (Hetzner VM provisioning + hub-core deploy) | 🚧 Phase 1A skeleton — mocked Hetzner, cloud-init generator, deploy planner |

## External repos

- [`pdatahub/pdatahub-plugin-template`](https://github.com/pdatahub/pdatahub-plugin-template) — template for plugin authors
- [`pdatahub/pdatahub-plugin-google-calendar`](https://github.com/pdatahub/pdatahub-plugin-google-calendar) — reference plugin (e2e verified)

## Quick start

### Prerequisites

- Node.js 20+
- JDK 17 (`brew install openjdk@17` or portable `~/.local/jdk/jdk-17`)
- Android SDK (for building android-app)
- pnpm 9+
- Optional: Tailscale for cross-device phone approval

### Hub core (laptop)

```bash
git clone https://github.com/pdatahub/pdatahub
cd pdatahub
pnpm install
pnpm --filter hub-core build

# Generate master key (keep secret!)
MASTER_KEY=$(openssl rand -hex 32)
HUB_API_TOKEN=$(openssl rand -hex 32)

# Start hub
node packages/hub-core/dist/index.js \
  --port 8080 \
  --master-key "$MASTER_KEY" \
  --db-path ~/.local/share/pdatahub/hub.db \
  --oauth-callback-port 8081 \
  --plugins-dir ~/.local/share/pdatahub/plugins
```

### MCP server (laptop)

```bash
# Configure OpenCode MCP
mkdir -p ~/.config/opencode
cat > ~/.config/opencode/opencode.json <<EOF
{
  "mcp": {
    "pdatahub": {
      "type": "http",
      "url": "http://127.0.0.1:8080",
      "enabled": true,
      "headers": {
        "Authorization": "Bearer $HUB_API_TOKEN"
      }
    }
  }
}
EOF
```

### Plugin (Google Calendar reference)

```bash
# Install reference plugin from GitHub Releases
PLUGIN_DIR=~/.local/share/pdatahub/plugins
mkdir -p $PLUGIN_DIR
curl -L https://github.com/pdatahub/pdatahub-plugin-google-calendar/releases/latest/download/google-calendar.tgz \
  | tar -xz -C $PLUGIN_DIR

# Hub picks it up on next restart (or symlink for dev)
ln -s /path/to/pdatahub-plugin-google-calendar $PLUGIN_DIR/google-calendar
```

### Google Cloud Console setup (for google-calendar plugin)

1. Create OAuth client at https://console.cloud.google.com/apis/credentials
2. Type: **Web application**
3. Authorized redirect URIs (one per network setup):
   - `http://127.0.0.1:8081/callback` (adb reverse / localhost)
   - `http://<your-laptop>.tailXXXXXX.ts.net:8081/callback` (Tailscale)
   - `http://192.168.x.x:8081/callback` (LAN direct)
4. Save client_id + client_secret into hub-core env:
   ```bash
   export HUB_CLIENT_GOOGLE_CALENDAR_ID="xxx.apps.googleusercontent.com"
   export HUB_CLIENT_GOOGLE_CALENDAR_SECRET="GOCSPX-xxx"
   # For Tailscale cross-device:
   export HUB_PUBLIC_HOSTNAME="<your-laptop>.tailXXXXXX.ts.net"
   ```

### Android app (debug build)

```bash
cd packages/android-app
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk

# Configure hub URL via shared_prefs (debug only)
adb shell "run-as com.pdatahub.hub.debug mkdir -p shared_prefs"
adb push hub_settings.xml /sdcard/
adb shell "cat /sdcard/hub_settings.xml | run-as com.pdatahub.hub.debug sh -c 'cat > /data/data/com.pdatahub.hub.debug/shared_prefs/hub_settings.xml'"
```

`hub_settings.xml` template:
```xml
<?xml version="1.0" encoding="utf-8" standalone="yes" ?>
<map>
    <string name="relay_url">wss://relay.pdatahub.app</string>
    <string name="hub_core_url">http://vladimirmyshkovski.tail36274d.ts.net:8080</string>
    <string name="hub_core_token">8516c9ac7e4f5226...</string>
    <boolean name="biometric_enabled" value="false" />
</map>
```

### Tailscale setup (recommended for phone approval)

```bash
# On laptop:
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# On Android:
# Install Tailscale from Play Store, sign in with same account

# Find your MagicDNS hostname:
tailscale status
# → 100.79.247.91  vladimirmyshkovski.tail36274d.ts.net  linux
```

Use the MagicDNS hostname in `hub_core_url` and Google Cloud Console redirect URIs.

## Roadmap

- ✅ MVP architecture verified end-to-end (2026-09-07)
- ✅ Tailscale relay mode (commit 4f2d879)
- ✅ Plugin symlink + spawn fix (commit 95ec01c)
- ✅ OAuth cross-device via `HUB_PUBLIC_HOSTNAME` (commit a452e15)
- ✅ Biometric prompt crash fix (commit 718f2a7)
- ✅ Heartbeat noise cleanup (commit 3530a99)
- ✅ Real Google Calendar data e2e via phone approval
- ✅ **Federation protocol v2 — Hub-to-Hub cross-user delegation (2026-09-08)**
  - Phase 0.5 — Migration framework + per-route auth + hard-fail token (commit 0e6fc47)
  - Phase 1 — Identity foundation (Ed25519 keypair, `/v1/identity`) (commit 0e6fc47)
  - Phase 2a — Delegation data model + sign/verify + canonical JSON (commit 0e6fc47)
  - Phase 2b — `user_id` semantics + grant match key fix (commit 0e6fc47)
  - Phase 3 — Hub-side call path (`/v1/federation/call` + inbound security) (commit 6e2c20f)
  - Phase 4 — CLI tooling (`delegate`, `accept-delegation`, `list`, `revoke`) (commit 4554ac8)
  - Phase 5 — Tool descriptors + mcp-server passthrough (`/v1/federation/invoke`) (commit a1cdc5f)
  - Phase 6 — Android UI (approval payload + HubIdentitySection + DelegationManagementScreen) (commits 778f342, 0895e8e)
  - Phase 7+7b — User documentation + audit retention CLI (`pdatahub-hub audit purge --older-than Nd`) (2026-09-08)
  - Phase 8a+8b — Multi-process integration + adversarial tests (`federation-multi-process.test.ts`, `federation-adversarial.test.ts`) — 11 new tests, 321 total passing (2026-09-08)
- 🚧 pdatahub Cloud v3 — Hosted Hub SaaS
  - **Phase 1A in progress** — Go module skeleton at [`packages/runner/`](./packages/runner/) with mocked Hetzner client, cloud-init generator, SSH key generator, hub-core deploy planner, and unit tests. Phase 1B wires real provisioning + SSH executor + health monitor.

See [`docs/architecture.md`](./docs/architecture.md) for detailed e2e flow, security model, and plugin lifecycle. See [`docs/federation.md`](./docs/federation.md) for the federation walkthrough. See [`packages/runner/README.md`](./packages/runner/README.md) for the Cloud v3 control-plane design.

## License

MIT
