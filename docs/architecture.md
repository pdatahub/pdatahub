# pdatahub Architecture

Detailed architecture reference for the pdatahub personal data hub MVP.

## End-to-end flow (verified 2026-09-07)

A single AI agent request that touches real Google Calendar data takes 4.6 seconds end-to-end:

```
AI agent (Claude / OpenCode)
  │
  │ 1. mcp__call_tool("google-calendar", "listEvents", {from, to})
  │    over stdio MCP protocol
  │
  ▼
pdatahub-mcp (laptop, packages/mcp-server/dist)
  │
  │ 2. HTTP POST /v1/plugins/google-calendar/call
  │    Authorization: Bearer <HUB_API_TOKEN>
  │    Body: { tool: "listEvents", arguments: {...} }
  │
  ▼
pdatahub-hub-core (laptop, packages/hub-core/dist)
  │
  │ 3. Look up active grant for (agent, tool)
  │    → not found → need approval
  │
  │ 4. WebSocket /approval-stream → phone
  │    {
  │      "type": "approval_request",
  │      "request_id": "ea1b910c-...",
  │      "agent_id": "opencode",
  │      "tool_name": "listEvents",
  │      "scope": "calendar:read",
  │      "justification": "User asked for today's events"
  │    }
  │
  ▼
Android Hub UI (cma-lx1)
  │
  │ 5. Show notification + PendingApprovalsCard row
  │    User taps [Approve]
  │    Optional: BiometricPrompt.prompt() (biometric_enabled=true)
  │
  │ 6. WebSocket → hub-core
  │    {
  │      "type": "approval_decided",
  │      "request_id": "ea1b910c-...",
  │      "decision": "approved"
  │    }
  │
  ▼
pdatahub-hub-core
  │
  │ 7. Resolve pending approval → grant created
  │    INSERT INTO grants (grant_id, agent, plugin, tool, scope, expires_at)
  │    expires_at = now + 3600s
  │
  │ 8. Proactive OAuth refresh if needed
  │    if (TokenVault.isExpiringSoon("google-calendar")) {
  │      await TokenVault.refreshAccessToken(plugin, client_id, client_secret, token_url)
  │    }
  │
  │ 9. Spawn (or reuse) plugin subprocess
  │    node plugin-google-calendar/dist/index.js
  │    stdin/stdout = JSON-RPC
  │
  ▼
google-calendar plugin (subprocess)
  │
  │ 10. Receive callTool request via JSON-RPC
  │     {
  │       "method": "callTool",
  │       "params": {
  │         "tool": "listEvents",
  │         "arguments": {from, to},
  │         "context": {
  │           "agent_id": "opencode",
  │           "request_id": "ea1b910c-...",
  │           "token": "<decrypted_access_token>"  ← injected by hub
  │         }
  │       }
  │     }
  │
  │ 11. Plugin SDK's `this.http` adds Authorization header
  │     GET https://www.googleapis.com/calendar/v3/calendars/primary/events
  │
  ▼
Google Calendar API
  │
  │ 12. JSON response → plugin → hub-core
  │
  ▼
pdatahub-hub-core
  │
  │ 13. Audit log append
  │     INSERT INTO audit_log (agent, tool, decision, granted_at)
  │
  │ 14. WebSocket broadcast audit_update → phone
  │
  │ 15. HTTP 200 to MCP client
  │     { result: { events: [...] } }
  │
  ▼
pdatahub-mcp → AI agent
```

## Security model

### Token vault

OAuth tokens stored encrypted at rest. Per-plugin encryption key derived from master key via HKDF:

