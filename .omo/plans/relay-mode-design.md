# Relay Mode — Design Document

**Status:** Tailscale chosen for MVP (2026-09-06). Custom Worker (option B) deferred until needed.
**Trigger:** `trycloudflare.com` blocked in user's country. `workers.dev` and Tailscale control plane accessible.

## Why Tailscale for MVP

| Constraint | Tailscale | Custom CF Worker (B) |
|---|---|---|
| Setup time | 15 min | 3-5 days |
| Infrastructure | None (control plane only) | Worker code + KV/Durable Objects |
| Works in user's country? | Yes (verified) | Likely yes (workers.dev reachable) |
| Phone app | Official (Google Play) | Manual config |
| Privacy from cloud | WireGuard (modern, audited) — coord server sees only key exchange | CF terminates TLS, sees metadata |
| Multi-hub support | Each device sees all others | Needs routing layer (Durable Objects) |
| Rate limiting | Per-device | Built into Worker |

## Current architecture (Tailscale, 2026-09-06)

```
[Phone (Tailscale IP 100.x.y.z)]
       │  HTTPS + WSS over WireGuard
       ▼
[Tailscale mesh network]
       │
       ▼
[Laptop (Tailscale IP 100.79.247.91)]
   └── hub-core binds 0.0.0.0:8080 (no code change)
       └── HTTP API + WebSocket approval stream
```

Setup steps (current):
1. Install Tailscale on laptop: `curl -fsSL https://tailscale.com/install.sh | sh`
2. Auth: `tailscale up` → opens browser OAuth
3. Install Tailscale on phone (Google Play)
4. Phone logs in to same Tailscale account
5. Phone can reach `http://100.79.247.91:8080` from any network

No code changes in hub-core. No new attack surface. WireGuard encryption.

## Option B — Custom Cloudflare Worker (deferred)

### When to migrate from Tailscale → Worker

Stay with Tailscale unless **all** of these are true:
- [ ] More than 5 devices on the same Tailscale account (Tailscale free tier caps at 100 devices but UX degrades)
- [ ] Want to share hub access with someone else's phone (no Tailscale account, just URL)
- [ ] Need rate limiting at edge (e.g., 100 req/min per IP)
- [ ] Want unified audit log across many hubs
- [ ] Self-hosting is not an option

If even one of these is required, evaluate option B vs self-hosted relay.

### Option B architecture

```
[OpenCode / Phone]
       │  HTTPS (Bearer token)
       ▼
[Cloudflare Worker (stateless)]
       │  WebSocket (outbound from hub-core)
       ▼
[hub-core (laptop or VPS)]
       │
       ▼
[Plugin subprocess] → [Google API]
```

### Components (when implementing)

**New code in `packages/hub-core/src/`:**
```
relay/
  ├── client.ts         # Outbound WebSocket to Worker (reconnection, heartbeat)
  ├── handler.ts        # HTTP-over-WS request routing inside hub-core
  ├── token-store.ts    # Long-lived session_token (32 bytes, encrypted at rest)
  ├── auth.ts           # HMAC sign outbound requests, verify inbound
  └── types.ts          # RelayMessage, RelayRequest, RelayResponse
```

**New repo `packages/relay-worker/`** (deployed via `wrangler deploy`):
```
relay-worker/
  ├── src/index.ts      # Worker fetch handler
  ├── wrangler.toml     # Worker config (KV namespace, secrets)
  └── package.json
```

### Worker logic (sketch)

```typescript
// relay-worker/src/index.ts
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // 1. Extract bearer token
    const token = request.headers.get('Authorization')?.replace('Bearer ', '');
    if (!token) return new Response('Unauthorized', { status: 401 });

    // 2. Look up hub instance in KV (token → hub connection ID)
    const hubId = await env.HUB_TOKENS.get(token);
    if (!hubId) return new Response('Invalid token', { status: 401 });

    // 3. Get Durable Object for this hub (holds the WebSocket connection)
    const hub = env.HUBS.get(env.HUBS.idFromName(hubId));
    return hub.fetch(request);
  }
};

// Durable Object holds long-lived WS to hub-core
export class HubConnection {
  async fetch(request: Request): Promise<Response> {
    // If WebSocket upgrade: register connection from hub-core
    // If regular HTTP: forward to hub-core via WS, return response
    ...
  }
}
```

