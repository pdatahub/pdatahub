# Threat Model

> **Audience:** engineers contributing to pdatahub, security researchers evaluating it, and self-hosters deciding what residual risk they're accepting.
>
> **Scope:** hub-core, mcp-server, plugin-sdk, relay, android-app, runner. Federation v2 is in scope as of v0.1.0 (2026-09-08). Cloud v3 design is documented in `.omo/plans/cloud-v3-design.md`; its threat model inherits from this one with per-tenant isolation additions.
>
> **Style:** direct, decision-complete. We name the adversary, the asset, the mitigation, and what we deliberately deferred.

## Asset model — what we protect

| # | Asset | Where it lives | Sensitivity |
|---|-------|----------------|-------------|
| 1 | **OAuth access tokens** for each plugin | Encrypted at rest in `tokens` table on hub | High — these grant upstream API access on the user's behalf |
| 2 | **OAuth refresh tokens** for each plugin | Same — encrypted with the access token | High — long-lived; theft = indefinite upstream access |
| 3 | **Grant data** (who approved what, when, expires, scope) | `grants` table on hub | Medium — disclosure reveals usage patterns |
| 4 | **Audit log** (every approval, every call, every decision) | Append-only `audit_log` table | Medium-high — tampering invalidates the whole security model |
| 5 | **User identity (Ed25519 signing key)** for federation v2 | Encrypted at rest under master key, in memory while hub runs | High — compromise allows forging delegation blobs |
| 6 | **Master key** (the secret that decrypts everything) | Memory while hub runs; user keeps a backup | Critical — compromise = full data exfiltration |
| 7 | **Plugin source code integrity** | On disk in `--plugins-dir` | Medium — modified plugin can do anything the user can |
| 8 | **Hub API token** (`HUB_API_TOKEN`) | Env var on laptop; user-supplied | High — anyone with it can issue calls on the user's behalf |
| 9 | **BIP-39 mnemonic** (used to derive a fresh master key for backup/restore) | User-managed (password manager, paper) | Critical — same blast radius as master key |

The "user" throughout this doc is a single individual running hub-core on a personal device (laptop or home server). When we say "phone," we mean the user's Android phone running the pdatahub Android app.

## Adversary model — who we designed against

We enumerate adversaries by **capability**, ordered roughly from least to most powerful. The mitigations assume the adversary has substantial capability unless noted.

### A1. Compromised plugin

A plugin author is malicious, or a legitimate plugin has a vulnerability. The plugin runs as a subprocess and has access to its own scope.

- **Can:** make any HTTP request to its declared service within the granted scope; read whatever the upstream API returns; call its own `@Tool`-decorated methods repeatedly.
- **Cannot (today):** see the raw OAuth token; see other plugins' tokens; touch `hub.db` directly; talk to another plugin's subprocess; impersonate the hub to the upstream service.
- **Cannot (post-v4 with V8 isolates):** access Node.js globals outside its sandbox.

### A2. Malicious AI agent

