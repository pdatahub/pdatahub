# Federation v2 — Design Document

**Status:** Design v2. Momus review complete, all 7 blockers + 5 spec contradictions + 10 important findings addressed. Awaiting second Momus pass.
**Scope:** MVP — single-tool delegation between two trusted hubs.
**Date:** 2026-09-07
**Effort estimate (post-Momus):** 13-14 working days (revised up from 8 — new Phase 0.5 + Phase 2 split + Phase 3 expansion)

## Motivation

Today, pdatahub is single-user: one hub = one user = one device trust domain (their phone). Federation v2 extends this so that **User A can grant User B's hub access to a single plugin tool on User A's hub**, with User A's phone retaining approval authority.

Use case: User A has Google Calendar plugin; User B wants their AI agent to read A's calendar for scheduling context. A delegates `listEvents` (read-only) to B's hub. B's AI invokes it; A's phone approves; result flows back to B.

## Architectural decisions (locked, v1)

| # | Decision | Rationale |
|---|---|---|
| 1 | **One tool + explicit grant per delegation** | Minimum viable trust surface. Bulk "share my whole hub" is v3+. Each delegation has a single (plugin, tool, scope) tuple and explicit expiry. |
| 2 | **Persistent Ed25519 hub identity** | Ed25519 keys generated at `pdatahub-hub init`, signing key encrypted under master key. Used to sign delegations and federated call requests. **Two distinct keypairs exist in pdatahub**: (a) **hub federation key** — new, lives on hub, stored in `federation_keys` table, used for delegation signing and federated call verification; (b) **phone device identity** — existing (`IdentityManager.kt`), lives on Android phone only, used for QR pairing and "audit log signing" (planned v3). They are NOT the same key. Hub identity does not derive from phone identity. |
| 3 | **Direct WireGuard (MagicDNS)** | No relay changes. A's hub reachable at `userA.tailXXXXXX.ts.net:8080` over WireGuard — already verified working (commits 4f2d879, a452e15). Relay refactor is deferred to v3. |
| 4 | **Proxy pattern (no token exposure)** | B never sees A's decrypted OAuth token. B's hub makes HTTP call to A's hub; A's hub decrypts token from its own vault, invokes plugin, returns result. Cross-boundary plaintext tokens never exist. |
| 5 | **A's phone approves** | Default. The data owner (A) retains authority. Optional auto-grant for trusted peers is a v3 feature. |

## Out of scope (v3+)

