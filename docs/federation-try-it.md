# Federation v2 — Try It (5-Minute Walkthrough)

Hands-on guide to going from **two fresh hubs** to a **successful federated tool call**. For architecture, concepts, and deep reference, see [federation.md](./federation.md). For full CLI flag documentation, see [cli-reference.md](./cli-reference.md).

**Time:** ~5 minutes if both hubs are already running on Tailscale.
**Result:** User B's AI can invoke one tool from User A's hub, with A's phone approving each call.

---

## Prerequisites

You need two machines (or two terminals on the same machine with two different `--db-path`s). Both must be on the same Tailscale tailnet.

| Requirement | Why | Verify |
|-------------|-----|--------|
| Two pdatahub hubs initialized | Each hub needs its own Ed25519 identity | `pdatahub-hub identity` prints a verify key + fingerprint |
| Tailscale running on both | Hubs reach each other via MagicDNS over WireGuard | `tailscale status` shows both hosts |
| Ports reachable on tailnet | Hubs listen on `:8080` by default | `curl http://<peer>.tailXXXXXX.ts.net:8080/health` returns `{"status":"ok"}` |
| A has a plugin with at least one tool | The federated tool comes from A's plugins | `curl -H "Authorization: Bearer $TOKEN" http://<A>:8080/v1/tools \| jq '.tools[].name'` shows ≥1 tool |
| Both hubs use the same master key format | Federation identity encryption derives from master key | `pdatahub-hub init --help` shows `--master-key` (32-byte hex) |

**Master key for testing** (do not use in production):

```
f92a24ff97a81014fdf0124f76b81da23d22241a5da31499cfe439672810b398
```

**Quick sanity check before proceeding:**

```bash
# On A's machine
curl http://userA.tailXXXXXX.ts.net:8080/health
# → {"status":"ok","service":"pdatahub-hub"}

# On B's machine
curl http://userB.tailXXXXXX.ts.net:8080/health
# → {"status":"ok","service":"pdatahub-hub"}
```

If either returns connection refused, start the missing hub:

```bash
pdatahub-hub start \
    --port 8080 \
    --db-path ~/.local/share/pdatahub/hub.db \
    --master-key "$MASTER_KEY"
```

---

## The 60-Second Version

If you've done this before, here's the whole flow. Expand the sections below for first-time setup.

```bash
# On A — grab verify key + fingerprint
pdatahub-hub identity

# On B — grab verify key + fingerprint
pdatahub-hub identity

# On A — create the delegation (paste B's verify key)
pdatahub-hub delegate \
    --peer-verify-key ed25519:<B_verify_key> \
    --plugin <plugin_name> \
    --tool <tool_name> \
    --scope <scope> \
    --expires 24h

# → prints a base64url blob. Copy it.

# On B — import the blob
pdatahub-hub accept-delegation <paste_blob_here>

# → prints "Fingerprint: XX XX XX ...". Verify it matches what A told you out-of-band.
# → type y to accept

# On B — invoke the federated tool
curl -H "Authorization: Bearer $HUB_API_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"tool":"federated__userA__<tool>","arguments":{},"agent_id":"opencode"}' \
    http://127.0.0.1:8080/v1/federation/invoke
```

End-to-end: ~5 seconds. A's phone buzzes → A approves → result returns to B.

---

## Step 1: Identify both hubs

**On A's machine:**

```bash
$ pdatahub-hub identity

Hub name:      userA
Verify key:    ed25519:wdlEEYI0rCNkobjR0d1aPJBl6v2HQ4Sqh8C5FZ3mNoE
Magic DNS:     userA.tailXXXXXX.ts.net:8080
Fingerprint:   C1 D9 44 11 82 34 AC 23
```

Send B two things out-of-band (Signal, in-person, anything not compromised):
1. **Verify key** — the `ed25519:wdlE...` string (43 chars after the prefix).
2. **Fingerprint** — the `C1 D9 44 11 82 34 AC 23` hex string.

**On B's machine:** run the same command. Send A your verify key + fingerprint the same way.

> **Why both directions?** Today only A→B is needed (A delegates to B), but the protocol is symmetric — B may delegate back to A later. Share both upfront so neither side has to pause later.

If `Magic DNS` shows `(not detected)`, Tailscale wasn't running at hub init. Fix with:

```bash
export HUB_PUBLIC_HOSTNAME=userA.tailXXXXXX.ts.net
pdatahub-hub start --port 8080 ...
```

---

## Step 2: Pick the tool and scope

On A, list available tools:

