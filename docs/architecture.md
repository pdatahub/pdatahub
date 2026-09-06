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