```
master_key (32 bytes, from --master-key CLI flag)
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

**Why per-plugin key**: if one plugin is compromised, attacker cannot decrypt another plugin's tokens. Master key never leaves hub process memory.

**Why "pdatahub-token-vault-v1"**: salt+info prefix allows future rotation (v2 can use different info without breaking v1).

### Plugin isolation

Plugins are spawned as separate Node.js processes. Communication is JSON-RPC over stdio. The plugin **never sees**:

- The master key
- Tokens of other plugins
- The HUB_API_TOKEN
- Other plugins' source code

The plugin **receives only**:
- Its own decrypted access_token (in the call context)
- The arguments passed by the AI agent
- The agent_id and request_id (for audit correlation)

### Approval flow invariants

1. **No grant, no call** — every tool call checks `GrantStore.isValid(grant_id)` first
2. **Grant is per-tool-per-agent** — `listEvents` for `opencode` ≠ `listEvents` for `cursor`
3. **Grant expires after 1h** — `expires_at = now + 3600_000`, lazy cleanup via `isValid()` on next access
4. **Approval times out after 60s** — `setTimeout(reject, 60_000)` in `ApprovalStream.requestApproval()`
5. **Token rotation is silent** — proactive refresh happens before plugin call, no UI interruption

## Plugin lifecycle

### Spawn (hub-core/src/plugin-process.ts)

```ts
async spawnPlugin(entry: string): Promise<PluginProcess> {
  const realEntry = realpathSync(entry);  // resolves symlinks
  const child = spawn('node', [realEntry], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PDATAHUB_PLUGIN_MODE: '1' },
  });

  const rpc = new JsonRpc(child.stdin, child.stdout);

  rpc.onRequest('initialize', async (params) => {
    return { name: 'google-calendar', version: '0.1.0', tools: [...] };
  });

  return new PluginProcess(child, rpc);
}
```

**Symlink handling** (commit 95ec01c): Node.js resolves symlinks for `import.meta.url` but keeps literal paths for `process.argv[1]`. Without `realpathSync()`, plugins imported via symlink would have mismatched identity checks. The fix normalizes both to the same resolved path.

### Tool invocation

```ts
async callTool(toolName: string, args: object, ctx: CallContext): Promise<ToolResult> {
  return this.rpc.request('callTool', {
    tool: toolName,
    arguments: args,
    context: ctx,  // includes decrypted token
  });
}
```

### OAuth injection

Hub decrypts the token from vault right before invocation:

```ts
// server.ts:296-313
if (this.opts.tokens.isExpiringSoon(grant.plugin)) {
  await this.opts.tokens.refreshAccessToken(...);
}
const tokens = this.opts.tokens.get(grant.plugin);

const result = await plugin.callTool(toolName, args, {
  agent_id, request_id,
  token: tokens.access_token,  // ← injected, plugin reads from context
});
```

The plugin SDK exposes `this.http` as a fetch wrapper that auto-adds `Authorization: Bearer ${this.context.token}`.

## Backup & restore (BIP-39)

Hub state can be exported to an encrypted file using a BIP-39 mnemonic:

```bash
# Export
node packages/hub-core/dist/index.js \
  --export-backup ~/.pdatahub-backup \
  --master-key "$MASTER_KEY"

# Produces: ~/.pdatahub-backup
#   - 12-word BIP-39 mnemonic
#   - SQLite dump of grants + audit + tokens (encrypted with key from mnemonic)

# Restore on another machine
node packages/hub-core/dist/index.js \
  --restore-backup ~/.pdatahub-backup \
  --master-key "$(echo 'word1 word2 ... word12' | mnemonic-to-hex)"
```

See `packages/hub-core/src/backup.ts` for implementation details.

## Plugin SDK distribution

Plugins are distributed via **GitHub Releases** (npmjs.com is closed to this project permanently):

```bash
# Plugin author publishes:
git tag v0.2.0
git push --tags
# → GitHub Actions builds, uploads plugin.tgz to release

# User installs:
curl -L https://github.com/pdatahub/pdatahub-plugin-X/releases/latest/download/X.tgz \
  | tar -xz -C ~/.local/share/pdatahub/plugins/X
```

Hub watches `--plugins-dir` for new folders on startup.

## Failure modes & recovery

| Failure | Recovery |
|---------|----------|
| Phone disconnects mid-approval | Hub times out after 60s, MCP call returns 403 APPROVAL_DENIED |
| OAuth refresh fails | Hub logs warning, continues with existing token (may 401 on next Google call) |
| Plugin subprocess crashes | Hub restarts on next call, audit log records error |
| Hub-core restart | Grants expire-checked lazily, audit log persistent, vault re-reads from disk |
| Tailscale offline | Phone can't reach hub (fallback: adb reverse over USB, or direct LAN IP) |
| Token vault corruption | BIP-39 backup restore from `~/.pdatahub-backup` |

## Federation v2

Federation v2 lets two hubs share a single plugin tool without sharing OAuth tokens. This section covers the architecture; the user-facing walkthrough lives in [docs/federation.md](./federation.md). The full threat model and design rationale are in [`.omo/plans/federation-v2-design.md`](https://example.invalid/.omo/plans/federation-v2-design.md) (Momus-reviewed).

### Two-hub delegation flow

```
                  userA's hub                            userB's hub
                  (data owner)                           (originator)
                  ────────────                           ─────────────
