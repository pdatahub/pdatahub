# @pdatahub/relay

Cloudflare Worker relay for Hub-to-laptop WebSocket routing when they are not on the same network.

```
┌──────────────┐      HTTPS       ┌─────────────────┐     WSS     ┌──────────┐
│  pdatahub-   │ ────────────────► │  Cloudflare     │ ◄────────► │   Hub    │
│  mcp         │                  │  Worker (DO)    │            │ (phone)  │
│ (laptop)     │ ◄──────────────── │                 │            │          │
└──────────────┘                  └─────────────────┘            └──────────┘
```

## What it does

- Stateless routing layer between AI agents (laptop) and Hub (phone)
- Holds **one Durable Object per session** — terminates Hub's WebSocket and laptop's WebSocket, forwards JSON messages between them
- The relay **never inspects** message payloads — it is opaque to contents. Hub is the source of truth.
- Token-based auth: Hub and laptop both receive per-session tokens at session creation

## What it does NOT do (yet)

- No HTTP gateway (MCP server talks HTTP; relay is WS-only in stub — future `POST /sessions/:id/send`)
- No message persistence (DOs are transient; messages lost if both peers disconnect)
- No rate limiting, no replay protection — those come later

## Routes

```
POST /sessions              create new pairing session
                            → 201 { sessionId, hubToken, laptopToken }

GET  /sessions/:id/ws       WebSocket upgrade
                            ?role=hub|laptop
                            ?token=<hub_token or laptop_token>
                            → 101 WebSocket handshake
                            → 400 invalid role / missing token
                            → 401 wrong token
                            → 404 session not initialized
                            → 409 role already connected

GET  /sessions/:id/health   → 200 { sessionId, status: "ok" }
GET  /health                → 200 { status: "ok", service: "pdatahub-relay" }
```

## Wire protocol

All messages are JSON strings sent over the WebSocket.

```typescript
// Client → Server (Hub or laptop)
type ClientMessage =
  | { type: 'forward'; payload: unknown }
  | { type: 'ping' };

// Server → Client
type ServerMessage =
  | { type: 'registered'; sessionId: string; role: 'hub' | 'laptop' }
  | { type: 'pong' }
  | { type: 'error'; reason: string };
```

The relay forwards `forward` messages between Hub and laptop with **no inspection**. Ping/pong are answered locally.

## Local development

```bash
cd packages/relay
pnpm install
pnpm dev                # wrangler dev — local server on http://localhost:8787
pnpm test               # vitest with miniflare
```

## Deploy

```bash
cd packages/relay
wrangler login          # one-time
pnpm deploy             # wrangler deploy — publishes to Cloudflare edge
```

After deploy, the Worker is reachable at `https://pdatahub-relay.<your-subdomain>.workers.dev`.

For production, set up a custom domain (e.g. `relay.pdatahub.app`).

## Usage from Hub (Kotlin / Android — future)

```kotlin
val client = RelayClient(
    url = "wss://relay.pdatahub.app/sessions/$sessionId/ws",
    role = "hub",
    token = hubToken,
)
client.connect()
client.send(ForwardMessage(payload = mcpRequest))
client.onMessage { raw -> handleMcpResponse(raw) }
```

## Usage from laptop (MCP server — future)

Currently `pdatahub-mcp` talks HTTP directly to the Hub when on the same network. To use the relay, MCP server would gain a "relay mode" that opens a long-lived WebSocket and proxies HTTP requests over it (like the Vite HMR WebSocket wrapper).

That's the next iteration. For now, relay is end-to-end testable via the vitest suite.

## Architecture

### Session lifecycle

```
Hub app                       Cloudflare                    Laptop
   │                              │                            │
   │── POST /sessions ───────────►│                            │
   │◄── 201 {sessionId, tokens} ──│                            │
   │                              │                            │
   │  (User shows QR code)        │                            │
   │                              │                            │
   │── GET /sessions/X/ws ───────►│                            │
   │   ?role=hub&token=H ────────►│                            │
   │◄── 101 WebSocket ────────────│                            │
   │                              │◄── GET /sessions/X/ws ─────│
   │                              │    ?role=laptop&token=L ──►│
   │                              │──────► 101 WebSocket ─────│
   │                              │                            │
   │── {type:'forward',...} ─────►│                            │
   │                              │── {type:'forward',...} ──►│
   │◄── {type:'forward',...} ─────│                            │
   │                              │◄── {type:'forward',...} ──│
```

### Why Durable Objects?

A naive WebSocket server would need sticky session routing — load balancer must consistently route the same session to the same Worker instance. Durable Objects give us this for free: each `idFromName(sessionId)` always lands on the same DO instance.

WebSocket **hibernation** keeps connections alive while the DO is evicted from memory. `acceptWebSocket(ws, [tag])` and `getWebSockets(tag)` work across evictions. The DO wakes on message and stays awake only briefly.

## Testing

```bash
pnpm test
```

Uses `@cloudflare/vitest-pool-workers` — runs tests inside miniflare with the same DO bindings as production. Catches binding config and DO behavior issues before deploy.

## Limits (Cloudflare DO)

- WebSocket hibernation: idle WS persists across DO eviction, message history NOT preserved
- Per-DO memory: 128 MB
- Per-WS message: 1 MB
- Per-request duration: 30 s (CPU time on inbound; WS messages are not request-scoped)

For PoC scale these are not constraints. Real production may need sharding by region, larger DOs, or moving to Hono on a TCP-based service.

## License

MIT
