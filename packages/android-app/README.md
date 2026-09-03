# pdatahub Android Hub

Kotlin Android app — the "Hub" runtime for pdatahub. Owns the user's data, runs plugin subprocesses, exposes the local MCP HTTP server.

This is **init scope** — the architectural foundation. UI is minimal, several features are stubs with TODOs. See the [main monorepo](https://github.com/pdatahub/pdatahub) for the broader project.

## Architecture

```
┌──────────────────────────┐
│  pdatahub-hub (Android)  │
│                          │
│  ┌────────────────────┐  │   spawn subprocess    ┌─────────────────┐
│  │ McpHttpServer      │◄─┼────────────────────► │ PluginProcess    │
│  │ (Ktor on 8080)     │  │ JSON-RPC over stdio  │  (Node.js SDK)   │
│  └────────┬───────────┘  │                       └─────────────────┘
│           │              │                                  │
│  ┌────────▼───────────┐  │   websocket                    │
│  │ PluginManager      │  │                          ┌──────▼──────────┐
│  │ + ToolRegistry     │  ├──────────────────────────►  Cloudflare    │
│  └────────┬───────────┘  │                          │  relay         │
│           │              │                          └─────────────────┘
│  ┌────────▼───────────┐  │
│  │ IdentityManager    │  │  Ed25519 keypair
│  │ (Ed25519)          │  │  used for pairing & audit
│  └────────────────────┘  │
│                          │
│  ┌────────────────────┐  │
│  │ PairingManager     │  │  session_token → QR code
│  └────────────────────┘  │
│                          │
│  ┌────────────────────┐  │
│  │ HubDatabase        │  │  Room + SQLCipher
│  │ (encrypted)        │  │  tokens, plugins, audit log
│  └────────────────────┘  │
│                          │
│  ┌────────────────────┐  │
│  │ CryptoBox          │  │  AES-256-GCM
│  │ (Tink + Keystore)  │  │  encrypts identity & tokens at rest
│  └────────────────────┘  │
└──────────────────────────┘
```

## What's implemented (init scope)

- **Build system**: Kotlin DSL, version catalog (`libs.versions.toml`), Hilt, KSP, Compose
- **Identity**: Ed25519 keypair via Android Keystore (API 33+) with BouncyCastle fallback
- **Encryption**: AES-256-GCM via Tink with Android Keystore-backed master key
- **Storage**: Room database (TokenEntity, PluginEntity) — schema ready, SQLCipher integration
- **Plugin subprocess**: Java `ProcessBuilder` → spawns `node plugin/index.js` → JSON-RPC over stdio
- **MCP HTTP server**: Ktor + Netty, exposes `/v1/tools` and `/v1/tools/{name}/call`
- **Foreground service**: `McpServerService` keeps the HTTP server alive
- **Pairing**: `PairingManager` generates session tokens + builds `pdatahub://pair?…` QR payload
- **Relay client stub**: OkHttp WebSocket interface (real impl follows pairing wiring)
- **UI**: Single screen with identity, server controls, pairing state, tools list

## What's stubbed (follow-ups)

- Plugin install/remove UI (plugins currently come from `PluginDao` only)
- Tooltip / approval UI when AI agent requests a scoped tool
- Real Cloudflare relay integration (just OkHttp WS impl, no pairing wiring yet)
- QR code rendering (uses `pdatahub://pair?…` payload string)
- Encrypted backup export/import (BIP-39 seed phrase)
- Approval flow with biometric prompt

## Build

### Prerequisites

- Android Studio Iguana (2023.2.1) or newer
- JDK 17
- Android SDK 35, build-tools 35.0.0
- An Android device or emulator (API 26+)

### Build from command line

```bash
cd packages/android-app
./gradlew assembleDebug
```

Outputs: `app/build/outputs/apk/debug/app-debug.apk`

### Open in Android Studio

1. File → Open → select `packages/android-app`
2. Wait for Gradle sync
3. Run → Run 'app' (Shift+F10)

### Install on device

```bash
./gradlew installDebug
```

## Tests

```bash
./gradlew test              # JVM unit tests
./gradlew connectedTest     # instrumented tests (requires device)
```

JVM tests verify contracts (Ed25519 key sizes, base64 encoding, JSON-RPC envelope shape).
Full integration tests live in `app/src/androidTest/`.

## Configuration

The Hub needs a `node` binary to spawn plugin subprocesses. On Android:

- Install Termux (`com.termux`)
- `pkg install node`
- Node lives at `/data/data/com.termux/files/usr/bin/node`

The Hub auto-detects this path. If not found, the UI shows an error.

## Wire protocol

Same JSON-RPC 2.0 envelope as `packages/plugin-sdk/src/types.ts`:

```typescript
// Hub → plugin (via stdin)
{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { hubVersion: '0.1.0' } }

// Plugin → Hub (via stdout)
{ jsonrpc: '2.0', id: 1, result: { name: 'google-calendar', version: '0.1.0', tools: [...] } }

// Hub → plugin (tool call)
{ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'listEvents', arguments: [...], context: { token: '...' } } }
```

stdout = protocol channel. stderr = logs (Hub captures and surfaces in the app log).

## Related repos

- [pdatahub/pdatahub](https://github.com/pdatahub/pdatahub) — monorepo with SDK, MCP server, relay
- [pdatahub/pdatahub-plugin-template](https://github.com/pdatahub/pdatahub-plugin-template) — template for plugin authors
- [pdatahub/pdatahub-plugin-google-calendar](https://github.com/pdatahub/pdatahub-plugin-google-calendar) — reference plugin

## License

MIT