- Bulk / blanket delegations
- Auto-grant for trusted peers
- Plugin-to-plugin delegation (B's plugin calling A's plugin directly)
- Hub-to-hub audit reconciliation (cross-hub signed audit feeds)
- Federation via Cloudflare Worker relay (replaces WireGuard)
- Multi-hop delegation (B delegates what A delegated to them)
- Hub-side rate limiting beyond per-delegation approval spam guard
- Per-user scope refinement (e.g., calendar listEvents but only certain calendars)
- Federation of approval flows themselves (B's phone approves on behalf of A) — explicitly NOT supported, prevents confused deputy
- Federated tools appear with colons in MCP name (use `federated__<hub>__<tool>` format to avoid MCP naming restrictions — `^[a-zA-Z0-9_-]{1,64}$`)
- Sign-in key rotation with `key_epoch` (v3 — current design assumes signing_key is rotated by user revoking + re-granting)

## Identity model

### Hub keypair

Every hub generates an Ed25519 keypair at `pdatahub-hub init`:

| Field | Value |
|---|---|
| `verify_key` (public) | 32 bytes, base64url encoded, prefixed `ed25519:` |
| `signing_key` (private) | 32 bytes, encrypted under master key |

Encryption: `HKDF-SHA256(master_key, salt="pdatahub-federation-v1", info="signing-key", L=32)` → wrapping key → AES-256-GCM. Stored as `federation_keys` table row:

```sql
CREATE TABLE IF NOT EXISTS federation_keys (
  id INTEGER PRIMARY KEY CHECK (id = 1),  -- single row
  verify_key TEXT NOT NULL,                -- "ed25519:abc..."
  signing_key_enc BLOB NOT NULL,
  signing_key_iv  BLOB NOT NULL,
  signing_key_tag BLOB NOT NULL,
  hub_name TEXT NOT NULL,                  -- "userA"
  magic_dns TEXT,                          -- "userA.tailXXXXXX.ts.net" (auto-detected if Tailscale)
  fingerprint TEXT NOT NULL,               -- 8-byte hex (first 8 bytes of verify_key, spaced pairs) for human comparison
  created_at TEXT NOT NULL
);
```

**Why a separate key for federation**: orthogonal to BIP-39 mnemonic. Loss of mnemonic doesn't compromise federation identity. Federation key can be re-issued without rotating the vault.

**Why a fingerprint**: humans compare fingerprints, not 43-char base64. CLI shows fingerprint alongside full key during delegation import.

### Hub identity endpoint

```
GET /v1/identity
  → 200 { verify_key, hub_name, magic_dns, fingerprint }
```

Per-route auth: **none** (public information). Used by other hubs for cross-checking identity but is NOT the trust anchor (the trust anchor is the verify_key inside the signed delegation blob — see Important finding I10).

## Delegation model

### Delegation lifecycle

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

### Data model

Two mirrored tables — one for delegations A has granted (so A can revoke them), one for delegations B has received (so B can invoke them).

**`delegations` table** (on A's hub — "I granted this"):

```sql
CREATE TABLE IF NOT EXISTS delegations (
  delegation_id TEXT PRIMARY KEY,          -- randomUUID()
  peer_verify_key TEXT NOT NULL,            -- "ed25519:B_public..."
  peer_hub_name TEXT,                       -- denormalized from blob for display
  plugin TEXT NOT NULL,                     -- "google-calendar"
  tool TEXT NOT NULL,                       -- "listEvents"
  scope TEXT NOT NULL,                      -- "calendar:read" (must match plugin manifest's declared scope for tool)
  expires_at TEXT NOT NULL,                 -- ISO8601 UTC
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  signature BLOB NOT NULL                   -- ed25519_sign(signing_key, canonical JSON of all other fields)
);

CREATE INDEX idx_delegations_peer ON delegations(peer_verify_key);
CREATE INDEX idx_delegations_expires ON delegations(expires_at);
```

**`peer_delegations` table** (on B's hub — "I can invoke via this"):

```sql
CREATE TABLE IF NOT EXISTS peer_delegations (
  delegation_id TEXT PRIMARY KEY,
  peer_verify_key TEXT NOT NULL,            -- A's verify_key (trust anchor)
  peer_hub_name TEXT NOT NULL,
  peer_hub_url TEXT NOT NULL,               -- "http://userA.tailXXXXXX.ts.net:8080" (resolved from magic_dns in blob at import time)
  plugin TEXT NOT NULL,
  tool TEXT NOT NULL,
  scope TEXT NOT NULL,
  input_schema TEXT,                        -- JSON Schema for the tool (signed by A, embedded in blob)
  expires_at TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  signature BLOB NOT NULL                   -- A's signature (verified against peer_verify_key on import)
);

-- (Momus C4: removed peer_signature_checked column — always 1 after successful import)
```

### Delegation blob format (out-of-band)

When A grants, hub produces a base64url-encoded JSON blob:

```json
{
  "version": 1,
  "delegation_id": "uuid-v4",
  "issuer": {
    "hub_name": "userA",
    "verify_key": "ed25519:abc...",
    "fingerprint": "AB CD EF 01 23 45 67 89",
    "magic_dns": "userA.example.ts.net:8080"
  },
  "subject": {
    "verify_key": "ed25519:B_public...",
    "fingerprint": "..."
  },
  "delegation": {
    "plugin": "google-calendar",
    "tool": "listEvents",
    "scope": "calendar:read",
    "input_schema": { /* JSON Schema for tool */ },
    "expires_at": "2026-09-08T12:00:00Z"
  },
  "signature": "<base64 ed25519 signature over canonical JSON of above (excluding signature field)>"
}
```

**Why `issuer.magic_dns` is in the blob** (Momus I9): B needs to construct the FQDN to import the delegation. The "avoids baked-in URLs" rationale is replaced by "blob is short-lived; re-issue if hostname changes".

**Why `input_schema` is in the blob** (Momus B7): B's MCP needs to expose federated tools in `GET /v1/tools`. Without the schema, B can't describe the tool to the AI. The schema is signed by A as part of the delegation.

**Why fingerprint** (Momus I10): `accept-delegation` prints fingerprint for human confirmation before storing. Defense against swapped blob on out-of-band channel.

## Schema migrations

### Why a migration framework is needed (Momus B5)

Today, every table is created with `CREATE TABLE IF NOT EXISTS` in a constructor (`audit-log.ts:43`, `grant-store.ts:16`, `token-vault.ts:55`). There is no migration runner. Adding columns (e.g. `delegated_by` to `audit_log`) fails silently on existing installs because `CREATE TABLE IF NOT EXISTS` does not alter tables.

**Phase 0.5 introduces a versioned migration runner**:

```ts
// packages/hub-core/src/migrations.ts
import type { Database } from 'better-sqlite3';

interface Migration {
  version: number;
  up: (db: Database) => void;
}

const migrations: Migration[] = [
  { version: 1, up: (db) => { db.exec(tokenVaultSchema); db.exec(grantStoreSchema); db.exec(auditLogSchema); } },
  { version: 2, up: (db) => { db.exec('ALTER TABLE audit_log ADD COLUMN delegated_by TEXT'); db.exec('ALTER TABLE audit_log ADD COLUMN delegated_to TEXT'); db.exec('ALTER TABLE grants ADD COLUMN delegated_by TEXT'); } },
  { version: 3, up: (db) => { db.exec(federationKeysSchema); db.exec(delegationsSchema); db.exec(peerDelegationsSchema); db.exec('ALTER TABLE audit_log ADD COLUMN decision_federated TEXT'); } },
  { version: 4, up: (db) => { db.exec('CREATE TABLE federation_nonces (...);'); } },
];

export function runMigrations(db: Database): void {
  db.pragma('user_version = 0');
  // ... apply each migration in order if user_version < migration.version
  // ... after each: db.pragma(`user_version = ${migration.version}`);
}
```

Each migration is idempotent (checks `user_version`). New schema changes always introduce a new migration, never modify an old one.

### `user_id` semantics (Momus B4 + C2)

**Decision: keep `'local-user'` as the local identity forever.**

Rationale: `user_id` is currently the only data-owner identifier in audit_log and grants. Changing it requires a one-time UPDATE on every existing install, and every old grant would lose its match key (`listActiveForUser` filter). The simpler zero-migration path:

- Local calls: `user_id = 'local-user'` (unchanged)
- Federated calls where A receives from B: `user_id = 'local-user'` (A is the data owner; "local-user" means "this hub's data")
- Federated calls where B proxies to A: `user_id = 'local-user'` (B's local user, regardless of which hub is being called)

**The `delegated_by` and `delegated_to` columns carry the federation context**, not `user_id`. Any audit query about "what did B's hub do" filters by `delegated_to`, not `user_id`.

Touch sites to update:
- `server.ts:62` — keep `defaultUserId = 'local-user'` (rename to `hub_name = 'local-user'` for clarity, but value unchanged)
- `server.ts:275, 280, 327, 345, 428` — unchanged
- `HomeViewModel.kt:92` — unchanged
- **New**: when federated call is invoked, also write `delegated_by = B_verify_key` to both A's `audit_log` and B's `audit_log`

### Schema additions (full list)

- `federation_keys` (single row, id=1)
- `delegations` (granted)
- `peer_delegations` (received)
- `federation_nonces` (request_id dedup, ~10-min sweep)

### Schema modifications

- `audit_log`: add `delegated_by TEXT`, `delegated_to TEXT`, `decision_federated TEXT` (e.g. `federated_ok`, `federated_denied` — see Momus C3)
- `grants`: add `delegated_by TEXT` and use it in `ensureGrant` match key (see Momus C1)

## Per-route auth strategy (Momus B1)

Today, `checkAuth` (server.ts:235-247) gates every request with `HUB_API_TOKEN` Bearer. Federation needs different auth per route.

```ts
type AuthStrategy = 'none' | 'bearer' | 'ed25519';

interface RouteAuth {
  method: string;
  path: string;             // e.g. "/v1/identity", "/v1/federation/call"
  auth: AuthStrategy;
}

const routeAuth: RouteAuth[] = [
  { method: 'GET',  path: '/v1/identity',                  auth: 'none' },
  { method: 'GET',  path: '/health',                       auth: 'none' },
  { method: 'GET',  path: '/v1/tools',                     auth: 'bearer' },
  { method: 'POST', path: '/v1/tools/:name/call',          auth: 'bearer' },
  { method: 'POST', path: '/v1/federation/delegate',       auth: 'bearer' },
  { method: 'GET',  path: '/v1/federation/delegations',    auth: 'bearer' },
  { method: 'POST', path: '/v1/federation/delegations/:id/revoke', auth: 'bearer' },
  { method: 'POST', path: '/v1/federation/invoke',         auth: 'ed25519' },
  // /v1/federation/call is INSIDE A's hub, invoked by B's hub
  // B-side endpoint is /v1/federation/invoke on B's hub, which then calls A
];
```

`handleRequest` checks the route table and dispatches to the right validator:
- `none` — no auth
- `bearer` — existing `HUB_API_TOKEN` check
- `ed25519` — verify `X-Federation-Pubkey` and `X-Federation-Signature` against canonical body

## Hard-fail on missing HUB_API_TOKEN (Momus B2)

Today, if `HUB_API_TOKEN` is unset, the gateway logs a warning and allows unauthenticated access on every `/v1/*` route. With federation, this becomes an instant data-leak primitive.

**Change**: at startup, if `HUB_API_TOKEN` is unset AND the hub is bound to a non-loopback interface (i.e., federation-capable), the hub **refuses to start** with a clear error message.

```ts
if (!process.env.HUB_API_TOKEN && config.host !== '127.0.0.1' && config.host !== '::1') {
  throw new Error(
    'HUB_API_TOKEN must be set when binding to a non-loopback interface. ' +
    'For local development only, bind to 127.0.0.1.'
  );
}
```

Loopback-only (dev) mode still allows missing token, since wireguard/tailnet isn't involved.

## Transport

- A's hub reachable at `http://userA.tailXXXXXX.ts.net:8080` over WireGuard (existing)
- HTTPS not required within tailnet (WireGuard is the encryption layer)
- HTTP for hub-to-hub calls (consistent with current phone→hub transport)

**Future**: when relay is adopted, transport changes but protocol (headers + body shape) stays identical.

## Protocol flow

### Setup (one-time per hub)

```bash
# On hub A
$ pdatahub-hub init
  → Generated Ed25519 keypair (signing_key + verify_key)
  → Encrypted signing_key under master_key
  → Stored in federation_keys table
  → hub_name prompt: "userA"
  → magic_dns auto-detected: "userA.example.ts.net" (from `tailscale status`)

$ pdatahub-hub identity show
  Hub name: userA
  Verify key: ed25519:c2OaYBx...
  Magic DNS: userA.example.ts.net:8080
  Fingerprint: AB CD EF 01 23 45 67 89
```

### Delegation creation (A)

```bash
# On hub A
$ pdatahub-hub delegate \
    --peer-verify-key ed25519:B_public... \
    --plugin google-calendar \
    --tool listEvents \
    --scope calendar:read \
    --expires 24h

  → Lookup plugin.getInfo().tools → confirm scope matches manifest (Momus C5)
  → INSERT INTO delegations
  → Sign delegation blob with A's signing_key (includes input_schema from plugin manifest)
  → Print QR code + base64 blob

$ pdatahub-hub delegate list
  ID                                   Plugin              Tool         Expires
  7f3e2b1a-...                         google-calendar     listEvents   2026-09-08 12:00
```

### Delegation import (B)

```bash
# On hub B
$ pdatahub-hub accept-delegation <base64_blob>
  → Parse JSON
  → Verify A's signature against issuer.verify_key IN THE BLOB (not from /v1/identity — see Momus I10)
  → Print:
      Hub:        userA
      Fingerprint: AB CD EF 01 23 45 67 89
      Plugin/Tool: google-calendar / listEvents
      Scope:      calendar:read
      Expires:    2026-09-08 12:00
  → "Accept this delegation? [y/N]" — required user confirmation (Momus Q5)
  → DNS resolve A's magic_dns (issuer.magic_dns from blob) → IP
  → INSERT INTO peer_delegations

$ pdatahub-hub delegation list
  Peer         Plugin             Tool         Expires             Status
  userA        google-calendar    listEvents   2026-09-08 12:00   active
```

### Invocation (B's AI → A's plugin)

#### Step 1: B's MCP receives call

B's MCP client invokes:
```
callTool("federated__userA__listEvents", {from, to})
```

(Note: `__` instead of `:` — Momus noted colons may violate MCP's `^[a-zA-Z0-9_-]{1,64}$` restriction. The actual format is a Phase 5 decision; both clients must agree.)

#### Step 2: B's mcp-server routes to hub-core

mcp-server is dumb. It calls hub-core:

```
POST /v1/federation/invoke
Headers:
  Authorization: Bearer <HUB_API_TOKEN>   (or future Ed25519 challenge)
Body: {
  "tool": "federated__userA__listEvents",
  "arguments": { from, to },
  "agent_id": "B_local_agent",
  "justification": "Read A's calendar for scheduling"
}
```

**Why this is on hub-core, not mcp-server** (Momus B6): mcp-server has no DB and no key access. Doing the lookup, signing, and outbound fetch in hub-core keeps the signing_key in one process.

#### Step 3: B's hub-core handles the request

```
1. Strip "federated__" prefix → peer_hub_name = "userA", tool = "listEvents"
2. Look up delegation in peer_delegations:
   - peer_hub_name = "userA", tool = "listEvents"
   - revoked = 0, expires_at > now
3. Tie-break if multiple rows: pick the one with latest expires_at
4. Build body to send to A:
   {
     delegation_id, tool, arguments,
     agent_id: "B_local_agent",
     request_id: randomBytes(8).toString('hex'),
     timestamp: ISO8601
   }
5. Sign with B's signing_key
6. POST http://userA.tailXXXXXX.ts.net:8080/v1/federation/call
   Headers:
     X-Federation-Pubkey: ed25519:B_public...
     X-Federation-Signature: <base64>
   Body: signed JSON
```

#### Step 4: A's hub receives federated call

```
POST /v1/federation/call
Headers: X-Federation-Pubkey, X-Federation-Signature
Body: { delegation_id, tool, arguments, agent_id, request_id, timestamp }
```

Per-route auth: **ed25519** (no Bearer check).

A's hub:
1. Check `|now - timestamp| <= 300s` (symmetric window — Momus I7)
2. Verify `X-Federation-Signature` against `X-Federation-Pubkey` over canonical body
3. Check `federation_nonces` for `request_id` — if seen within last 10 min → 409 REPLAY (Momus I4)
4. Insert into `federation_nonces` with `seen_at = now`. **Sweep mechanism**: lazy only. Rows older than 10 min are filtered at query time (`seen_at > now - 600s`) rather than deleted. Table size ≈ max-concurrent-active-requests × 1. Acceptable for MVP.
5. Lookup delegation in `delegations` by `delegation_id`
6. Check delegation not revoked, not expired
7. Check `delegation.peer_verify_key === X-Federation-Pubkey` (defense in depth)
8. Check `delegation.tool === body.tool`
9. **Fast-path: if `clients.size === 0` on `/approval-stream`, return 503 NO_APPROVER_CONNECTED immediately** (Momus I2 — A's phone offline → don't burn 120s)
10. **Run approval flow with extended budget = 120s** (Momus I1)
    - New fields on `ApprovalStreamMessage.approval_request`:
      - `delegated_by: string` (verify_key of B)
      - `peer_hub_name: string`
      - `agent_id: string` (from B)
      - `tool_name`, `scope`, `justification` (existing)
    - **Rate-limit scope**: `(peer_verify_key, agent_id)` keyed, not per-delegation. Otherwise a malicious B with 100 delegations from A could spam 1000/min by distributing across delegation_ids. Pending approvals for the same `(B_verify_key, agent_id)` pair in last 60s > 10 → 429 (Momus I5)
    - Broadcast on `/approval-stream` WebSocket → A's phone
    - Notification: "**B**'s agent **B_local_agent** requests **listEvents** on your Google Calendar"
11. A taps Approve (with biometric)
12. A's hub invokes google-calendar plugin with A's decrypted token (existing flow)
13. Returns plugin result to B
14. **All of the above happens inside an `ensureGrant`-style flow with `delegated_by` in the match key** (Momus C1 — prevents reusing local grants)

#### Step 5: Cross-hub audit log

**A's hub** logs:
```sql
INSERT INTO audit_log (
  id, timestamp, agent_id, user_id, tool_name, plugin, scope,
  justification, decision, decision_federated, grant_id, duration_ms, error,
  delegated_by, delegated_to
) VALUES (
  'uuid', '2026-09-07T12:00:00Z', 'B_local_agent', 'local-user', 'listEvents',
  'google-calendar', 'calendar:read', 'Read A\'s calendar', 'approved', NULL,
  'grant_uuid', 450, NULL,
  'ed25519:B_public...', NULL
);
```

`user_id = 'local-user'` (A is the data owner), `delegated_by = B_verify_key`.

**B's hub** logs:
```sql
INSERT INTO audit_log (
  id, timestamp, agent_id, user_id, tool_name, plugin, scope,
  justification, decision, decision_federated, grant_id, duration_ms, error,
  delegated_by, delegated_to
) VALUES (
  'uuid', '2026-09-07T12:00:00Z', 'B_local_agent', 'local-user', 'listEvents',
  'google-calendar', 'calendar:read', 'Read A\'s calendar via federation', 'approved', 'federated_ok',
  NULL, 450, NULL,
  NULL, 'ed25519:A_public...'
);
```

`user_id = 'local-user'`, `decision_federated = 'federated_ok'` (Momus C3 — distinct decision value, NOT 'approved', because B didn't make the approval decision).

If A denied: `decision_federated = 'federated_denied'` on B's side; A's side records `decision = 'denied'`.

#### Step 6: Result flows back

A's hub returns plugin result to B. B's hub returns to B's MCP client. AI sees the events.

## API surface

### A-side (receives federated calls)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/v1/identity` | none | Public identity |
| POST | `/v1/federation/delegate` | bearer | A creates delegation |
| GET | `/v1/federation/delegations` | bearer | A lists granted |
| POST | `/v1/federation/delegations/:id/revoke` | bearer | A revokes |
| POST | `/v1/federation/call` | ed25519 | B calls A (signed request) |

### B-side (originates federated calls)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/v1/federation/invoke` | bearer | B's mcp-server invokes a federated tool (B's hub-core does the actual outbound to A) |

### Common (unchanged)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/v1/tools` | bearer | Returns local tools + synthetic federated descriptors (Momus B7) |
| POST | `/v1/tools/:name/call` | bearer | Local tool call (existing) |

### `GET /v1/tools` enhancement (Momus B7)

The response now includes synthetic descriptors for each active `peer_delegations` row:

```json
{
  "tools": [
    {
      "name": "listEvents",
      "description": "Local: List events from primary calendar",
      "plugin": "google-calendar",
      "scope": "calendar:read",
      "inputSchema": { /* JSON Schema */ },
      "federated": false
    },
    {
      "name": "federated__userA__listEvents",
      "description": "Federated: List events from userA's primary calendar (delegated 2026-09-08)",
      "plugin": "google-calendar",
      "scope": "calendar:read",
      "inputSchema": { /* from blob */ },
      "federated": true,
      "delegation_id": "uuid",
      "peer_hub_name": "userA"
    }
  ]
}
```

Revoked or expired delegations are omitted.

## CLI surface

```
pdatahub-hub init                     # Generate Ed25519 keypair (called on first start; reuses existing `init` subcommand)
pdatahub-hub identity show            # Print verify_key + magic_dns + fingerprint
pdatahub-hub delegate \
  --peer-verify-key <key> \
  --plugin <name> --tool <name> \
  --scope <scope> --expires <duration>
                                       # Create delegation, output blob + QR
pdatahub-hub delegate list            # List granted delegations
pdatahub-hub accept-delegation <blob> # Import delegation from peer (prints fingerprint + asks y/N)
pdatahub-hub delegation list          # List received delegations
pdatahub-hub delegation revoke <id>   # Revoke granted delegation
```

## Android app changes

- Approval message payload adds `delegated_by`, `peer_hub_name`, `agent_id` fields (Momus B3)
- UI displays: "**B's agent** requests **listEvents** on your Google Calendar. Approve?"
- Approval row shows source: local agent vs. peer agent (visual distinction, color or icon)
- Settings → Hub Identity section shows `verify_key` + `fingerprint` (for sharing)
- HomeScreen audit history renders `delegated_by`/`delegated_to` columns (Momus I8)
- Delegation management UI: list received + granted delegations, revoke from phone (Momus I8 — otherwise revocation is CLI-only)

## Implementation phases

**Realistic total: 13-14 working days** (Momus re-estimate from 8).

### Phase 0.5 — Migration framework + per-route auth + hard-fail token (~0.5d)

- Create `packages/hub-core/src/migrations.ts` with versioned migration runner using `PRAGMA user_version`
- Add per-route auth strategy table to `server.ts`
- Add hard-fail at startup if `HUB_API_TOKEN` unset and bind is non-loopback
- Tests: migrate pre-federation DB forward; assert idempotency; assert hard-fail works; assert per-route auth dispatches correctly

### Phase 1 — Identity foundation (~1d)

- Ed25519 keypair generation at `pdatahub-hub init` (extend existing `init` subcommand)
- `federation_keys` table (migration v3 in Phase 0.5 framework)
- `GET /v1/identity` endpoint (auth: none)
- Encrypted storage of `signing_key` under HKDF-derived wrapping key
- Magic DNS auto-detection from `tailscale status`
- `pdatahub-hub identity show` CLI command
- Tests: keypair persistence + load + decrypt; signature round-trip; restart preserves identity

### Phase 2a — Delegation data model (~1d)

- `delegations` + `peer_delegations` tables (migrations)
- Sign/verify functions (`@noble/ed25519`)
- Canonical JSON serialization for signing (RFC 8785 or hand-rolled)
- Delegation blob generation (with `input_schema` from plugin manifest)
- Delegation blob verification (against embedded `verify_key`, NOT `/v1/identity`)
- Tests: round-trip blob; flip each field, assert verification fails

### Phase 2b — `user_id` semantics + grant match key fix (~1d, Momus C1)

- Touch 5 sites in `server.ts` where `user_id = 'local-user'` is written (no value change)
- Update `GrantStore.create` to include `delegated_by` in match key for `ensureGrant`
- Update `HomeViewModel.kt:92` (no value change, but verify after refactor)
- Add `delegated_by`/`delegated_to`/`decision_federated` columns to `audit_log` and `grants`
- Tests: pre-existing local grant does NOT satisfy federated call; pre-migration grants still work for local calls

### Phase 3 — Hub-side call path (~3.5-4d, Momus I1, I2, I4, I5)

- `POST /v1/federation/call` endpoint with ed25519 auth dispatch
- `federation_nonces` table + sweep (Momus I4 — replay dedup)
- Approval flow with `delegated_by` in message + extended 120s budget (Momus I1)
- Rate-limit scope: `(peer_verify_key, agent_id)` keyed (NOT per-delegation — see protocol step 4); 10 pending approvals/60s → 429 (Momus I5)
- Fast 503 path when `clients.size === 0` on `/approval-stream` (Momus I2)
- Symmetric clock skew check `|now - ts| <= 300s` (Momus I7)
- Cross-hub audit logging (A logs `delegated_by = B_key`, B logs `delegated_to = A_key` + `decision_federated`)
- **Federated grant row shape**: federated calls reuse the existing `grants` table with `delegated_by` populated. The match key for `ensureGrant` becomes `(tool_name, agent_id, plugin, delegated_by)` — local calls have `delegated_by = NULL`, federated calls have `delegated_by = B_verify_key`. The `grant_id` is stored in the federated grant row and passed to the plugin context along with the rest of `CallContext`. Lifetime is identical to local grants (1h default).
- **`ApprovalStream` timeout handling**: existing `ApprovalStream.timeoutMs` is global per-instance. To give federated calls a 120s budget while keeping local calls at 60s, instantiate a second `ApprovalStream` for federated requests with `timeoutMs = 120_000`. Both share the same `/approval-stream` WebSocket endpoint; the difference is internal state. Do NOT attempt per-call override — that would require threading the budget through every caller.
- Tests: rejection suite (bad sig, unknown delegation, revoked, expired, wrong peer, replayed, future-timestamp, past-timestamp, no approver, denied, rate-limit)

### Phase 4 — CLI tooling (~1.5d, Momus C5, Q5)

- `pdatahub-hub delegate` command
- `pdatahub-hub accept-delegation` with fingerprint + y/N confirmation (Momus Q5)
- `pdatahub-hub delegate list` and `pdatahub-hub delegation list` and `pdatahub-hub delegation revoke`
- Scope validation against plugin manifest at delegate-creation (Momus C5)
- QR code generation for delegation blob
- Tests: delegate writes exactly one row + emits valid blob; `accept-delegation` of malformed blob rejected; scope not in manifest rejected

### Phase 5 — Tool descriptors + mcp-server passthrough (~1.5d, Momus B6, B7)

- `GET /v1/tools` emits synthetic descriptors for active `peer_delegations` (Momus B7)
- `POST /v1/federation/invoke` endpoint on hub-core (Momus B6)
- mcp-server: detect `federated__<hub>__<tool>` prefix and call `/v1/federation/invoke` instead of `/v1/tools/:name/call`
- Tests: `GET /v1/tools` includes federated descriptors; invocation produces correct outbound request

### Phase 6 — Android UI (~1.5-2d, Momus I8)

- `ApprovalStreamEvent.ApprovalRequest` adds `delegated_by`, `peer_hub_name`, `agent_id` fields (Momus B3)
- Verify `ignoreUnknownKeys = true` on Kotlin deserializer
- Approval notification displays peer agent source
- HomeScreen audit history rows render `delegated_by`/`delegated_to`
- Delegation management UI: list received + granted, revoke from phone
- Settings → Hub Identity section shows verify_key + fingerprint
- Tests: Kotlin deserialization of new payload; notification text matches format

### Phase 7 — Documentation (~0.5d)

- `docs/federation.md` — user guide with delegation setup walkthrough
- Update `docs/architecture.md` — federation section
- Update `README.md` — federation example

### Phase 7b — Audit retention policy (~0.5d, Momus I6)

- Document retention policy: `audit_log` rows accumulate indefinitely in MVP. Estimate ~1MB/yr per hub at current call rate (10 calls/day × ~500 bytes per row × 365).
- Add `purge_audit` SQL helper (CLI: `pdatahub-hub audit purge --older-than 365d`) that deletes rows in batches. No automatic background job — user triggers manually.
- Document operational guidance in `docs/federation.md`: "Audit log will grow unbounded. Use `audit purge` periodically. Federation multiplies row volume by 2x per federated call (both hubs log)."
- v3: scheduled retention task + per-user quotas.

### Phase 8 — Integration tests (~1d, split: happy path + adversarial)

- **8a Happy path (0.5d)**: two hub processes on distinct ports + DBs + keypairs, scripted phone client auto-approving, full B-invokes-A flow with assertions on cross-hub audit logs and plugin output match
- **8b Adversarial (0.5d)**: revoked delegation → 403; expired → 403; wrong peer key → 403; replayed request_id → 409; timestamp skew ±10min → 401; no phone connected → 503; 11th call in 1 min → 429

## Security model

### Threat model

Adversaries:
- **Network observer**: sees encrypted WireGuard traffic, learns magic DNS names, IPs, message sizes/timing
- **Compromised hub**: has access to its own vault, signing_key, etc. Cannot forge other hubs' signatures.
- **Malicious peer (B)**: tries to invoke more than delegated, or impersonate another peer
- **Out-of-band channel attacker**: tries to forge delegation blobs (caught by fingerprint confirmation — Momus Q5)

### Mitigations

| Threat | Mitigation |
|---|---|
| Forged delegation blob | Ed25519 signature verified on import against `issuer.verify_key` IN THE BLOB (Momus I10 — not from `/v1/identity`) |
| Stolen delegation blob | Bound to B's verify_key (in `subject.verify_key`); B proves possession of signing_key by signing requests |
| Replay of old federation call | `request_id` + `federation_nonces` table with 10-min sweep (Momus I4) |
| Scope escalation | Tool name and scope checked against delegation (Momus C1 — via grant match key including `delegated_by`); scope also validated against plugin manifest at delegate-creation (Momus C5) |
| Peer impersonation | `X-Federation-Pubkey` checked against `delegation.peer_verify_key` (defense in depth) |
| Token exfiltration to B | Proxy pattern — A's token never leaves A's hub |
| Cross-user approval routing | Approval broadcast filtered by `delegated_by` for federated calls; UI shows source peer (Momus B3) |
| Compromised signing key | v3 — `key_epoch` (Momus I3); for MVP, A revokes all delegations + re-grants. Per-call approval is the real backstop. |
| Local grant reused for federated call | `ensureGrant` match key now includes `delegated_by` (Momus C1 — security hole fix) |
| Notification spam DoS | Per-delegation rate limit 10/min → 429 (Momus I5) |

### Known limitations (acceptable for MVP)

- **No perfect forward secrecy** for federated calls (Ed25519 doesn't ratchet). Hub compromise leaks all past delegations + future ones.
- **No automatic delegation expiry** — expired delegations stay in DB until manual cleanup (add cleanup task in v3).
- **No revocation broadcast** — when A revokes, B's `peer_delegations` doesn't know until next call attempt. Acceptable: failed call returns clear 403 `DELEGATION_REVOKED`.
- **No multi-hop delegation** — B can't re-delegate what A delegated.
- **Hard-fail on missing token may break dev convenience** — bind to 127.0.0.1 to keep current dev flow (Momus B2).

## Failure modes

| Failure | Behavior |
|---|---|
| A's hub offline | B's HTTP call returns connection error; B's MCP returns tool error; AI retries or gives up |
| A's hub up, A's phone offline | Fast 503 NO_APPROVER_CONNECTED (Momus I2) — B sees immediate failure, not 120s wait |
| Magic DNS stale (A's hostname changed) | DNS resolve fails at import time or call time; user re-issues delegation |
| B's signing_key rotated | Old delegation calls fail signature verification; B must re-accept delegation |
| A revokes delegation | Next call from B returns 403 DELEGATION_REVOKED; B's `peer_delegations.revoked` not auto-updated (manual cleanup) |
| Clock skew between hubs | Symmetric window `|now - ts| <= 300s` (Momus I7) |
| Plugin call fails on A | A returns error to B; B's MCP returns tool error; cross-hub audit logs `error` field |
| Network partition mid-call | TCP timeout; both sides log error; no partial state |
| Replayed request_id | Second call with same request_id returns 409 REPLAY within 10-min window (Momus I4) |
| Multiple delegations for same (peer, tool) | Tie-break: latest `expires_at`; tool name includes `delegation_id` to avoid MCP namespace collision (Momus Q4) |
| A's HUB_API_TOKEN missing + tailnet bind | Hub refuses to start with clear error (Momus B2) |

## Decisions log (Momus answers to v1 open questions)

| Q | v1 question | v2 answer |
|---|---|---|
| Q1 | Proxy vs capability token? | Proxy (decision 5 requires per-call approval) |
| Q2 | 5-min timestamp window vs request_id dedup? | Add dedup in Phase 3 — `federation_nonces` table |
| Q3 | Single tool vs folder scopes? | Single tool MVP; scope validated against plugin manifest (Momus C5) |
| Q4 | Multiple delegations per peer with different scopes? | Allow; tie-break by latest `expires_at`; tool name includes `delegation_id` |
| Q5 | `accept-delegation` confirmation? | Yes — fingerprint + y/N required |
