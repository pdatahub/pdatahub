# Federation v2 — User Guide

**Status:** All eight phases shipped (2026-09-08). Hub-core 310/310 tests pass; Android 39/39 pass.
**Scope:** Single-tool delegation between two trusted hubs over WireGuard/Tailscale.
**Out of scope (v3+):** blanket delegations, auto-grant, multi-hop, relay-over-Cloudflare.

## Overview

Federation v2 lets **User A** share a single plugin tool from A's hub with **User B's** hub, while A's phone keeps approval authority. Use case: A has Google Calendar; B wants B's AI to read A's calendar for scheduling. A delegates `listEvents` (read-only) to B's hub. B's AI invokes it; A's phone approves; result flows back to B.

The wire format is a base64url-encoded, Ed25519-signed delegation blob that travels **out-of-band** (QR, copy-paste, secure chat). On every invocation, B's hub signs the request with B's Ed25519 identity and POSTs it to A's `/v1/federation/call` over your existing tailnet. No raw OAuth token ever crosses the hub boundary — A decrypts and uses its own token on A's side (proxy pattern, see [architecture.md](./architecture.md#federation-v2)).

## Concepts

### Hub identity (Ed25519)

Each hub owns a single Ed25519 keypair generated at `pdatahub-hub init`:

| Field | Purpose |
|-------|---------|
| `verify_key` (public) | Base64url of the 32-byte public key, prefixed `ed25519:`. Published by `GET /v1/identity` and embedded inside every delegation blob A signs. |
| `signing_key` (private) | 32 bytes, encrypted at rest under the hub master key via `HKDF-SHA256(salt="pdatahub-federation-v1", info="signing-key", L=32)` → AES-256-GCM. Never leaves the hub process in plaintext. |
| `fingerprint` | First 8 bytes of the public key, formatted as `AB CD EF 01 23 45 67 89`. Humans compare fingerprints, not 43-char base64. |
| `magic_dns` | The hub's Tailscale MagicDNS hostname (`userA.tailXXXXXX.ts.net:8080`). Auto-detected from `tailscale status` when present. |

This is a **separate** key from the BIP-39 mnemonic. Loss of mnemonic doesn't compromise federation identity; rotation of one doesn't touch the other.

### Delegations (granted vs received)

Each delegation has exactly one `(plugin, tool, scope)` triple and an explicit expiry. The split into two mirrored tables is deliberate — A and B hold independent state:

| Table | Lives on | Created by | Lets the holder… |
|-------|----------|-----------|------------------|
| `delegations` | A (issuer) | `pdatahub-hub delegate` | A revoke at any time |
| `peer_delegations` | B (receiver) | `pdatahub-hub accept-delegation` | B invoke the federated tool |

Both rows reference the same `delegation_id` (UUID v4) and the same `(plugin, tool, scope, expires_at)` tuple, but only A holds A's Ed25519 signature on the blob that B imports.

### Federation flow

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

## Setup

Two users, A and B, each run the hub on their own laptop. The whole setup is a few minutes once both hubs are initialized with Tailscale.

### 1. Tailscale mesh (already documented)

Both hubs need to be reachable at their MagicDNS hostnames over WireGuard. If you have not done this yet, see [docs/relay-mode.md](./relay-mode.md). Verify with `curl http://<hub>.tailXXXXXX.ts.net:8080/health` — expect `{"status":"ok","service":"pdatahub-hub"}`.

### 2. Initialize A's hub

```bash
$ pdatahub-hub init --hub-name userA --db-path ~/.local/share/pdatahub/hub.db --master-key "$MASTER_KEY"

=== FEDERATION IDENTITY ===
Hub name:      userA
Verify key:    ed25519:wdlEEYI0rCNkobjR0d1aPJBl6v2HQ4Sqh8C5FZ3mNoE
Magic DNS:     userA.example.ts.net:8080
Fingerprint:   C1 D9 44 11 82 34 AC 23
DB:            /home/userA/.local/share/pdatahub/hub.db
```

Copy **the verify key** and **the fingerprint** — B needs them. Share out-of-band (Signal, in person, anything not compromised). Do not paste them into a public chat.

If Tailscale was not running at init time, `Magic DNS` will print `(not detected)`. Re-run `pdatahub-hub identity regen` after Tailscale is up, or pass `HUB_PUBLIC_HOSTNAME=userA.example.ts.net` when starting the hub.

### 3. Initialize B's hub

```bash
$ pdatahub-hub init --hub-name userB --db-path ~/.local/share/pdatahub/hub.db --master-key "$MASTER_KEY"

=== FEDERATION IDENTITY ===
Hub name:      userB
Verify key:    ed25519:Q7NFSFHIjVfvxRee7YcN4rXgMzK9wHpaJqL2TuBvC0I
Magic DNS:     userB.example.ts.net:8080
Fingerprint:   3F 8A 12 9C 44 5B 6D 70
DB:            /home/userB/.local/share/pdatahub/hub.db
```

A now needs B's verify key and fingerprint too — but only when **A** wants to delegate to **B**. For this walkthrough, A delegates `listEvents` to B, so only B needs to know A's verify key.

## Granting a delegation (A's side)

Run on A's hub:

```bash
$ pdatahub-hub delegate \
    --peer-verify-key ed25519:Q7NFSFHIjVfvxRee7YcN4rXgMzK9wHpaJqL2TuBvC0I \
    --plugin google-calendar \
    --tool listEvents \
    --scope calendar:read \
    --expires 24h \
    --db-path ~/.local/share/pdatahub/hub.db

Delegation issued: 7f3e2b1a-9c4d-4a72-b8e1-2a5d8f9c0b3e
Plugin: google-calendar / listEvents   Scope: calendar:read
Expires: 24h

Blob (base64url, share this with the peer):
eyJ2ZXJzaW9uIjoxLCJkZWxlZ2F0aW9uX2lkIjoiN2YzZTJiMWEtOWM0ZC00YTcyLWI4ZTEtMmE1ZDhmOWMwYjNlIiwiaXNzdWVyIjp7Imh1Yl9uYW1lIjoidXNlckEiLCJ2ZXJpZnlrZXkiOiJlZDI1NTE5OndkbEVFWkkwc…

QR (base64 PNG, 596 chars):
iVBORw0KGgoAAAANSUhEUgAAAUAAAAFAAQMAAAC…
```

The `--expires` flag accepts `Nh`, `Nd`, or `Nw` (e.g. `24h`, `30d`, `1w`). The CLI validates the requested scope against the plugin manifest on A's running hub — if you pass `--scope calendar:write` for a tool whose manifest declares `calendar:read`, the command fails with `scope mismatch` rather than silently letting B read more than you intended.

You can verify the delegation exists with `pdatahub-hub delegate list`:

```bash
$ pdatahub-hub delegate list --db-path ~/.local/share/pdatahub/hub.db
ID                                     Plugin              Tool         Scope              Expires               Revoked
7f3e2b1a-9c4d-4a72-b8e1-2a5d8f9c0b3e   google-calendar     listEvents   calendar:read      2026-09-09 07:36      no

1 delegation(s).
```

Now share the **base64url blob** (or the QR code, scanned by the recipient) with B via Signal / in-person / secure paste. The blob is signed by A's Ed25519 identity, so B's hub will verify it on import — but only if the embedded fingerprint matches what B sees here.

## Accepting a delegation (B's side)

Run on B's hub:

```bash
$ pdatahub-hub accept-delegation eyJ2ZXJzaW9uIjoxLCJkZWxlZ2F0aW9uX2lkIjoiN2YzZTJiMWEtOWM0ZC00YTcyLWI4ZTEtMmE1ZDhmOWMwYjNlIiwiaXNzdWVyIjp7Imh1Yl9uYW1lIjoidXNlckEiLCJ2ZXJpZnlrZXkiOiJlZDI1NTE5OndkbEVFWkkwc… --db-path ~/.local/share/pdatahub/hub.db

Hub:         userA
Fingerprint: C1 D9 44 11 82 34 AC 23
Plugin/Tool: google-calendar / listEvents
Scope:       calendar:read
Expires:     2026-09-09 07:36 UTC
Magic DNS:   userA.example.ts.net:8080

Accept this delegation? [y/N] y

Imported delegation: 7f3e2b1a-9c4d-4a72-b8e1-2a5d8f9c0b3e
Peer:    userA
Hub URL: http://<peer-host>:8080/

Use "pdatahub-hub delegation list" to view received delegations.
```

The CLI prints the issuer's hub name, fingerprint, scope, and expiry, then asks `Accept this delegation? [y/N]`. **Verify the fingerprint matches what A told you out-of-band** before typing `y`. If the fingerprint is wrong, the blob was tampered with on its way to you — abort with `N` and re-share via a different channel.

For non-interactive use (CI, scripted provisioning), pass `--yes`:

```bash
$ pdatahub-hub accept-delegation "$BLOB" --yes --db-path ~/.local/share/pdatahub/hub.db
```

B's hub also resolves the issuer's `magic_dns` to a tailnet IP at import time. If the lookup fails, it falls back to the hostname string so the row still gets persisted (you can edit it later or re-import after fixing DNS). The Hub URL is stored as `http://<resolved-ip>:8080/` and used as the base URL for all `federated__userA__listEvents` calls.

Verify with `pdatahub-hub delegation list`:

```bash
$ pdatahub-hub delegation list --db-path ~/.local/share/pdatahub/hub.db
ID                                     Peer             Plugin             Tool         Scope              Expires               Revoked
7f3e2b1a-9c4d-4a72-b8e1-2a5d8f9c0b3e   userA            google-calendar    listEvents   calendar:read      2026-09-09 07:36      no

1 delegation(s).
```

## Calling a federated tool

The federated tool appears in B's `GET /v1/tools` response under the synthetic name `federated__<peer_hub>__<tool>`:

```bash
$ curl -H "Authorization: Bearer $HUB_API_TOKEN" http://127.0.0.1:8080/v1/tools | jq '.tools[] | select(.federated)'
{
  "name": "federated__userA__listEvents",
  "description": "Federated call to listEvents on userA's google-calendar hub (expires 2026-09-09T07:36:38Z)",
  "inputSchema": { "type": "object", "properties": { "from": { "type": "string" }, "to": { "type": "string" } }, "required": ["from"] },
  "scope": "calendar:read",
  "plugin": "google-calendar",
  "federated": true,
  "delegation_id": "7f3e2b1a-9c4d-4a72-b8e1-2a5d8f9c0b3e",
  "peer_hub_name": "userA",
  "peer_hub_url": "http://<peer-host>:8080/",
  "expires_at": "2026-09-09T07:36:38Z"
}
```

When B's MCP client invokes it natively (e.g. from an AI agent using OpenCode or Claude), it routes via `pdatahub-hub-mcp`, which detects the `federated__` prefix and forwards to `POST /v1/federation/invoke` on B's hub-core.

For direct testing on B's hub:

```bash
$ curl -sS -H "Authorization: Bearer $HUB_API_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{
          "tool": "federated__userA__listEvents",
          "arguments": { "from": "2026-09-01", "to": "2026-09-07" },
          "agent_id": "opencode",
          "justification": "Schedule meeting for userA"
        }' \
    http://127.0.0.1:8080/v1/federation/invoke
```

The flow under the hood:

1. **B's hub-core** strips `federated__` → `(peer_hub_name=userA, tool=listEvents)`, looks up the active delegation in `peer_delegations`, and finds the latest `expires_at` row.
2. **B's hub-core** builds the federation request body, signs it with B's signing key (`X-Federation-Pubkey`, `X-Federation-Signature` headers), and POSTs to `http://<peer-host>:8080/v1/federation/call`.
3. **A's hub-core** verifies the signature, checks clock skew (±5 min), looks up `delegations.delegation_id`, confirms B is the named peer, and checks the approval stream — A's phone must be connected.
4. **A's phone** receives an approval notification: *"userB's agent **opencode** requests **listEvents** on your Google Calendar"*. User taps Approve (with biometric if enabled).
5. **A's hub-core** invokes the google-calendar plugin with **A's** decrypted OAuth token from A's vault, returns the result to B.
6. **Both hubs** write to their audit logs:
   - **A**: `delegated_by = B_verify_key`, `decision = 'approved'`, `decision_federated = NULL`.
   - **B**: `delegated_to = A_verify_key`, `decision_federated = 'federated_ok'`.

Average end-to-end: ~5 seconds (signature + DNS + phone approval + plugin call + audit broadcast).

## Listing & revoking

A can revoke at any time. The change is immediate on A's side; B's next call will return `403 DELEGATION_REVOKED` (B's `peer_delegations.revoked` flag is **not** auto-updated — that's manual cleanup in v1, see [known limitations](#known-limitations)).

```bash
# On A's hub — list granted
$ pdatahub-hub delegate list
ID                                     Plugin              Tool         Scope              Expires               Revoked
7f3e2b1a-9c4d-4a72-b8e1-2a5d8f9c0b3e   google-calendar     listEvents   calendar:read      2026-09-09 07:36      no

# Revoke — copy the ID from the table above
$ pdatahub-hub delegation revoke 7f3e2b1a-9c4d-4a72-b8e1-2a5d8f9c0b3e
Revoked: 7f3e2b1a-9c4d-4a72-b8e1-2a5d8f9c0b3e
```

Confirm:

```bash
$ pdatahub-hub delegate list
ID                                     Plugin              Tool         Scope              Expires               Revoked
7f3e2b1a-9c4d-4a72-b8e1-2a5d8f9c0b3e   google-calendar     listEvents   calendar:read      2026-09-09 07:36      yes
```

B can also delete the matching `peer_delegations` row from B's side (it will never match again):

```bash
# On B's hub
$ sqlite3 ~/.local/share/pdatahub/hub.db \
    "DELETE FROM peer_delegations WHERE delegation_id = '7f3e2b1a-9c4d-4a72-b8e1-2a5d8f9c0b3e'"
```

Federated grants created by A in response to a successful call (`ensureGrant` with `delegated_by = B_verify_key`) live for the standard 1-hour TTL and can be revoked from A's phone UI just like local grants.

## Audit retention (Phase 7b)

Audit rows accumulate indefinitely in MVP — at 10 calls/day and ~500 bytes per row, expect ~1 MB/year per hub for local calls, **doubled** when federation is active (each federated call produces two rows — one on A, one on B with `decision_federated` populated).

There is no automatic background purge. Run `audit purge` periodically to bound the DB:

```bash
# Preview what would be deleted (no rows touched)
$ pdatahub-hub audit purge --older-than 365d
Preview: 1247 audit rows older than 365d would be deleted.
Run with --yes to actually delete.

# Actually delete
$ pdatahub-hub audit purge --older-than 365d --yes
Deleted 1247 audit rows (older than 365d).
116 remaining audit rows.
```

The `--older-than` flag accepts the same `Nh|Nd|Nw` syntax as `--expires`. Without `--yes`, the command prints the count and exits — no rows are touched. With `--yes`, the row count is reported both before and after the deletion.

Suggested cadence:

- Personal hub with light federation: every 6–12 months.
- Active multi-peer hub: monthly.
- Pre-migration to v3 (where scheduled retention lands): one-shot cleanup before the new policy takes over.

**Federation context is preserved on remaining rows**: a purge at `--older-than 365d` deletes the row but never modifies surviving rows. A query like *"all actions by userB's hub in the last 30 days"* keeps working the same way.

## Known limitations

These are accepted for MVP and addressed in v3+. They are **not** bugs — they are explicit non-goals of federation v2 (see design doc §"Out of scope"):

| Limitation | Workaround today | Lands in |
|------------|------------------|----------|
| Revoked delegations don't broadcast — B only learns on next call (`403 DELEGATION_REVOKED`) | B can manually delete the row from `peer_delegations` after seeing a 403 | v3 (signed revocation broadcast) |
| No automatic expiry cleanup — expired rows live in DB | Run `sqlite3 hub.db "DELETE FROM peer_delegations WHERE expires_at < datetime('now')"` periodically | v3 (scheduled task) |
| No perfect forward secrecy — Ed25519 doesn't ratchet | Per-call approval is the real backstop; revoke all delegations + re-issue if signing key compromised | v3 (key_epoch) |
| Per-delegation rate limit only, no per-peer global cap | `/v1/federation/call` enforces 10 pending approvals / 60s per `(peer_verify_key, agent_id)`. Local endpoints additionally rate-limited per (IP, route_class) — see MIT-005 in `docs/threat-model.md` | v3 (per-peer global cap) |
| A's phone must be reachable for every call | Approval fast-paths to `503 NO_APPROVER_CONNECTED` if no `/approval-stream` clients — better than burning 120s on a timeout | unchanged |
| One tool per delegation — no folder scopes, no "calendar listEvents but only certain calendars" | Compose multiple delegations if needed | v3 (per-user scope refinement) |

## Where things live in the code

| Concern | File |
|---------|------|
| Identity (keypair, encrypt/decrypt, fingerprint, magic DNS) | `packages/hub-core/src/federation/identity.ts` |
| Blob format, sign/verify, canonical JSON | `packages/hub-core/src/federation/delegation.ts` |
| CLI (`delegate`, `accept-delegation`, `list`, `revoke`, `audit purge`) | `packages/hub-core/src/federation/delegation-cli.ts`, `src/index.ts` |
| Inbound call handler `/v1/federation/call` | `packages/hub-core/src/server.ts` (handler `handleFederationCall`) |
| Outbound call handler `/v1/federation/invoke` | `packages/hub-core/src/server.ts` (handler `handleFederationInvoke`) |
| Synthetic tool descriptors in `GET /v1/tools` | `packages/hub-core/src/server.ts` (method `listFederatedToolDescriptors`) |
| Replay dedup | `packages/hub-core/src/federation/nonces.ts` |
| Schema migrations | `packages/hub-core/src/migrations.ts` |
| Android approval payload + UI for delegated calls | `packages/android-app/app/src/main/kotlin/.../HomeViewModel.kt`, `ApprovalNotification.kt`, `DelegationManagementScreen.kt`, `HubIdentitySection.kt` |
| MCP server detection of `federated__` prefix | `packages/mcp-server/src/...` (Phase 5) |

## Threat model (TL;DR)

See [design doc §"Security model"](../.omo/plans/federation-v2-design.md#security-model) for the full table. The five mitigations that matter most for daily operation:

1. **Out-of-band fingerprint verification** — `accept-delegation` prints the issuer's fingerprint; you compare it against what the issuer told you separately. Defense against forged blobs.
2. **Defense in depth** — even if `/v1/identity` lies, the signed blob carries A's verify_key; B verifies against the embedded key, not the endpoint.
3. **Per-call approval** — A's phone approves every call by default. No auto-grant in v1.
4. **Proxy pattern** — B never sees A's OAuth token. A decrypts and uses locally.
5. **Cross-hub audit** — both sides log every call with `delegated_by`/`delegated_to` populated. Tampering requires compromising both hubs.

## What to do if things break

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `pdatahub-hub delegate` returns `plugin "X" not found in registry` | Hub started without the plugin loaded | Start the hub with `--plugins-dir <path>` containing the plugin; or skip the CLI and use the HTTP `/v1/federation/delegate` endpoint (Phase 4 said scope validation is best-effort at CLI). The CLI also has HTTP mode: pass `--hub-url <url>` to talk to a running hub without holding master_key locally — see `docs/cli-reference.md` |
| `accept-delegation` says `signature verification failed: signature mismatch` | Tampered blob or wrong issuer verify_key | Re-share the blob with A; double-check you copied it character-for-character |
| B's call returns `403 DELEGATION_REVOKED` | A revoked | Ask A to re-issue |
| B's call returns `403 DELEGATION_EXPIRED` | Past `--expires` | Ask A to re-issue with longer TTL |
| B's call returns `401 CLOCK_SKEW` | Clocks differ by >5 min | Sync clocks (NTP / chrony) |
| B's call returns `409 REPLAY` | Same `request_id` reused within 10 min | B's MCP must generate a fresh `request_id` per call |
| B's call returns `503 NO_APPROVER_CONNECTED` | A's phone offline / not connected to tailnet | Wait for A's phone to reconnect, or A binds `/approval-stream` from desktop too (Phase 6 Android UI does this) |
| B's call returns `429 RATE_LIMIT` | >10 calls in 60s for the same `(B_verify_key, agent_id)` | Slow down; the limit exists so a compromised B can't spam A's phone |
| B's call returns `502 FEDERATION_UPSTREAM_ERROR` | A's hub unreachable | Check `tailscale status`, verify A's hub is running, ping A's magic DNS |
| Phone shows approval but no notification | Android app not running / notification permission denied | Open the pdatahub Android app; check Settings → Notifications |
