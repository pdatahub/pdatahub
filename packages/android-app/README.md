# pdatahub Android Hub (UI client)

Kotlin Android app — UI client for pdatahub. Shows approval notifications, audit log, active grants. **Does not** run plugins or host MCP server anymore.

> **Revised architecture (2026-09-05):** Hub core (Node.js, runs on user's laptop) handles plugin subprocess, token vault, audit log, OAuth. Android app = thin UI client that connects via WebSocket for approval notifications.

See [main monorepo README](../../README.md) for the full architecture diagram.

## What this app does

- **Pairing** — generate QR code for pdatahub-mcp on laptop to scan
- **Approval notifications** — receive `approval_request` events from hub-core via WebSocket, show in PendingApprovalsCard with Approve/Deny buttons
- **Audit log viewer** — display audit entries broadcast from hub-core
- **Active grants list** — list time-bounded grants from hub-core (TODO)

## What this app does NOT do (anymore)

Previously this app ran:
- Plugin subprocesses (now runs on laptop via `pdatahub-hub-core`)
- HTTP server for MCP endpoints (now in hub-core)
- OAuth flow (now in hub-core)
- Token storage (now in hub-core's encrypted SQLite vault)

These components were moved to [`packages/hub-core/`](../../packages/hub-core/).

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ Android APK (Hub UI only)                                   │
│                                                              │
│  ┌─────────────────────────┐    ┌──────────────────────────┐ │
│  │ Compose UI             │    │ ApprovalWebSocketClient  │ │
│  │ • HomeScreen           │◄───┤ • OkHttp WebSocket       │ │
│  │ • PairingCard          │    │ • Auto-reconnect         │ │
│  │ • HubCoreCard          │    │ • Ping/pong heartbeat    │ │
│  │ • PendingApprovalsCard │    └────────────┬─────────────┘ │
│  └─────────────────────────┘                 │               │
│                                              │ ws://         │
│  ┌─────────────────────────┐                 │               │
│  │ SettingsRepository     │                 │               │
│  │ (SharedPreferences)    │                 │               │
│  │ • hubCoreUrl           │                 │               │
│  │ • hubCoreAuthToken     │                 │               │
│  │ • relayUrl             │                 │               │
│  └─────────────────────────┘                 │               │
└──────────────────────────────────────────────┼───────────────┘
                                               │
                                               ▼
                                  ┌────────────────────────┐
                                  │ hub-core (Node.js)     │
                                  │ on user's laptop       │
                                  └────────────────────────┘
```

## What's implemented

- **Build system**: Kotlin DSL, version catalog (`libs.versions.toml`), Hilt, KSP, Compose
- **Identity**: Ed25519 keypair via Android Keystore (API 33+) with BouncyCastle fallback
- **Encryption**: AES-256-GCM via Tink with Android Keystore-backed master key
- **Storage**: Room database (TokenEntity, PluginEntity) — schema ready, SQLCipher integration
- **Pairing**: `PairingManager` generates session tokens + builds `pdatahub://pair?…` QR payload
- **Approval WebSocket**: `ApprovalWebSocketClient` — OkHttp WS with auto-reconnect, ping/pong
- **Approval UI**: `ApprovalNotificationManager` + `HomeScreen.PendingApprovalsCard`
- **Settings**: `SettingsRepository` — hub-core URL + auth token + relay URL
- **UI**: Single screen with identity, hub-core status, pairing state, pending approvals

## What's TODO (post-MVP)

- Biometric prompt before Approve tap (currently just buttons)
- Active grants list with revoke buttons
- Audit log full history (currently shows live updates only)
- Encrypted backup / BIP-39 recovery

## Build

### Prerequisites

- JDK 17 (Temurin recommended)
- Android SDK 35, build-tools 35.0.0
- An Android device or emulator (API 26+)

### Build from command line

```bash
cd packages/android-app
JAVA_HOME=/path/to/jdk-17 ./gradlew assembleDebug
```

Outputs: `app/build/outputs/apk/debug/app-debug.apk` (~47 MB).

### Install on device

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.pdatahub.hub.debug/com.pdatahub.hub.MainActivity
```

### Configure hub-core URL

Default `hub_core_url` in SharedPreferences is `ws://192.168.1.100:8090`. Override:

```bash
# Direct LAN
adb shell run-as com.pdatahub.hub.debug \
  sh -c 'mkdir -p shared_prefs && cat > shared_prefs/hub_settings.xml <<EOF
<?xml version="1.0" encoding="utf-8" standalone="yes" ?>
<map>
    <string name="hub_core_url">ws://YOUR_LAPTOP_IP:8080</string>
</map>
EOF'

# OR via adb reverse for localhost-from-phone
adb reverse tcp:8080 tcp:8080
# Then hub_core_url can stay ws://127.0.0.1:8080
```

## Tests

```bash
./gradlew test              # JVM unit tests (CryptoBox, IdentityManager)
./gradlew connectedTest     # instrumented tests (requires device)
```

JVM tests verify contracts (Ed25519 key sizes, base64 encoding).

## Wire protocol (WebSocket)

The Android app connects to `ws://<hub-core>:8080/approval-stream` and exchanges:

**Server → Client:**
```json
{ "type": "approval_request", "request_id": "...", "agent_id": "...", "tool_name": "calendar.read.events", "scope": "calendar:read", "justification": null, "created_at": "..." }
{ "type": "audit_update", "entry": { ... } }
{ "type": "grant_revoked", "grant_id": "..." }
{ "type": "pong" }
```

**Client → Server:**
```json
{ "type": "approval_decided", "request_id": "...", "decision": "approved" }
{ "type": "approval_decided", "request_id": "...", "decision": "denied" }
{ "type": "ping" }
```

## Verified end-to-end

On 2026-09-05, the full flow was tested on Honor CMA-LX1:
- Hub-core restarted → phone WebSocket reconnected within 30s
- Approval request sent via `curl POST /v1/tools/listEvents/call`
- UI dump showed "Pending approvals" + "Approve" button visible
- User tapped Approve on phone within 2 seconds
- Hub-core audit log: `decision: approved`, `grant_id: 478dbd06-...`, `duration_ms: 8460`

## Related repos

- [pdatahub/pdatahub](https://github.com/pdatahub/pdatahub) — monorepo (hub-core, mcp-server, plugin-sdk, relay)
- [pdatahub/pdatahub-plugin-template](https://github.com/pdatahub/pdatahub-plugin-template) — template for plugin authors
- [pdatahub/pdatahub-plugin-google-calendar](https://github.com/pdatahub/pdatahub-plugin-google-calendar) — reference plugin

## License

MIT