```bash
$ curl -sS -H "Authorization: Bearer $HUB_API_TOKEN" http://127.0.0.1:8080/v1/tools | jq '.tools[] | {name, scope, plugin}'

{
  "name": "listEvents",
  "scope": "calendar:read",
  "plugin": "google-calendar"
}
{
  "name": "getCatFact",
  "scope": "public:read",
  "plugin": "catfact"
}
```

Pick a tool. **Scope hygiene matters:** delegate the narrowest scope the tool accepts. `listEvents` for Google Calendar is `calendar:read` — never `calendar:write`.

For this walkthrough we'll use `listEvents` on `google-calendar`.

---

## Step 3: A creates the delegation

**On A:**

```bash
$ pdatahub-hub delegate \
    --peer-verify-key ed25519:Q7NFSFHIjVfvxRee7YcN4rXgMzK9wHpaJqL2TuBvC0I \
    --plugin google-calendar \
    --tool listEvents \
    --scope calendar:read \
    --expires 24h

Delegation issued: 7f3e2b1a-9c4d-4a72-b8e1-2a5d8f9c0b3e
Plugin: google-calendar / listEvents   Scope: calendar:read
Expires: 24h

Blob (base64url, share this with the peer):
eyJ2ZXJzaW9uIjoxLCJkZWxlZ2F0aW9uX2lkIjoiN2YzZTJiMWEtOWM0ZC00YTcyLWI4ZTEtMmE1ZDhmOWMwYjNlIiwiaXN1...

QR (base64 PNG, 596 chars):
iVBORw0KGgoAAAANSUhEUgAAAUAAAAFAAQMAAAC...
```

Three things to note:
1. **`--expires` syntax:** `Nh`, `Nd`, or `Nw` — e.g. `24h`, `7d`, `2w`. Default is 24h.
2. **The CLI validates scope against the plugin manifest.** If you pass `--scope calendar:write` for a tool whose manifest declares `calendar:read`, the command fails with `scope mismatch`.
3. **The blob is signed by A's Ed25519 key.** B will verify this signature on import — but only if the fingerprint B sees matches what you shared out-of-band.

Copy the **base64url blob** (the long string starting with `eyJ2...`). Send it to B via Signal / in-person / secure paste. The QR is the same blob encoded as a scannable PNG — use it for mobile workflows.

---

## Step 4: B accepts the delegation

**On B:**

```bash
$ pdatahub-hub accept-delegation eyJ2ZXJzaW9uIjoxLCJkZWxlZ2F0aW9uX2lkIjoiN2YzZTJiMWEtOWM0ZC00YTcyLWI4ZTEtMmE1ZDhmOWMwYjNlIiwiaXN1...

Hub:         userA
Fingerprint: C1 D9 44 11 82 34 AC 23
Plugin/Tool: google-calendar / listEvents
Scope:       calendar:read
Expires:     2026-09-09 07:36 UTC
Magic DNS:   userA.tailXXXXXX.ts.net:8080

Accept this delegation? [y/N]
```

**STOP and verify the fingerprint matches what A sent you out-of-band.** If `C1 D9 44 11 82 34 AC 23` ≠ what A sent you via Signal, the blob was tampered with on its way to you. Type `N` and re-share via a different channel.

If it matches, type `y`:

```bash
Imported delegation: 7f3e2b1a-9c4d-4a72-b8e1-2a5d8f9c0b3e
Peer:    userA
Hub URL: http://100.x.y.z:8080/

Use "pdatahub-hub delegation list" to view received delegations.
```

For CI / scripted provisioning, skip the prompt with `--yes`:

```bash
pdatahub-hub accept-delegation "$BLOB" --yes
```

---

## Step 5: B invokes the federated tool

The federated tool appears in B's `/v1/tools` under the synthetic name `federated__<peer>__<tool>`:

```bash
$ curl -sS -H "Authorization: Bearer $HUB_API_TOKEN" http://127.0.0.1:8080/v1/tools \
    | jq '.tools[] | select(.federated) | {name, peer_hub_name, scope, expires_at}'

{
  "name": "federated__userA__listEvents",
  "peer_hub_name": "userA",
  "scope": "calendar:read",
  "expires_at": "2026-09-09T07:36:38Z"
}
```

Call it via the federation invoke endpoint:

```bash
$ curl -sS \
    -H "Authorization: Bearer $HUB_API_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{
          "tool": "federated__userA__listEvents",
          "arguments": { "from": "2026-09-01", "to": "2026-09-07" },
          "agent_id": "opencode",
          "justification": "Schedule meeting for userA"
        }' \
    http://127.0.0.1:8080/v1/federation/invoke
```

**What happens now (~5 seconds):**