[1] `pdatahub-hub delegate`                            [4] `pdatahub-hub accept-delegation`
    generates Ed25519 blob ─── out-of-band ───> verifies A's signature
    INSERT INTO delegations                          INSERT INTO peer_delegations

[5] B's MCP calls                                    [5] B's MCP calls
    federated__userA__listEvents                     federated__userA__listEvents
            │                                                │
            │                                                ▼
            │                                  POST /v1/federation/invoke
            │                                  looks up peer_delegations
            │                                  signs body with B's key
            │                                                │
            │                                                ▼
            │   ◀──── HTTP /v1/federation/call ──── POST over WireGuard
            │          X-Federation-Pubkey
            │          X-Federation-Signature
            ▼
[6] verify sig + clock skew + nonce dedup
    look up delegation by id
    fast-fail if /approval-stream empty
            │
            ▼
[7] WebSocket /approval-stream → A's phone
    A taps Approve (biometric)
            │
            ▼
[8] invoke plugin with A's decrypted token
            │
            ▼
[9] HTTP 200 → B's hub ──→ MCP ──→ AI agent
```

The HTTP path uses the existing tailnet/WireGuard transport from [docs/relay-mode.md](./relay-mode.md). No new networking layer is introduced.

### Key model

Each hub owns one Ed25519 keypair, generated at `pdatahub-hub init`:

```
master_key (32 bytes, user-supplied via --master-key)
  │
  │ HKDF-SHA256(salt="pdatahub-federation-v1", info="signing-key", L=32)
  │
  ▼
wrapping_key (32 bytes, AES-256) ─── encrypts ───▶ signing_key (32 bytes)
                                                       │
                                            ed25519_getPublicKey
                                                       │
                                                       ▼
                                              verify_key (32 bytes)
                                                       │
                                                       ▼
                                     "ed25519:" + base64url(verify_key)