### Hub-core relay client (sketch)

```typescript
// hub-core/src/relay/client.ts
export class RelayClient {
  private ws?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;

  async connect(url: string, token: string) {
    this.ws = new WebSocket(`${url}/hub?token=${token}`);
    this.ws.addEventListener('open', () => this.onOpen());
    this.ws.addEventListener('message', (e) => this.onMessage(e));
    this.ws.addEventListener('close', () => this.scheduleReconnect());
  }

  private onMessage(event: MessageEvent) {
    const msg: RelayRequest = JSON.parse(event.data);
    const response = await this.handler.handle(msg);
    this.ws!.send(JSON.stringify(response));
  }

  private scheduleReconnect() {
    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 60s
    ...
  }
}
```

### Auth model for option B

- **Hub-core ↔ Worker**: Hub generates 32-byte `session_token` on first start. Token sent in `Authorization: Bearer` on initial WebSocket upgrade. Worker stores in KV (token → hub ID).
- **Client ↔ Worker**: Same token. Phone / OpenCode use the same `HUB_API_TOKEN` they'd use for direct hub-core access.
- **No mTLS for MVP**: Worker only does TLS termination. Hub↔Worker trust is via shared secret token. Worker can revoke by deleting KV entry.

### Estimated effort

| Component | LOC | Days |
|---|---|---|
| `packages/hub-core/src/relay/` | ~400 | 2 |
| `packages/relay-worker/` | ~150 | 1 |
| Tests | ~300 | 1 |
| OpenCode integration (HTTPS client + retry) | ~100 | 0.5 |
| Android integration (HTTPS client) | ~150 | 1 |
| E2E test | ~200 | 0.5 |
| **Total** | **~1300 LOC** | **6 days** |

### Migration checklist (Tailscale → Worker)

1. Add `--relay-url <wss://...>` flag to hub-core
2. Add `--relay-token <token>` flag (also reads `HUB_RELAY_TOKEN`)
3. When relay-url set: open outbound WS to Worker, advertise token, disable direct HTTP/WS listeners (or keep both for migration)
4. Build Worker (`packages/relay-worker/`), deploy via `wrangler deploy`
5. Set Worker secrets: `HUB_TOKEN` → generated session_token
6. Update OpenCode config: `hub-core URL` → `https://pdatahub-relay.<user>.workers.dev`
7. Update Android app: same URL
8. Test: phone in cafe → laptop at home, all through Worker
9. Once verified working for 1 week: disable direct listeners, uninstall Tailscale

### When NOT to do option B

- Personal use only → Tailscale is enough
- Latency critical (gaming, real-time) → Tailscale lower overhead (no third hop)
- Don't want CF account → Self-host relay on VPS (option R from earlier discussion)

## Self-hosted relay (option R) — alternative

If CF blocked too, deploy tiny Node.js relay on a cheap VPS:

```
[Phone/OpenCode] → HTTPS (Bearer) → [VPS relay :443] → WSS → [hub-core]
```

Cost: Hetzner CX22 €3.59/month (~700MB RAM, 20GB SSD). Run:
- Caddy (auto-TLS) on :443, proxy to localhost:8080
- Small Node.js WebSocket multiplexer if multiple hubs
- Or just `cloudflared` on VPS pointing to localhost:8080 (yes, VPS itself can use CF Tunnel even if trycloudflare.com blocked)

This is essentially option B but you own the relay. Code reuse from option B.

## References

- Tailscale docs: https://tailscale.com/docs/
- Cloudflare Workers: https://developers.cloudflare.com/workers/
- Durable Objects (for stateful routing): https://developers.cloudflare.com/durable-objects/
- WireGuard: https://www.wireguard.com/

## Change log

- 2026-09-06: Created. Tailscale chosen for MVP. Option B deferred.