1. B's hub signs the request with B's Ed25519 key (`X-Federation-Pubkey`, `X-Federation-Signature` headers).
2. POSTed to `http://userA.tailXXXXXX.ts.net:8080/v1/federation/call`.
3. A's hub verifies B's signature, checks clock skew (±5 min), looks up the delegation, and pushes an approval notification to A's phone.
4. **A taps Approve** (with biometric if enabled).
5. A's hub invokes `listEvents` using A's OAuth token from A's vault.
6. Result flows back to B.
7. **Both hubs** write audit rows — A's with `delegated_by = B_verify_key`, B's with `delegated_to = A_verify_key`.

If A's phone is offline, you'll get `503 NO_APPROVER_CONNECTED` immediately rather than waiting 120s for a timeout.

---

## Step 6: Verify the audit trail

**On A** — A's audit row shows the delegation source:

```bash
$ sqlite3 ~/.local/share/pdatahub/hub.db \
    "SELECT tool_name, plugin, decision, delegated_by, duration_ms
     FROM audit_log
     WHERE delegated_by IS NOT NULL
     ORDER BY id DESC LIMIT 1"

listEvents|google-calendar|approved|ed25519:Q7NFSFHI...|3421
```

**On B** — B's audit row shows the delegation target:

```bash
$ sqlite3 ~/.local/share/pdatahub/hub.db \
    "SELECT tool_name, plugin, decision, delegated_to, decision_federated, duration_ms
     FROM audit_log
     WHERE delegated_to IS NOT NULL
     ORDER BY id DESC LIMIT 1"

federated__userA__listEvents|google-calendar|approved|ed25519:wdlEEYI...|federated_ok|4127
```

If both rows are present and `decision_federated = 'federated_ok'`, the federation round-trip succeeded end-to-end.

---

## Cleanup

A can revoke at any time:

```bash
# On A
$ pdatahub-hub delegation revoke 7f3e2b1a-9c4d-4a72-b8e1-2a5d8f9c0b3e
Revoked: 7f3e2b1a-9c4d-4a72-b8e1-2a5d8f9c0b3e

# B's next call returns 403 DELEGATION_REVOKED
```

B can delete the local copy manually:

```bash
# On B
sqlite3 ~/.local/share/pdatahub/hub.db \
    "DELETE FROM peer_delegations WHERE delegation_id = '7f3e2b1a-9c4d-4a72-b8e1-2a5d8f9c0b3e'"
```

---

## Troubleshooting

The full troubleshooting matrix is in [federation.md §"What to do if things break"](./federation.md#what-to-do-if-things-break). The top five issues for first-time setup:

| Symptom | Cause | Fix |
|---------|-------|-----|
| `accept-delegation` says `signature verification failed: signature mismatch` | Blob was tampered with, OR you pasted it with whitespace/newlines | Re-copy the blob character-for-character. Single-line base64 only. |
| A's hub returns `503 NO_APPROVER_CONNECTED` | A's phone is offline / not on tailnet | Open the pdatahub Android app on A's phone; verify it's connected. A's desktop hub can also approve if `/approval-stream` is bound to localhost. |
| `401 CLOCK_SKEW` on B's call | Clocks differ by >5 min | `sudo chronyc tracking` on both machines; force sync with `sudo chronyc -a makestep` |
| `409 REPLAY` | Same `request_id` reused within 10 min | B's MCP client must generate a fresh `request_id` (UUID v4) per call. Most clients do this automatically. |
| `502 FEDERATION_UPSTREAM_ERROR` | A's hub unreachable from B | `tailscale status` on both machines. Verify A's hub is running on `:8080`. `curl http://userA.tailXXXXXX.ts.net:8080/health` from B. |

**Still stuck?** Check both hubs' logs:

```bash
# On A — should show the inbound /v1/federation/call
pdatahub-hub logs --follow --filter=federation

# On B — should show the outbound POST + response
pdatahub-hub logs --follow --filter=federation
```

If you see `verify failed: signature mismatch` in A's logs, the issue is on B's side — B is signing with the wrong key. Re-run `pdatahub-hub identity` on B and double-check that the verify key B is signing with matches the one embedded in the blob.

---

## What to read next

- **[federation.md](./federation.md)** — architecture, threat model, known limitations, full CLI reference
- **[cli-reference.md](./cli-reference.md)** — every flag for `delegate`, `accept-delegation`, `delegation list`, `delegation revoke`, `audit purge`
- **[threat-model.md](./threat-model.md)** — MIT-005 (federation rate limits), proxy pattern rationale, replay/nonce design
- **[relay-mode.md](./relay-mode.md)** — if you don't have Tailscale yet, this walks through the tunnel setup