The AI agent (OpenCode, Claude Code, Cursor, custom) is either honest-but-curious (calls things the user didn't intend) or actively malicious (compromised LLM weights, prompt injection, malicious tool description).
- **Can:** issue any tool call via MCP, with arbitrary arguments.
- **Cannot:** bypass phone approval (default mode); read data outside granted scope; persist beyond session lifetime (grants expire after 1h).

### A3. Network attacker

An attacker on the path between hub-core and the external service (e.g. compromised router, BGP hijack, on-path TLS termination by a corporate middlebox), or between hub-core and the phone.
- **Can:** intercept traffic if not encrypted; replay captured packets; inject packets.
- **Cannot (with default config):** break TLS to upstream APIs (the SDK uses native `fetch` with TLS); break WireGuard between hub and phone (Tailscale); break HTTPS to Cloudflare Worker (the relay uses TLS termination).

### A4. Compromised phone (with biometric)

The phone is stolen or has malware. The attacker has the user's biometric (or knows the PIN).
- **Can:** approve any tool call; read the audit log; generate new delegations (federation v2).
- **Cannot:** read the master key (it's on the laptop, not the phone); exfiltrate hub database (it's on the laptop); impersonate the phone to a different hub (per-device session token).

### A5. Compromised laptop

The laptop is stolen or has malware running as the user. The attacker has full disk access and process privileges.
- **Can:** read `hub.db` (decrypts with master key from env or memory); read `HUB_API_TOKEN`; impersonate the user to all upstream services; revoke all grants; issue any audit row.
- **Cannot:** magically decrypt master key from a separate device (master key never persisted in plaintext to disk; only in process memory and in user's password manager).
- **Residual risk:** the user accepts this. Self-hosting puts the laptop in the trust boundary. Cloud v3 with HSM-backed keys addresses it.

### A6. Compromised peer hub (federation v2)

User B's hub is compromised. B delegates a tool from B's hub to User A's hub (or vice versa). The compromised hub has the delegation blob and B's signing key.
- **Can (today):** issue federated calls within the delegation scope; replay `request_id` (mitigated by nonce dedup within 10 min); spam approvals (mitigated by 10/60s rate limit per `(peer_verify_key, agent_id)`).
- **Cannot:** see A's OAuth token; forge a delegation blob signed by A; escalate scope; extend the delegation past `expires_at`; bypass A's phone approval.

### A7. Cloud v3 operator (Hetzner / Cloudflare / us)

Adversary for the future Cloud v3 product. Inherits A5 plus:
- **Can:** see all customers' data on shared infrastructure; mine audit logs across tenants.
- **Cannot (with proper isolation):** see plaintext OAuth tokens (per-tenant encryption keys in v3.1); cross tenant boundaries (DB-per-tenant + dedicated VM in v3); tamper with audit logs (append-only enforcement + replication).

We are **not** designing against a Cloud operator today — that's a separate threat model. For self-hosted (current), A5 is the residual risk.

## Trust boundaries

```
              (A) TRUSTED                      (B) SEMI-TRUSTED
              ──────────                       ──────────────────

  User's laptop                Hub process                Plugin subprocess
  ┌──────────────┐             ┌──────────────┐            ┌──────────────┐
  │ Master key   │────────────►│ Vault        │───AES───► │ Decrypted    │
  │ HUB_API_TOKEN│  in-memory  │ Audit log    │  key       │ access_token │
  │ hub.db       │             │ Grants       │            │ (per call)   │
  └──────────────┘             └──────┬───────┘            └──────┬───────┘
        ▲                             │                           │
        │ WebSocket                   │ JSON-RPC                  │ HTTPS + Bearer
        │ /approval-stream            │ stdio                     │ to upstream API
        │                             ▼                           ▼
  ┌─────┴──────────┐           (B) UNTRUSTED                  (C) UPSTREAM
  │ Android phone  │                                             (Google, Slack, etc.)
  │ • Pairing      │           Network: Tailscale mesh              ▲
  │ • Approval UI  │           Encryption: WireGuard                │
  │ • Audit viewer │           Auth: HUB_API_TOKEN                  │
  └────────────────┘                                                │
                                                                     │
              (A) TRUSTED                                            │
              User B's hub (federation v2) ──────── Ed25519 ─────────┘
              ┌──────────────────────────────┐
              │ Ed25519 signing key          │
              │ peer_delegations table       │
              │ /v1/federation/invoke handler│
              └──────────────┬───────────────┘
                             │ HTTP over tailnet, signed
                             ▼
              User A's /v1/federation/call (this hub)
```

### What's trusted vs untrusted at each boundary

| Boundary | Trusted side | Untrusted side | What crosses |
|----------|--------------|----------------|--------------|
| Hub ↔ Phone | Hub | Phone (treat as untrusted input source) | WebSocket frames: `approval_decided`, `ping`; **never** trust approval without biometric verification flag |
| Hub ↔ Plugin subprocess | Hub | Plugin (semi-trusted) | JSON-RPC requests with `context.token` injected by Hub. Plugin reads token from context, never from stdout. |
| Hub ↔ Upstream API | Hub | Network (TLS) | HTTPS with Bearer token. Certificate validation on by default. |
| Hub A ↔ Hub B (federation) | Hub A (data owner) | Hub B (peer) | HTTP over tailnet, signed with B's Ed25519 key. A's OAuth token NEVER crosses. |
| Hub ↔ MCP client (mcp-server) | Hub | MCP client | HTTP with `HUB_API_TOKEN`. All calls go through approval flow unless granted. |

## Security mechanisms — what's actually shipped

### Token vault (AES-256-GCM, HKDF per-plugin)

```
master_key (32 bytes, from --master-key CLI flag or HUB_MASTER_KEY env)
   │
   │ HKDF-SHA256(
   │   ikm  = master_key,
   │   salt = plugin_name (e.g., "google-calendar"),
   │   info = "pdatahub-token-vault-v1",
   │   length = 32
   │ )
   │
   ▼
per_plugin_key (32 bytes, AES-256)
   │
   │ AES-256-GCM(
   │   key = per_plugin_key,
   │   iv  = random 12 bytes,
   │   plaintext = access_token (or refresh_token)
   │ )
   │
   ▼
stored in SQLite: access_token_enc, access_token_iv, access_token_tag
```

**Why per-plugin key:** if one plugin is compromised, the attacker cannot decrypt another plugin's tokens without also compromising the master key. The master key is never persisted to disk in plaintext; it lives in process memory for the lifetime of the hub process.

**Why `info = "pdatahub-token-vault-v1"`:** salt + info prefix allows future rotation. A future `v2` can use a different `info` string without breaking `v1` decryption (and vice versa, if we ever need to).

**Why AES-256-GCM:** authenticated encryption with associated data. We don't use AES-CBC or AES-CTR; both are footguns (CBC has no authentication, CTR has no authentication; AEAD ciphers do both).

**Source:** `packages/hub-core/src/vault.ts`.

### Plugin isolation (subprocess + JSON-RPC over stdio)

Plugins are spawned as separate Node.js processes. Communication is JSON-RPC 2.0 over `stdin`/`stdout`. The plugin:

- **Never sees** the master key, other plugins' tokens, `HUB_API_TOKEN`, or other plugins' source code.
- **Receives only** its own decrypted access_token (in the call `context`), the arguments passed by the AI agent, and `agent_id` / `request_id` for audit correlation.
- **Cannot** write to `hub.db` directly. It can only return tool results over JSON-RPC.
- **Cannot** read `~/.local/share/pdatahub/` outside `--plugins-dir`. Hub's process privileges don't extend to the plugin subprocess (the plugin runs as the same OS user, but has no direct file access — only the hub does).

**Limitation (v0.x):** the plugin shares Node.js's V8 globals (`process`, `global`, etc.) inside its own process. A memory-corruption vulnerability in Node.js or a malicious Node.js native module could theoretically reach the hub process. **v4 introduces V8 isolates for memory isolation** — see [Out of scope](#out-of-scope-current-limitations).

**Source:** `packages/hub-core/src/plugin-process.ts`.

### Per-action approval

Every tool call triggers an approval request to the phone over WebSocket:

```json
{
  "type": "approval_request",
  "request_id": "uuid-v4",
  "agent_id": "opencode",
  "tool_name": "listEvents",
  "plugin": "google-calendar",
  "scope": "calendar:read",
  "justification": "User asked for today's events",
  "created_at": "2026-09-07T12:34:56Z"
}
```

The phone displays a notification. The user taps Approve or Deny. If biometric is enabled, the OS prompts for fingerprint/face before sending `approval_decided`.

Approval timeout: **60 seconds**. If the phone doesn't respond, the call returns `403 APPROVAL_DENIED`. This bounds the latency for a compromised/disabled phone.

**Source:** `packages/hub-core/src/approval-stream.ts`, `packages/android-app/app/src/main/kotlin/.../PendingApprovalsCard.kt`.

### Time-bounded grants

A successful approval creates a grant:

```sql
INSERT INTO grants (
  grant_id,    -- uuid v4
  agent_id,    -- "opencode", "claude-code", ...
  plugin,      -- "google-calendar"
  tool,        -- "listEvents"
  scope,       -- "calendar:read"
  expires_at,  -- now + 3600s
  revoked,     -- 0
  created_at   -- now
);
```

`expires_at` is checked on every access via `GrantStore.isValid(grant_id)`. Default lifetime: **1 hour**. Lazy cleanup — expired rows stay in the DB until periodic GC (Cloud v3) or manual cleanup.

The grant key is `(agent_id, plugin, tool)`. If the same agent calls the same tool within the hour, the existing grant is reused without re-approval. If a different agent calls the same tool, a new approval is required.

**Source:** `packages/hub-core/src/grant-store.ts`.

### Lazy revocation

`POST /v1/grants/:id/revoke` flips `revoked = 1`. The next call fails with `403 GRANT_REVOKED`. The user can also flip from the Android app's Active Grants list.

Latency for next-access denial: **<2 seconds** in practice. There's no need for a hub to actively poll for revocation; the next call's `isValid()` check picks it up.

**Limitation (federation v2):** when A revokes a delegation, B does not learn until B's next call returns `403 DELEGATION_REVOKED`. B's `peer_delegations.revoked` flag is **not** auto-flipped. v3 will broadcast signed revocation.

### Audit log (append-only SQLite)

Every tool call, approval, denial, plugin error, and OAuth event writes an audit row:

```sql
CREATE TABLE audit_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at      TEXT    NOT NULL,
  agent_id        TEXT,
  tool_name       TEXT,
  plugin          TEXT,
  scope           TEXT,
  decision        TEXT,    -- 'approved' / 'denied' / 'error'
  decision_federated TEXT, -- 'federated_ok' / 'federated_denied' / 'federated_error' / NULL
  delegated_by    TEXT,    -- peer's verify_key (federation only)
  delegated_to    TEXT,    -- peer's verify_key (federation only)
  user_id         TEXT,    -- always 'local-user' on the data-owning hub
  justification   TEXT,
  duration_ms     INTEGER
);
```

Append-only is enforced by triggers: any UPDATE or DELETE on `audit_log` raises a SQL error. The audit log is the **single source of truth** for "what happened."

A WebSocket broadcasts new audit rows to the Android phone (`{ type: 'audit_update', entry: ... }`). The user sees their AI agent's actions in real time.

**Limitation:** append-only is process-level. A determined attacker with hub process access can DROP the audit table or open the SQLite file with `sqlite3` and rewrite history. **Hardware-rooted attestation (TPM/HSM) is the next-level mitigation** — see [Future hardening](#future-hardening).

**Source:** `packages/hub-core/src/audit-log.ts`.

### OAuth injection via SDK

The Hub decrypts the access token from the vault right before invoking the plugin. The token is then injected via the JSON-RPC `context` field:

```ts
// packages/hub-core/src/server.ts (handleToolCall)
const tokens = this.opts.tokens.get(grant.plugin);
const result = await plugin.callTool(toolName, args, {
  agent_id, request_id,
  token: tokens.access_token,  // ← injected, plugin reads from context
});
```

The plugin SDK exposes `this.http` as a wrapper that auto-adds `Authorization: Bearer ${this.context.token}`. The plugin never sees the token as a literal string it could log or exfiltrate; it only sees authenticated requests it made through `this.http`.

**Source:** `packages/plugin-sdk/src/http-client.ts`.

### Federation inbound security (13 steps)

When Hub A receives a federated call from Hub B on `POST /v1/federation/call`:

1. **Body size limit** — reject if > 256 KB.
2. **Header parse** — extract `X-Federation-Pubkey`, `X-Federation-Signature`.
3. **Signature verification** — Ed25519 verify over canonical JSON of body.
4. **Clock skew check** — `now - request.timestamp` must be in [-300s, +300s].
5. **Nonce dedup** — reject if `(peer_verify_key, request_id)` seen in last 10 minutes.
6. **Rate limit** — `(peer_verify_key, agent_id)` allowed ≤10 pending approvals per 60s; else `429 RATE_LIMIT`.
7. **Delegation lookup** — `peer_delegations` table by `delegation_id` from body.
8. **Delegation expiry** — `now < delegation.expires_at`.
9. **Delegation revocation** — `delegation.revoked = 0`.
10. **Peer match** — `delegation.peer_verify_key == X-Federation-Pubkey`.
11. **Scope match** — request scope is allowed by delegation scope.
12. **Approval stream check** — `clients.aud.size > 0` else `503 NO_APPROVER_CONNECTED` (fast-fail; don't burn 60s timeout).
13. **Approval flow** — normal per-action approval on A's phone; A's hub executes the plugin with A's token; result returns to B.

Steps 1–2 are pure parsing. Steps 3–11 are pure validation. Step 12 is the fast-fail UX optimization. Step 13 is the actual call.

**Source:** `packages/hub-core/src/federation/call-handler.ts`, `packages/hub-core/src/federation/nonces.ts`.

### Hard-fail on missing HUB_API_TOKEN

If `HUB_API_TOKEN` is unset AND the hub binds to a non-loopback interface, the hub **refuses to start**:

```
HUB_API_TOKEN must be set when binding to a non-loopback interface.
For local development only, bind to 127.0.0.1.
```

This closes the previous dev-default behavior — "log a warning, allow unauthenticated access" — which was a footgun: any user running `pdatahub-hub --bind 0.0.0.0` without setting a token would expose `/v1/*` on their tailnet unauthenticated.

Loopback binds (127.0.0.1, ::1, localhost) preserve the dev convenience.

**Source:** `packages/hub-core/src/server.ts`.

### Proactive OAuth refresh

`TokenVault.isExpiringSoon(plugin)` is checked before each tool call. If the access token expires within 5 minutes, the vault refreshes it via the `refresh_token` and updates the stored ciphertext. The plugin never knows.

Failure modes:
- Refresh fails (e.g. user revoked at the provider) — hub logs a warning, continues with the existing token. The next upstream call returns 401, plugin surfaces the error to the AI agent.
- No refresh token — falls back to requiring re-authentication when the access token expires.

**Source:** `packages/hub-core/src/vault.ts`.

### BIP-39 encrypted backup

Hub state can be exported to an encrypted file using a 12-word BIP-39 mnemonic:

```bash
pdatahub-hub backup --output ~/.pdatahub-backup --master-key "$MASTER_KEY"
# Prints mnemonic, writes encrypted SQLite dump
```

To restore on a fresh machine:

```bash
pdatahub-hub restore --input ~/.pdatahub-backup \
  --master-key "$(echo 'word1 word2 ... word12' | mnemonic-to-hex)"
```

The mnemonic is a fallback for master key loss. Write it on paper; don't store digitally.

**Source:** `packages/hub-core/src/backup.ts`.

### Rate limiting (per-IP, per route class)

Every HTTP request burns a token from an in-memory token bucket keyed by `(client IP, route_class)`. Default 60 req/min with a 60-token burst; configurable via `HUB_RATE_LIMIT_PER_MIN` / `HUB_RATE_LIMIT_BURST` env vars. A 429 response includes a `Retry-After` header (seconds) computed from the bucket refill rate.

**Bucket dimensions** (see `routeClassFor` in `src/rate-limit.ts`): `public` (`/health`, `/v1/identity`), `tool-call`, `federation-inbound`, `federation-outbound`, `federation-mgmt`, `plugin-mgmt`, `auth-mgmt`, `audit-read`, `other`. A spammer hammering `/v1/tools/listEvents/call` cannot starve `/v1/federation/invoke`.

**Ordering in `handleRequest`:** auth → rate-limit → dispatch. Auth runs first so we don't burn buckets on rejected traffic; rate-limit runs second so we don't pay handler cost for spam; dispatch runs last. Excluded: `OPTIONS` (CORS preflight is browser-driven).

**Why in-memory only:** P0 scope. Multi-process Hub deploys (Cloud v3 Phase 1B) will need Redis-backed bucket store — deferred. A single restart resets all buckets; the 1-second gap at 60/min is not a meaningful DoS reduction.

**Memory bound:** idle buckets are evicted every 5 minutes by a `setInterval` (auto-stopped on `HubServer.stop`). ~200 bytes per bucket × 10k unique `(ip, class)` pairs ≈ 2 MB — negligible.

**Source:** `packages/hub-core/src/rate-limit.ts`.

### Error sanitization (no internal-info leakage)

Error responses from hub-core never leak server internals. Two layers:

1. **Type-driven SafeError** (`type SafeError` in `src/error-sanitize.ts`): a closed enum of known error kinds (`auth`, `authz`, `not_found`, `validation`, `conflict`, `rate_limit`, `upstream`, `identity`) with hand-written status codes, codes, and messages. Adding a new kind requires a security review — the message IS user-visible.

2. **Defense-in-depth `safeClientMessage`** (auto-applied in `sendError`): any message string reaching the wire is passed through `safeClientMessage` which:
   - Redacts `LEAK_PATTERNS`: filesystem paths, stack frames (`at Word (`), SQLite error fragments, `node_modules/...` paths, IP:port pairs, semver versions, 64-char hex blobs (master key fingerprints).
   - Strips control characters and newlines (prevents header injection / log forgery).
   - Truncates to 200 chars + `...`.

**Catch-all path** (top-level `catch` in `handleRequest`): unknown errors get `sanitizeUnknownError` which logs the full error server-side (with `request_id` for correlation) and returns opaque `{error: 'internal_error', code: 'INTERNAL_ERROR', request_id}`. The full error context is preserved in the server log for forensics — clients only see the request_id and can quote it in bug reports.

**`x-request-id` header:** every response gets an 8-char base36 request_id derived from `(timestamp XOR random)`. The same ID appears in the corresponding server log entry. Clients quote it in bug reports → ops can grep the log instantly.

**What this closes:**
- Stack traces leaking library versions (`at Object.<anonymous> (better-sqlite3@9.4.0:...)`)
- Filesystem paths leaking user info (`ENOENT /home/alice/.pdatahub/...`)
- SQLite error fragments leaking schema (`SQLITE_CONSTRAINT: UNIQUE constraint failed: tokens.plugin`)
- Internal ports leaking topology (`ECONNREFUSED 127.0.0.1:8081`)
- Master key fingerprints leaking when an error message includes a hex prefix

**What this does NOT close (deferred):**
- Timing-based side channels (e.g. `setTimeout` differences between "delegation revoked" and "delegation not found") — Momus review item.
- Volume-based attack via the in-memory bucket itself (single process OOM under heavy unique-IP load) — addressed in Cloud v3 with Redis.

**Source:** `packages/hub-core/src/error-sanitize.ts`.

## Critical threat scenarios

These are **explicit threat scenarios** that we name and analyze individually. Each has a unique ID (`T-XXX-NNN`) for tracking across docs, issues, and audits.

### T-PERSISTENT-001: Refresh token extraction after laptop compromise

**Attack scenario (full chain):**

1. Attacker gains physical or root access to user's laptop (theft, malicious insider, malware with kernel-level compromise, evil-maid attack).
2. Attacker reads `master_key` from `/proc/<pid>/cmdline` of the running `pdatahub-hub` process. **On Linux, this file is world-readable by default** — no privilege escalation required.
3. Attacker copies the encrypted vault file (e.g. `~/.local/share/pdatahub/hub.db`) via filesystem access.
4. Attacker runs offline decryption: `AES-256-GCM(key = HKDF(master_key, plugin_name, "pdatahub-token-vault-v1"), iv, ciphertext)` for each plugin.
5. Attacker extracts the `refresh_token` for Google Calendar (or any plugin the user authorized).
6. Attacker leaves the laptop, takes the refresh_token to any device anywhere.
7. Attacker mints fresh `access_token`s indefinitely via Google's token endpoint: `POST https://oauth2.googleapis.com/token` with `grant_type=refresh_token&refresh_token=...`. **No user interaction required, no Android approval triggered.**
8. Attacker reads/writes Google Calendar forever, until user manually revokes at https://myaccount.google.com/permissions.

**Why this bypasses Android approval:**

Android approval is per-**plugin call** (via `pdatahub-hub → POST /v1/plugins/google-calendar/authenticate`). Refresh token usage happens **outside** the plugin subprocess — the attacker calls Google's token endpoint directly with the stolen refresh_token, getting a fresh access_token, then calls Calendar API directly. The phone never sees a notification because no `pdatahub-hub` invocation happened.

**Impact:**

- **Full account compromise** for every plugin the user authorized (calendar, mail, contacts, etc.).
- **Persistent** — until user manually revokes at each provider.
- **Undetectable from Android** — phone UI sees no approval flow because no `pdatahub-hub` request happened.
- **Geographically unrestricted** — attacker operates from any device with internet.

**Likelihood:**

- **MEDIUM** as a capability (any moderately-skilled attacker can do this once they have laptop access).
- **LOW-MEDIUM** as an occurrence (requires laptop compromise, which itself is uncommon).
- **Severity-weighted likelihood: HIGH** because the impact is total compromise, and the prerequisites (laptop access + 5 minutes + reading 2 files) are modest.

**Why current mitigations are insufficient:**

| Mitigation | Why it doesn't help here |
|------------|--------------------------|
| AES-256-GCM vault encryption | Doesn't help — attacker also has the master_key |
| HKDF per-plugin keys | Doesn't help — derived from same master_key the attacker has |
| Per-action phone approval | Doesn't trigger — attack happens outside hub-core |
| Time-bounded grants (1h) | Doesn't help — attacker uses refresh_token, never invokes hub-core |
| Tailscale mesh | Doesn't help — attacker uses Google API directly |
| HUB_API_TOKEN bearer auth | Doesn't help — attack never hits hub-core |
| Append-only audit log | Doesn't help — attack never triggers an audit entry |
| BIP-39 backup | Doesn't help — recovery mechanism, not prevention |

**Real mitigation requirements:**

| # | Mitigation | Effect | Effort |
|---|-----------|--------|--------|
| 1 | **master_key в system keyring** (Linux Secret Service via libsecret / macOS Keychain / Windows DPAPI) instead of CLI args | `master_key` no longer readable from `/proc/<pid>/cmdline` — attacker needs additional local privilege escalation | Medium (3-5 days, all platforms) — **DONE 2026-09-09** |
| 2 | **TPM-backed key sealing** (Linux: tpm2-tss, Windows: TPM, macOS: Secure Enclave) | `master_key` cryptographically bound to hardware — can't be exfiltrated even with root | Hard (1-2 weeks, platform-specific) |
| 3 | **Refresh token rotation on every use** (Google's `prompt=consent` returns rotated refresh_token) | Each refresh invalidates old refresh_token — limits window if extracted | Easy (config flag, 1 day) |
| 4 | **Refresh token bound to client fingerprint** (RFC 8252 §8.1) | Refresh_token only works from same IP/UA fingerprint — extracted token unusable elsewhere | Medium (Google-specific, 3 days) |
| 5 | **Anomaly detection** — Google FCM push to Android on suspicious access_token use from new IP/geo | User alerted within minutes, can revoke at provider | Medium (provider-specific, 1 week) |
| 6 | **Android remote kill switch** — user can disable hub-core from phone even when laptop is offline | Reduces window of vulnerability | Medium (3-5 days) |
| 7 | **Audit log of vault decryptions** — every `getAccessToken()` call writes audit row, streamed to Android in real-time | Detects post-extraction re-use if attacker uses hub-core itself | Easy (1 day, audit infrastructure already exists) |
| 8 | **Mandatory FIDO2/WebAuthn** for master_key rotation | Forces physical key for recovery, blocks remote rotation attacks | Hard (1 week, requires hardware) |

**Minimum viable hardening for v0.3.0 (priority order):**

1. **#1 master_key в system keyring** — single biggest win. Removes the trivial `/proc/<pid>/cmdline` exfiltration. Attacker now needs root + ability to call keyring APIs. **IMPLEMENTED 2026-09-09.**
2. **#7 Audit log of every vault decryption** — detects if attacker tries to use hub-core itself with stolen key. Streams to Android live.
3. **#3 Refresh token rotation** — limits persistence window if exfiltrated.

**Until v0.3.0 lands, users MUST:**

- Use full-disk encryption (FileVault / BitLocker / LUKS) on the laptop.
- Treat physical access to the laptop as equivalent to access to all authorized plugin data.
- Regularly audit `https://myaccount.google.com/permissions` and revoke plugins that are no longer needed.
- Rotate master_key periodically (manual: backup → restore with new key → re-authorize all plugins). Not currently automated.

**Status:** Accepted residual risk in v0.x. The user explicitly accepts this trade-off when using the MVP. **Mitigation #1 (keyring) is implemented (2026-09-09)**; mitigation #2 (audit log of vault decryptions) and #3 (refresh token rotation) are scheduled for v0.3.0.

## Out of scope (current limitations)

These are **accepted residual risks** in v0.x. We are explicit about them so users can make informed decisions.

| Limitation | Today's mitigation | Lands in |
|------------|-------------------|----------|
| **V8 isolate plugin isolation** — plugins share Node.js V8 globals. A memory-corruption vulnerability could escape the subprocess sandbox. | Subprocess isolation is in place; rely on Node.js security updates; install only trusted plugins. | v4 (2027+) |
| **No key rotation (`key_epoch`)** — once master key is set, you cannot rotate without re-authenticating every plugin. | BIP-39 backup + restore on a fresh master key if compromised. | v3.1 |
| **No per-tenant encryption keys in Cloud v3** — all cloud users share one master key, with multi-VM isolation. | Physical VM isolation; master key in memory only. | Cloud v3.1 |
| **No WebAuthn / phone OTP** for hub-core admin actions (init, restore). | Master key + BIP-39 mnemonic only. | v3.5 |
| **No plugin signature verification** — plugins are trusted by URL/path. | Distribute via signed GitHub Releases; SHA256 in release notes. | v3.1 |
| **Tailscale dependency for phone approval** — if Tailscale is blocked, only USB tether works. | `adb reverse` fallback; Cloudflare Worker relay ships in stub. | relay v1 (production hardening) |
| **Federation: no signed revocation broadcast** — when A revokes, B learns on next call. | B can manually delete `peer_delegations` row. | v3 |
| **Federation: no perfect forward secrecy** — Ed25519 doesn't ratchet. | Per-call phone approval is the backstop. | v3.1 (`key_epoch`) |
| **Cloud v3: cross-tenant log mining** — operator can correlate logs across users on shared infra. | Separate VMs per tenant; audit log kept on the VM, not centralized. | Cloud v3.1 (per-tenant encryption) |
| **Local-attacker bypass of audit log** — process-level attacker can `DROP TABLE audit_log`. | Rely on host security (full-disk encryption, screen lock, no shared laptops). | v4 (TPM attestation) |
| **T-PERSISTENT-001: Refresh token extraction after laptop compromise** — `master_key` in process args (`/proc/<pid>/cmdline` world-readable) + vault on disk = offline decrypt of refresh_tokens, indefinite bypass of Android approval. | Disk encryption (out of scope); user accepts this trade-off for MVP. | **v0.3.0 — FULLY MITIGATED (#1 master_key в keyring; #2 audit log; #3 refresh rotation audit — all shipped 2026-09-09)** |

## Future hardening

| Mitigation | When | Threat addressed |
|-----------|------|------------------|
| **Hardware Security Module (HSM) for master key** | v4 | A5 (compromised laptop) loses master key access |
| **TPM-backed hub attestation** | v4 | A5 cannot tamper with audit log or token vault unnoticed |
| **master_key в system keyring** (Linux Secret Service / macOS Keychain / Windows DPAPI) | **v0.3.0 — IMPLEMENTED (2026-09-09)** | T-PERSISTENT-001 — removes trivial `/proc/<pid>/cmdline` exfiltration |
| **Refresh token rotation on every use** (`prompt=consent` flag) | **v0.3.0 — IMPLEMENTED (2026-09-09)** | T-PERSISTENT-001 — limits persistence window if extracted |
| **Audit log of every vault decryption** (streamed to Android live) | **v0.3.0 — IMPLEMENTED (2026-09-09)** | T-PERSISTENT-001 — detects post-extraction re-use via hub-core |
| **OAuth step-up auth for high-risk scopes** | v3 | A2 (malicious agent) needs extra verification for `calendar:write`, `mail:send`, etc. |
| **WebAuthn for hub-core admin actions** | v3.5 | A4 (compromised phone) cannot rotate master key without physical security key |
| **Plugin signature verification** | v3.1 | A1 (malicious plugin) cannot impersonate a legitimate one |
| **Per-tenant encryption keys (Cloud v3.1)** | Cloud v3.1 | A7 (Cloud operator) cannot read OAuth tokens |
| **`key_epoch` for key rotation** | v3.1 | Master key compromise is bounded; rotate without re-auth |
| **Signed revocation broadcast (federation)** | v3 | A6 (compromised peer hub) cannot continue using revoked delegations silently |
| **V8 isolate plugin isolation** | v4 | A1 cannot escape subprocess sandbox via V8 bug |

## Audit history

### T-PERSISTENT-001 mitigation #1 — master_key in OS keyring (2026-09-09)

Implemented per the v0.3.0 roadmap. Single biggest win for T-PERSISTENT-001 — removes the trivial `/proc/<pid>/cmdline` exfiltration vector.

- **Storage backend**: cross-platform via `@napi-rs/keyring` (Rust-based, active maintenance). Linux Secret Service / macOS Keychain / Windows DPAPI. No new native build on developer machines — prebuilds published for all major targets.
- **API**: new `src/keyring.ts` exposes `getMasterKey` / `setMasterKey` / `hasMasterKey` / `deleteMasterKey` with a swappable backend interface for testing. 24 new tests with mocked backend — no real keyring required in CI.
- **Resolution priority** (`src/config.ts`): priority 1-3 (CLI arg / env / passphrase) emit a one-shot `T-PERSISTENT-001` warning to stderr at every startup; priority 4 (system keyring) is silent; priority 5 (interactive prompt) deferred. Suppress the warning with `--ack-insecure-master-key`.
- **Migration path**: `pdatahub-hub --store-keyring <hex>` writes to the OS keyring; subsequent `pdatahub-hub` (no flags) reads it back. `pdatahub-hub keyring show|clear` subcommands for management.
- **Graceful degradation**: if `@napi-rs/keyring` fails to load (no libsecret, no daemon, sandbox without IPC), the hub logs a one-time warning and falls back to the legacy CLI/env paths. NEVER crashes on startup.
- **Cross-platform**: builds verified on Linux. macOS / Windows paths are untested in this codebase's CI (no runners) but the library is documented as cross-platform by upstream.
- **Tests**: 24 new tests in `tests/keyring.test.ts`. Full hub-core suite: 395 total, 385 pass (10 pre-existing failures in `lifecycle-rpc` and `federation-adversarial` unrelated to this change — see issue tracker).
- **Backward compat**: existing `--master-key` / `--passphrase` / `HUB_MASTER_KEY` users see the same boot sequence plus a single stderr warning. Vault format unchanged.

### T-PERSISTENT-001 mitigation #2 — audit log of every vault decryption (2026-09-09)

Closes the second attack vector for T-PERSISTENT-001 — detects post-extraction re-use via hub-core. If an attacker exfiltrates the vault and uses it via hub-core (instead of calling Google directly), every `getAccessToken` call writes a `decision='vault_access'` audit row streamed live to Android via WebSocket.

- **Schema (migration v7)**: adds `actor_type` (`'agent' | 'user' | 'system'`), `actor_id`, `request_id` columns to `audit_log`. Existing rows preserved.
- **AuditStore.recordVaultAccess** (`src/audit-log.ts`): writes non-blocking via `setImmediate`. Fire-and-forget wrapper (`safeRecordVaultAccess`) catches and logs audit failures so they never break vault decryption.
- **TokenVault.getAccessToken** (`src/token-vault.ts`): calls `safeRecordVaultAccess` on every call with `result: 'success' | 'not_found' | 'error'`. Records `actor_type`, `actor_id`, `tool_name`, `request_id` from the calling context.
- **ApprovalStream.broadcastVaultAccess** (`src/approval-stream.ts`): new WebSocket broadcast method for live Android updates. Filtered to `userAgent === 'android-hub'` clients only.
- **Fail-soft**: WebSocket broadcast errors are caught and logged, never break vault decryption.
- **Tests**: 14 new tests — `tests/vault-audit.test.ts` (10) + `tests/audit-migration.test.ts` updates (4) for v7 column round-trip. Full hub-core suite: 393 → 407 passing.

This mitigation makes **Path B** (use hub-core with stolen vault) detectable within seconds. Path A (direct Google API call with stolen refresh_token) is addressed by mitigation #3.

### T-PERSISTENT-001 mitigation #3 — refresh token rotation audit (2026-09-09)

Closes the third attack vector — limits the window of an extracted refresh_token by detecting rotations. When Google's token endpoint returns a rotated refresh_token, the old token is invalidated server-side. Any extracted copy becomes useless immediately.

- **Existing infrastructure**: OAuth flow already uses `prompt: 'consent' + access_type: 'offline'` (lines 106-110 of `src/oauth-flow.ts`), and `refreshAccessToken` already preserves rotated refresh_tokens (`json.refresh_token ?? existing.refresh_token`). This commit adds the AUDIT LOG entry.
- **AuditLog.recordTokenRotation** (`src/audit-log.ts`): sync write (rare event, want immediate incident-response visibility). New `decision: 'token_rotation'` value. `error: 'no_rotation'` if Google returned the same refresh_token.
- **TokenVault.refreshAccessToken** (`src/token-vault.ts`): calls `recordTokenRotation` after successful `store`. Safe try/catch wrap.
- **AuditDecision type** (`src/types.ts`): extended with `'token_rotation'`.
- **AuditLog.stats()**: `token_rotation: 0` added to default return literal (so `Record<AuditDecision, number>` is exhaustive).
- **Tests**: 3 new tests in `tests/audit-migration.test.ts` (rotation=true/false, stats counter). Full hub-core suite: 407 → 410 passing.

**Net T-PERSISTENT-001 status (after all 3 mitigations):**

| Mitigation | Status |
|------------|--------|
| #1 master_key в system keyring | ✅ shipped (commit `acefe65`) |
| #2 audit log of every vault decryption | ✅ shipped (commit `d92cf83`) |
| #3 refresh token rotation audit | ✅ shipped (commit `a5a8c2a`) |

Remaining residual risk: an attacker with laptop + disk access can still exfiltrate the keyring entry (Linux libsecret uses login-keyring-derived encryption; macOS Keychain and Windows DPAPI are stronger). Mitigation requires **TPM/SEV-SNP key sealing** (deferred to v4) which cryptographically binds master_key to hardware so it cannot be exfiltrated even with root.

### MIT-005 — Rate limiting (DoS protection) (2026-09-10)

Closes the "spammer burns handler cost" vector. Before this change, an unauthenticated attacker could fire thousands of `/v1/tools/:name/call` requests per second; each one triggered approval flow, DB writes, and audit log entries. Now any single `(IP, route_class)` pair is capped at 60 req/min with a 60-token burst.

- **Algorithm**: token bucket per `(IP, route_class)`. Refill is continuous (linear), capped at burst capacity (no thundering-herd). O(1) per request.
- **Bucket dimensions**: 9 route classes — `public`, `tool-call`, `federation-inbound`, `federation-outbound`, `federation-mgmt`, `plugin-mgmt`, `auth-mgmt`, `audit-read`, `other`. Coarser than per-endpoint (spam doesn't fragment across similar URLs), finer than just per-IP (heavy user of `/v1/tools` doesn't get blocked from `/v1/identity`).
- **Client identity**: socket `remoteAddress` with `X-Forwarded-For` (first hop) override. `XFF` honored because most reverse proxies preserve it; future Momus audit will consider TRUTH-CID (`Cloudflare Cf-Connecting-Ip`, etc.).
- **Middleware order**: `auth → rate-limit → dispatch`. Auth first to avoid burning buckets on rejected traffic; rate-limit second to avoid paying handler cost on spam.
- **Response shape**: HTTP 429 with `Retry-After: <seconds>` header. Body is `{error, code: 'RATE_LIMITED', request_id}`.
- **Memory bound**: idle buckets evicted every 5 minutes (`setInterval`, auto-stopped in `HubServer.stop`). ~200 bytes per bucket; 10k unique `(ip, class)` pairs ≈ 2 MB.
- **Config**: `HUB_RATE_LIMIT_PER_MIN` (default 60), `HUB_RATE_LIMIT_BURST` (default 60). Escape hatch: `0` disables rate limiting (tests/dev only — never in prod).
- **Tests**: 13 new tests in `tests/rate-limit.test.ts`. Cover burst-then-429, refill timing, per-key isolation, eviction, invalid config, XFF handling, route classification. Full hub-core suite: 432 → 462 passing (+30 new).
- **Known limits**: in-memory only (single process). Multi-process Hub (Cloud v3 Phase 1B) will need Redis-backed bucket store — deferred.

### MIT-006 — Error sanitization (info disclosure protection) (2026-09-10)

Closes the "error message leaks internals" vector. Before this change, line 478 of `server.ts` returned `\`internal error: ${err.message}\`` to clients — leaking SQLite error strings, stack frames, filesystem paths, and plugin source paths. Now every error response is opaque to clients, with the full error preserved server-side for forensics.

- **Two-layer defense**: (1) type-driven `SafeError` enum for known-error paths; (2) `safeClientMessage` auto-applied in `sendError` as defense in depth.
- **Redaction patterns** (`LEAK_PATTERNS` in `src/error-sanitize.ts`): filesystem paths (`/foo/bar`), stack frames (`at Word (`), SQLite error fragments (`SQLITE_*`), `node_modules/...` paths, IP:port pairs, semver versions (`@X.Y.Z`), 64-char hex blobs (master key fingerprints).
- **Catch-all path** (`sanitizeUnknownError`): unknown errors log full `err.message` + `err.stack` server-side keyed by `request_id`; client sees only `{error: 'internal_error', code: 'INTERNAL_ERROR', request_id}`.
- **`x-request-id` correlation header**: 8-char base36 derived from `(timestamp XOR random)`. Same ID appears in server log + client response. Clients quote it in bug reports → ops can grep the log instantly.
- **Order matters**: regex redaction must run `node_modules_path` BEFORE `filesystem_path`, otherwise the leading `/better-sqlite3/...` gets redacted and the `node_modules` context is lost. This is documented in the regex definition.
- **Threshold matters**: master_key fingerprint detector requires EXACTLY 64 hex chars (full 32-byte hex). Shorter hashes or all-letter strings don't trigger — avoids false positives on user-input strings like `'a'.repeat(500)`.
- **Tests**: 17 new tests in `tests/error-sanitize.test.ts`. Cover filesystem path redaction, IP:port redaction, SQL fragment redaction, node_modules + semver, master key hex, control char stripping, truncation, opaque catch-all, request_id entropy, server-side log forensics. Full hub-core suite: 462 → 462 passing (+17 new).

**Combined rate-limit + error-sanitize shipping notes:**
- 0 existing tests broke (432 → 462 → 462 across the two PRs; +30 new tests).
- 1 pre-existing flake in `oauth-flow.test.ts` (timing-sensitive 100ms assertion); passes in isolation, unrelated to this PR.
- Hub-core CI green; ready for hub-core v0.4.0 release + `sdk-v0.2.3` (no SDK changes needed for this PR — pure server-side hardening).

### Federation v2 design — Momus round 1 (2026-09-07)

7 blockers, 5 spec contradictions, 10 important findings. **All addressed.** Highlights:

- **B1 (blocker):** Federation needs different auth per route (`none` for `/v1/identity`, `bearer` for local, `ed25519` for federation). Single Bearer check is wrong. → Added `RouteAuth` table.
- **B2 (blocker):** Hub starting on non-loopback without `HUB_API_TOKEN` is a footgun. → Hard-fail added.
- **B4 (blocker):** `user_id` semantics were ambiguous between local and federated. → Decided to keep `'local-user'` as "this hub's data" forever; federation context carried by `delegated_by`/`delegated_to`.
- **B5 (blocker):** No schema migration framework. → Added versioned migration runner.
- **C1 (spec contradiction):** `delegated_by` missing from `ensureGrant` match key. → Migration v4 adds column; match key updated.
- **C2 (spec contradiction):** `user_id` rename would break every existing install. → Decision to keep `'local-user'`.
- **C3 (spec contradiction):** Single `decision` field couldn't represent local approval vs federation result. → Added `decision_federated` field.

Full findings: `.omo/plans/federation-v2-design.md` (in-file annotations).

### Federation v2 design — Momus round 2 (2026-09-08)

4 final doc fixes — **all applied**. Cross-references in the federation user guide were updated to match the canonical naming.

### Cloud v3 design — Momus round 1 (2026-09-08)

**OKAY.** References verified; Phase 1A design verified done. No blockers.

### Future audits

- **External audit** planned before v1.0.0. We will commission a third-party review of hub-core, plugin-sdk, and federation protocol.
- **Bug bounty** planned at v1.0.0. See [SECURITY.md §Hall of fame](../SECURITY.md#hall-of-fame).

## Decision record

For the reasoning behind specific design choices (why Ed25519, why HKDF, why per-plugin keys, why 1h grants, why 60s approval timeout, why no V8 isolates yet), see the relevant sections of:

- [docs/architecture.md §Security model](./architecture.md#security-model) — token vault, plugin isolation, approval flow
- [docs/architecture.md §Federation v2](./architecture.md#federation-v2) — federation protocol design
- [docs/federation.md](./federation.md) — user-facing federation guide with threat-model TL;DR
- [.omo/plans/federation-v2-design.md](../.omo/plans/federation-v2-design.md) — RFC-level design with Momus annotations
- [.omo/plans/cloud-v3-design.md](../.omo/plans/cloud-v3-design.md) — Cloud v3 design

---

If you're a security researcher and you find something we haven't, see [SECURITY.md](../SECURITY.md) for the disclosure process.