```

`signing_key` is held in memory only after `HubIdentity.load(db, master_key)` and re-encrypted on disk after every operation that updates it. `verify_key` is published by `GET /v1/identity` (auth: `none`) but the **trust anchor for delegation is the verify_key embedded in the signed blob**, not this endpoint — a hub can lie about `/v1/identity` but cannot forge A's signature.

See `packages/hub-core/src/federation/identity.ts` for the full implementation.

### Per-route auth strategy

Federation needs different auth per route. The strategy is declared declaratively:

```ts
// packages/hub-core/src/server.ts
export const routeAuth: RouteAuth[] = [
  { method: 'GET',  path: '/health',                 auth: 'none' },
  { method: 'GET',  path: '/v1/identity',            auth: 'none' },
  { method: 'GET',  path: '/v1/tools',               auth: 'bearer' },
  { method: 'POST', path: '/v1/tools/:name/call',    auth: 'bearer' },
  { method: 'POST', path: '/v1/federation/invoke',   auth: 'bearer' },
  { method: 'POST', path: '/v1/federation/call',     auth: 'ed25519' },
];
```

- `none` — public (identity, health).
- `bearer` — `HUB_API_TOKEN` Bearer check (existing local flow).
- `ed25519` — `X-Federation-Pubkey` + `X-Federation-Signature` verification over the raw request body. Implemented in `handleFederationCall` (Phase 3).

The default for any unlisted route is `bearer` (fail-closed).

### Hard-fail on missing HUB_API_TOKEN

If the hub binds to a non-loopback interface (anything reachable from the tailnet) without `HUB_API_TOKEN`, it **refuses to start**:

```
HUB_API_TOKEN must be set when binding to a non-loopback interface.
For local development only, bind to 127.0.0.1.
```

This prevents the previous dev-default behavior — "log a warning, allow unauthenticated access" — from silently leaking `/v1/*` on a tailnet. Loopback binds (127.0.0.1, ::1, localhost) preserve the dev convenience.

### Cross-hub audit log semantics

Every audit row gains three new columns in migration v4 (Phase 2b):

| Column | Local call | A receiving federated | B originating federated |
|--------|-----------|----------------------|------------------------|
| `user_id` | `'local-user'` | `'local-user'` (A owns the data) | `'local-user'` |
| `delegated_by` | `NULL` | `B_verify_key` | `NULL` |
| `delegated_to` | `NULL` | `NULL` | `A_verify_key` |
| `decision` | `'approved'` / `'denied'` / `'error'` | `'approved'` / `'denied'` / `'error'` | `'approved'` (synonym for federated_ok) |
| `decision_federated` | `NULL` | `NULL` | `'federated_ok'` / `'federated_denied'` / `'federated_error'` |

The split keeps `decision` semantically stable on each hub — it always means "this hub made the approval decision". `decision_federated` is the bridge between "approved by A" and "the result came back from A" on B's side.

The `user_id` semantics are intentionally **NOT** renamed — `'local-user'` continues to mean "this hub's data" regardless of whether the call originated locally or via federation. Federation context is always carried by `delegated_by` / `delegated_to`. Queries like *"what did userB's hub do?"* filter by `delegated_by`, not `user_id`.

### Federation vs local call distinction

A federated tool appears in `GET /v1/tools` with `federated: true` and a synthetic name `federated__<peer_hub>__<tool>` (double underscore to satisfy MCP's `^[a-zA-Z0-9_-]{1,64}$` constraint):

```json
{
  "name": "federated__userA__listEvents",
  "description": "Federated call to listEvents on userA's google-calendar hub (expires 2026-09-09T07:36:38Z)",
  "inputSchema": { "type": "object", "properties": { "from": { "type": "string" } } },
  "scope": "calendar:read",
  "plugin": "google-calendar",
  "federated": true,
  "delegation_id": "7f3e2b1a-9c4d-4a72-b8e1-2a5d8f9c0b3e",
  "peer_hub_name": "userA",
  "peer_hub_url": "http://<peer-host>:8080/",
  "expires_at": "2026-09-09T07:36:38Z"
}
```

mcp-server checks `federated: true` and routes the call to `POST /v1/federation/invoke` on B's hub-core instead of `POST /v1/tools/:name/call`. The descriptor is regenerated on every `GET /v1/tools` call by walking the `peer_delegations` table and skipping revoked/expired rows.

The `ToolDescriptor` type (in `packages/hub-core/src/types.ts`) carries the optional fields `federated`, `delegation_id`, `peer_hub_name`, `peer_hub_url`, and `expires_at`. Local tool descriptors simply omit them — same shape, additive only. mcp-server's type narrowing uses `federated === true` as the discriminator.

### Federation-specific failure modes

Extends the table above:

| Failure | Recovery |
|---------|----------|
| A's phone offline | Fast 503 NO_APPROVER_CONNECTED (clients.size === 0 on `/approval-stream`); B sees immediate failure instead of 120s wait |
| A's hub unreachable | B's `/v1/federation/invoke` returns 502 FEDERATION_UPSTREAM_ERROR; B writes `decision_federated = 'federated_error'` |
| A revokes mid-session | B's next call returns 403 DELEGATION_REVOKED; B's `peer_delegations.revoked` row is **not** auto-flipped (manual cleanup; v3 broadcasts revocation) |
| Clock skew > 5 min | B's call returns 401 CLOCK_SKEW on A; sync clocks via NTP/chrony |
| Replayed `request_id` within 10 min | A returns 409 REPLAY; `federation_nonces` table deduplicates |
| Spammed approvals (>10 / 60s per (peer, agent)) | A returns 429 RATE_LIMIT before burning approval budget |
| Compromised B's signing_key | Old delegation calls fail signature verification on A; B must re-accept delegation (rotate) |
| A rotates signing_key | All existing delegations are invalidated; A must re-issue; B must re-accept |
| `audit_log` growth | Manual: `pdatahub-hub audit purge --older-than 365d [--yes]` — see [docs/federation.md §Audit retention](./federation.md#audit-retention-phase-7b) |

### Federation-specific invariants

1. **No raw token crosses the hub boundary.** A decrypts its OAuth token from its own vault; B never sees it. The plugin subprocess on A's side receives the token via the SDK's `context.token` injection.
2. **Per-call approval by default.** A's phone approves every federated call; no auto-grant for trusted peers (v3).
3. **One tool per delegation.** Each delegation has a single `(plugin, tool, scope)` triple. Bulk "share my whole hub" is explicitly v3+.
4. **`delegations` and `peer_delegations` are mirrors, not views.** They share the `delegation_id` but live on different hubs. A revoking does not auto-update B.
5. **`delegated_by` is in the `ensureGrant` match key.** Without it (Phase 2b before Momus C1), a local grant could satisfy a federated call, bypassing the approval flow entirely. Migration v4 fixes this by adding the column and updating `GrantStore.findActive`.
6. **Audit retention is the user's responsibility.** No background task. `pdatahub-hub audit purge --older-than Nd --yes` is the only mechanism.

